import Foundation

/// One logged connection, as shown in the connection list.
public struct ConnectionRecord: Codable, Hashable, Identifiable, Sendable {
    public var id: Int64
    public var flowID: UUID
    public var time: Date
    public var process: ProcessIdentity
    public var pid: Int32?
    public var remoteAddress: String?
    public var remoteHost: String?
    public var remotePort: UInt16
    public var proto: TransportProtocol
    public var direction: TrafficDirection
    public var action: RuleAction
    public var reason: VerdictReason
    /// The rule or blocklist that decided, if any.
    public var sourceID: UUID?
    public var profileID: UUID?
    public var bytesIn: Int64
    public var bytesOut: Int64
    /// Decided without the user (silent mode or unanswered alert) and not yet reviewed.
    public var needsReview: Bool

    public init(
        id: Int64 = 0, flowID: UUID, time: Date, process: ProcessIdentity, pid: Int32?, remoteAddress: String?,
        remoteHost: String?, remotePort: UInt16, proto: TransportProtocol, direction: TrafficDirection,
        action: RuleAction, reason: VerdictReason, sourceID: UUID?, profileID: UUID?,
        bytesIn: Int64 = 0, bytesOut: Int64 = 0, needsReview: Bool
    ) {
        self.id = id
        self.flowID = flowID
        self.time = time
        self.process = process
        self.pid = pid
        self.remoteAddress = remoteAddress
        self.remoteHost = remoteHost
        self.remotePort = remotePort
        self.proto = proto
        self.direction = direction
        self.action = action
        self.reason = reason
        self.sourceID = sourceID
        self.profileID = profileID
        self.bytesIn = bytesIn
        self.bytesOut = bytesOut
        self.needsReview = needsReview
    }

    public var displayHost: String { remoteHost ?? remoteAddress ?? "unknown" }
}

public struct ConnectionQuery: Codable, Hashable, Sendable {
    /// Matches process name/path/signing ID, host or address (case-insensitive substring).
    public var search: String?
    /// Only records with a larger ID (for live tailing).
    public var afterID: Int64?
    public var action: RuleAction?
    /// Clamped to 1...5000.
    public var limit: Int

    public init(search: String? = nil, afterID: Int64? = nil, action: RuleAction? = nil, limit: Int = 500) {
        self.search = search
        self.afterID = afterID
        self.action = action
        self.limit = limit
    }
}

/// Unreviewed connections grouped by process and destination.
public struct ReviewItem: Codable, Hashable, Identifiable, Sendable {
    public var process: ProcessIdentity
    public var host: String
    public var remotePort: UInt16
    public var proto: TransportProtocol
    public var action: RuleAction
    public var count: Int
    public var lastSeen: Date

    public var id: String { "\(process.path)|\(process.name ?? "")|\(host)" }
}

public struct TrafficQuery: Codable, Hashable, Sendable {
    public var since: Date
    /// Bucket size for the time series. Must be a multiple of an hour; 1 to 168 hours.
    public var bucketHours: Int
    /// Restrict the time series and host totals to one app.
    public var appKey: String?

    public init(since: Date, bucketHours: Int = 1, appKey: String? = nil) {
        self.since = since
        self.bucketHours = bucketHours
        self.appKey = appKey
    }
}

public struct TrafficPoint: Codable, Hashable, Sendable {
    public var bucket: Date
    public var appKey: String
    public var appName: String
    public var bytesIn: Int64
    public var bytesOut: Int64
}

public struct TrafficTotal: Codable, Hashable, Identifiable, Sendable {
    /// App key (signing ID or path) or host name.
    public var key: String
    public var name: String
    public var bytesIn: Int64
    public var bytesOut: Int64
    public var flows: Int64

    public var id: String { key }
    public var total: Int64 { bytesIn + bytesOut }
}

public struct TrafficReport: Codable, Hashable, Sendable {
    public var series: [TrafficPoint]
    public var apps: [TrafficTotal]
    public var hosts: [TrafficTotal]
}

/// Extension status for the app and `tattlectl status`.
public struct ServiceStatus: Codable, Hashable, Sendable {
    public var version: String
    public var settings: Settings
    public var activeProfileName: String?
    public var ruleCount: Int
    public var blocklistEntryCount: Int
    public var pendingAlerts: Int
    public var alertClientConnected: Bool
    public var connectionsLogged: Int64
    public var dnsProxyRunning: Bool
    public var network: NetworkContext
    /// Totals since the extension started. Optional so an app and extension from different
    /// builds still understand each other during an update.
    public var activity: ActivityTotals?
}

/// Counters since the extension started. The app turns byte totals into rates by
/// comparing successive readings.
public struct ActivityTotals: Codable, Hashable, Sendable {
    public var bytesIn: Int64 = 0
    public var bytesOut: Int64 = 0
    public var allowed: Int64 = 0
    public var denied: Int64 = 0

    public init(bytesIn: Int64 = 0, bytesOut: Int64 = 0, allowed: Int64 = 0, denied: Int64 = 0) {
        self.bytesIn = bytesIn
        self.bytesOut = bytesOut
        self.allowed = allowed
        self.denied = denied
    }
}

extension ProcessIdentity {
    /// The key traffic statistics are grouped by: signing ID for signed code, else path.
    public var appKey: String { isSigned ? (signingID ?? path) : path }
}
