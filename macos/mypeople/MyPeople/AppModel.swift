import AppKit
import MyPeopleKit
import Observation
import SwiftUI

enum Screen: String, Hashable, CaseIterable, Identifiable {
    case today, upcoming, people, ask
    case profiles, duplicates, conflicts
    case importData, phone, google
    case activity

    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: "Today"
        case .upcoming: "Upcoming"
        case .people: "People"
        case .ask: "Ask"
        case .profiles: "Profiles"
        case .duplicates: "Duplicates"
        case .conflicts: "Conflicts"
        case .importData: "Import"
        case .phone: "Phone"
        case .google: "Google"
        case .activity: "Activity"
        }
    }

    var symbol: String {
        switch self {
        case .today: "sun.max"
        case .upcoming: "calendar"
        case .people: "person.2"
        case .ask: "questionmark.bubble"
        case .profiles: "person.crop.circle.badge.questionmark"
        case .duplicates: "square.on.square"
        case .conflicts: "arrow.triangle.branch"
        case .importData: "square.and.arrow.down"
        case .phone: "iphone.radiowaves.left.and.right"
        case .google: "person.crop.rectangle.stack"
        case .activity: "list.bullet.rectangle"
        }
    }
}

struct PersonRoute: Hashable {
    var id: Int
    var uid: String
}

struct Notice: Identifiable, Equatable {
    let id = UUID()
    var text: String
    var isError: Bool
}

struct EngineFailure: Equatable {
    var title: String
    var detail: String
    var diagnostics = ""
    var showInstall = false
}

enum EngineState: Equatable {
    case starting
    case ready
    case restarting
    case failed(EngineFailure)
}

enum JobStatus: Equatable {
    case running, succeeded, failed, cancelled, interrupted

    var label: String {
        switch self {
        case .running: "Running"
        case .succeeded: "Finished"
        case .failed: "Failed"
        case .cancelled: "Stopped"
        case .interrupted: "Interrupted"
        }
    }
}

struct Job: Identifiable {
    let id: Int
    let engineId: Int
    let generation: Int
    let kind: String
    let params: JSONValue
    var title: String
    var status = JobStatus.running
    var lines: [String] = []
    var droppedLines = 0
    var progress: JSONValue?
    var qrPath: String?
    var qrExpires: Date?
    var started = Date()
    var finished: Date?
    var message = ""

    var isRunning: Bool { status == .running }

    /// A failed command's last line is usually its error, which is shown on its own.
    var outputLines: [String] {
        status == .failed && lines.last == message ? Array(lines.dropLast()) : lines
    }

    mutating func add(line: String) {
        lines.append(line)
        if lines.count > 4000 {
            lines.removeFirst(1000)
            droppedLines += 1000
        }
    }
}

/// Everything the windows see: the engine connection, the published view, and running jobs.
/// It holds no domain logic that can change data. Every change is a call to the engine.
@MainActor @Observable
final class AppModel {
    private(set) var state = EngineState.starting
    private(set) var records = Records() {
        didSet { memo.removeAll() }
    }
    private(set) var hasLoaded = false
    private(set) var refreshing = false
    private(set) var viewError: String?
    private(set) var status: SystemStatus?
    private(set) var engineDescription = ""
    private(set) var jobs: [Int: Job] = [:]

    var screen: Screen = .today
    var paths: [Screen: [PersonRoute]] = [:]
    var notice: Notice?
    var creatingContact = false
    var selectedPeople: Set<Int> = []
    var searchFocusRequest = 0
    /// Questions asked this session; the engine deliberately doesn't echo free text.
    var asks: [(question: String, jobId: Int)] = []

    @ObservationIgnored private var memo: [String: Any] = [:]
    @ObservationIgnored private var client: EngineClient?
    @ObservationIgnored private var viewVersion = -1
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var attempts = 0
    @ObservationIgnored private var shellPath: String?
    @ObservationIgnored private var stopping = false
    @ObservationIgnored private var noticeTask: Task<Void, Never>?

    var isReady: Bool { state == .ready }
    var enginePath: String {
        get { UserDefaults.standard.string(forKey: "enginePath") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "enginePath") }
    }

    init() {
        if let raw = UserDefaults.standard.string(forKey: "initialScreen"), let screen = Screen(rawValue: raw) { self.screen = screen }
    }

    /// Values computed from the view are kept until the view next changes.
    func derived<T>(_ key: String, _ compute: (Records) -> T) -> T {
        // Read first, even on a hit: this read is what makes the calling view observe the records.
        let records = records
        if let value = memo[key] as? T { return value }
        let value = compute(records)
        memo[key] = value
        return value
    }

    // MARK: Engine lifecycle

    func start() async {
        guard generation == 0 else { return }
        await connect()
    }

    func retry() {
        attempts = 0
        state = .starting
        Task { await connect() }
    }

    func stopEngine() {
        stopping = true
        let client = client
        Task { await client?.stop() }
    }

    /// After choosing a different CLI. Whatever it was running is told to stop.
    func reconnect() {
        stopping = false
        attempts = 0
        state = hasLoaded ? .restarting : .starting
        Task { await connect() }
    }

    private func connect() async {
        generation += 1
        let generation = generation
        viewVersion = -1
        if shellPath == nil { shellPath = await loginShellPath() }
        guard !stopping, generation == self.generation else { return }
        let locator = EngineLocator(shellPath: shellPath)
        guard let command = locator.locate(chosen: enginePath) else {
            state = .failed(EngineFailure(
                title: "MyPeople needs its command-line tool",
                detail: "This app is the Mac's window onto the MyPeople CLI, which does the reading and keeps your memory. It wasn't found on this Mac. Install it, then try again, or choose it in Settings.",
                showInstall: true))
            return
        }
        engineDescription = command.description

        let client: EngineClient
        do {
            let transport = try ProcessTransport(executable: command.executable, arguments: command.arguments,
                                                 environment: EngineLocator.childEnvironment(shellPath: shellPath))
            client = EngineClient(transport: transport) { [weak self] event in
                await self?.receive(event, generation: generation)
            }
        } catch {
            state = .failed(EngineFailure(title: "Couldn't start MyPeople's engine", detail: "\(command.description): \(error.localizedDescription)", showInstall: true))
            return
        }
        self.client = client
        Task { [weak self] in
            await client.run()
            await self?.engineEnded(generation: generation, client: client)
        }

        do {
            let hello: Hello = try await client.call("app.hello")
            guard hello.protocolVersion == engineProtocolVersion else {
                state = .failed(EngineFailure(
                    title: hello.protocolVersion < engineProtocolVersion ? "Update the MyPeople CLI" : "Update this app",
                    detail: "The CLI at \(command.description) speaks engine protocol \(hello.protocolVersion), and this app speaks \(engineProtocolVersion). Nothing was changed.",
                    showInstall: hello.protocolVersion < engineProtocolVersion))
                await client.stop()
                return
            }
            if let backend = UserDefaults.standard.string(forKey: "llmBackend"), !backend.isEmpty {
                let _: NoReply? = try? await client.call("settings.llm", ["backend": .string(backend)])
            }
            let snapshot: ViewSnapshot = try await client.call("view.snapshot")
            guard generation == self.generation else { return }
            records = Records(snapshot: snapshot.records)
            viewVersion = snapshot.version
            hasLoaded = true
            attempts = 0
            state = .ready
            refreshStatus()
        } catch EngineError.rpc(_, let message) {
            state = .failed(EngineFailure(title: "Couldn't open your memory", detail: message))
            await client.stop()
        } catch {
            // The process ended; engineEnded decides what to do and has the diagnostics.
        }
    }

    /// Starting a login shell costs a few hundred milliseconds, so launches use the PATH the last one
    /// found and look again in the background, for the next connection.
    private func loginShellPath() async -> String? {
        let key = "loginShellPath"
        guard let cached = UserDefaults.standard.string(forKey: key), !cached.isEmpty else {
            let found = await EngineLocator.loginShellPath()
            if let found { UserDefaults.standard.set(found, forKey: key) }
            return found
        }
        Task { [weak self] in
            guard let found = await EngineLocator.loginShellPath() else { return }
            UserDefaults.standard.set(found, forKey: key)
            self?.shellPath = found
        }
        return cached
    }

    private func engineEnded(generation: Int, client: EngineClient) async {
        guard generation == self.generation, !stopping else { return }
        for (id, job) in jobs where job.isRunning && job.generation == generation {
            jobs[id]?.status = .interrupted
            jobs[id]?.finished = Date()
        }
        if case .failed = state { return }
        self.client = nil
        attempts += 1
        if !hasLoaded && attempts >= 2 {
            let diagnostics = await client.diagnostics()
            let needsUpdate = diagnostics.contains("invalid choice") && diagnostics.contains("app-server")
            state = .failed(EngineFailure(
                title: needsUpdate ? "Update the MyPeople CLI" : "MyPeople's engine stopped",
                detail: needsUpdate ? "The CLI at \(engineDescription) is older than this app and has no engine command." : "It stopped before it could open your memory (\(engineDescription)).",
                diagnostics: needsUpdate ? "" : diagnostics, showInstall: needsUpdate))
            return
        }
        // The last view stays browsable, read-only, while the engine comes back. Edits are never
        // retried: whatever failed was reported to whoever asked for it.
        state = hasLoaded ? .restarting : .starting
        let delay = min(30, 1 << min(attempts, 5))
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, generation == self.generation, !self.stopping else { return }
            await self.connect()
        }
    }

    private func receive(_ event: EngineEvent, generation: Int) {
        guard generation == self.generation else { return }
        switch event {
        case .viewDelta(let delta):
            guard viewVersion >= 0, delta.version > viewVersion else { return }
            guard delta.version == viewVersion + 1 else { resynchronize(); return }
            records.apply(delta)
            viewVersion = delta.version
        case .viewState(let refreshing, let error):
            self.refreshing = refreshing
            viewError = error
        case .jobStarted(let started):
            let id = jobKey(started.id, generation)
            jobs[id] = Job(id: id, engineId: started.id, generation: generation, kind: started.kind, params: started.params,
                           title: jobTitle(kind: started.kind, params: started.params))
        case .jobOutput(let id, let line):
            jobs[jobKey(id, generation)]?.add(line: line)
        case .jobProgress(let id, let event):
            let key = jobKey(id, generation)
            if event["kind"]?.string == "qr" {
                jobs[key]?.qrPath = event["path"]?.string
                jobs[key]?.qrExpires = event["expires"]?.double.map { Date(timeIntervalSince1970: $0) }
            } else {
                jobs[key]?.progress = event
            }
        case .jobFinished(let finished):
            let key = jobKey(finished.id, generation)
            jobs[key]?.status = switch finished.status {
            case "succeeded": .succeeded
            case "cancelled": .cancelled
            default: .failed
            }
            jobs[key]?.finished = Date()
            jobs[key]?.message = finished.message
            refreshStatus()
        case .unknown:
            break
        }
    }

    private func jobKey(_ id: Int, _ generation: Int) -> Int { generation << 20 | id }

    /// A delta was missed. Deltas are ignored until the new snapshot lands, which the engine
    /// sends in order with them.
    private func resynchronize() {
        viewVersion = -1
        Task {
            guard let snapshot: ViewSnapshot = try? await call("view.snapshot") else { return }
            records = Records(snapshot: snapshot.records)
            viewVersion = snapshot.version
        }
    }

    // MARK: Talking to the engine

    func call<T: Decodable & Sendable>(_ method: String, _ params: JSONValue = [:], as type: T.Type = T.self) async throws -> T {
        guard let client else { throw EngineError.stopped }
        return try await client.call(method, params)
    }

    func call<T: Decodable & Sendable, P: Encodable & Sendable>(_ method: String, encoding params: P, as type: T.Type = T.self) async throws -> T {
        guard let client else { throw EngineError.stopped }
        return try await client.call(method, encoding: params)
    }

    func contactAssociations(uid: String) async throws -> ContactAssociations {
        guard isReady, let client else { throw EngineError.stopped }
        return try await client.contactAssociations(uid: uid)
    }

    func splitContact(_ request: ContactSplitRequest) async throws -> ContactSplitReply {
        guard isReady, let client else { throw EngineError.stopped }
        return try await client.splitContact(request)
    }

    /// Runs an action whose failure belongs in a notice rather than on a particular form.
    func perform(_ action: @escaping @MainActor () async throws -> Void) {
        Task {
            do {
                try await action()
            } catch {
                show(error.localizedDescription, isError: true)
            }
        }
    }

    func edit(_ kind: String, _ payload: JSONValue) {
        perform { [self] in
            let _: EditReply = try await call("edit.apply", ["kind": .string(kind), "payload": payload])
        }
    }

    /// Starts a job and returns its id, which the caller can follow. The job is already in `jobs`
    /// on return, because the engine announces it before answering.
    @discardableResult
    func startJob(_ kind: String, _ params: JSONValue = [:]) async -> Int? {
        do {
            let started: StartedJob = try await call("job.start", ["kind": .string(kind), "params": params])
            return jobKey(started.id, generation)
        } catch {
            show(error.localizedDescription, isError: true)
            return nil
        }
    }

    func cancel(_ job: Job) {
        guard job.generation == generation else { return }
        perform { [self] in
            let _: NoReply = try await call("job.cancel", ["id": .int(job.engineId)])
        }
    }

    func answer(_ job: Job, text: String = "") {
        guard job.generation == generation else { return }
        perform { [self] in
            let _: NoReply = try await call("job.input", ["id": .int(job.engineId), "text": .string(text)])
        }
    }

    func latestJob(_ kinds: String...) -> Job? {
        jobs.values.filter { kinds.contains($0.kind) }.max { $0.id < $1.id }
    }

    var runningJobs: Int { jobs.values.filter(\.isRunning).count }

    func refreshView() {
        perform { [self] in
            let _: NoReply = try await call("view.refresh")
        }
    }

    func refreshStatus() {
        Task {
            if let status: SystemStatus = try? await call("system.status") { self.status = status }
        }
    }

    // MARK: Interface

    func show(_ text: String, isError: Bool = false) {
        notice = Notice(text: text, isError: isError)
        noticeTask?.cancel()
        noticeTask = Task {
            try? await Task.sleep(for: .seconds(isError ? 8 : 4))
            if !Task.isCancelled { notice = nil }
        }
    }

    func go(_ screen: Screen) { self.screen = screen }

    func newContact() {
        creatingContact = true
    }

    func focusSearch() {
        screen = .people
        searchFocusRequest += 1
    }

    func open(_ id: Int) {
        guard let person = records.people[id] else { return }
        paths[screen, default: []].append(PersonRoute(id: id, uid: person.contactUid))
    }

    /// Split replies carry the new identity; do not depend on a list selection or name lookup.
    func openSplitContact(_ reply: ContactSplitReply) {
        if screen == .people {
            selectedPeople = [reply.personId]
        } else {
            paths[screen, default: []].append(PersonRoute(id: reply.personId, uid: reply.contactUid))
        }
        show("Created a separate contact. Only the selected associations were moved.")
    }

    func setBackend(_ backend: String) {
        perform { [self] in
            let _: NoReply = try await call("settings.llm", ["backend": .string(backend)])
            UserDefaults.standard.set(backend, forKey: "llmBackend")
            refreshStatus()
        }
    }

    func name(_ id: Int) -> String { records.people[id]?.name ?? "Person #\(id)" }

    private func jobTitle(kind: String, params: JSONValue) -> String {
        switch kind {
        case "import":
            let names = ["imessage": "iMessage", "whatsapp": "WhatsApp", "vcf": "vCard file", "gvoice": "Google Voice", "mbox": "mbox",
                         "linkedin": "LinkedIn", "google": "Google Contacts"]
            let source = params["source"]?.string ?? ""
            return "Import \(names[source] ?? source.prefix(1).uppercased() + source.dropFirst())"
        case "ask": return "Ask"
        case "google_login": return "Google sign-in"
        case "google_sync": return params["apply"]?.bool == true ? "Google sync" : "Google preview"
        case "transfer_qr": return "Phone pairing"
        case "transfer_export": return "Export memory file"
        case "transfer_import": return "Import phone edits"
        case "transfer_merge": return "Merge memory file"
        case "recover_phones": return params["apply"]?.bool == true ? "Recover phone numbers" : "Preview phone recovery"
        case "signal_export": return "Export Signal"
        default: return kind
        }
    }
}
