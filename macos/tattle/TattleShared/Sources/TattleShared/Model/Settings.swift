import Foundation

/// What happens to flows that no rule matches.
public enum FilterMode: String, Codable, Sendable, CaseIterable {
    /// Ask the user. Unanswered alerts fall back to `Settings.defaultPolicy`.
    case alert
    /// Allow and record the flow for later review.
    case silentAllow
    /// Deny and record the flow for later review.
    case silentDeny
}

public struct Settings: Codable, Hashable, Sendable {
    public var mode: FilterMode = .alert
    /// Applied when an alert times out or no app is connected to answer it.
    public var defaultPolicy: RuleAction = .allow
    /// Seconds to wait for an alert answer. Clamped to 5...300.
    public var alertTimeout: Double = 30
    public var activeProfileID: UUID?
    /// Switch profiles automatically when the network changes.
    public var automaticProfiles = true
    /// Days of connection history to keep. Clamped to 1...365.
    public var connectionRetentionDays = 7
    /// Days of traffic statistics to keep. Clamped to 1...730.
    public var trafficRetentionDays = 30
    public var dns = DNSSettings()

    public init() {}

    public func validated() -> Settings {
        var settings = self
        settings.alertTimeout = min(max(alertTimeout, 5), 300)
        settings.connectionRetentionDays = min(max(connectionRetentionDays, 1), 365)
        settings.trafficRetentionDays = min(max(trafficRetentionDays, 1), 730)
        return settings
    }
}

public struct DNSSettings: Codable, Hashable, Sendable {
    public var enabled = false
    /// The DNS-over-HTTPS endpoint. Use an IP literal (https://1.1.1.1/dns-query) so the
    /// resolver itself doesn't need DNS.
    public var resolverURL = "https://1.1.1.1/dns-query"
    /// When the resolver fails, answer from the system's original DNS server instead of
    /// failing the lookup. Keeps the Mac online at the cost of an unencrypted query.
    public var fallbackToSystemDNS = true

    public init() {}

    public static let presets: [(name: String, url: String)] = [
        ("Cloudflare", "https://1.1.1.1/dns-query"),
        ("Google", "https://8.8.8.8/dns-query"),
        ("Quad9", "https://9.9.9.9/dns-query"),
    ]

    /// Only HTTPS URLs with a host are accepted.
    public var isValidResolver: Bool {
        guard let url = URL(string: resolverURL), url.scheme == "https", let host = url.host(), !host.isEmpty else { return false }
        return true
    }
}

/// A named set of rules. Rules with no profile apply in every profile.
public struct Profile: Codable, Hashable, Identifiable, Sendable {
    public var id: UUID
    public var name: String
    /// Activate this profile automatically when connected to one of these Wi-Fi networks.
    public var ssids: [String]
    /// Or when one of these interfaces (such as "en0" or "utun3") is in use.
    public var interfaces: [String]

    public init(id: UUID = UUID(), name: String, ssids: [String] = [], interfaces: [String] = []) {
        self.id = id
        self.name = name
        self.ssids = ssids
        self.interfaces = interfaces
    }

    public func validated() throws -> Profile {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 100 else { throw RuleValidationError("Profile names must be 1 to 100 characters.") }
        guard ssids.count <= 100, interfaces.count <= 100,
              (ssids + interfaces).allSatisfy({ !$0.isEmpty && $0.utf8.count <= 64 })
        else { throw RuleValidationError("Network names must be 1 to 64 characters.") }
        var profile = self
        profile.name = trimmed
        return profile
    }
}

/// The network the Mac is on, as far as profile switching cares.
public struct NetworkContext: Codable, Hashable, Sendable {
    public var ssid: String?
    /// Names of interfaces the current default path uses.
    public var interfaces: [String]

    public init(ssid: String? = nil, interfaces: [String] = []) {
        self.ssid = ssid
        self.interfaces = interfaces
    }
}

public enum ProfileSelector {
    /// The first profile whose SSIDs or interfaces match the network, or nil to fall back to
    /// rules that apply in every profile. SSID matches beat interface matches.
    public static func select(from profiles: [Profile], network: NetworkContext) -> UUID? {
        if let ssid = network.ssid, let profile = profiles.first(where: { $0.ssids.contains(ssid) }) {
            return profile.id
        }
        return profiles.first(where: { !Set($0.interfaces).isDisjoint(with: network.interfaces) })?.id
    }
}
