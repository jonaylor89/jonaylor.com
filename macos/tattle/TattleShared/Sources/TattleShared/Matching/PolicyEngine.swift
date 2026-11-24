import Foundation

/// One immutable snapshot of everything a verdict depends on. The extension swaps in a new
/// snapshot when rules, lists or settings change; a verdict never waits for that.
///
/// Order of evaluation:
/// 1. User and system rules (`RuleIndex` precedence).
/// 2. Blocklists. User rules always win over list entries.
/// 3. The mode: ask, silently allow, or silently deny. In ask mode, DNS lookups are
///    allowed without an alert; the connection that follows is asked about instead.
public struct PolicyEngine: Sendable {
    public let rules: RuleIndex
    public let blocklists: BlocklistSet
    public let mode: FilterMode

    public init(rules: RuleIndex = RuleIndex(), blocklists: BlocklistSet = BlocklistSet(), mode: FilterMode = .alert) {
        self.rules = rules
        self.blocklists = blocklists
        self.mode = mode
    }

    public func decide(_ flow: FlowInfo) -> Decision {
        if let rule = rules.bestMatch(for: flow) {
            return .of(rule.action, .rule, sourceID: rule.id)
        }
        if let list = blocklists.match(flow) {
            return .deny(.blocklist, sourceID: list)
        }
        switch mode {
        case .alert: return flow.remotePort == 53 ? .allow(.dnsLookup, sourceID: nil) : .ask
        case .silentAllow: return .allow(.silentAllow, sourceID: nil)
        case .silentDeny: return .deny(.silentDeny, sourceID: nil)
        }
    }
}

/// Rules that keep macOS connected. They're created on first launch in the "System" group,
/// shown in the rules editor, and can be edited or disabled like any other rule.
public enum SystemRules {
    /// Apple daemons that networking, time, certificates, push and updates depend on.
    public static let appleServices: [(signingID: String, note: String)] = [
        ("com.apple.mDNSResponder", "DNS and Bonjour"),
        ("com.apple.configd", "Network configuration (DHCP)"),
        ("com.apple.timed", "Network time"),
        ("com.apple.trustd", "Certificate revocation checks"),
        ("com.apple.apsd", "Apple push notifications"),
        ("com.apple.softwareupdated", "macOS updates"),
        ("com.apple.nsurlsessiond", "Background downloads for system services"),
        ("com.apple.mobileassetd", "System assets"),
        ("com.apple.networkserviceproxy", "Private Relay and network services"),
    ]

    /// Stable IDs so re-seeding never duplicates a rule.
    public static func makeRules(tattleSigningIDPrefix: String?, tattleTeamID: String?, now: Date = Date()) -> [Rule] {
        var rules = appleServices.enumerated().map { index, service in
            Rule(
                id: stableID(index),
                process: ProcessMatch(signingID: service.signingID, teamID: ProcessMatch.appleTeamID),
                direction: .any, action: .allow, created: now, note: service.note, isSystem: true
            )
        }
        if let tattleSigningIDPrefix, let tattleTeamID {
            rules.append(Rule(
                id: stableID(100),
                process: ProcessMatch(signingID: tattleSigningIDPrefix, teamID: tattleTeamID),
                direction: .any, action: .allow, created: now, note: "Tattle itself", isSystem: true
            ))
        }
        return rules
    }

    static func stableID(_ index: Int) -> UUID {
        UUID(uuidString: String(format: "00000000-0000-5E00-0000-%012X", index))!
    }
}
