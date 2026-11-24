import Foundation

/// An immutable index over rules that finds the winning rule for a flow without scanning
/// every rule.
///
/// Rules are bucketed by their remote match: exact host, domain (looked up by each suffix
/// of the flow's host names), CIDR network (one hash lookup per prefix length in use), or
/// any destination (bucketed again by signing ID or path). A lookup touches a number of
/// buckets bounded by the host name's label count and the number of distinct prefix
/// lengths, not by the number of rules, so it is O(1) in the rule count for realistic rule
/// sets. Only the candidates in those buckets are checked in full.
///
/// Precedence among matching rules: deny-specific > allow-specific > deny-general >
/// allow-general, where "specific" means the rule names a destination. Ties go to the most
/// recently modified rule. See `Rule.outranks`.
public struct RuleIndex: Sendable {
    private var hosts: [String: [Rule]] = [:]
    private var domains: [String: [Rule]] = [:]
    private var v4Networks: [Int: [IPAddress: [Rule]]] = [:]
    private var v6Networks: [Int: [IPAddress: [Rule]]] = [:]
    private var v4PrefixLengths: [Int] = []
    private var v6PrefixLengths: [Int] = []
    private var anyRemoteBySigningID: [String: [Rule]] = [:]
    private var anyRemoteByPath: [String: [Rule]] = [:]
    private var anyRemoteOther: [Rule] = []
    public private(set) var count = 0

    public init() {}

    /// Indexes the rules that are active: enabled, in every profile or in `profileID`, and
    /// (for until-restart rules) from the current boot session. Once rules are ignored.
    public init(rules: [Rule], profileID: UUID? = nil, bootSession: String? = nil) {
        for rule in rules where Self.isActive(rule, profileID: profileID, bootSession: bootSession) {
            insert(rule)
        }
        v4PrefixLengths = v4Networks.keys.sorted(by: >)
        v6PrefixLengths = v6Networks.keys.sorted(by: >)
    }

    public static func isActive(_ rule: Rule, profileID: UUID?, bootSession: String?) -> Bool {
        guard rule.enabled, rule.lifetime != .once else { return false }
        if let ruleProfile = rule.profileID, ruleProfile != profileID { return false }
        if rule.lifetime == .untilRestart, rule.bootSession != bootSession { return false }
        return true
    }

    private mutating func insert(_ rule: Rule) {
        count += 1
        switch rule.remote {
        case .host(let name):
            hosts[name, default: []].append(rule)
        case .domain(let name):
            domains[name, default: []].append(rule)
        case .ip(let address):
            insert(rule, network: IPNetwork(address: address, prefixLength: address.bitCount)!)
        case .network(let network):
            insert(rule, network: network)
        case .any:
            if let signingID = rule.process.signingID {
                anyRemoteBySigningID[signingID, default: []].append(rule)
            } else if let path = rule.process.path {
                anyRemoteByPath[path, default: []].append(rule)
            } else {
                anyRemoteOther.append(rule)
            }
        }
    }

    private mutating func insert(_ rule: Rule, network: IPNetwork) {
        if network.address.isIPv4 {
            v4Networks[network.prefixLength, default: [:]][network.address, default: []].append(rule)
        } else {
            v6Networks[network.prefixLength, default: [:]][network.address, default: []].append(rule)
        }
    }

    /// The highest-precedence rule that matches the flow, if any.
    public func bestMatch(for flow: FlowInfo) -> Rule? {
        var best: Rule?
        func consider(_ rules: [Rule]?) {
            guard let rules else { return }
            for rule in rules where rule.matchesNonRemote(flow) {
                if let current = best, !rule.outranks(current) { continue }
                best = rule
            }
        }

        for name in flow.hostnames {
            consider(hosts[name])
            if !domains.isEmpty {
                for suffix in DomainName.suffixes(of: name) {
                    consider(domains[String(suffix)])
                }
            }
        }
        if let address = flow.remoteAddress {
            let (tables, lengths) = address.isIPv4 ? (v4Networks, v4PrefixLengths) : (v6Networks, v6PrefixLengths)
            for length in lengths {
                consider(tables[length]?[address.masked(to: length)])
            }
        }
        if let signingID = flow.process.signingID, flow.process.isSigned {
            consider(anyRemoteBySigningID[signingID])
        }
        consider(anyRemoteByPath[flow.process.path])
        consider(anyRemoteOther)
        return best
    }
}
