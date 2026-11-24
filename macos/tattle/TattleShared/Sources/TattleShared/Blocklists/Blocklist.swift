import Foundation

/// A subscribed list of hosts to deny. User rules always take priority over list entries.
public struct Blocklist: Codable, Hashable, Identifiable, Sendable {
    public var id: UUID
    public var name: String
    public var url: String
    public var enabled: Bool
    /// Hours between automatic refreshes. Clamped to 1...720.
    public var refreshHours: Int
    public var lastUpdated: Date?
    public var lastError: String?
    public var entryCount: Int
    /// Flows denied because of this list.
    public var hitCount: Int

    public init(
        id: UUID = UUID(), name: String, url: String, enabled: Bool = true, refreshHours: Int = 24,
        lastUpdated: Date? = nil, lastError: String? = nil, entryCount: Int = 0, hitCount: Int = 0
    ) {
        self.id = id
        self.name = name
        self.url = url
        self.enabled = enabled
        self.refreshHours = refreshHours
        self.lastUpdated = lastUpdated
        self.lastError = lastError
        self.entryCount = entryCount
        self.hitCount = hitCount
    }

    public func validated() throws -> Blocklist {
        var list = self
        list.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !list.name.isEmpty, list.name.count <= 100 else { throw RuleValidationError("List names must be 1 to 100 characters.") }
        guard url.utf8.count <= 2048, let parsed = URL(string: url), parsed.scheme == "https", parsed.host() != nil else {
            throw RuleValidationError("Blocklists must be downloaded over HTTPS.")
        }
        list.refreshHours = min(max(refreshHours, 1), 720)
        return list
    }

    public func isDue(at now: Date) -> Bool {
        guard enabled else { return false }
        guard let lastUpdated else { return true }
        return now.timeIntervalSince(lastUpdated) >= Double(refreshHours) * 3600
    }
}

/// The entries of one downloaded list.
public struct BlocklistEntries: Sendable, Equatable {
    public var domains: Set<String>
    public var addresses: Set<IPAddress>

    public init(domains: Set<String> = [], addresses: Set<IPAddress> = []) {
        self.domains = domains
        self.addresses = addresses
    }

    public var count: Int { domains.count + addresses.count }
}

public enum BlocklistParser {
    /// Addresses that hosts files use as "nowhere"; they are never blocked themselves.
    private static let sinkholes: Set<String> = ["0.0.0.0", "127.0.0.1", "::", "::1", "0", "::0"]
    /// Names hosts files map to loopback for the system's own use.
    private static let reservedNames: Set<String> = [
        "localhost", "localhost.localdomain", "local", "broadcasthost", "ip6-localhost", "ip6-loopback",
        "ip6-localnet", "ip6-mcastprefix", "ip6-allnodes", "ip6-allrouters", "ip6-allhosts", "0.0.0.0",
    ]
    public static let maxEntries = 2_000_000

    /// Parses either format, line by line:
    /// - hosts: `0.0.0.0 ads.example.com tracker.example.com`
    /// - domain list: `ads.example.com`, also `||ads.example.com^` and `*.ads.example.com`
    /// Comments (`#`, `!`) and blank lines are skipped, as are lines that don't parse.
    /// Every domain entry also blocks its subdomains.
    public static func parse(_ text: String) -> BlocklistEntries {
        var entries = BlocklistEntries()
        text.enumerateLines { rawLine, stop in
            var line = Substring(rawLine)
            if let hash = line.firstIndex(of: "#") { line = line[..<hash] }
            line = line.trimmingCharacters(in: .whitespaces)[...]
            guard !line.isEmpty, !line.hasPrefix("!"), !line.hasPrefix("[") else { return }
            let fields = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
            if fields.count >= 2, sinkholes.contains(String(fields[0])) || IPAddress(String(fields[0])) != nil {
                // hosts format: the address is a sinkhole, every following field is a name.
                for name in fields.dropFirst() { add(String(name), to: &entries) }
            } else if fields.count == 1 {
                add(String(fields[0]), to: &entries)
            }
            if entries.count >= maxEntries { stop = true }
        }
        return entries
    }

    private static func add(_ token: String, to entries: inout BlocklistEntries) {
        var value = token
        if value.hasPrefix("||") { value.removeFirst(2) }
        if value.hasSuffix("^") { value.removeLast() }
        if value.hasPrefix("*.") { value.removeFirst(2) }
        if value.hasPrefix(".") { value.removeFirst() }
        if let address = IPAddress(value) {
            if !sinkholes.contains(value), !address.isLoopback { entries.addresses.insert(address) }
            return
        }
        guard let name = DomainName.normalize(value), !reservedNames.contains(name), name.contains(".") else { return }
        entries.domains.insert(name)
    }
}

/// All enabled lists merged for lookup. The first list (in subscription order) that
/// contains an entry gets the hit.
public struct BlocklistSet: Sendable {
    private var domains: [String: UUID] = [:]
    private var addresses: [IPAddress: UUID] = [:]

    public init() {}

    public init(lists: [(id: UUID, entries: BlocklistEntries)]) {
        for (id, entries) in lists {
            for domain in entries.domains where domains[domain] == nil { domains[domain] = id }
            for address in entries.addresses where addresses[address] == nil { addresses[address] = id }
        }
    }

    public var isEmpty: Bool { domains.isEmpty && addresses.isEmpty }

    /// The list that blocks this flow, if any.
    public func match(_ flow: FlowInfo) -> UUID? {
        for name in flow.hostnames {
            for suffix in DomainName.suffixes(of: name) {
                if let id = domains[String(suffix)] { return id }
            }
        }
        if let address = flow.remoteAddress { return addresses[address] }
        return nil
    }
}
