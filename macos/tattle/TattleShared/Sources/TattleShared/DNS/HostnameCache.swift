import Foundation
import os

/// Remembers which host names recently resolved to which addresses, so rules that name a
/// domain can match flows that only show an IP. Fed by flows' own host names and by DNS
/// answers that pass through the DNS proxy.
///
/// Bounded: at most `capacity` addresses, each with at most `namesPerAddress` names. The
/// oldest address is evicted first. Entries expire after their TTL (at least `minimumTTL`,
/// so short-TTL CDNs still map for flows that start a little later).
public final class HostnameCache: @unchecked Sendable {
    private struct Entry {
        var names: [(name: String, expires: TimeInterval)]
        var lastTouched: TimeInterval
    }

    private let lock = OSAllocatedUnfairLock()
    private var entries: [IPAddress: Entry] = [:]
    private let capacity: Int
    private let namesPerAddress: Int
    private let minimumTTL: TimeInterval
    private let now: @Sendable () -> TimeInterval

    public init(
        capacity: Int = 50_000, namesPerAddress: Int = 8, minimumTTL: TimeInterval = 300,
        now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    ) {
        self.capacity = capacity
        self.namesPerAddress = namesPerAddress
        self.minimumTTL = minimumTTL
        self.now = now
    }

    public func record(hostname: String, address: IPAddress, ttl: TimeInterval = 0) {
        guard let name = DomainName.normalize(hostname) else { return }
        let time = now()
        let expires = time + max(ttl, minimumTTL)
        lock.withLock {
            var entry = entries[address] ?? Entry(names: [], lastTouched: time)
            entry.names.removeAll { $0.name == name || $0.expires <= time }
            entry.names.insert((name, expires), at: 0)
            if entry.names.count > namesPerAddress { entry.names.removeLast(entry.names.count - namesPerAddress) }
            entry.lastTouched = time
            entries[address] = entry
            if entries.count > capacity { evictOldest() }
        }
    }

    /// Unexpired names for the address, most recent first.
    public func hostnames(for address: IPAddress) -> [String] {
        let time = now()
        return lock.withLock {
            entries[address]?.names.filter { $0.expires > time }.map(\.name) ?? []
        }
    }

    public var count: Int { lock.withLock { entries.count } }

    /// Drops the oldest tenth so eviction cost is amortized.
    private func evictOldest() {
        let excess = max(entries.count - capacity, capacity / 10)
        let victims = entries.sorted { $0.value.lastTouched < $1.value.lastTouched }.prefix(excess).map(\.key)
        for key in victims { entries[key] = nil }
    }
}
