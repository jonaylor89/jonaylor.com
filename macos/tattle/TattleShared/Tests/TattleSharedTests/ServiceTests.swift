import Foundation
import os
import Testing

@testable import TattleShared

/// A presenter that records alerts and lets the test answer them.
final class FakePresenter: AlertPresenting, @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock()
    private var replies: [(AlertRequest, @Sendable (AlertAnswer?) -> Void)] = []

    func present(_ alert: AlertRequest, reply: @escaping @Sendable (AlertAnswer?) -> Void) {
        lock.withLock { replies.append((alert, reply)) }
    }

    var shown: [AlertRequest] { lock.withLock { replies.map(\.0) } }

    func answer(_ index: Int = 0, _ answer: AlertAnswer?) {
        let reply = lock.withLock { replies[index].1 }
        reply(answer)
    }
}

final class Box<T: Sendable>: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock()
    private var values: [T] = []
    func append(_ value: T) { lock.withLock { values.append(value) } }
    var all: [T] { lock.withLock { values } }
}

func makeService(
    fetch: @escaping @Sendable (URL) async throws -> Data = { _ in Data() }, now: Date = Date()
) throws -> (FilterService, TattleDatabase) {
    let database = try TattleDatabase()
    let service = FilterService(database: database, configuration: .init(
        version: "test", bootSession: "boot-1", tattleSigningID: "dev.example.Tattle", tattleTeamID: "TEAM",
        fetchBlocklist: fetch, now: { now }, flushInterval: 3600, maxPendingAlerts: 2, maxWaitingFlows: 4
    ))
    service.start()
    return (service, database)
}

extension FilterService {
    /// Requests an alert the way the extension does: an immediate decision goes straight to
    /// the completion, as the filter would apply it without pausing.
    func ask(_ flow: FlowInfo, into box: Box<Decision>) {
        if let decision = requestAlert(flowID: UUID(), flow: flow, completion: { box.append($0) }) {
            box.append(decision)
        }
    }

    /// Lets queued alert presentation and answers run.
    func settle() {
        Thread.sleep(forTimeInterval: 0.05)
    }

    func send(_ request: ServiceRequest, as caller: Caller = .app) -> ServiceResponse { handle(request, caller: caller) }

    func rulesList() -> [Rule] {
        guard case .rules(let rules) = send(.rules) else { return [] }
        return rules
    }
}

struct ServiceTests {
    @Test func seedsSystemRulesOnceAndExpiresTemporaryRules() throws {
        let database = try TattleDatabase()
        try database.saveRules([
            Rule(action: .deny, lifetime: .untilQuit, boundProcess: ProcessInstance(pid: 1, pidVersion: 1)),
            Rule(action: .deny, lifetime: .untilRestart, bootSession: "old-boot"),
            Rule(action: .deny, lifetime: .untilRestart, bootSession: "boot-1"),
        ])
        let config = FilterService.Configuration(version: "t", bootSession: "boot-1", fetchBlocklist: { _ in Data() })
        let service = FilterService(database: database, configuration: config)
        service.start()
        let rules = service.rulesList()
        #expect(rules.filter(\.isSystem).count == SystemRules.appleServices.count)
        #expect(rules.filter { !$0.isSystem }.map(\.bootSession) == ["boot-1"])

        // Deleting a system rule sticks: seeding happens once.
        let systemID = try #require(rules.first(where: \.isSystem)?.id)
        _ = service.send(.deleteRules([systemID]))
        service.stop()
        let restarted = FilterService(database: database, configuration: config)
        restarted.start()
        #expect(!restarted.rulesList().contains { $0.id == systemID })
    }

    @Test func modesAndLogging() throws {
        let (service, database) = try makeService()
        var settings = Settings()
        settings.mode = .silentDeny
        #expect(service.send(.updateSettings(settings)) == .ok)
        let f = flow(curl, host: "example.com")
        let decision = service.decide(f)
        #expect(decision == .deny(.silentDeny, sourceID: nil))
        let flowID = UUID()
        service.record(flowID: flowID, flow: f, decision: decision)
        service.flush()
        let records = try database.connections(ConnectionQuery())
        #expect(records.count == 1 && records[0].needsReview && records[0].action == .deny && records[0].remoteHost == "example.com")
        guard case .reviewItems(let items) = service.send(.reviewItems) else { Issue.record("no review items"); return }
        #expect(items.count == 1 && items[0].count == 1 && items[0].host == "example.com")
        #expect(service.send(.markReviewed(path: curl.path, host: "example.com")) == .ok)
        guard case .reviewItems(let after) = service.send(.reviewItems) else { return }
        #expect(after.isEmpty)
        // Search
        guard case .connections(let found) = service.send(.connections(ConnectionQuery(search: "exam"))) else { return }
        #expect(found.count == 1)
        guard case .connections(let none) = service.send(.connections(ConnectionQuery(search: "100%_"))) else { return }
        #expect(none.isEmpty)
    }

    @Test func untilQuitRulesLastExactlyAsLongAsTheirProcess() throws {
        let alive = OSAllocatedUnfairLock<Set<Int32>>(initialState: [10, 12])
        let database = try TattleDatabase()
        func untilQuit(_ pid: Int32, boot: String) -> Rule {
            Rule(process: ProcessMatch(identity: curl), action: .allow, lifetime: .untilQuit,
                 boundProcess: ProcessInstance(pid: pid, pidVersion: 1), bootSession: boot)
        }
        let running = untilQuit(10, boot: "boot-1"), exited = untilQuit(11, boot: "boot-1"), oldBoot = untilQuit(10, boot: "boot-0")
        try database.saveRules([running, exited, oldBoot])

        let service = FilterService(database: database, configuration: .init(
            version: "test", bootSession: "boot-1", fetchBlocklist: { _ in Data() }, flushInterval: 3600,
            processExists: { pid in alive.withLock { $0.contains(pid) } }
        ))
        service.start()
        // A restart of the extension keeps rules for processes that are still running.
        #expect(Set(service.rulesList().filter { !$0.isSystem }.map(\.id)) == [running.id])

        alive.withLock { $0.remove(10) }
        service.sweepUntilQuitRules()
        #expect(service.rulesList().filter { !$0.isSystem }.isEmpty)
        #expect(try database.rules().filter { !$0.isSystem }.isEmpty)
    }

    @Test func unlocatedProcessesKeepTheirNameInTheLog() throws {
        let (service, database) = try makeService()
        var settings = Settings()
        settings.mode = .silentAllow
        #expect(service.send(.updateSettings(settings)) == .ok)
        for name in ["tailscaled", "atuin"] {
            let f = flow(.unknown(name: name), host: "derp.example")
            service.record(flowID: UUID(), flow: f, decision: service.decide(f))
        }
        service.flush()
        let records = try database.connections(ConnectionQuery())
        #expect(Set(records.map(\.process.displayName)) == ["tailscaled", "atuin"])
        guard case .connections(let found) = service.send(.connections(ConnectionQuery(search: "tailsc"))) else { return }
        #expect(found.count == 1)
        // Two unidentified processes reaching one host stay separate in Review.
        guard case .reviewItems(let items) = service.send(.reviewItems) else { Issue.record("no review items"); return }
        #expect(items.count == 2 && Set(items.map(\.id)).count == 2)
    }

    @Test func alertAnswersCreateRulesAndReleaseGroupedFlows() throws {
        let (service, _) = try makeService()
        let presenter = FakePresenter()
        #expect(service.handle(.registerForAlerts, caller: .app, presenter: presenter) == .ok)
        let decisions = Box<Decision>()
        let f = flow(curl, host: "api.example.com", port: 443)
        #expect(service.decide(f) == .ask)
        service.ask(f, into: decisions)
        service.ask(f, into: decisions)  // same app+host+port: grouped
        service.settle()
        #expect(presenter.shown.count == 1 && service.pendingAlertCount == 1)
        #expect(presenter.shown[0].displayHost == "api.example.com" && presenter.shown[0].timeout == 30)

        presenter.answer(0, AlertAnswer(action: .deny, lifetime: .forever, anyPort: true))
        service.settle()
        #expect(decisions.all.count == 2 && decisions.all.allSatisfy { $0.action == .deny })
        let rule = try #require(service.rulesList().first { !$0.isSystem })
        #expect(rule.remote == .host("api.example.com") && rule.port == .any && rule.proto == .any && rule.process == ProcessMatch(identity: curl))
        // The rule now decides without asking, on any port.
        #expect(service.decide(flow(curl, host: "api.example.com", port: 80)) == .deny(.rule, sourceID: rule.id))
        // Answering twice is harmless.
        presenter.answer(0, AlertAnswer(action: .allow, lifetime: .forever))
        service.settle()
        #expect(decisions.all.count == 2)
    }

    @Test func onceUntilQuitAndAnyHostAnswers() throws {
        let (service, _) = try makeService()
        let presenter = FakePresenter()
        service.setAlertPresenter(presenter)
        let instance = ProcessInstance(pid: 50, pidVersion: 2)
        let decisions = Box<Decision>()
        service.ask(flow(curl, host: "once.example"), into: decisions)
        service.settle()
        presenter.answer(0, AlertAnswer(action: .allow, lifetime: .once))
        service.settle()
        #expect(decisions.all == [.allow(.alert, sourceID: nil)])
        #expect(service.rulesList().allSatisfy { $0.isSystem })

        service.ask(flow(curl, host: nil, ip: "5.6.7.8", instance: instance), into: decisions)
        service.settle()
        presenter.answer(1, AlertAnswer(action: .allow, lifetime: .untilQuit, anyHost: true))
        service.settle()
        let rule = try #require(service.rulesList().first { !$0.isSystem })
        #expect(rule.remote == .any && rule.boundProcess == instance && rule.lifetime == .untilQuit)
        #expect(service.decide(flow(curl, host: "x.example", instance: instance)).action == .allow)
        #expect(service.decide(flow(curl, host: "x.example", instance: ProcessInstance(pid: 50, pidVersion: 3))) == .ask)

        // Until quit without a known process degrades to until restart.
        let unbound = try #require(service.makeRule(from: AlertAnswer(action: .deny, lifetime: .untilQuit), flow: flow(curl, host: nil, ip: "5.6.7.8")))
        #expect(unbound.lifetime == .untilRestart && unbound.bootSession == "boot-1" && unbound.remote == .ip(IPAddress("5.6.7.8")!))
    }

    @Test func unlocatedProcessesOnlyGetRulesForTheirOwnRun() throws {
        let (service, _) = try makeService()
        let ghost = ProcessIdentity.unknown(name: "tailscaled")
        #expect(ghost.displayName == "tailscaled" && !ghost.isLocated)
        let instance = ProcessInstance(pid: 558, pidVersion: 9)

        // "Forever" becomes "until it quits", bound to this process, never "any unknown".
        let rule = try #require(service.makeRule(
            from: AlertAnswer(action: .allow, lifetime: .forever), flow: flow(ghost, host: "derp.example", instance: instance)
        ))
        #expect(rule.lifetime == .untilQuit && rule.boundProcess == instance && rule.process == .any)
        let index = RuleIndex(rules: [rule])
        #expect(index.bestMatch(for: flow(ghost, host: "derp.example", instance: instance))?.id == rule.id)
        let other = ProcessIdentity.unknown(name: "something-else")
        #expect(index.bestMatch(for: flow(other, host: "derp.example", instance: ProcessInstance(pid: 9, pidVersion: 1))) == nil)

        // Without a process instance there's nothing safe to bind to: no rule at all.
        #expect(service.makeRule(from: AlertAnswer(action: .allow, lifetime: .forever), flow: flow(ghost, host: "derp.example")) == nil)

        // A located but unverifiable process is matched by path, like an unsigned one.
        let located = ProcessIdentity.unknown(path: "/opt/tool")
        let pathRule = try #require(service.makeRule(from: AlertAnswer(action: .allow, lifetime: .forever), flow: flow(located)))
        #expect(pathRule.lifetime == .forever && pathRule.process == ProcessMatch(path: "/opt/tool"))
    }

    @Test func failSafeWithoutUITimeoutsDisconnectAndOverflow() throws {
        let (service, database) = try makeService()
        let decisions = Box<Decision>()
        // No app connected: default policy (allow) immediately.
        service.ask(flow(curl, host: "a.example"), into: decisions)
        #expect(decisions.all == [.allow(.defaultPolicy, sourceID: nil)])

        var settings = Settings()
        settings.defaultPolicy = .deny
        _ = service.send(.updateSettings(settings))
        let presenter = FakePresenter()
        service.setAlertPresenter(presenter)
        service.ask(flow(curl, host: "b.example"), into: decisions)
        service.ask(flow(curl, host: "c.example"), into: decisions)
        // maxPendingAlerts is 2: a third distinct alert overflows to the default policy.
        service.ask(flow(curl, host: "d.example"), into: decisions)
        #expect(decisions.all.last == .deny(.overflow, sourceID: nil))
        // maxWaitingFlows is 4: the 5th waiting flow overflows.
        service.ask(flow(curl, host: "b.example"), into: decisions)
        service.ask(flow(curl, host: "b.example"), into: decisions)
        service.ask(flow(curl, host: "b.example"), into: decisions)
        #expect(decisions.all.last == .deny(.overflow, sourceID: nil))

        // The app disconnects: everything pending gets the default policy now.
        service.removeAlertPresenter(FakePresenter())  // a different presenter changes nothing
        #expect(service.pendingAlertCount == 2)
        service.removeAlertPresenter(presenter)
        #expect(service.pendingAlertCount == 0)
        // 3 decided earlier (no UI, two overflows) + 4 released: b.example's three, c.example's one.
        #expect(decisions.all.count == 7)
        #expect(decisions.all.suffix(4).allSatisfy { $0 == .deny(.defaultPolicy, sourceID: nil) })
        service.flush()
        #expect(try database.connections(ConnectionQuery()).count == 7)
    }

    @Test func alertsTimeOut() async throws {
        let (service, _) = try makeService()
        var settings = Settings()
        settings.alertTimeout = 5
        _ = service.send(.updateSettings(settings))
        service.setAlertPresenter(FakePresenter())
        let decisions = Box<Decision>()
        service.ask(flow(curl), into: decisions)
        #expect(decisions.all.isEmpty)
        for _ in 0..<80 where decisions.all.isEmpty { try await Task.sleep(for: .milliseconds(100)) }
        #expect(decisions.all == [.allow(.defaultPolicy, sourceID: nil)])
    }

    @Test func cliPermissions() throws {
        let (service, _) = try makeService()
        #expect(service.send(.deleteRules([]), as: .cli(isRoot: false)) == .failure("This command changes the firewall. Run it with sudo."))
        #expect(service.send(.deleteRules([]), as: .cli(isRoot: true)) == .ok)
        #expect(service.send(.registerForAlerts, as: .cli(isRoot: true)) == .failure("Permission denied."))
        #expect(service.handle(.registerForAlerts, caller: .app, presenter: nil) == .failure("This connection can't show alerts."))
        guard case .status(let status) = service.send(.status, as: .cli(isRoot: false)) else { Issue.record("no status"); return }
        #expect(status.version == "test" && status.ruleCount == SystemRules.makeRules(tattleSigningIDPrefix: "a", tattleTeamID: "b").count)
    }

    @Test func rulesEditingValidationAndImportExport() throws {
        let (service, _) = try makeService()
        #expect(service.send(.saveRules([Rule(remote: .host("bad host"), action: .deny)])) == .failure("“bad host” isn't a valid host name."))
        #expect(service.send(.saveRules([Rule(action: .deny, profileID: UUID())])) == .failure("The rule refers to a profile that doesn't exist."))
        guard case .rules(let saved) = service.send(.saveRules([Rule(remote: .domain("Ads.Example"), action: .deny)])) else { Issue.record("save failed"); return }
        #expect(saved[0].remote == .domain("ads.example"))
        #expect(service.decide(flow(curl, host: "x.ads.example")) == .deny(.rule, sourceID: saved[0].id))

        guard case .document(let exported) = service.send(.exportRules) else { Issue.record("export failed"); return }
        #expect(service.send(.deleteRules([saved[0].id])) == .ok)
        #expect(service.decide(flow(curl, host: "x.ads.example")) == .ask)
        let exportedCount = service.rulesList().count + 1  // system rules + the deleted one
        #expect(service.send(.importRules(document: exported, replace: false)) == .imported(count: exportedCount))
        #expect(service.decide(flow(curl, host: "x.ads.example")).action == .deny)

        // Replace keeps system rules and drops other user rules.
        _ = service.send(.saveRules([Rule(remote: .domain("other.example"), action: .deny)]))
        let onlyOne = try RuleDocument(rules: [Rule(remote: .host("keep.example"), action: .deny)], profiles: []).encoded()
        #expect(service.send(.importRules(document: onlyOne, replace: true)) == .imported(count: 1))
        let after = service.rulesList()
        #expect(after.filter { !$0.isSystem }.map(\.remote) == [.host("keep.example")])
        #expect(after.contains { $0.isSystem })
        #expect(service.send(.importRules(document: Data("nope".utf8), replace: false)) == .failure("This isn't a Tattle rules file."))
    }

    @Test func profilesSwitchManuallyAndAutomatically() throws {
        let (service, database) = try makeService()
        let work = Profile(name: "Work", ssids: ["Corp"])
        guard case .profiles = service.send(.saveProfile(work)) else { Issue.record("profile save failed"); return }
        #expect(service.send(.saveProfile(Profile(name: "  "))) == .failure("Profile names must be 1 to 100 characters."))
        _ = service.send(.saveRules([Rule(remote: .domain("social.example"), action: .deny, profileID: work.id)]))
        #expect(service.decide(flow(curl, host: "social.example")) == .ask)

        _ = service.send(.networkChanged(NetworkContext(ssid: "Corp", interfaces: ["en0"])))
        #expect(service.decide(flow(curl, host: "social.example")).action == .deny)
        guard case .status(let status) = service.send(.status) else { return }
        #expect(status.activeProfileName == "Work" && status.network.ssid == "Corp")

        _ = service.send(.networkChanged(NetworkContext(ssid: "Home")))
        #expect(service.decide(flow(curl, host: "social.example")) == .ask)
        #expect(service.send(.activateProfile(work.id)) == .ok)
        #expect(service.decide(flow(curl, host: "social.example")).action == .deny)
        #expect(service.send(.activateProfile(UUID())) == .failure("There's no such profile."))

        var settings = try database.settings()
        settings.automaticProfiles = false
        settings.activeProfileID = nil
        _ = service.send(.updateSettings(settings))
        service.interfacesChanged(["utun9"])
        _ = service.send(.networkChanged(NetworkContext(ssid: "Corp")))
        #expect(service.decide(flow(curl, host: "social.example")) == .ask)

        #expect(service.send(.deleteProfile(work.id)) == .ok)
        #expect(!service.rulesList().contains { $0.profileID == work.id })
    }

    @Test func blocklistsRefreshCountHitsAndYieldToUserRules() async throws {
        let (service, database) = try makeService(fetch: { url in
            if url.host() == "fail.example" { throw URLError(.cannotFindHost) }
            return Data("0.0.0.0 ads.example\n0.0.0.0 track.example\n".utf8)
        })
        let list = Blocklist(name: "Ads", url: "https://lists.example/hosts")
        guard case .blocklists = service.send(.saveBlocklist(list)) else { Issue.record("list save failed"); return }
        for _ in 0..<50 {
            service.drain()
            if service.decide(flow(curl, host: "x.ads.example")).reason == .blocklist { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let decision = service.decide(flow(curl, host: "x.ads.example"))
        #expect(decision == .deny(.blocklist, sourceID: list.id))
        service.record(flowID: UUID(), flow: flow(curl, host: "x.ads.example"), decision: decision)
        service.flush()
        guard case .blocklists(let lists) = service.send(.blocklists) else { return }
        #expect(lists[0].entryCount == 2 && lists[0].hitCount == 1 && lists[0].lastError == nil && lists[0].lastUpdated != nil)
        #expect(try database.blocklistContent(list.id) != nil)

        // A user rule beats the list.
        _ = service.send(.saveRules([Rule(process: ProcessMatch(identity: curl), remote: .host("x.ads.example"), action: .allow)]))
        #expect(service.decide(flow(curl, host: "x.ads.example")).reason == .rule)

        // Failures are reported; disabling removes the list's effect.
        let broken = Blocklist(name: "Broken", url: "https://fail.example/list")
        _ = service.send(.saveBlocklist(broken))
        for _ in 0..<50 {
            service.drain()
            if case .blocklists(let all) = service.send(.blocklists), all.last?.lastError != nil { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        guard case .blocklists(let withError) = service.send(.blocklists) else { return }
        #expect(withError.last?.lastError != nil)
        var disabled = list
        disabled.enabled = false
        _ = service.send(.saveBlocklist(disabled))
        #expect(service.decide(flow(safari, host: "ads.example")) == .ask)
        #expect(service.send(.deleteBlocklist(list.id)) == .ok)
        #expect(service.send(.saveBlocklist(Blocklist(name: "x", url: "ftp://nope"))) == .failure("Blocklists must be downloaded over HTTPS."))
    }

    @Test func trafficStatisticsAndRetention() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let (service, database) = try makeService(now: now)
        let id = UUID()
        let f = flow(curl, host: "dl.example")
        service.record(flowID: id, flow: f, decision: .allow(.rule, sourceID: nil))
        service.updateBytes(flowID: id, bytesIn: 1000, bytesOut: 100, closed: false)
        service.updateBytes(flowID: id, bytesIn: 1500, bytesOut: 100, closed: true)
        service.updateBytes(flowID: id, bytesIn: 9999, bytesOut: 9999, closed: false)  // after close: ignored
        guard case .traffic(let report) = service.send(.traffic(TrafficQuery(since: now.addingTimeInterval(-86400)))) else {
            Issue.record("no traffic"); return
        }
        #expect(report.apps.first?.key == "com.apple.curl" && report.apps.first?.bytesIn == 1500 && report.apps.first?.bytesOut == 100)
        #expect(report.apps.first?.flows == 1 && report.apps.first?.total == 1600)
        #expect(report.hosts.first?.name == "dl.example")
        #expect(report.series.count == 1 && report.series[0].bucket == Date(timeIntervalSince1970: TimeInterval(FilterService.hourBucket(now))))
        guard case .traffic(let filtered) = service.send(.traffic(TrafficQuery(since: now.addingTimeInterval(-86400), bucketHours: 24, appKey: "nope"))) else { return }
        #expect(filtered.series.isEmpty && filtered.hosts.isEmpty)
        let records = try database.connections(ConnectionQuery())
        #expect(records.first?.bytesIn == 1500)

        // Running totals for the menu bar: bytes since start, and verdict counts.
        service.record(flowID: UUID(), flow: f, decision: .deny(.rule, sourceID: nil))
        guard case .status(let status) = service.send(.status) else { Issue.record("no status"); return }
        #expect(status.activity == ActivityTotals(bytesIn: 1500, bytesOut: 100, allowed: 1, denied: 1))

        // Retention: data older than the setting goes.
        var settings = Settings()
        settings.connectionRetentionDays = 1
        settings.trafficRetentionDays = 1
        try database.prune(settings: settings, now: now.addingTimeInterval(3 * 86400))
        #expect(try database.connections(ConnectionQuery()).isEmpty)
        #expect(service.send(.eraseHistory) == .ok)
    }

    @Test func settingsAreClampedAndDNSValidated() throws {
        let (service, database) = try makeService()
        var settings = Settings()
        settings.alertTimeout = 1
        settings.connectionRetentionDays = 0
        settings.trafficRetentionDays = 10_000
        settings.activeProfileID = UUID()
        _ = service.send(.updateSettings(settings))
        let saved = try database.settings()
        #expect(saved.alertTimeout == 5 && saved.connectionRetentionDays == 1 && saved.trafficRetentionDays == 730 && saved.activeProfileID == nil)
        settings.dns.enabled = true
        settings.dns.resolverURL = "http://1.1.1.1/dns-query"
        #expect(service.send(.updateSettings(settings)) == .failure("The DNS resolver must be an https:// URL."))
        settings.dns.resolverURL = "https://1.1.1.1/dns-query"
        #expect(service.send(.updateSettings(settings)) == .ok)
        #expect(service.currentSettings.dns.enabled)
        service.dnsProxyRunning = true
        #expect(service.dnsProxyRunning)
    }
}
