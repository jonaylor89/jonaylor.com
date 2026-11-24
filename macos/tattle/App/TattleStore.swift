import Foundation
import Observation
import TattleShared
import os

/// The app's view of the extension: everything the windows show, loaded over XPC.
@MainActor
@Observable
final class TattleStore {
    private(set) var status: ServiceStatus?
    private(set) var connections: [ConnectionRecord] = []
    private(set) var rules: [Rule] = []
    private(set) var profiles: [Profile] = []
    private(set) var blocklists: [Blocklist] = []
    private(set) var reviewItems: [ReviewItem] = []
    private(set) var traffic: TrafficReport?
    /// The last failure, shown in a banner until the next success.
    var lastError: String?
    /// Whether the extension answered the last request.
    private(set) var reachable = false
    /// Recent download/upload rates, oldest first, for the menu bar graph.
    private(set) var rates: [RateSample] = []
    /// The section the main window shows; the menu bar sets it before opening the window.
    var section: AppSection? = .connections

    var connectionSearch = "" {
        didSet { if connectionSearch != oldValue { Task { await reloadConnections() } } }
    }

    let alerts = AlertCenter()
    let countryData = CountryData()
    private let client: TattleXPCClient?
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Tattle", category: "store")
    private var pollTask: Task<Void, Never>?
    private var liveViewers = 0
    private var lastActivity: (time: Date, totals: ActivityTotals)?
    static let rateInterval: TimeInterval = 2
    static let rateSamples = 60
    private static let maxConnections = 2000

    init() {
        guard let info = ExtensionInfo.embedded(in: .main) else {
            client = nil
            return
        }
        let alerts = alerts
        // The extension must be signed by our own team.
        let teamID = CodeIdentity.current()?.teamID
        client = TattleXPCClient(
            extensionInfo: info, teamID: teamID, alertHandler: alerts,
            onReconnect: { client in Task { _ = try? await client.send(.registerForAlerts) } }
        )
    }

    // MARK: Requests

    /// Sends a request; failures land in `lastError` and return nil.
    @discardableResult
    func send(_ request: ServiceRequest) async -> ServiceResponse? {
        guard let client else {
            lastError = "This build of Tattle has no filter extension."
            return nil
        }
        do {
            let response = try await client.send(request)
            reachable = true
            if case .failure(let message) = response {
                lastError = message
                return nil
            }
            lastError = nil
            return response
        } catch {
            reachable = false
            return nil
        }
    }

    /// Polls connections every second while the window or the menu is open. Calls nest:
    /// each `startPolling` needs a matching `stopPolling`.
    func startPolling() {
        liveViewers += 1
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            await self?.send(.registerForAlerts)
            await self?.reloadAll()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self else { return }
                await self.pollConnections()
            }
        }
    }

    func stopPolling() {
        liveViewers = max(liveViewers - 1, 0)
        guard liveViewers == 0 else { return }
        pollTask?.cancel()
        pollTask = nil
    }

    /// Runs for the app's lifetime: samples status for the traffic graph and keeps the
    /// alert channel registered.
    func runInBackground() {
        Task {
            var tick = 0
            while true {
                await reloadStatus()
                if tick % 5 == 0, reachable, status?.alertClientConnected != true {
                    await send(.registerForAlerts)
                }
                tick += 1
                try? await Task.sleep(for: .seconds(Self.rateInterval))
            }
        }
    }

    func reloadAll() async {
        await reloadStatus()
        await reloadConnections()
        await reloadRules()
        await reloadProfiles()
        await reloadBlocklists()
        await reloadReview()
    }

    func reloadStatus() async {
        guard case .status(let status) = await send(.status) else { return }
        self.status = status
        if let totals = status.activity { sampleRate(totals) }
    }

    private func sampleRate(_ totals: ActivityTotals) {
        let now = Date()
        defer { lastActivity = (now, totals) }
        // A restarted extension starts counting from zero again.
        guard let last = lastActivity, totals.bytesIn >= last.totals.bytesIn, totals.bytesOut >= last.totals.bytesOut else { return }
        let seconds = now.timeIntervalSince(last.time)
        guard seconds > 0.2 else { return }
        rates.append(RateSample(
            time: now,
            down: Double(totals.bytesIn - last.totals.bytesIn) / seconds,
            up: Double(totals.bytesOut - last.totals.bytesOut) / seconds
        ))
        if rates.count > Self.rateSamples { rates.removeFirst(rates.count - Self.rateSamples) }
    }

    func reloadConnections() async {
        let query = ConnectionQuery(search: connectionSearch.isEmpty ? nil : connectionSearch, limit: Self.maxConnections)
        if case .connections(let records) = await send(.connections(query)) { connections = records }
    }

    /// Fetches only connections newer than the newest shown.
    private func pollConnections() async {
        guard connectionSearch.isEmpty else { return await reloadConnections() }
        let newest = connections.first?.id ?? 0
        guard case .connections(let fresh) = await send(.connections(ConnectionQuery(afterID: newest, limit: 1000))), !fresh.isEmpty else { return }
        connections = Array((fresh.reversed() + connections).prefix(Self.maxConnections))
    }

    func reloadRules() async {
        if case .rules(let rules) = await send(.rules) { self.rules = rules }
    }

    func reloadProfiles() async {
        if case .profiles(let profiles) = await send(.profiles) { self.profiles = profiles }
    }

    func reloadBlocklists() async {
        if case .blocklists(let lists) = await send(.blocklists) { blocklists = lists }
    }

    func reloadReview() async {
        if case .reviewItems(let items) = await send(.reviewItems) { reviewItems = items }
    }

    func reloadTraffic(_ query: TrafficQuery) async {
        if case .traffic(let report) = await send(.traffic(query)) { traffic = report }
    }

    // MARK: Changes

    func save(_ rule: Rule) async -> Bool {
        let ok = await send(.saveRules([rule])) != nil
        await reloadRules()
        return ok
    }

    func delete(_ rules: [Rule]) async {
        await send(.deleteRules(rules.map(\.id)))
        await reloadRules()
    }

    func setEnabled(_ rule: Rule, _ enabled: Bool) async {
        var copy = rule
        copy.enabled = enabled
        _ = await save(copy)
    }

    func exportRules() async -> Data? {
        if case .document(let data) = await send(.exportRules) { return data }
        return nil
    }

    func importRules(_ data: Data, replace: Bool) async -> Int? {
        defer { Task { await reloadRules(); await reloadProfiles() } }
        if case .imported(let count) = await send(.importRules(document: data, replace: replace)) { return count }
        return nil
    }

    func update(_ change: (inout TattleShared.Settings) -> Void) async {
        guard var settings = status?.settings else { return }
        change(&settings)
        await send(.updateSettings(settings))
        await reloadStatus()
    }

    func save(_ profile: Profile) async -> Bool {
        let ok = await send(.saveProfile(profile)) != nil
        await reloadProfiles()
        return ok
    }

    func delete(_ profile: Profile) async {
        await send(.deleteProfile(profile.id))
        await reloadProfiles()
        await reloadRules()
        await reloadStatus()
    }

    func activate(_ profile: Profile?) async {
        await send(.activateProfile(profile?.id))
        await reloadStatus()
    }

    func save(_ list: Blocklist) async -> Bool {
        let ok = await send(.saveBlocklist(list)) != nil
        await reloadBlocklists()
        return ok
    }

    func delete(_ list: Blocklist) async {
        await send(.deleteBlocklist(list.id))
        await reloadBlocklists()
    }

    func refresh(_ list: Blocklist?) async {
        await send(.refreshBlocklists(list?.id))
        try? await Task.sleep(for: .seconds(2))
        await reloadBlocklists()
    }

    func markReviewed(_ item: ReviewItem?) async {
        await send(.markReviewed(path: item?.process.path, host: item?.host))
        await reloadReview()
    }

    /// Creates a permanent rule for a reviewed connection and marks it reviewed.
    func decide(_ item: ReviewItem, _ action: RuleAction) async {
        let remote: RemoteMatch = DomainName.normalize(item.host).map { .host($0) } ?? IPAddress(item.host).map { .ip($0) } ?? .any
        let rule = Rule(process: ProcessMatch(identity: item.process), remote: remote, action: action)
        if await save(rule) { await markReviewed(item) }
    }

    func eraseHistory() async {
        await send(.eraseHistory)
        connections = []
        await reloadReview()
    }

    func networkChanged(_ context: NetworkContext) async {
        await send(.networkChanged(context))
        await reloadStatus()
    }

    // MARK: Lookups

    func profileName(_ id: UUID?) -> String {
        guard let id else { return "All profiles" }
        return profiles.first { $0.id == id }?.name ?? "Unknown profile"
    }

    func sourceName(for record: ConnectionRecord) -> String? {
        guard let id = record.sourceID else { return nil }
        if record.reason == .blocklist { return blocklists.first { $0.id == id }?.name }
        return rules.first { $0.id == id }.map(RuleText.summary)
    }
}

struct RateSample: Identifiable, Sendable {
    let time: Date
    /// Bytes per second.
    let down: Double
    let up: Double
    var id: Date { time }
}

/// The main window's sections.
enum AppSection: String, CaseIterable, Identifiable {
    case connections = "Connections", review = "Review", rules = "Rules", profiles = "Profiles"
    case blocklists = "Blocklists", traffic = "Traffic", setup = "Setup", settings = "Settings"
    var id: Self { self }
    var icon: String {
        switch self {
        case .connections: "network"
        case .review: "tray"
        case .rules: "list.bullet.rectangle"
        case .profiles: "person.2.badge.gearshape"
        case .blocklists: "nosign"
        case .traffic: "chart.bar.xaxis"
        case .setup: "eye"
        case .settings: "gearshape"
        }
    }
}
