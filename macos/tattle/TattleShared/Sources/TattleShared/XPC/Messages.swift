import Foundation

/// The XPC interface the filter extension exports. There is one method: requests and
/// responses are `ServiceRequest` / `ServiceResponse` values encoded as JSON. The extension
/// treats every byte as untrusted: oversized messages and anything that doesn't decode
/// into a known request are rejected, and every value is validated before use.
@objc public protocol TattleServiceProtocol {
    func perform(_ request: Data, withReply reply: @escaping @Sendable (Data) -> Void)
}

/// The interface the app exports back to the extension so the extension can ask it to
/// show alerts.
@objc public protocol TattleClientProtocol {
    func handleAlert(_ alert: Data, withReply reply: @escaping @Sendable (Data) -> Void)
}

public enum XPCLimits {
    /// Largest request the extension accepts (a big rules import).
    public static let maxRequestBytes = 32 * 1024 * 1024
}

public enum ServiceRequest: Codable, Hashable, Sendable {
    case status
    case connections(ConnectionQuery)
    case reviewItems
    case markReviewed(path: String?, host: String?)
    case rules
    case saveRules([Rule])
    case deleteRules([UUID])
    case exportRules
    /// `document` is a rules file exactly as read from disk; the extension validates it.
    case importRules(document: Data, replace: Bool)
    case updateSettings(Settings)
    case profiles
    case saveProfile(Profile)
    case deleteProfile(UUID)
    /// Manually activate a profile (nil: only rules that apply in every profile).
    case activateProfile(UUID?)
    /// The app reports the current Wi-Fi network, which the extension can't read itself.
    case networkChanged(NetworkContext)
    case blocklists
    case saveBlocklist(Blocklist)
    case deleteBlocklist(UUID)
    /// Refresh one list now, or every enabled list with nil.
    case refreshBlocklists(UUID?)
    case traffic(TrafficQuery)
    case eraseHistory
    /// The app offers to answer alerts on this connection.
    case registerForAlerts

    /// Requests that change rules or behaviour. `tattlectl` must run as root (sudo) to
    /// send these.
    public var isPrivileged: Bool {
        switch self {
        case .status, .connections, .reviewItems, .rules, .exportRules, .profiles, .blocklists, .traffic: false
        default: true
        }
    }

    /// Requests only the app may send.
    public var isAppOnly: Bool {
        switch self {
        case .registerForAlerts, .networkChanged: true
        default: false
        }
    }
}

public enum ServiceResponse: Codable, Hashable, Sendable {
    case ok
    case failure(String)
    case status(ServiceStatus)
    case connections([ConnectionRecord])
    case reviewItems([ReviewItem])
    case rules([Rule])
    case document(Data)
    case imported(count: Int)
    case profiles([Profile])
    case blocklists([Blocklist])
    case traffic(TrafficReport)
}

/// Who is on the other end of an XPC connection, as established by the extension.
public enum Caller: Sendable, Equatable {
    case app
    case cli(isRoot: Bool)

    public func may(send request: ServiceRequest) -> Bool {
        switch self {
        case .app: true
        case .cli(let isRoot): !request.isAppOnly && (isRoot || !request.isPrivileged)
        }
    }
}

/// What the extension asks the user.
public struct AlertRequest: Codable, Hashable, Identifiable, Sendable {
    public var id: UUID
    public var time: Date
    public var process: ProcessIdentity
    public var pid: Int32?
    public var remoteHost: String?
    public var remoteAddress: String?
    public var remotePort: UInt16
    public var proto: TransportProtocol
    /// Seconds until the default policy applies.
    public var timeout: Double
    public var defaultPolicy: RuleAction

    public init(
        id: UUID = UUID(), time: Date = Date(), process: ProcessIdentity, pid: Int32?, remoteHost: String?,
        remoteAddress: String?, remotePort: UInt16, proto: TransportProtocol, timeout: Double, defaultPolicy: RuleAction
    ) {
        self.id = id
        self.time = time
        self.process = process
        self.pid = pid
        self.remoteHost = remoteHost
        self.remoteAddress = remoteAddress
        self.remotePort = remotePort
        self.proto = proto
        self.timeout = timeout
        self.defaultPolicy = defaultPolicy
    }

    public var displayHost: String { remoteHost ?? remoteAddress ?? "unknown" }
}

/// The user's answer to an alert.
public struct AlertAnswer: Codable, Hashable, Sendable {
    public var action: RuleAction
    public var lifetime: RuleLifetime
    /// Apply to every destination instead of just this host.
    public var anyHost: Bool
    /// Apply to every port instead of just this one.
    public var anyPort: Bool

    public init(action: RuleAction, lifetime: RuleLifetime, anyHost: Bool = false, anyPort: Bool = false) {
        self.action = action
        self.lifetime = lifetime
        self.anyHost = anyHost
        self.anyPort = anyPort
    }
}

/// JSON coding used for every XPC message.
public enum XPCCoding {
    public static func encode<T: Encodable>(_ value: T) -> Data {
        // Encoding our own value types can't fail.
        (try? RuleDocument.makeEncoder().encode(value)) ?? Data()
    }

    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        guard data.count <= XPCLimits.maxRequestBytes else { throw XPCError.messageTooLarge }
        return try RuleDocument.makeDecoder().decode(type, from: data)
    }
}

public enum XPCError: LocalizedError, CustomStringConvertible, Equatable {
    public var errorDescription: String? { description }

    case messageTooLarge
    case connectionFailed(String)
    case extensionNotAvailable

    public var description: String {
        switch self {
        case .messageTooLarge: "The message is too large."
        case .connectionFailed(let reason): "Couldn't reach the Tattle filter: \(reason)"
        case .extensionNotAvailable: "The Tattle filter extension isn't running."
        }
    }
}
