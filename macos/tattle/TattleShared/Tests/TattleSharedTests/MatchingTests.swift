import Foundation
import Testing

@testable import TattleShared

let safari = ProcessIdentity(signingID: "com.apple.Safari", teamID: ProcessMatch.appleTeamID, path: "/Applications/Safari.app/Contents/MacOS/Safari", signature: .apple)
let curl = ProcessIdentity(signingID: "com.apple.curl", teamID: ProcessMatch.appleTeamID, path: "/usr/bin/curl", signature: .apple)
let unsignedTool = ProcessIdentity(signingID: nil, teamID: nil, path: "/tmp/tool", signature: .unsigned)

func flow(
    _ process: ProcessIdentity = safari, host: String? = "www.example.com", ip: String? = "93.184.216.34",
    port: UInt16 = 443, proto: TransportProtocol = .tcp, instance: ProcessInstance? = nil
) -> FlowInfo {
    FlowInfo(
        process: process, processInstance: instance, proto: proto,
        remoteAddress: ip.flatMap(IPAddress.init), remotePort: port, hostnames: host.map { [$0] } ?? []
    )
}

func date(_ seconds: TimeInterval) -> Date { Date(timeIntervalSince1970: 1_700_000_000 + seconds) }

struct PrecedenceTests {
    let app = ProcessMatch(identity: safari)

    @Test func denySpecificBeatsAllowSpecific() {
        let allow = Rule(process: app, remote: .domain("example.com"), action: .allow, created: date(10))
        let deny = Rule(process: .any, remote: .host("www.example.com"), action: .deny, created: date(0))
        #expect(RuleIndex(rules: [allow, deny]).bestMatch(for: flow())?.id == deny.id)
    }

    @Test func allowSpecificBeatsDenyGeneral() {
        let denyAll = Rule(process: app, remote: .any, action: .deny, created: date(10))
        let allowOne = Rule(process: app, remote: .domain("example.com"), action: .allow, created: date(0))
        #expect(RuleIndex(rules: [denyAll, allowOne]).bestMatch(for: flow())?.id == allowOne.id)
    }

    @Test func denyGeneralBeatsAllowGeneral() {
        let allowAll = Rule(process: .any, action: .allow, created: date(10))
        let denyApp = Rule(process: app, action: .deny, created: date(0))
        #expect(RuleIndex(rules: [allowAll, denyApp]).bestMatch(for: flow())?.id == denyApp.id)
    }

    @Test func tiesGoToTheNewestRule() {
        let older = Rule(process: app, remote: .domain("example.com"), action: .allow, created: date(0))
        let newer = Rule(process: .any, remote: .host("www.example.com"), action: .allow, created: date(5))
        #expect(RuleIndex(rules: [newer, older]).bestMatch(for: flow())?.id == newer.id)
        #expect(RuleIndex(rules: [older, newer]).bestMatch(for: flow())?.id == newer.id)
        // Modification time counts, not creation time.
        var edited = older
        edited.modified = date(20)
        #expect(RuleIndex(rules: [edited, newer]).bestMatch(for: flow())?.id == edited.id)
    }

    @Test func identicalTimestampsStillGiveAStableWinner() {
        let a = Rule(id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!, action: .allow, created: date(0))
        let b = Rule(id: UUID(uuidString: "00000000-0000-0000-0000-000000000002")!, action: .allow, created: date(0))
        #expect(RuleIndex(rules: [a, b]).bestMatch(for: flow())?.id == b.id)
        #expect(RuleIndex(rules: [b, a]).bestMatch(for: flow())?.id == b.id)
    }

    @Test func tierValues() {
        #expect(Rule(remote: .host("a.com"), action: .deny).tier == 3)
        #expect(Rule(remote: .host("a.com"), action: .allow).tier == 2)
        #expect(Rule(action: .deny).tier == 1)
        #expect(Rule(action: .allow).tier == 0)
    }

    @Test func noRulesNoMatch() {
        #expect(RuleIndex().bestMatch(for: flow()) == nil)
        #expect(RuleIndex().count == 0)
    }
}

struct RemoteMatchTests {
    @Test func domainRulesMatchSubdomainsButNotLookalikes() {
        let index = RuleIndex(rules: [Rule(remote: .domain("example.com"), action: .deny)])
        #expect(index.bestMatch(for: flow(host: "example.com")) != nil)
        #expect(index.bestMatch(for: flow(host: "a.b.example.com")) != nil)
        #expect(index.bestMatch(for: flow(host: "notexample.com")) == nil)
        #expect(index.bestMatch(for: flow(host: "example.com.evil.net")) == nil)
        #expect(index.bestMatch(for: flow(host: nil)) == nil)
    }

    @Test func hostRulesMatchOnlyThatHost() {
        let index = RuleIndex(rules: [Rule(remote: .host("example.com"), action: .deny)])
        #expect(index.bestMatch(for: flow(host: "EXAMPLE.com.")) != nil)
        #expect(index.bestMatch(for: flow(host: "www.example.com")) == nil)
    }

    @Test func anyOfTheFlowsHostNamesCanMatch() {
        let index = RuleIndex(rules: [Rule(remote: .domain("cdn.net"), action: .deny)])
        var f = flow(host: "www.example.com")
        f.hostnames.append("edge.cdn.net")
        #expect(index.bestMatch(for: f) != nil)
    }

    @Test func ipv4CIDR() throws {
        let network = try #require(IPNetwork("10.1.0.0/16"))
        let index = RuleIndex(rules: [Rule(remote: .network(network), action: .deny)])
        #expect(index.bestMatch(for: flow(host: nil, ip: "10.1.200.3")) != nil)
        #expect(index.bestMatch(for: flow(host: nil, ip: "10.2.0.1")) == nil)
        #expect(index.bestMatch(for: flow(host: nil, ip: "::ffff:10.1.0.9")) != nil)
        #expect(index.bestMatch(for: flow(host: nil, ip: nil)) == nil)
    }

    @Test func ipv6CIDRAndOddPrefixes() throws {
        let index = RuleIndex(rules: [
            Rule(remote: .network(try #require(IPNetwork("2001:db8::/33"))), action: .deny),
            Rule(remote: .network(try #require(IPNetwork("192.168.1.128/25"))), action: .deny),
        ])
        #expect(index.bestMatch(for: flow(host: nil, ip: "2001:db8:7fff::1")) != nil)
        #expect(index.bestMatch(for: flow(host: nil, ip: "2001:db8:8000::1")) == nil)
        #expect(index.bestMatch(for: flow(host: nil, ip: "192.168.1.200")) != nil)
        #expect(index.bestMatch(for: flow(host: nil, ip: "192.168.1.127")) == nil)
    }

    @Test func exactIPRule() throws {
        let index = RuleIndex(rules: [Rule(remote: .ip(try #require(IPAddress("1.2.3.4"))), action: .deny)])
        #expect(index.bestMatch(for: flow(host: nil, ip: "1.2.3.4")) != nil)
        #expect(index.bestMatch(for: flow(host: nil, ip: "1.2.3.5")) == nil)
    }

    @Test func zeroPrefixMatchesEverythingInTheFamily() throws {
        let index = RuleIndex(rules: [Rule(remote: .network(try #require(IPNetwork("0.0.0.0/0"))), action: .deny)])
        #expect(index.bestMatch(for: flow(host: nil, ip: "8.8.8.8")) != nil)
        #expect(index.bestMatch(for: flow(host: nil, ip: "2001:4860::8888")) == nil)
    }

    @Test func portsProtocolsAndDirection() {
        let index = RuleIndex(rules: [
            Rule(remote: .any, port: .range(8000, 8100), proto: .udp, action: .deny),
        ])
        #expect(index.bestMatch(for: flow(port: 8050, proto: .udp)) != nil)
        #expect(index.bestMatch(for: flow(port: 8050, proto: .tcp)) == nil)
        #expect(index.bestMatch(for: flow(port: 8101, proto: .udp)) == nil)
        var inbound = flow(port: 8050, proto: .udp)
        inbound.direction = .inbound
        #expect(index.bestMatch(for: inbound) == nil)
        #expect(PortMatch.single(53).contains(53) && !PortMatch.single(53).contains(54))
    }
}

struct ProcessMatchTests {
    @Test func signingIDNeedsAValidSignatureAndTeam() {
        let rule = Rule(process: ProcessMatch(signingID: "com.apple.Safari", teamID: ProcessMatch.appleTeamID), action: .deny)
        let index = RuleIndex(rules: [rule])
        #expect(index.bestMatch(for: flow(safari)) != nil)
        // Same signing ID claimed by an ad-hoc signature, or by another team, doesn't match.
        let impostor = ProcessIdentity(signingID: "com.apple.Safari", teamID: nil, path: "/tmp/Safari", signature: .adHoc)
        #expect(index.bestMatch(for: flow(impostor)) == nil)
        let otherTeam = ProcessIdentity(signingID: "com.apple.Safari", teamID: "ABCDE12345", path: "/tmp/Safari", signature: .developer)
        #expect(index.bestMatch(for: flow(otherTeam)) == nil)
    }

    @Test func rulesFromAnIdentityBindSigningIDAndPath() {
        let match = ProcessMatch(identity: safari)
        #expect(match.signingID == "com.apple.Safari" && match.path == safari.path)
        var moved = safari
        moved.path = "/Users/x/Safari.app/Contents/MacOS/Safari"
        #expect(!match.matches(moved))
        #expect(match.matches(safari))
    }

    @Test func unsignedProcessesMatchByPathOnly() {
        let match = ProcessMatch(identity: unsignedTool)
        #expect(match.signingID == nil && match.path == "/tmp/tool")
        let index = RuleIndex(rules: [Rule(process: match, action: .deny)])
        #expect(index.bestMatch(for: flow(unsignedTool)) != nil)
        #expect(index.bestMatch(for: flow(curl)) == nil)
    }

    @Test func teamOnlyRule() {
        let index = RuleIndex(rules: [Rule(process: ProcessMatch(teamID: ProcessMatch.appleTeamID), action: .deny)])
        #expect(index.bestMatch(for: flow(curl)) != nil)
        #expect(index.bestMatch(for: flow(unsignedTool)) == nil)
    }
}

struct LifetimeAndProfileTests {
    @Test func untilQuitRulesOnlyMatchTheirProcessInstance() {
        let instance = ProcessInstance(pid: 100, pidVersion: 7)
        let rule = Rule(process: ProcessMatch(identity: curl), action: .deny, lifetime: .untilQuit, boundProcess: instance)
        let index = RuleIndex(rules: [rule])
        #expect(index.bestMatch(for: flow(curl, instance: instance)) != nil)
        #expect(index.bestMatch(for: flow(curl, instance: ProcessInstance(pid: 100, pidVersion: 8))) == nil)
        #expect(index.bestMatch(for: flow(curl, instance: nil)) == nil)
    }

    @Test func untilRestartRulesNeedTheSameBootSession() {
        let rule = Rule(action: .deny, lifetime: .untilRestart, bootSession: "boot-a")
        #expect(RuleIndex(rules: [rule], bootSession: "boot-a").count == 1)
        #expect(RuleIndex(rules: [rule], bootSession: "boot-b").count == 0)
    }

    @Test func onceAndDisabledRulesAreNeverIndexed() {
        let rules = [Rule(action: .deny, lifetime: .once), Rule(action: .deny, enabled: false)]
        #expect(RuleIndex(rules: rules).count == 0)
    }

    @Test func profileRulesApplyOnlyInTheirProfile() {
        let home = UUID()
        let work = UUID()
        let rules = [
            Rule(remote: .domain("example.com"), action: .deny, profileID: work),
            Rule(remote: .domain("example.com"), action: .allow, profileID: nil),
        ]
        #expect(RuleIndex(rules: rules, profileID: work).bestMatch(for: flow())?.action == .deny)
        #expect(RuleIndex(rules: rules, profileID: home).bestMatch(for: flow())?.action == .allow)
        #expect(RuleIndex(rules: rules, profileID: nil).bestMatch(for: flow())?.action == .allow)
    }

    @Test func profileSelectionPrefersSSIDThenInterface() {
        let office = Profile(name: "Office", ssids: ["CorpWiFi"])
        let vpn = Profile(name: "VPN", interfaces: ["utun3"])
        let profiles = [vpn, office]
        #expect(ProfileSelector.select(from: profiles, network: NetworkContext(ssid: "CorpWiFi", interfaces: ["en0", "utun3"])) == office.id)
        #expect(ProfileSelector.select(from: profiles, network: NetworkContext(ssid: "Cafe", interfaces: ["en0", "utun3"])) == vpn.id)
        #expect(ProfileSelector.select(from: profiles, network: NetworkContext(ssid: nil, interfaces: ["en0"])) == nil)
    }
}

struct PolicyEngineTests {
    @Test func userRulesBeatBlocklistsWhichBeatTheMode() throws {
        let listID = UUID()
        let lists = BlocklistSet(lists: [(listID, BlocklistParser.parse("0.0.0.0 ads.example.com"))])
        let allowAds = Rule(process: ProcessMatch(identity: safari), remote: .host("ads.example.com"), action: .allow)
        let engine = PolicyEngine(rules: RuleIndex(rules: [allowAds]), blocklists: lists, mode: .alert)

        #expect(engine.decide(flow(safari, host: "ads.example.com")) == .allow(.rule, sourceID: allowAds.id))
        #expect(engine.decide(flow(curl, host: "x.ads.example.com")) == .deny(.blocklist, sourceID: listID))
        #expect(engine.decide(flow(curl, host: "example.com")) == .ask)
    }

    @Test func modesDecideUnmatchedFlows() {
        #expect(PolicyEngine(mode: .silentAllow).decide(flow()) == .allow(.silentAllow, sourceID: nil))
        #expect(PolicyEngine(mode: .silentDeny).decide(flow()) == .deny(.silentDeny, sourceID: nil))
        #expect(Decision.ask.action == nil && Decision.ask.reason == nil && Decision.ask.sourceID == nil)
    }

    @Test func askModeAllowsDNSLookupsButRulesStillApply() {
        let engine = PolicyEngine(mode: .alert)
        #expect(engine.decide(flow(curl, port: 53, proto: .udp)) == .allow(.dnsLookup, sourceID: nil))
        #expect(engine.decide(flow(curl, port: 53, proto: .tcp)) == .allow(.dnsLookup, sourceID: nil))
        #expect(engine.decide(flow(curl, port: 443)) == .ask)

        let noDNS = Rule(process: ProcessMatch(identity: curl), port: .single(53), action: .deny)
        let strict = PolicyEngine(rules: RuleIndex(rules: [noDNS]), mode: .alert)
        #expect(strict.decide(flow(curl, port: 53, proto: .udp)) == .deny(.rule, sourceID: noDNS.id))
        #expect(PolicyEngine(mode: .silentDeny).decide(flow(curl, port: 53, proto: .udp)).action == .deny)
    }

    @Test func systemRulesAllowAppleDaemonsButNotImpostors() {
        let rules = SystemRules.makeRules(tattleSigningIDPrefix: "dev.jonaylor.Tattle", tattleTeamID: "9HNXYM86C6")
        let engine = PolicyEngine(rules: RuleIndex(rules: rules), mode: .silentDeny)
        let mdns = ProcessIdentity(signingID: "com.apple.mDNSResponder", teamID: ProcessMatch.appleTeamID, path: "/usr/sbin/mDNSResponder", signature: .apple)
        #expect(engine.decide(flow(mdns, port: 53, proto: .udp)).action == .allow)
        let fake = ProcessIdentity(signingID: "com.apple.mDNSResponder", teamID: nil, path: "/tmp/m", signature: .adHoc)
        #expect(engine.decide(flow(fake)).action == .deny)
        #expect(rules.allSatisfy { $0.isSystem })
        #expect(Set(rules.map(\.id)).count == rules.count)
        // Re-seeding gives the same IDs.
        #expect(SystemRules.makeRules(tattleSigningIDPrefix: "x", tattleTeamID: "y").map(\.id) == rules.map(\.id))
    }
}

struct ValidationTests {
    @Test func normalizesNamesAndRejectsBadInput() throws {
        let rule = try Rule(remote: .domain("Example.COM."), action: .deny).validated()
        #expect(rule.remote == .domain("example.com"))
        #expect(throws: RuleValidationError.self) { try Rule(remote: .host("bad host"), action: .deny).validated() }
        #expect(throws: RuleValidationError.self) { try Rule(remote: .domain("1.2.3.4"), action: .deny).validated() }
        #expect(throws: RuleValidationError.self) { try Rule(port: .range(10, 5), action: .deny).validated() }
        #expect(throws: RuleValidationError.self) { try Rule(process: ProcessMatch(path: "relative"), action: .deny).validated() }
        #expect(throws: RuleValidationError.self) { try Rule(process: ProcessMatch(signingID: ""), action: .deny).validated() }
        #expect(throws: RuleValidationError.self) { try Rule(process: ProcessMatch(teamID: ""), action: .deny).validated() }
        #expect(throws: RuleValidationError.self) { try Rule(action: .deny, lifetime: .once).validated() }
        #expect(throws: RuleValidationError.self) { try Rule(action: .deny, lifetime: .untilQuit).validated() }
        #expect(throws: RuleValidationError.self) { try Rule(action: .deny, note: String(repeating: "x", count: 2000)).validated() }
    }

    @Test func domainNames() {
        #expect(DomainName.normalize("a-b.c_d.example") == "a-b.c_d.example")
        #expect(DomainName.normalize("-a.com") == nil)
        #expect(DomainName.normalize("a..com") == nil)
        #expect(DomainName.normalize("") == nil)
        #expect(DomainName.normalize(String(repeating: "a", count: 64) + ".com") == nil)
        #expect(DomainName.suffixes(of: "a.b.c").map(String.init) == ["a.b.c", "b.c", "c"])
    }

    @Test func ipParsing() throws {
        #expect(IPAddress("::ffff:1.2.3.4") == IPAddress("1.2.3.4"))
        #expect(IPAddress("fe80::1%en0")?.isIPv4 == false)
        #expect(IPAddress("1.2.3") == nil)
        #expect(IPNetwork("10.0.0.0/33") == nil)
        #expect(IPNetwork("10.0.0.0/x") == nil)
        #expect(IPNetwork("10.0.0.0/08") == nil)
        #expect(IPNetwork("10.9.8.7/8")?.description == "10.0.0.0/8")
        #expect(IPNetwork("::ffff:10.0.0.0/104")?.description == "10.0.0.0/8")
        #expect(IPNetwork("::ffff:10.0.0.0/64") == nil)
        #expect(IPNetwork("1.2.3.4")?.prefixLength == 32)
        let network = try #require(IPNetwork("10.0.0.0/8"))
        #expect(!network.contains(try #require(IPAddress("::1"))))
        let v4 = try #require(IPAddress("1.2.3.4"))
        let v6 = try #require(IPAddress("::1"))
        #expect(v4 < v6)
        #expect(v6.isLoopback)
    }
}
