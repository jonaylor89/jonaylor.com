import Foundation
import TattleShared

// Verdict-path benchmark: 10,000 mixed rules plus a 100,000-entry blocklist, then 200,000
// verdicts over a mix of matching and non-matching flows. Run with:
//   swift run -c release tattle-bench

var generator = SystemRandomNumberGenerator()
let ruleCount = Int(CommandLine.arguments.dropFirst().first ?? "") ?? 10_000
let lookups = 200_000

let apps: [ProcessIdentity] = (0..<500).map { index in
    ProcessIdentity(signingID: "com.example.app\(index)", teamID: "TEAM\(index % 50)", path: "/Applications/App\(index).app/Contents/MacOS/App\(index)", signature: .developer)
}

var rules: [Rule] = []
for index in 0..<ruleCount {
    let app = apps[index % apps.count]
    // Some rules apply to every app, but none to every app and every destination.
    let process = index % 7 == 0 && index % 5 != 4 ? ProcessMatch.any : ProcessMatch(identity: app)
    let remote: RemoteMatch = switch index % 5 {
    case 0: .host("host\(index).example.com")
    case 1: .domain("domain\(index).net")
    case 2: .ip(IPAddress("10.\(index / 65536 % 256).\(index / 256 % 256).\(index % 256)")!)
    case 3: .network(IPNetwork("172.\(16 + index % 16).\(index % 256).0/24")!)
    default: index % 2 == 0 ? .any : .domain("cdn\(index % 300).org")
    }
    let port: PortMatch = index % 3 == 0 ? .single(443) : (index % 3 == 1 ? .range(1000, 2000) : .any)
    rules.append(Rule(
        process: process, remote: remote, port: port, proto: index % 4 == 0 ? .udp : .any,
        action: index % 2 == 0 ? .allow : .deny, created: Date(timeIntervalSince1970: Double(index))
    ))
}

var blocklistText = ""
for index in 0..<100_000 { blocklistText += "0.0.0.0 ads\(index).tracker.test\n" }
let blocklist = BlocklistSet(lists: [(UUID(), BlocklistParser.parse(blocklistText))])

let buildStart = DispatchTime.now()
let engine = PolicyEngine(rules: RuleIndex(rules: rules), blocklists: blocklist, mode: .alert)
let buildMillis = Double(DispatchTime.now().uptimeNanoseconds - buildStart.uptimeNanoseconds) / 1e6

let flows: [FlowInfo] = (0..<1000).map { index in
    let app = apps[Int.random(in: 0..<apps.count, using: &generator)]
    let n = Int.random(in: 0..<ruleCount, using: &generator)
    let (host, ip): (String?, String) = switch index % 6 {
    case 0: ("host\(n).example.com", "93.184.216.\(n % 256)")
    case 1: ("www.domain\(n).net", "93.184.217.\(n % 256)")
    case 2: (nil, "10.\(n / 65536 % 256).\(n / 256 % 256).\(n % 256)")
    case 3: (nil, "172.\(16 + n % 16).\(n % 256).9")
    case 4: ("ads\(n % 100_000).tracker.test", "203.0.113.\(n % 256)")
    default: ("unmatched\(n).example.org", "198.51.100.\(n % 256)")
    }
    return FlowInfo(
        process: app, proto: index % 4 == 0 ? .udp : .tcp, remoteAddress: IPAddress(ip),
        remotePort: [443, 1500, 80, 53][index % 4], hostnames: host.map { [$0] } ?? []
    )
}

var samples = [UInt64]()
samples.reserveCapacity(lookups)
var decisions = [Int](repeating: 0, count: 3)
for index in 0..<lookups {
    let flow = flows[index % flows.count]
    let start = DispatchTime.now().uptimeNanoseconds
    let decision = engine.decide(flow)
    samples.append(DispatchTime.now().uptimeNanoseconds - start)
    switch decision {
    case .allow: decisions[0] += 1
    case .deny: decisions[1] += 1
    case .ask: decisions[2] += 1
    }
}
samples.sort()
let sorted = samples
@MainActor func percentile(_ p: Double) -> Double { Double(sorted[min(Int(Double(sorted.count) * p), sorted.count - 1)]) / 1000 }

print("rules: \(engine.rules.count), blocklist entries: 100000, index build: \(String(format: "%.1f", buildMillis)) ms")
print("verdicts: \(lookups) (allow \(decisions[0]), deny \(decisions[1]), ask \(decisions[2]))")
print(String(format: "latency µs  p50 %.2f  p90 %.2f  p99 %.2f  p99.9 %.2f  max %.2f",
             percentile(0.50), percentile(0.90), percentile(0.99), percentile(0.999), Double(samples.last!) / 1000))
