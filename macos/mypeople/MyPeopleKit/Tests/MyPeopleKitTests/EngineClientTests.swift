import Foundation
import Testing
@testable import MyPeopleKit

/// A scripted engine: every line the client sends is answered by `respond`.
final class FakeTransport: EngineTransport, @unchecked Sendable {
    let lines: AsyncStream<Data>
    private let continuation: AsyncStream<Data>.Continuation
    private let lock = NSLock()
    private var _sent: [JSONValue] = []
    var respond: @Sendable (JSONValue, FakeTransport) -> Void = { _, _ in }
    var failSends = false

    init() { (lines, continuation) = AsyncStream.makeStream(of: Data.self) }

    func send(_ line: Data) throws {
        if failSends { throw CocoaError(.fileWriteUnknown) }
        let frame = try JSONDecoder().decode(JSONValue.self, from: line)
        lock.withLock { _sent.append(frame) }
        respond(frame, self)
    }
    var sent: [JSONValue] { lock.withLock { _sent } }
    func deliver(_ text: String) { continuation.yield(Data(text.utf8)) }
    func hangUp() { continuation.finish() }
    func close() { hangUp() }
    func diagnostics() -> String { "last words" }
}

actor EventLog {
    var events: [EngineEvent] = []
    func add(_ event: EngineEvent) async {
        events.append(event)
    }
}

struct EngineClientTests {
    func client(_ transport: FakeTransport, log: EventLog = EventLog()) -> EngineClient {
        let client = EngineClient(transport: transport) { await log.add($0) }
        Task { await client.run() }
        return client
    }

    @Test func aResponseArrivesOnlyAfterTheEventsBeforeItAreApplied() async throws {
        let transport = FakeTransport()
        transport.respond = { frame, t in
            let id = frame["id"]!.int!
            t.deliver(#"{"event":"view.delta","params":{"version":1,"upserts":[{"kind":"person","id":"1","data":{"name":"Ada"}}],"deletes":[]}}"#)
            t.deliver("{\"id\":\(id),\"result\":{\"message\":\"ok\"}}")
        }
        // The handler is deliberately slow, as a hop to the main actor can be.
        final class Box: @unchecked Sendable { var applied = false }
        let box = Box()
        let client = EngineClient(transport: transport) { _ in
            try? await Task.sleep(for: .milliseconds(50))
            box.applied = true
        }
        Task { await client.run() }
        let reply: EditReply = try await client.call("edit.apply", ["kind": "alias_add"])
        #expect(reply.message == "ok")
        #expect(box.applied, "the caller must see its own edit on return")
    }

    @Test func requestsAndResponsesMatchByIdInAnyOrder() async throws {
        let transport = FakeTransport()
        transport.respond = { frame, t in
            let id = frame["id"]!.int!
            guard frame["method"] == "b" else { return }
            t.deliver("{\"id\":\(id),\"result\":{\"message\":\"b\"}}")
            t.deliver("{\"id\":\(id - 1),\"result\":{\"message\":\"a\"}}")
        }
        let client = client(transport)
        async let a: EditReply = client.call("a")
        try await Task.sleep(for: .milliseconds(20))
        async let b: EditReply = client.call("b")
        #expect(try await a.message == "a")
        #expect(try await b.message == "b")
    }

    @Test func engineRefusalsCarryTheirCode() async throws {
        let transport = FakeTransport()
        transport.respond = { frame, t in
            t.deliver("{\"id\":\(frame["id"]!.int!),\"error\":{\"code\":\"conflict\",\"message\":\"This contact changed\"}}")
        }
        await #expect(throws: EngineError.rpc(code: "conflict", message: "This contact changed")) {
            let _: NoReply = try await client(transport).call("contact.save")
        }
        #expect(EngineError.rpc(code: "conflict", message: "").isConflict)
    }

    @Test func aDyingEngineFailsWhatsWaitingAndWhatComesNext() async throws {
        let transport = FakeTransport()
        let client = client(transport)
        let waiting = Task { let _: NoReply = try await client.call("slow") }
        try await Task.sleep(for: .milliseconds(20))
        transport.hangUp()
        await #expect(throws: EngineError.stopped) { try await waiting.value }
        await #expect(throws: EngineError.stopped) {
            let _: NoReply = try await client.call("after")
        }
    }

    @Test func anEventWithTheWrongShapeIsIgnoredAndTheConversationContinues() async throws {
        let transport = FakeTransport()
        let client = client(transport)
        let waiting = Task { () -> Hello in try await client.call("app.hello") }
        try await Task.sleep(for: .milliseconds(20))
        transport.deliver(#"{"event":"view.delta","params":{"version":"not a number"}}"#)
        transport.deliver(#"{"event":"job.output","params":"not an object"}"#)
        transport.deliver("not json at all")
        transport.deliver(#"{"id":1,"result":{"protocol":1,"version":"0","db":"/x"}}"#)
        #expect(try await waiting.value.db == "/x")
    }

    @Test func aFailedWriteIsAFailureRatherThanAHang() async {
        let transport = FakeTransport()
        transport.failSends = true
        await #expect(throws: EngineError.stopped) {
            let _: NoReply = try await client(transport).call("x")
        }
    }

    @Test func unexpectedFramesAreIgnored() async throws {
        let transport = FakeTransport()
        let log = EventLog()
        let client = client(transport, log: log)
        transport.deliver("not json")
        transport.deliver("[1,2,3]")
        transport.deliver(#"{"id":999,"result":{}}"#)
        transport.deliver(#"{"id":null,"error":{"code":"invalid","message":"Not a JSON object."}}"#)
        transport.deliver(#"{"event":"view.delta","params":{"nonsense":true}}"#)
        transport.deliver(#"{"event":"from.the.future","params":{}}"#)
        transport.respond = { frame, t in t.deliver("{\"id\":\(frame["id"]!.int!),\"result\":{}}") }
        let _: NoReply = try await client.call("ping")
        let events = await log.events
        #expect(events.count == 1)
        if case .unknown("from.the.future") = events[0] {} else { Issue.record("expected the unknown event") }
    }

    @Test func everyJobEventDecodes() async throws {
        let transport = FakeTransport()
        let log = EventLog()
        let client = client(transport, log: log)
        transport.deliver(#"{"event":"job.started","params":{"id":1,"kind":"transfer_qr","params":{}}}"#)
        transport.deliver(#"{"event":"job.output","params":{"id":1,"line":"hello"}}"#)
        transport.deliver(#"{"event":"job.progress","params":{"id":1,"event":{"kind":"qr","path":"/x"}}}"#)
        transport.deliver(#"{"event":"job.finished","params":{"id":1,"kind":"transfer_qr","code":0,"status":"succeeded","message":"hello"}}"#)
        transport.deliver(#"{"event":"view.state","params":{"refreshing":false,"error":null}}"#)
        transport.respond = { frame, t in t.deliver("{\"id\":\(frame["id"]!.int!),\"result\":{}}") }
        let _: NoReply = try await client.call("ping")
        let events = await log.events
        #expect(events.count == 5)
        if case .jobOutput(1, "hello") = events[1] {} else { Issue.record("job.output") }
        if case .jobProgress(1, let event) = events[2] { #expect(event["path"] == "/x") } else { Issue.record("job.progress") }
        if case .jobFinished(let f) = events[3] { #expect(f.status == "succeeded") } else { Issue.record("job.finished") }
    }

    @Test func aCardIsEncodedExactly() async throws {
        let transport = FakeTransport()
        transport.respond = { frame, t in t.deliver("{\"id\":\(frame["id"]!.int!),\"result\":{}}") }
        struct Save: Encodable, Sendable { var card: ContactCard }
        var card = ContactCard(name: "Ada 🦋 \"Q\"\nnext", region: "GB")
        card.notes = "línea"
        let _: NoReply = try await client(transport).call("contact.save", encoding: Save(card: card))
        let sent = try #require(transport.sent.first)
        #expect(sent["params"]?["card"]?["name"] == "Ada 🦋 \"Q\"\nnext")
        #expect(sent["params"]?["card"]?["notes"] == "línea")
    }

    @Test func framesNeverSplitAcrossLines() {
        var splitter = LineSplitter()
        #expect(splitter.append(Data("ab".utf8)).isEmpty)
        #expect(splitter.append(Data("c\nde".utf8)) == [Data("abc".utf8)])
        #expect(splitter.append(Data("\n\n\nf\ng".utf8)) == [Data("de".utf8), Data("f".utf8)])
        #expect(splitter.append(Data("\n".utf8)) == [Data("g".utf8)])
        #expect(splitter.append(Data()).isEmpty)
    }

    @Test func aHugeFrameIsAssembledInLinearTime() {
        var splitter = LineSplitter()
        let chunk = Data(repeating: 65, count: 64 * 1024)
        for _ in 0..<320 { #expect(splitter.append(chunk).isEmpty) }
        let lines = splitter.append(Data("\n".utf8))
        #expect(lines.count == 1)
        #expect(lines[0].count == 320 * 64 * 1024)
    }

    @Test func theTailKeepsOnlyTheEnd() {
        let tail = TailBuffer(limit: 4)
        tail.append(Data("abcdefghij".utf8))
        tail.append(Data("kl".utf8))
        #expect(tail.text == "ijkl")
    }
}

struct EngineLocatorTests {
    func locator(_ executables: Set<String>, env: [String: String] = [:], shellPath: String? = nil, projects: Set<String> = []) -> EngineLocator {
        EngineLocator(environment: env, home: "/Users/me", shellPath: shellPath, sourceFile: "/repo/macos/mypeople/MyPeopleKit/Sources/MyPeopleKit/EngineLocator.swift",
                      isExecutable: { executables.contains($0) }, directoryHasProject: { projects.contains($0) })
    }

    @Test func searchesInTheDocumentedOrder() {
        let all: Set<String> = ["/chosen/mypeople", "/bin-env/mypeople", "/Users/me/.local/bin/mypeople", "/opt/homebrew/bin/mypeople", "/usr/local/bin/mypeople", "/shell/mypeople"]
        var available = all
        let env = ["MYPEOPLE_BIN": "/bin-env/mypeople"]
        for expected in ["/chosen/mypeople", "/bin-env/mypeople", "/Users/me/.local/bin/mypeople", "/opt/homebrew/bin/mypeople", "/usr/local/bin/mypeople", "/shell/mypeople"] {
            let found = locator(available, env: env, shellPath: "/nope:/shell").locate(chosen: "/chosen/mypeople")
            #expect(found?.executable.path == expected)
            #expect(found?.arguments == ["app-server"])
            available.remove(expected)
        }
        #expect(locator(available, env: env, shellPath: "/nope:/shell").locate(chosen: "/chosen/mypeople") == nil)
    }

    @Test func aCheckoutRunsThroughUv() {
        let found = locator(["/opt/homebrew/bin/uv"], projects: ["/repo/cli/mypeople"]).locate()
        #expect(found?.executable.path == "/opt/homebrew/bin/uv")
        #expect(found?.arguments == ["run", "--project", "/repo/cli/mypeople", "--locked", "--all-extras", "mypeople", "app-server"])
        #expect(locator(["/x/uv"], env: ["MYPEOPLE_CHECKOUT": "/co"], shellPath: "/x", projects: ["/co"]).locate()?.arguments[2] == "/co")
        #expect(locator([], projects: ["/repo/cli/mypeople"]).locate() == nil, "no uv")
        #expect(locator(["/opt/homebrew/bin/uv"]).locate() == nil, "no checkout")
    }

    @Test func theChildGetsTheLoginShellsPath() {
        #expect(EngineLocator.childEnvironment(base: ["PATH": "/usr/bin", "A": "1"], shellPath: "/x:/y") == ["PATH": "/x:/y", "A": "1"])
        #expect(EngineLocator.childEnvironment(base: ["PATH": "/usr/bin"], shellPath: nil) == ["PATH": "/usr/bin"])
    }
}
