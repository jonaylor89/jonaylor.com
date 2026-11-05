import Foundation

/// Requests and responses over a transport.
///
/// One invariant matters above all: the engine sends an edit's `view.delta` before its response, and
/// the pump awaits the event handler before moving to the next line. So when `call` returns, the
/// model has already applied the delta, and the screen can't flash the old value.
public actor EngineClient {
    public typealias EventHandler = @Sendable (EngineEvent) async -> Void

    private struct Header: Decodable {
        struct Failure: Decodable { var code: String; var message: String }
        var id: Int?
        var event: String?
        var error: Failure?
    }

    private struct Result<T: Decodable>: Decodable { var result: T }
    private struct Params<T: Decodable>: Decodable { var params: T }
    private struct Request<P: Encodable>: Encodable { var id: Int; var method: String; var params: P }

    private let transport: EngineTransport
    private let onEvent: EventHandler
    private var nextId = 1
    private var waiting: [Int: CheckedContinuation<Data, Error>] = [:]
    private var pump: Task<Void, Never>?
    private var closed = false
    private let encoder = JSONEncoder()

    public init(transport: EngineTransport, onEvent: @escaping EventHandler) {
        self.transport = transport
        self.onEvent = onEvent
    }

    /// Begins reading. Returns when the engine has gone, having failed anything still waiting.
    public func run() async {
        for await line in transport.lines { await handle(line) }
        finish()
    }

    public func stop() { transport.close() }

    public func diagnostics() -> String { transport.diagnostics() }

    public func call<T: Decodable & Sendable>(_ method: String, _ params: JSONValue = .object([:]), as type: T.Type = T.self) async throws -> T {
        try await decodeResult(call(raw: method, params: params))
    }

    /// For requests whose card must round-trip exactly, which JSONValue can't guarantee for it.
    public func call<T: Decodable & Sendable, P: Encodable & Sendable>(_ method: String, encoding params: P, as type: T.Type = T.self) async throws -> T {
        try await decodeResult(call(raw: method, params: params))
    }

    private func decodeResult<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(Result<T>.self, from: data).result
        } catch {
            throw EngineError.malformed(String(describing: error))
        }
    }

    private func call<P: Encodable>(raw method: String, params: P) async throws -> Data {
        guard !closed else { throw EngineError.stopped }
        let id = nextId
        nextId += 1
        var line = try encoder.encode(Request(id: id, method: method, params: params))
        line.append(10)
        return try await withCheckedThrowingContinuation { continuation in
            waiting[id] = continuation
            do {
                try transport.send(line)
            } catch {
                waiting[id] = nil
                continuation.resume(throwing: EngineError.stopped)
            }
        }
    }

    private func handle(_ line: Data) async {
        guard let header = try? JSONDecoder().decode(Header.self, from: line) else { return }
        if let name = header.event {
            if let event = Self.decodeEvent(name, line) { await onEvent(event) }
        } else if let id = header.id, let waiter = waiting.removeValue(forKey: id) {
            if let failure = header.error {
                waiter.resume(throwing: EngineError.rpc(code: failure.code, message: failure.message))
            } else {
                waiter.resume(returning: line)
            }
        }
    }

    private func finish() {
        closed = true
        for waiter in waiting.values { waiter.resume(throwing: EngineError.stopped) }
        waiting.removeAll()
    }

    private static func decodeParams<T: Decodable>(_ type: T.Type, _ line: Data) -> T? {
        try? JSONDecoder().decode(Params<T>.self, from: line).params
    }

    private static func decodeEvent(_ name: String, _ line: Data) -> EngineEvent? {
        func params<T: Decodable & Sendable>(_ type: T.Type) -> T? { decodeParams(type, line) }
        struct State: Decodable { var refreshing: Bool; var error: String? }
        struct Output: Decodable { var id: Int; var line: String }
        struct Progress: Decodable { var id: Int; var event: JSONValue }
        switch name {
        case "view.delta": return params(ViewDelta.self).map(EngineEvent.viewDelta)
        case "view.state": return params(State.self).map { .viewState(refreshing: $0.refreshing, error: $0.error) }
        case "job.started": return params(JobStarted.self).map(EngineEvent.jobStarted)
        case "job.output": return params(Output.self).map { .jobOutput(id: $0.id, line: $0.line) }
        case "job.progress": return params(Progress.self).map { .jobProgress(id: $0.id, event: $0.event) }
        case "job.finished": return params(JobFinished.self).map(EngineEvent.jobFinished)
        default: return .unknown(name)
        }
    }
}
