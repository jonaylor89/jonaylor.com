import Foundation
import TattleShared

// tattlectl: command-line access to the Tattle filter.
//
// Ships inside Tattle.app/Contents/MacOS. Reading needs no privileges; changing rules
// needs `sudo`, which the extension verifies from the connection's effective user ID.
// The extension only accepts this tool when it's signed by the same team.

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

func printJSON<T: Encodable>(_ value: T) {
    let encoder = RuleDocument.makeEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(value) else { fail("Couldn't encode the output.") }
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

/// The app bundle this tool lives in, following symlinks such as /usr/local/bin/tattlectl.
func enclosingApp() -> Bundle? {
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    let candidates = [
        Bundle.main.bundleURL,
        executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent(),
        URL(fileURLWithPath: "/Applications/Tattle.app"),
    ]
    return candidates.lazy.filter { $0.pathExtension == "app" }.compactMap(Bundle.init(url:)).first {
        ExtensionInfo.embedded(in: $0) != nil
    }
}

let command: CLICommand
do {
    command = try CLICommand.parse(Array(CommandLine.arguments.dropFirst()))
} catch {
    fail("\(error)\n\n\(CLICommand.usage)", code: 64)
}
if command == .help {
    print(CLICommand.usage)
    exit(0)
}

guard let app = enclosingApp(), let info = ExtensionInfo.embedded(in: app) else {
    fail("Can't find Tattle.app. Run tattlectl from inside the app bundle or install Tattle in /Applications.")
}
guard let teamID = CodeIdentity.current()?.teamID else {
    fail("tattlectl isn't signed, so the filter won't talk to it. Use the copy inside Tattle.app.")
}
let client = TattleXPCClient(extensionInfo: info, teamID: teamID)

func send(_ request: ServiceRequest) async -> ServiceResponse {
    do {
        let response = try await client.send(request, timeout: 15)
        if case .failure(let message) = response { fail(message) }
        return response
    } catch {
        fail("\(error.localizedDescription)\nIs the Tattle filter installed and turned on?")
    }
}

func run() async {
    switch command {
    case .help:
        print(CLICommand.usage)

    case .status(let json):
        guard case .status(let status) = await send(.status) else { fail("Unexpected reply.") }
        if json { return printJSON(status) }
        print("""
        Tattle \(status.version)
        Mode:              \(status.settings.mode.rawValue)
        Default policy:    \(status.settings.defaultPolicy.rawValue) when an alert isn't answered
        Active profile:    \(status.activeProfileName ?? "none")
        Rules:             \(status.ruleCount)
        Blocklist entries: \(status.blocklistEntryCount)
        Connections:       \(status.connectionsLogged) logged
        App connected:     \(status.alertClientConnected ? "yes" : "no (alerts use the default policy)")
        DNS-over-HTTPS:    \(status.dnsProxyRunning ? "running via \(status.settings.dns.resolverURL)" : "off")
        """)

    case .listRules(let json):
        guard case .rules(let rules) = await send(.rules) else { fail("Unexpected reply.") }
        if json { return printJSON(rules) }
        for rule in rules.sorted(by: { ($0.isSystem ? 1 : 0, $0.created) < ($1.isSystem ? 1 : 0, $1.created) }) {
            print(CLIFormat.describe(rule))
        }

    case .addRule(let rule):
        _ = await send(.saveRules([rule]))
        print("Added \(CLIFormat.describe(rule))")

    case .removeRules(let ids):
        _ = await send(.deleteRules(ids))
        print("Removed \(ids.count) rule\(ids.count == 1 ? "" : "s").")

    case .export(let path):
        guard case .document(let data) = await send(.exportRules) else { fail("Unexpected reply.") }
        if let path {
            do { try data.write(to: URL(fileURLWithPath: path), options: .atomic) } catch { fail("Can't write \(path): \(error.localizedDescription)") }
        } else {
            FileHandle.standardOutput.write(data + Data("\n".utf8))
        }

    case .import(let path, let replace):
        let data: Data
        do { data = try Data(contentsOf: URL(fileURLWithPath: path)) } catch { fail("Can't read \(path): \(error.localizedDescription)") }
        guard data.count <= XPCLimits.maxRequestBytes - 1024 else { fail("\(path) is too large.") }
        guard case .imported(let count) = await send(.importRules(document: data, replace: replace)) else { fail("Unexpected reply.") }
        print("Imported \(count) rule\(count == 1 ? "" : "s")\(replace ? ", replacing your previous rules" : "").")

    case .tail(let count, let follow, let json):
        guard case .connections(let initial) = await send(.connections(ConnectionQuery(limit: count))) else { fail("Unexpected reply.") }
        var newest: Int64 = 0
        func emit(_ records: [ConnectionRecord]) {
            for record in records {
                newest = max(newest, record.id)
                if json {
                    let encoder = RuleDocument.makeEncoder()
                    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
                    if let data = try? encoder.encode(record) { FileHandle.standardOutput.write(data + Data("\n".utf8)) }
                } else {
                    print(CLIFormat.describe(record))
                }
            }
        }
        emit(initial.reversed())  // oldest first, like tail
        while follow {
            try? await Task.sleep(for: .seconds(1))
            guard case .connections(let fresh) = await send(.connections(ConnectionQuery(afterID: newest, limit: 1000))) else { continue }
            emit(fresh)  // afterID queries come back oldest first
        }
    }
}

setvbuf(stdout, nil, _IOLBF, 0)
// Top-level code runs on the main actor, so the main queue must keep running for the task;
// blocking it (for example on a semaphore) would deadlock.
Task {
    await run()
    exit(0)
}
dispatchMain()
