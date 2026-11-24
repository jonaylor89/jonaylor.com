import Foundation
import Testing

@testable import TattleShared

struct BlocklistParserTests {
    @Test func hostsFormat() {
        let entries = BlocklistParser.parse("""
            # comment
            127.0.0.1 localhost
            ::1 ip6-localhost
            0.0.0.0 ads.example.com tracker.example.com # trailing comment
            0.0.0.0 0.0.0.0
            10.0.0.1\tlan-ad.example.net

            """)
        #expect(entries.domains == ["ads.example.com", "tracker.example.com", "lan-ad.example.net"])
        #expect(entries.addresses.isEmpty)
    }

    @Test func domainListFormats() throws {
        let entries = BlocklistParser.parse("""
            ! adblock comment
            [Adblock Plus 2.0]
            Plain.Example.org.
            ||abp.example.com^
            *.wild.example.com
            .dot.example.com
            203.0.113.7
            127.0.0.1
            not a domain at all
            singlelabel
            """)
        #expect(entries.domains == ["plain.example.org", "abp.example.com", "wild.example.com", "dot.example.com"])
        #expect(entries.addresses == [try #require(IPAddress("203.0.113.7"))])
        #expect(entries.count == 5)
    }

    @Test func firstListGetsTheHitAndSubdomainsMatch() {
        let first = UUID()
        let second = UUID()
        let set = BlocklistSet(lists: [
            (first, BlocklistEntries(domains: ["example.com"])),
            (second, BlocklistEntries(domains: ["example.com", "other.net"], addresses: [IPAddress("1.1.1.1")!])),
        ])
        #expect(set.match(flow(host: "deep.sub.example.com")) == first)
        #expect(set.match(flow(host: "other.net")) == second)
        #expect(set.match(flow(host: nil, ip: "1.1.1.1")) == second)
        #expect(set.match(flow(host: "fine.org", ip: "9.9.9.9")) == nil)
        #expect(!set.isEmpty && BlocklistSet().isEmpty)
    }

    @Test func validationAndScheduling() throws {
        #expect(throws: RuleValidationError.self) { try Blocklist(name: "x", url: "http://insecure.example/list").validated() }
        #expect(throws: RuleValidationError.self) { try Blocklist(name: " ", url: "https://e.example/list").validated() }
        let list = try Blocklist(name: " Ads ", url: "https://e.example/list", refreshHours: 0).validated()
        #expect(list.name == "Ads" && list.refreshHours == 1)
        let now = Date()
        #expect(list.isDue(at: now))
        var updated = list
        updated.lastUpdated = now
        #expect(!updated.isDue(at: now.addingTimeInterval(1800)))
        #expect(updated.isDue(at: now.addingTimeInterval(3600)))
        updated.enabled = false
        #expect(!updated.isDue(at: now.addingTimeInterval(9999)))
    }
}

struct DNSTests {
    /// A response for www.example.com: CNAME edge.cdn.net, A 93.184.216.34, AAAA 2001:db8::1,
    /// using name compression.
    static let response: Data = {
        func label(_ text: String) -> [UInt8] { [UInt8(text.utf8.count)] + Array(text.utf8) }
        var b: [UInt8] = [0x12, 0x34, 0x81, 0x80, 0, 1, 0, 3, 0, 0, 0, 0]
        b += label("www")
        b += label("example")
        b += label("com")
        b += [0, 0, 1, 0, 1]
        // CNAME: name pointer to offset 12, target edge.cdn.net
        var target: [UInt8] = label("edge")
        target += label("cdn")
        target += label("net")
        target += [0]
        b += [0xC0, 12, 0, 5, 0, 1, 0, 0, 0, 60, 0, UInt8(target.count)]
        b += target
        let edgeOffset = UInt8(b.count - target.count)
        b += [0xC0, edgeOffset, 0, 1, 0, 1, 0, 0, 1, 0, 0, 4, 93, 184, 216, 34]
        b += [0xC0, edgeOffset, 0, 28, 0, 1, 0, 0, 1, 0, 0, 16, 0x20, 0x01, 0x0d, 0xb8]
        b += [UInt8](repeating: 0, count: 11)
        b += [1]
        return Data(b)
    }()

    @Test func parsesAnswersAndFollowsCNAMEs() throws {
        let message = try DNSMessage(parsing: Self.response)
        #expect(message.id == 0x1234 && message.isResponse && message.responseCode == 0)
        #expect(message.questions.first?.name == "www.example.com")
        #expect(message.answers.count == 3)
        let mappings = message.addressMappings()
        let names = Set(mappings.filter { $0.address == IPAddress("93.184.216.34") }.map(\.hostname))
        #expect(names == ["www.example.com", "edge.cdn.net"])
        #expect(mappings.contains { $0.address == IPAddress("2001:db8::1") && $0.hostname == "www.example.com" })
    }

    @Test func rejectsTruncatedAndLoopingMessages() {
        #expect(throws: (any Error).self) { try DNSMessage(parsing: Self.response.prefix(20)) }
        // A name that points at itself.
        var looping: [UInt8] = [0, 0, 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0, 0xC0, 12, 0, 1, 0, 1]
        #expect(throws: (any Error).self) { try DNSMessage(parsing: Data(looping)) }
        looping[13] = 200
        #expect(throws: (any Error).self) { try DNSMessage(parsing: Data(looping)) }
        #expect(throws: (any Error).self) { try DNSMessage(parsing: Data([0, 0, 0, 0, 0, 99, 0, 0, 0, 0, 0, 0])) }
    }

    @Test func queriesAndServerFailures() throws {
        let query = DNSMessage.query(id: 7, name: "example.com", type: DNSMessage.typeAAAA)
        let parsed = try DNSMessage(parsing: query)
        #expect(parsed.id == 7 && !parsed.isResponse && parsed.questions.first?.type == DNSMessage.typeAAAA)
        let failure = try DNSMessage(parsing: try #require(DNSMessage.serverFailure(for: query)))
        #expect(failure.isResponse && failure.responseCode == 2 && failure.id == 7)
        #expect(DNSMessage.serverFailure(for: Data([1, 2])) == nil)
    }

    @Test func hostnameCacheExpiresAndEvicts() {
        nonisolated(unsafe) var clock: TimeInterval = 0
        let cache = HostnameCache(capacity: 10, namesPerAddress: 2, minimumTTL: 10, now: { clock })
        let address = IPAddress("1.2.3.4")!
        cache.record(hostname: "a.example", address: address, ttl: 5)
        cache.record(hostname: "B.example.", address: address, ttl: 100)
        cache.record(hostname: "c.example", address: address, ttl: 100)
        cache.record(hostname: "not valid!", address: address)
        #expect(cache.hostnames(for: address) == ["c.example", "b.example"])
        clock = 200
        #expect(cache.hostnames(for: address).isEmpty)
        for index in 0..<20 {
            clock += 1
            cache.record(hostname: "h\(index).example", address: IPAddress("10.0.0.\(index)")!)
        }
        #expect(cache.count <= 10)
        #expect(cache.hostnames(for: IPAddress("10.0.0.19")!) == ["h19.example"])
    }
}

struct RuleDocumentTests {
    @Test func roundTripsEveryRuleShape() throws {
        let profile = Profile(name: "Work", ssids: ["Corp"], interfaces: ["utun3"])
        let rules = [
            Rule(process: ProcessMatch(identity: safari), remote: .domain("example.com"), port: .single(443), proto: .tcp, action: .allow, profileID: profile.id, note: "web"),
            Rule(process: ProcessMatch(path: "/usr/bin/nc"), remote: .network(IPNetwork("10.0.0.0/8")!), port: .range(1, 1024), action: .deny),
            Rule(remote: .ip(IPAddress("2001:db8::1")!), proto: .udp, action: .deny, enabled: false),
            Rule(remote: .host("a.example"), action: .allow, isSystem: true),
            Rule(action: .deny, lifetime: .untilRestart, bootSession: "b"),
        ]
        let data = try RuleDocument(rules: rules, profiles: [profile]).encoded()
        let decoded = try RuleDocument.decode(data)
        #expect(decoded.rules.count == 4)  // the until-restart rule isn't exported
        for (original, copy) in zip(rules, decoded.rules) {
            #expect(copy.id == original.id && copy.remote == original.remote && copy.port == original.port)
            #expect(copy.process == original.process && copy.action == original.action && copy.proto == original.proto)
            #expect(copy.enabled == original.enabled && copy.note == original.note && copy.isSystem == original.isSystem)
        }
        #expect(decoded.profiles == [profile])
        let json = String(decoding: data, as: UTF8.self)
        #expect(json.contains("\"format\" : \"tattle-rules\"") && json.contains("\"type\" : \"cidr\""))
    }

    @Test func minimalHandWrittenFile() throws {
        let json = """
            {"format": "tattle-rules", "version": 1, "exported": "2026-01-01T00:00:00Z", "profiles": [],
             "rules": [{"id": "6F9619FF-8B86-D011-B42D-00C04FC964FF", "action": "deny",
                        "remote": {"type": "domain", "value": "Tracker.Example"}}]}
            """
        let document = try RuleDocument.decode(Data(json.utf8))
        let rule = try #require(document.rules.first)
        #expect(rule.remote == .domain("tracker.example") && rule.process.isAny && rule.port == .any && rule.direction == .outbound)
    }

    @Test func rejectsBadFiles() {
        #expect(throws: RuleDocument.ImportError.notATattleFile) { try RuleDocument.decode(Data("{}".utf8)) }
        #expect(throws: RuleDocument.ImportError.notATattleFile) {
            try RuleDocument.decode(Data(#"{"format":"other","version":1,"exported":"2026-01-01T00:00:00Z","rules":[],"profiles":[]}"#.utf8))
        }
        #expect(throws: RuleDocument.ImportError.unsupportedVersion(9)) {
            try RuleDocument.decode(Data(#"{"format":"tattle-rules","version":9,"exported":"2026-01-01T00:00:00Z","rules":[],"profiles":[]}"#.utf8))
        }
        let badRule = #"{"format":"tattle-rules","version":1,"exported":"2026-01-01T00:00:00Z","profiles":[],"rules":[{"id":"6F9619FF-8B86-D011-B42D-00C04FC964FF","action":"deny","remote":{"type":"host","value":"bad host"}}]}"#
        #expect(throws: RuleDocument.ImportError.self) { try RuleDocument.decode(Data(badRule.utf8)) }
        let badCIDR = #"{"format":"tattle-rules","version":1,"exported":"2026-01-01T00:00:00Z","profiles":[],"rules":[{"id":"6F9619FF-8B86-D011-B42D-00C04FC964FF","action":"deny","remote":{"type":"cidr","value":"10.0.0.0/99"}}]}"#
        #expect(throws: RuleDocument.ImportError.notATattleFile) { try RuleDocument.decode(Data(badCIDR.utf8)) }
        #expect(RuleDocument.ImportError.tooLarge.description.contains("100000"))
    }
}

struct CLITests {
    @Test func parsesCommands() throws {
        #expect(try CLICommand.parse([]) == .help)
        #expect(try CLICommand.parse(["status", "--json"]) == .status(json: true))
        #expect(try CLICommand.parse(["rules", "list"]) == .listRules(json: false))
        #expect(try CLICommand.parse(["export"]) == .export(path: nil))
        #expect(try CLICommand.parse(["import", "f.json", "--replace"]) == .import(path: "f.json", replace: true))
        #expect(try CLICommand.parse(["log", "tail", "-n", "10", "-f"]) == .tail(count: 10, follow: true, json: false))
        let id = UUID()
        #expect(try CLICommand.parse(["rules", "remove", id.uuidString]) == .removeRules([id]))
    }

    @Test func parsesRuleOptions() throws {
        guard case .addRule(let rule) = try CLICommand.parse([
            "rules", "add", "--deny", "--signing-id", "com.example.app", "--team-id", "ABC", "--path", "/Applications/X.app/Contents/MacOS/X",
            "--domain", "Example.com", "--ports", "8000-8100", "--protocol", "tcp", "--note", "hi",
        ]) else { Issue.record("not addRule"); return }
        #expect(rule.action == .deny && rule.remote == .domain("example.com") && rule.port == .range(8000, 8100))
        #expect(rule.process == ProcessMatch(signingID: "com.example.app", teamID: "ABC", path: "/Applications/X.app/Contents/MacOS/X"))
        #expect(rule.proto == .tcp && rule.note == "hi")
        guard case .addRule(let ipRule) = try CLICommand.parse(["rules", "add", "--allow", "--cidr", "10.0.0.0/8", "--port", "22"]) else { return }
        #expect(ipRule.remote == .network(IPNetwork("10.0.0.0/8")!) && ipRule.port == .single(22))
        guard case .addRule(let hostRule) = try CLICommand.parse(["rules", "add", "--allow", "--host", "a.example", "--ip", "1.2.3.4"]) else { return }
        #expect(hostRule.remote == .ip(IPAddress("1.2.3.4")!))
    }

    @Test(arguments: [
        ["bogus"], ["rules"], ["rules", "nope"], ["rules", "remove"], ["rules", "remove", "x"], ["rules", "add"],
        ["rules", "add", "--allow", "--ip", "1.2.3"], ["rules", "add", "--allow", "--cidr", "x"], ["rules", "add", "--allow", "--port", "70000"],
        ["rules", "add", "--allow", "--ports", "9-1"], ["rules", "add", "--allow", "--protocol", "any"], ["rules", "add", "--allow", "--host", "bad host"],
        ["rules", "add", "--allow", "--path"], ["rules", "add", "--allow", "--wat"], ["status", "--xml"], ["export", "a", "b"], ["import"],
        ["log"], ["log", "tail", "-n", "0"], ["log", "tail", "--bad"],
    ])
    func rejectsBadInput(arguments: [String]) {
        #expect(throws: CLICommand.ParseError.self) { try CLICommand.parse(arguments) }
    }

    @Test func formatsRulesAndConnections() {
        let rule = Rule(process: ProcessMatch(signingID: "com.apple.curl"), remote: .domain("example.com"), port: .single(443), proto: .tcp, action: .deny, lifetime: .untilRestart, isSystem: true)
        let line = CLIFormat.describe(rule)
        #expect(line.contains("deny  com.apple.curl → *.example.com:443 tcp [system, untilRestart]"))
        let record = ConnectionRecord(
            flowID: UUID(), time: Date(), process: curl, pid: 1, remoteAddress: "1.2.3.4", remoteHost: nil, remotePort: 80,
            proto: .tcp, direction: .outbound, action: .allow, reason: .rule, sourceID: nil, profileID: nil, needsReview: false
        )
        #expect(CLIFormat.describe(record).contains("allow curl → 1.2.3.4:80 tcp (rule)"))
    }
}

struct XPCMessageTests {
    @Test func requestsRoundTripAndPermissionsHold() throws {
        let requests: [ServiceRequest] = [
            .status, .saveRules([Rule(remote: .domain("a.example"), action: .deny)]), .importRules(document: Data("{}".utf8), replace: true),
            .connections(ConnectionQuery(search: "x", afterID: 5, action: .deny, limit: 10)), .networkChanged(NetworkContext(ssid: "s", interfaces: ["en0"])),
        ]
        for request in requests {
            #expect(try XPCCoding.decode(ServiceRequest.self, from: XPCCoding.encode(request)) == request)
        }
        #expect(Caller.app.may(send: .registerForAlerts))
        #expect(!Caller.cli(isRoot: true).may(send: .registerForAlerts))
        #expect(Caller.cli(isRoot: true).may(send: .deleteRules([])))
        #expect(!Caller.cli(isRoot: false).may(send: .deleteRules([])))
        #expect(Caller.cli(isRoot: false).may(send: .exportRules))
        #expect(throws: (any Error).self) { try XPCCoding.decode(ServiceRequest.self, from: Data(#"{"launchMissiles":{}}"#.utf8)) }
        #expect(throws: XPCError.messageTooLarge) {
            try XPCCoding.decode(ServiceRequest.self, from: Data(count: XPCLimits.maxRequestBytes + 1))
        }
        #expect(CodeRequirement.signed(teamID: "T\"X", identifiers: ["a", "b"]) ==
            #"anchor apple generic and certificate leaf[subject.OU] = "T\"X" and (identifier "a" or identifier "b")"#)
    }

    @Test func auditTokenFields() {
        var values: [UInt32] = [0, 0, 0, 0, 0, 4242, 0, 9]
        let data = Data(bytes: &values, count: 32)
        #expect(CodeIdentity.processInstance(auditToken: data) == ProcessInstance(pid: 4242, pidVersion: 9))
        #expect(CodeIdentity.processInstance(auditToken: Data([1, 2])) == nil)
        #expect(CodeIdentity.resolve(auditToken: Data([1])).signature == .unknown)
    }

    @Test func resolvesOwnProcessByPID() {
        let identity = CodeIdentity.resolve(pid: getpid())
        #expect(identity.path != "unknown")
        let unknown = CodeIdentity.resolve(pid: -5)
        #expect(unknown.signingID == nil)
    }

    @Test func kernelReportsExecutablePaths() {
        let own = CodeIdentity.executablePath(pid: getpid())
        #expect(own?.hasPrefix("/") == true)
        #expect(CodeIdentity.executablePath(pid: -5) == nil)
    }

    @Test func identityCacheEvictsLeastRecentlyUsed() {
        let cache = IdentityCache(capacity: 8)
        for pid in 0..<8 { cache.store(curl, for: ProcessInstance(pid: Int32(pid), pidVersion: 0)) }
        _ = cache.identity(for: ProcessInstance(pid: 0, pidVersion: 0))
        cache.store(safari, for: ProcessInstance(pid: 100, pidVersion: 0))
        #expect(cache.count <= 8)
        #expect(cache.identity(for: ProcessInstance(pid: 0, pidVersion: 0)) == curl)
        #expect(cache.identity(for: ProcessInstance(pid: 1, pidVersion: 0)) == nil)
        #expect(cache.identity(for: ProcessInstance(pid: 100, pidVersion: 0)) == safari)
    }
}

struct TimestampTests {
    @Test func roundTripsExactly() {
        for _ in 0..<20_000 {
            let date = Date(timeIntervalSince1970: Double.random(in: -1e9...4e9)).storedPrecision
            #expect(Timestamp.parse(Timestamp.format(date)) == date)
            #expect(date.storedPrecision == date)
        }
    }

    @Test func formatsAndParses() {
        #expect(Timestamp.format(Date(timeIntervalSince1970: 1.5)) == "1970-01-01T00:00:01.500Z")
        #expect(Timestamp.format(Date(timeIntervalSince1970: -0.25)) == "1969-12-31T23:59:59.750Z")
        #expect(Timestamp.parse("2026-01-01T00:00:00Z") == Date(timeIntervalSince1970: 1_767_225_600))
        #expect(Timestamp.parse("2026-01-01T00:00:00.1239Z") == Date(timeIntervalSince1970: 1_767_225_600.123))
        #expect(Timestamp.parse("2026-01-01T00:00:00.Z") == nil)
        #expect(Timestamp.parse("2026-01-01T00:00:00+02:00") == nil)
        #expect(Timestamp.parse("nope") == nil)
    }
}
