import Foundation

/// How to start the engine.
public struct EngineCommand: Sendable, Equatable {
    public var executable: URL
    public var arguments: [String]
    /// Shown in Settings and in error messages.
    public var description: String

    public init(executable: URL, arguments: [String], description: String) {
        self.executable = executable; self.arguments = arguments; self.description = description
    }
}

/// Finds the CLI. The app accompanies it rather than bundling it, so this is the only part that
/// would change if a relocatable Python were ever shipped inside the app.
public struct EngineLocator: Sendable {
    public static let installHint = "uv tool install --from './cli/mypeople[bluetooth,browser,osint]' mypeople"

    public var isExecutable: @Sendable (String) -> Bool
    public var directoryHasProject: @Sendable (String) -> Bool
    public var environment: [String: String]
    public var home: String
    /// The login shell's PATH, since an app opened from the Dock starts with a minimal one.
    public var shellPath: String?
    /// This source file's own path at build time, which leads to the checkout on a developer's Mac.
    public var sourceFile: String

    public init(environment: [String: String] = ProcessInfo.processInfo.environment,
                home: String = NSHomeDirectory(), shellPath: String? = nil, sourceFile: String = #filePath,
                isExecutable: @escaping @Sendable (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) },
                directoryHasProject: @escaping @Sendable (String) -> Bool = { FileManager.default.fileExists(atPath: "\($0)/uv.lock") && FileManager.default.fileExists(atPath: "\($0)/src/mypeople/appserver.py") }) {
        self.environment = environment; self.home = home; self.shellPath = shellPath; self.sourceFile = sourceFile
        self.isExecutable = isExecutable; self.directoryHasProject = directoryHasProject
    }

    /// The first usable CLI: `chosen` (from Settings), `$MYPEOPLE_BIN`, the usual install locations,
    /// the login shell's PATH, then a repository checkout through uv.
    public func locate(chosen: String? = nil) -> EngineCommand? {
        var candidates: [String] = []
        if let chosen, !chosen.isEmpty { candidates.append((chosen as NSString).expandingTildeInPath) }
        if let bin = environment["MYPEOPLE_BIN"], !bin.isEmpty { candidates.append((bin as NSString).expandingTildeInPath) }
        candidates += ["\(home)/.local/bin/mypeople", "/opt/homebrew/bin/mypeople", "/usr/local/bin/mypeople"]
        candidates += searchPath.map { "\($0)/mypeople" }
        if let found = candidates.first(where: isExecutable) {
            return EngineCommand(executable: URL(fileURLWithPath: found), arguments: ["app-server"], description: found)
        }
        return checkoutCommand(chosen: chosen)
    }

    private var searchPath: [String] { (shellPath ?? "").split(separator: ":").map(String.init) }

    private func checkoutCommand(chosen: String?) -> EngineCommand? {
        var projects: [String] = []
        if let checkout = environment["MYPEOPLE_CHECKOUT"], !checkout.isEmpty { projects.append(checkout) }
        // .../macos/mypeople/MyPeopleKit/Sources/MyPeopleKit/EngineLocator.swift → .../cli/mypeople
        let root = URL(fileURLWithPath: sourceFile).deletingLastPathComponent().appendingPathComponent("../../../../../cli/mypeople").standardizedFileURL.path
        projects.append(root)
        guard let project = projects.first(where: directoryHasProject),
              let uv = (["\(home)/.local/bin/uv", "/opt/homebrew/bin/uv", "/usr/local/bin/uv"] + searchPath.map { "\($0)/uv" }).first(where: isExecutable)
        else { return nil }
        return EngineCommand(executable: URL(fileURLWithPath: uv),
                             arguments: ["run", "--project", project, "--locked", "--all-extras", "mypeople", "app-server"],
                             description: "uv, from \(project)")
    }

    /// Asks the user's login shell for its PATH, giving up after a few seconds. Sentinels keep any
    /// greeting a shell's startup files print out of the answer.
    public static func loginShellPath(environment: [String: String] = ProcessInfo.processInfo.environment, timeout: TimeInterval = 5) async -> String? {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                let shell = environment["SHELL"].flatMap { $0.hasSuffix("zsh") || $0.hasSuffix("bash") ? $0 : nil } ?? "/bin/zsh"
                let process = Process()
                let output = Pipe()
                process.executableURL = URL(fileURLWithPath: shell)
                process.arguments = ["-ilc", "printf '\\n@@PATH@@%s@@END@@\\n' \"$PATH\""]
                process.standardOutput = output
                process.standardError = FileHandle.nullDevice
                process.standardInput = FileHandle.nullDevice
                do { try process.run() } catch { continuation.resume(returning: nil); return }
                let killer = DispatchWorkItem { if process.isRunning { process.terminate() } }
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: killer)
                let data = output.fileHandleForReading.readDataToEndOfFile()
                killer.cancel()
                let text = String(decoding: data, as: UTF8.self)
                guard let start = text.range(of: "@@PATH@@"), let end = text.range(of: "@@END@@", range: start.upperBound..<text.endIndex) else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: String(text[start.upperBound..<end.lowerBound]))
            }
        }
    }

    /// The child's environment: ours, with the login shell's PATH so `docker`, `lms` and `pi` are found.
    public static func childEnvironment(base: [String: String] = ProcessInfo.processInfo.environment, shellPath: String?) -> [String: String] {
        var env = base
        if let shellPath, !shellPath.isEmpty { env["PATH"] = shellPath }
        return env
    }
}
