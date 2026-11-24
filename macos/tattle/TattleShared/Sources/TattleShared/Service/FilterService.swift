import Foundation
import os

/// Shows alerts to the user. The extension implements this over XPC with the app.
public protocol AlertPresenting: AnyObject, Sendable {
    /// Calls `reply` exactly once, with nil if the alert couldn't be shown or answered.
    func present(_ alert: AlertRequest, reply: @escaping @Sendable (AlertAnswer?) -> Void)
}

/// Everything the filter extension does apart from talking to NetworkExtension and XPC.
///
/// Threading:
/// - `decide`, `record`, `requestAlert` and `updateBytes` are called on the filter's
///   threads. They only take short in-memory locks; they never touch the database or wait
///   for the user.
/// - Everything else (requests from the app, persistence, blocklist refreshes) runs on a
///   private serial queue. Database writes are batched and flushed from that queue.
public final class FilterService: @unchecked Sendable {
    public struct Configuration: Sendable {
        public var version: String
        /// Identifies this boot of the Mac (kern.bootsessionuuid).
        public var bootSession: String
        /// Signing identifier prefix and team of Tattle's own code, for the system rules.
        public var tattleSigningID: String?
        public var tattleTeamID: String?
        public var fetchBlocklist: @Sendable (URL) async throws -> Data
        public var now: @Sendable () -> Date
        public var flushInterval: TimeInterval
        public var maxPendingAlerts: Int
        public var maxWaitingFlows: Int
        /// Whether a process ID is in use, to expire until-quit rules. Injectable for tests.
        public var processExists: @Sendable (pid_t) -> Bool

        public init(
            version: String, bootSession: String, tattleSigningID: String? = nil, tattleTeamID: String? = nil,
            fetchBlocklist: @escaping @Sendable (URL) async throws -> Data,
            now: @escaping @Sendable () -> Date = { Date() }, flushInterval: TimeInterval = 1,
            maxPendingAlerts: Int = 64, maxWaitingFlows: Int = 1024,
            processExists: @escaping @Sendable (pid_t) -> Bool = CodeIdentity.processExists
        ) {
            self.processExists = processExists
            self.version = version
            self.bootSession = bootSession
            self.tattleSigningID = tattleSigningID
            self.tattleTeamID = tattleTeamID
            self.fetchBlocklist = fetchBlocklist
            self.now = now
            self.flushInterval = flushInterval
            self.maxPendingAlerts = maxPendingAlerts
            self.maxWaitingFlows = maxWaitingFlows
        }
    }

    public typealias Completion = @Sendable (Decision) -> Void

    private let database: TattleDatabase
    private let config: Configuration
    private let logger = Logger(subsystem: "Tattle", category: "service")
    public let hostnames = HostnameCache()

    /// Serial queue that owns the state below and all database access.
    private let queue = DispatchQueue(label: "Tattle.service")
    private let alertQueue = DispatchQueue(label: "Tattle.alerts")
    private var settings = Settings()
    private var rules: [Rule] = []
    private var profiles: [Profile] = []
    private var blocklists: [Blocklist] = []
    private var blocklistEntries: [UUID: BlocklistEntries] = [:]
    private var network = NetworkContext()
    private var refreshing: Set<UUID> = []
    private var timers: [DispatchSourceTimer] = []

    /// Read on every flow; replaced whole when anything changes.
    private let snapshot = OSAllocatedUnfairLock(initialState: Snapshot())
    private let buffer = OSAllocatedUnfairLock(initialState: LogBuffer())
    private let alerts = OSAllocatedUnfairLock(initialState: AlertState())
    private let dnsRunning = OSAllocatedUnfairLock(initialState: false)

    struct Snapshot {
        var engine = PolicyEngine()
        var settings = Settings()
        var profileID: UUID?
    }

    public init(database: TattleDatabase, configuration: Configuration) {
        self.database = database
        self.config = configuration
        queue.setSpecific(key: Self.queueKey, value: true)
    }

    // MARK: Lifecycle

    /// Loads state from the database and starts the periodic flush, prune and refresh timers.
    public func start() {
        queue.sync {
            do {
                settings = try database.settings().validated()
                profiles = try database.profiles()
                blocklists = try database.blocklists()
                for list in blocklists {
                    if let content = try database.blocklistContent(list.id) {
                        blocklistEntries[list.id] = BlocklistParser.parse(String(decoding: content, as: UTF8.self))
                    }
                }
                let removed = try database.removeStaleTemporaryRules(bootSession: config.bootSession, processExists: config.processExists)
                if removed > 0 { logger.info("Removed \(removed) expired temporary rules") }
                if try database.flag("systemRulesSeeded") != true {
                    try database.saveRules(SystemRules.makeRules(
                        tattleSigningIDPrefix: config.tattleSigningID, tattleTeamID: config.tattleTeamID, now: config.now()
                    ))
                    try database.setFlag("systemRulesSeeded", true)
                }
                rules = try database.rules()
                try database.prune(settings: settings, now: config.now())
            } catch {
                logger.error("Loading state failed: \(String(describing: error), privacy: .public)")
            }
            rebuild()
        }
        schedule(every: config.flushInterval) { [weak self] in self?.flush() }
        schedule(every: 3600) { [weak self] in self?.prune() }
        schedule(every: 60) { [weak self] in self?.expireUntilQuitRules() }
        schedule(every: 900, initialDelay: 30) { [weak self] in self?.refreshBlocklists(nil, force: false) }
    }

    public func stop() {
        queue.sync {
            timers.forEach { $0.cancel() }
            timers = []
        }
        failAllAlerts()
        flush()
    }

    private func schedule(every interval: TimeInterval, initialDelay: TimeInterval? = nil, _ body: @escaping @Sendable () -> Void) {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + (initialDelay ?? interval), repeating: interval, leeway: .milliseconds(200))
        timer.setEventHandler(handler: body)
        timer.resume()
        queue.async { self.timers.append(timer) }
    }

    /// Rebuilds the snapshot from the current state. Must run on `queue`.
    private func rebuild() {
        dispatchPrecondition(condition: .onQueue(queue))
        let profileID = effectiveProfileID()
        let lists = blocklists.filter(\.enabled).compactMap { list in blocklistEntries[list.id].map { (list.id, $0) } }
        let engine = PolicyEngine(
            rules: RuleIndex(rules: rules, profileID: profileID, bootSession: config.bootSession),
            blocklists: BlocklistSet(lists: lists),
            mode: settings.mode
        )
        let settings = self.settings
        snapshot.withLock { $0 = Snapshot(engine: engine, settings: settings, profileID: profileID) }
    }

    private func effectiveProfileID() -> UUID? {
        let known = Set(profiles.map(\.id))
        if settings.automaticProfiles, let automatic = ProfileSelector.select(from: profiles, network: network) {
            return automatic
        }
        return settings.activeProfileID.flatMap { known.contains($0) ? $0 : nil }
    }

    // MARK: Verdicts (filter threads)

    /// The verdict for a new flow, from memory only.
    public func decide(_ flow: FlowInfo) -> Decision {
        snapshot.withLock { $0.engine }.decide(flow)
    }

    public var currentSettings: Settings { snapshot.withLock { $0.settings } }

    public var dnsProxyRunning: Bool {
        get { dnsRunning.withLock { $0 } }
        set { dnsRunning.withLock { $0 = newValue } }
    }

    /// Records a decided flow in the connection log (buffered).
    public func record(flowID: UUID, flow: FlowInfo, decision: Decision, needsReview: Bool? = nil) {
        guard let action = decision.action, let reason = decision.reason else { return }
        let profileID = snapshot.withLock { $0.profileID }
        let review = needsReview ?? (reason == .silentAllow || reason == .silentDeny || reason == .defaultPolicy || reason == .overflow)
        let record = ConnectionRecord(
            flowID: flowID, time: config.now(), process: flow.process, pid: flow.processInstance?.pid,
            remoteAddress: flow.remoteAddress?.description, remoteHost: flow.hostnames.first,
            remotePort: flow.remotePort, proto: flow.proto, direction: flow.direction, action: action, reason: reason,
            sourceID: decision.sourceID, profileID: profileID, needsReview: review
        )
        let bucket = Self.hourBucket(config.now())
        buffer.withLock { buffer in
            buffer.append(record)
            if action == .allow { buffer.totals.allowed += 1 } else { buffer.totals.denied += 1 }
            if reason == .blocklist, let list = decision.sourceID { buffer.hits[list, default: 0] += 1 }
            buffer.addTraffic(
                key: TrafficKey(bucket: bucket, appKey: flow.process.appKey, host: flow.displayHost),
                appName: flow.process.displayName, bytesIn: 0, bytesOut: 0, flows: 1
            )
            if action == .allow {
                buffer.trackFlow(flowID, FlowMeta(appKey: flow.process.appKey, appName: flow.process.displayName, host: flow.displayHost))
            }
        }
    }

    /// Cumulative byte counts for an allowed flow, from the filter's statistics reports.
    public func updateBytes(flowID: UUID, bytesIn: Int64, bytesOut: Int64, closed: Bool) {
        let bucket = Self.hourBucket(config.now())
        buffer.withLock { buffer in
            guard var meta = buffer.flows[flowID] else { return }
            let deltaIn = max(bytesIn - meta.lastIn, 0)
            let deltaOut = max(bytesOut - meta.lastOut, 0)
            meta.lastIn = max(bytesIn, meta.lastIn)
            meta.lastOut = max(bytesOut, meta.lastOut)
            if deltaIn > 0 || deltaOut > 0 {
                buffer.totals.bytesIn += deltaIn
                buffer.totals.bytesOut += deltaOut
                buffer.addTraffic(
                    key: TrafficKey(bucket: bucket, appKey: meta.appKey, host: meta.host),
                    appName: meta.appName, bytesIn: deltaIn, bytesOut: deltaOut, flows: 0
                )
                buffer.bytes[flowID] = (meta.lastIn, meta.lastOut)
            }
            buffer.flows[flowID] = closed ? nil : meta
        }
    }

    static func hourBucket(_ date: Date) -> Int64 {
        Int64(date.timeIntervalSince1970 / 3600) * 3600
    }

    // MARK: Alerts

    /// Asks the user about a flow.
    ///
    /// Returns a decision right away when the flow can't wait (no app connected to answer,
    /// or too many alerts pending): the default policy. Otherwise returns nil and later calls
    /// `completion` exactly once with the user's answer or, on timeout or disconnect, the
    /// default policy. `completion` is never called before this method returns, so the
    /// caller can pause the flow first. Identical pending flows (same app, host, port and
    /// protocol) share one alert. Either way the flow is recorded in the log.
    public func requestAlert(flowID: UUID, flow: FlowInfo, completion: @escaping Completion) -> Decision? {
        let settings = currentSettings
        let key = "\(flow.process.appKey)|\(flow.displayHost)|\(flow.remotePort)|\(flow.proto.rawValue)"
        enum Outcome { case wait, present(AlertPresenting, AlertRequest), fallback(VerdictReason) }

        let outcome: Outcome = alerts.withLock { state in
            guard let presenter = state.presenter else { return .fallback(.defaultPolicy) }
            if state.pending[key] != nil {
                guard state.waitingFlows < config.maxWaitingFlows else { return .fallback(.overflow) }
                state.pending[key]!.waiters.append(Waiter(flowID: flowID, flow: flow, completion: completion))
                state.waitingFlows += 1
                return .wait
            }
            guard state.pending.count < config.maxPendingAlerts, state.waitingFlows < config.maxWaitingFlows else {
                return .fallback(.overflow)
            }
            let request = AlertRequest(
                time: config.now(), process: flow.process, pid: flow.processInstance?.pid, remoteHost: flow.hostnames.first,
                remoteAddress: flow.remoteAddress?.description, remotePort: flow.remotePort, proto: flow.proto,
                timeout: settings.alertTimeout, defaultPolicy: settings.defaultPolicy
            )
            state.pending[key] = PendingAlert(id: request.id, flow: flow, waiters: [Waiter(flowID: flowID, flow: flow, completion: completion)])
            state.waitingFlows += 1
            return .present(presenter, request)
        }

        switch outcome {
        case .wait:
            return nil
        case .fallback(let reason):
            let decision = Decision.of(settings.defaultPolicy, reason)
            record(flowID: flowID, flow: flow, decision: decision, needsReview: true)
            return decision
        case .present(let presenter, let request):
            alertQueue.asyncAfter(deadline: .now() + settings.alertTimeout) { [weak self] in
                self?.resolveAlert(key: key, id: request.id, answer: nil)
            }
            // Present asynchronously so an immediate reply can't race the caller's pause.
            alertQueue.async { [weak self] in
                guard let self else { return }
                presenter.present(request) { [weak self] answer in
                    guard let self else { return }
                    self.alertQueue.async { self.resolveAlert(key: key, id: request.id, answer: answer) }
                }
            }
            return nil
        }
    }

    private func resolveAlert(key: String, id: UUID, answer: AlertAnswer?) {
        let pending: PendingAlert? = alerts.withLock { state in
            guard let pending = state.pending[key], pending.id == id else { return nil }
            state.pending[key] = nil
            state.waitingFlows -= pending.waiters.count
            return pending
        }
        guard let pending else { return }  // already answered or timed out

        let decision: Decision
        let needsReview: Bool
        if let answer {
            var ruleID: UUID?
            if answer.lifetime != .once, let rule = makeRule(from: answer, flow: pending.flow) {
                ruleID = rule.id
                // Synchronously, so flows released below and new flows see the rule.
                queue.sync {
                    do {
                        try database.saveRules([rule])
                        rules.append(rule)
                        rebuild()
                    } catch {
                        logger.error("Saving alert rule failed: \(String(describing: error), privacy: .public)")
                    }
                }
            }
            decision = .of(answer.action, .alert, sourceID: ruleID)
            needsReview = false
        } else {
            decision = .of(currentSettings.defaultPolicy, .defaultPolicy)
            needsReview = true
        }
        for waiter in pending.waiters {
            record(flowID: waiter.flowID, flow: waiter.flow, decision: decision, needsReview: needsReview)
            waiter.completion(decision)
        }
    }

    /// The rule an alert answer creates, or nil when it can only apply to this connection.
    ///
    /// A process whose executable can't be located has no identity to match later: a rule
    /// for "unknown" would match every unidentifiable process. Its rules are bound to the
    /// running process instead and end when it quits.
    func makeRule(from answer: AlertAnswer, flow: FlowInfo) -> Rule? {
        let located = flow.process.isSigned || flow.process.isLocated
        if !located, flow.processInstance == nil { return nil }
        var remote: RemoteMatch = .any
        if !answer.anyHost {
            if let host = flow.hostnames.first {
                remote = .host(host)
            } else if let address = flow.remoteAddress {
                remote = .ip(address)
            }
        }
        var lifetime = answer.lifetime
        var bound: ProcessInstance?
        if !located { lifetime = .untilQuit }
        if lifetime == .untilQuit {
            bound = flow.processInstance
            if bound == nil { lifetime = .untilRestart }
        }
        return Rule(
            process: located ? ProcessMatch(identity: flow.process) : .any,
            direction: .outbound,
            remote: remote,
            port: answer.anyPort ? .any : .single(flow.remotePort),
            proto: answer.anyPort ? .any : flow.proto,
            action: answer.action,
            lifetime: lifetime,
            created: config.now(),
            boundProcess: bound,
            bootSession: lifetime == .untilRestart || lifetime == .untilQuit ? config.bootSession : nil
        )
    }

    /// Makes `presenter` the one that answers alerts (the most recent app to register).
    public func setAlertPresenter(_ presenter: AlertPresenting) {
        alerts.withLock { $0.presenter = presenter }
    }

    /// Called when an app's connection goes away. Pending alerts it was showing fall back to
    /// the default policy right away rather than waiting for their timeout.
    public func removeAlertPresenter(_ presenter: AlertPresenting) {
        let removed = alerts.withLock { state in
            guard state.presenter === presenter else { return false }
            state.presenter = nil
            return true
        }
        if removed { failAllAlerts() }
    }

    private func failAllAlerts() {
        let pending = alerts.withLock { state in
            defer { state.pending = [:]; state.waitingFlows = 0 }
            return Array(state.pending.values)
        }
        let decision = Decision.of(currentSettings.defaultPolicy, .defaultPolicy)
        for alert in pending {
            for waiter in alert.waiters {
                record(flowID: waiter.flowID, flow: waiter.flow, decision: decision, needsReview: true)
                waiter.completion(decision)
            }
        }
    }

    public var pendingAlertCount: Int { alerts.withLock { $0.pending.count } }

    // MARK: Network

    /// Interfaces seen by the extension's own path monitor.
    public func interfacesChanged(_ interfaces: [String]) {
        queue.async {
            guard self.network.interfaces != interfaces else { return }
            self.network.interfaces = interfaces
            self.rebuild()
        }
    }

    // MARK: Persistence

    /// Writes buffered log entries, byte counts, traffic and blocklist hits.
    public func flush() {
        let batch = buffer.withLock { buffer in
            defer {
                buffer.records = []
                buffer.bytes = [:]
                buffer.traffic = [:]
                buffer.hits = [:]
            }
            return (buffer.records, buffer.bytes, buffer.traffic, buffer.hits)
        }
        guard !batch.0.isEmpty || !batch.1.isEmpty || !batch.2.isEmpty || !batch.3.isEmpty else { return }
        let work = {
            do {
                try self.database.writeConnections(batch.0, byteUpdates: batch.1.mapValues { (bytesIn: $0.0, bytesOut: $0.1) })
                try self.database.addTraffic(batch.2.map { key, value in
                    TattleDatabase.TrafficDelta(
                        bucket: key.bucket, appKey: key.appKey, appName: value.appName, host: key.host,
                        bytesIn: value.bytesIn, bytesOut: value.bytesOut, flows: value.flows
                    )
                })
                if !batch.3.isEmpty {
                    try self.database.addBlocklistHits(batch.3)
                    for index in self.blocklists.indices {
                        self.blocklists[index].hitCount += batch.3[self.blocklists[index].id] ?? 0
                    }
                }
            } catch {
                self.logger.error("Writing the connection log failed: \(String(describing: error), privacy: .public)")
            }
        }
        if DispatchQueue.getSpecific(key: Self.queueKey) != nil { work() } else { queue.sync(execute: work) }
    }

    private static let queueKey = DispatchSpecificKey<Bool>()

    /// Removes until-quit rules whose process has exited. A reused process ID can't keep a
    /// rule alive in a harmful way: the rule also matches the PID version, so it never
    /// applies to the new process, and it goes once that one exits.
    private func expireUntilQuitRules() {
        let expired = rules.filter { rule in
            rule.lifetime == .untilQuit && !(rule.boundProcess.map { config.processExists($0.pid) } ?? false)
        }
        guard !expired.isEmpty else { return }
        do {
            try database.deleteRules(expired.map(\.id))
            let ids = Set(expired.map(\.id))
            rules.removeAll { ids.contains($0.id) }
            rebuild()
        } catch {
            logger.error("Expiring until-quit rules failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// Runs the until-quit sweep now (tests).
    func sweepUntilQuitRules() { queue.sync { expireUntilQuitRules() } }

    private func prune() {
        do { try database.prune(settings: settings, now: config.now()) } catch {
            logger.error("Pruning failed: \(String(describing: error), privacy: .public)")
        }
    }

    // MARK: Blocklists

    /// Downloads due lists (or `id`, or every enabled list when `force`) in the background.
    public func refreshBlocklists(_ id: UUID?, force: Bool) {
        queue.async {
            let now = self.config.now()
            let targets = self.blocklists.filter { list in
                guard !self.refreshing.contains(list.id) else { return false }
                if let id { return list.id == id }
                return list.enabled && (force || list.isDue(at: now))
            }
            for list in targets {
                self.refreshing.insert(list.id)
                guard let url = URL(string: list.url) else { continue }
                let fetch = self.config.fetchBlocklist
                Task.detached {
                    let result: Result<(Data, BlocklistEntries), Error>
                    do {
                        let data = try await fetch(url)
                        result = .success((data, BlocklistParser.parse(String(decoding: data, as: UTF8.self))))
                    } catch {
                        result = .failure(error)
                    }
                    self.queue.async { self.finishRefresh(list.id, result) }
                }
            }
        }
    }

    private func finishRefresh(_ id: UUID, _ result: Result<(Data, BlocklistEntries), Error>) {
        refreshing.remove(id)
        guard let index = blocklists.firstIndex(where: { $0.id == id }) else { return }
        switch result {
        case .success(let (data, entries)):
            blocklistEntries[id] = entries
            blocklists[index].entryCount = entries.count
            blocklists[index].lastUpdated = config.now()
            blocklists[index].lastError = entries.count == 0 ? "The list has no entries Tattle can read." : nil
            try? database.saveBlocklistContent(id, content: data)
            rebuild()
        case .failure(let error):
            blocklists[index].lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        try? database.saveBlocklist(blocklists[index])
    }

    /// Waits until queued work (including started refreshes' completions) has run. Tests only.
    func drain() { queue.sync {} }

    // MARK: Requests

    /// Handles a request from the app or `tattlectl`. `presenter` is the caller's alert
    /// channel, used by `.registerForAlerts`.
    public func handle(_ request: ServiceRequest, caller: Caller, presenter: AlertPresenting? = nil) -> ServiceResponse {
        guard caller.may(send: request) else {
            if case .cli = caller, request.isPrivileged, !request.isAppOnly {
                return .failure("This command changes the firewall. Run it with sudo.")
            }
            return .failure("Permission denied.")
        }
        if case .registerForAlerts = request {
            guard let presenter else { return .failure("This connection can't show alerts.") }
            setAlertPresenter(presenter)
            return .ok
        }
        return queue.sync {
            do {
                return try perform(request)
            } catch let error as RuleValidationError {
                return .failure(error.description)
            } catch let error as RuleDocument.ImportError {
                return .failure(error.description)
            } catch {
                logger.error("Request failed: \(String(describing: error), privacy: .public)")
                return .failure("Tattle couldn't complete the request.")
            }
        }
    }

    private func perform(_ request: ServiceRequest) throws -> ServiceResponse {
        dispatchPrecondition(condition: .onQueue(queue))
        let now = config.now().storedPrecision
        switch request {
        case .status:
            let profileID = snapshot.withLock { $0.profileID }
            return .status(ServiceStatus(
                version: config.version, settings: settings,
                activeProfileName: profiles.first { $0.id == profileID }?.name,
                ruleCount: snapshot.withLock { $0.engine.rules.count },
                blocklistEntryCount: blocklists.filter(\.enabled).reduce(0) { $0 + (blocklistEntries[$1.id]?.count ?? 0) },
                pendingAlerts: pendingAlertCount,
                alertClientConnected: alerts.withLock { $0.presenter != nil },
                connectionsLogged: try database.connectionCount(),
                dnsProxyRunning: dnsProxyRunning,
                network: network,
                activity: buffer.withLock { $0.totals }
            ))

        case .connections(let query):
            return .connections(try database.connections(query))

        case .reviewItems:
            return .reviewItems(try database.reviewItems())

        case .markReviewed(let path, let host):
            try database.markReviewed(path: path, host: host)
            return .ok

        case .rules:
            return .rules(rules)

        case .saveRules(let incoming):
            guard incoming.count <= 10_000 else { throw RuleValidationError("Too many rules in one request.") }
            var saved: [Rule] = []
            for rule in incoming {
                var clean = try rule.validated()
                if let existing = rules.first(where: { $0.id == clean.id }) {
                    clean.created = existing.created
                    clean.isSystem = existing.isSystem
                } else {
                    clean.created = now
                }
                clean.modified = now
                if let profile = clean.profileID, !profiles.contains(where: { $0.id == profile }) {
                    throw RuleValidationError("The rule refers to a profile that doesn't exist.")
                }
                saved.append(clean)
            }
            try database.saveRules(saved)
            let ids = Set(saved.map(\.id))
            rules = rules.filter { !ids.contains($0.id) } + saved
            rebuild()
            return .rules(saved)

        case .deleteRules(let ids):
            try database.deleteRules(ids)
            let doomed = Set(ids)
            rules.removeAll { doomed.contains($0.id) }
            rebuild()
            return .ok

        case .exportRules:
            return .document(try RuleDocument(rules: rules, profiles: profiles, exported: now).encoded())

        case .importRules(let data, let replace):
            let document = try RuleDocument.decode(data)
            for profile in document.profiles { try database.saveProfile(profile) }
            profiles = try database.profiles()
            let known = Set(profiles.map(\.id))
            let imported = document.rules.map { rule -> Rule in
                var rule = rule
                if let profile = rule.profileID, !known.contains(profile) { rule.profileID = nil }
                return rule
            }
            if replace {
                // System rules stay, but imported system rules replace them by ID.
                try database.replaceUserRules(with: imported)
            } else {
                try database.saveRules(imported)
            }
            rules = try database.rules()
            rebuild()
            return .imported(count: imported.count)

        case .updateSettings(let incoming):
            var clean = incoming.validated()
            if let profile = clean.activeProfileID, !profiles.contains(where: { $0.id == profile }) {
                clean.activeProfileID = nil
            }
            if clean.dns.enabled, !clean.dns.isValidResolver {
                throw RuleValidationError("The DNS resolver must be an https:// URL.")
            }
            settings = clean
            try database.saveSettings(settings)
            rebuild()
            return .ok

        case .profiles:
            return .profiles(profiles)

        case .saveProfile(let profile):
            let clean = try profile.validated()
            try database.saveProfile(clean)
            profiles = try database.profiles()
            rebuild()
            return .profiles(profiles)

        case .deleteProfile(let id):
            try database.deleteProfile(id)
            profiles = try database.profiles()
            rules = try database.rules()
            if settings.activeProfileID == id {
                settings.activeProfileID = nil
                try database.saveSettings(settings)
            }
            rebuild()
            return .ok

        case .activateProfile(let id):
            if let id, !profiles.contains(where: { $0.id == id }) { throw RuleValidationError("There's no such profile.") }
            settings.activeProfileID = id
            try database.saveSettings(settings)
            rebuild()
            return .ok

        case .networkChanged(let context):
            guard (context.ssid?.utf8.count ?? 0) <= 64, context.interfaces.count <= 64 else {
                throw RuleValidationError("Invalid network description.")
            }
            network.ssid = context.ssid
            if !context.interfaces.isEmpty { network.interfaces = context.interfaces }
            rebuild()
            return .ok

        case .blocklists:
            return .blocklists(blocklists)

        case .saveBlocklist(let list):
            var clean = try list.validated()
            if let existing = blocklists.firstIndex(where: { $0.id == clean.id }) {
                // Statistics belong to the extension.
                clean.lastUpdated = blocklists[existing].lastUpdated
                clean.lastError = blocklists[existing].lastError
                clean.entryCount = blocklists[existing].entryCount
                clean.hitCount = blocklists[existing].hitCount
                let urlChanged = blocklists[existing].url != clean.url
                blocklists[existing] = clean
                if urlChanged {
                    blocklists[existing].lastUpdated = nil
                    blocklistEntries[clean.id] = nil
                }
            } else {
                guard blocklists.count < 100 else { throw RuleValidationError("You can subscribe to at most 100 lists.") }
                clean.lastUpdated = nil
                clean.lastError = nil
                clean.entryCount = 0
                clean.hitCount = 0
                blocklists.append(clean)
            }
            try database.saveBlocklist(clean)
            rebuild()
            if clean.enabled, blocklistEntries[clean.id] == nil { refreshBlocklists(clean.id, force: true) }
            return .blocklists(blocklists)

        case .deleteBlocklist(let id):
            try database.deleteBlocklist(id)
            blocklists.removeAll { $0.id == id }
            blocklistEntries[id] = nil
            rebuild()
            return .ok

        case .refreshBlocklists(let id):
            refreshBlocklists(id, force: true)
            return .ok

        case .traffic(let query):
            flush()
            return .traffic(try database.traffic(query))

        case .eraseHistory:
            buffer.withLock { $0 = LogBuffer() }
            try database.eraseHistory()
            return .ok

        case .registerForAlerts:
            return .ok  // handled in `handle`
        }
    }
}

// MARK: - Internal state

struct Waiter {
    let flowID: UUID
    let flow: FlowInfo
    let completion: FilterService.Completion
}

struct PendingAlert {
    let id: UUID
    let flow: FlowInfo
    var waiters: [Waiter]
}

struct AlertState {
    var presenter: AlertPresenting?
    var pending: [String: PendingAlert] = [:]
    var waitingFlows = 0
}

struct TrafficKey: Hashable {
    let bucket: Int64
    let appKey: String
    let host: String
}

struct TrafficValue {
    var appName: String
    var bytesIn: Int64
    var bytesOut: Int64
    var flows: Int64
}

struct FlowMeta {
    let appKey: String
    let appName: String
    let host: String
    var lastIn: Int64 = 0
    var lastOut: Int64 = 0
}

struct LogBuffer {
    static let maxRecords = 20_000
    static let maxTrackedFlows = 50_000

    var records: [ConnectionRecord] = []
    var bytes: [UUID: (Int64, Int64)] = [:]
    var traffic: [TrafficKey: TrafficValue] = [:]
    var hits: [UUID: Int] = [:]
    /// Allowed flows whose byte counts we're still following.
    var flows: [UUID: FlowMeta] = [:]
    /// Running totals since the extension started, for the menu bar's live view.
    var totals = ActivityTotals()

    mutating func append(_ record: ConnectionRecord) {
        // If the database falls behind, drop the oldest unwritten entries rather than grow.
        if records.count >= Self.maxRecords { records.removeFirst(records.count - Self.maxRecords + 1) }
        records.append(record)
    }

    mutating func addTraffic(key: TrafficKey, appName: String, bytesIn: Int64, bytesOut: Int64, flows: Int64) {
        traffic[key, default: TrafficValue(appName: appName, bytesIn: 0, bytesOut: 0, flows: 0)].bytesIn += bytesIn
        traffic[key]!.bytesOut += bytesOut
        traffic[key]!.flows += flows
    }

    mutating func trackFlow(_ id: UUID, _ meta: FlowMeta) {
        if flows.count >= Self.maxTrackedFlows, let victim = flows.keys.first { flows[victim] = nil }
        flows[id] = meta
    }
}
