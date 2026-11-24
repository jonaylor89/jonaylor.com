import Foundation

/// Who is behind a flow, resolved from its audit token.
public struct ProcessIdentity: Codable, Hashable, Sendable {
    /// Code-signing identifier, present only when the signature is valid.
    public var signingID: String?
    /// Team identifier, or `ProcessMatch.appleTeamID` for Apple platform binaries.
    public var teamID: String?
    public var path: String
    public var signature: SignatureStatus
    /// The kernel's name for the process, kept only when its executable can't be located
    /// (for example it was replaced while running). For display; never used for matching.
    public var name: String?

    public init(signingID: String?, teamID: String?, path: String, signature: SignatureStatus, name: String? = nil) {
        self.signingID = signingID
        self.teamID = teamID
        self.path = path
        self.signature = signature
        self.name = name
    }

    public var isSigned: Bool { signature == .apple || signature == .developer }

    /// Whether the executable was found on disk. Without it there's nothing stable to
    /// recognise the process by later, so rules for it can only last while it runs.
    public var isLocated: Bool { path.hasPrefix("/") }

    /// The executable's file name, or the bundle name for apps.
    public var displayName: String {
        if !isLocated, let name, !name.isEmpty { return name }
        let components = path.split(separator: "/")
        if let app = components.last(where: { $0.hasSuffix(".app") }) {
            return String(app.dropLast(4))
        }
        return components.last.map(String.init) ?? path
    }

    public static func unknown(path: String = "unknown", name: String? = nil) -> ProcessIdentity {
        ProcessIdentity(signingID: nil, teamID: nil, path: path, signature: .unknown, name: name)
    }
}

public enum SignatureStatus: String, Codable, Sendable {
    /// Signed by Apple (platform binary or Apple-signed software).
    case apple
    /// Validly signed by a developer team.
    case developer
    /// Ad-hoc signed: no certificate, so the identity proves nothing.
    case adHoc
    case unsigned
    /// The signature is present but fails validation.
    case invalid
    /// The process couldn't be inspected (for example, it already exited).
    case unknown
}

/// Everything the matcher needs to know about a new flow.
public struct FlowInfo: Hashable, Sendable {
    public var process: ProcessIdentity
    public var processInstance: ProcessInstance?
    public var direction: TrafficDirection
    public var proto: TransportProtocol
    /// The remote address, when known.
    public var remoteAddress: IPAddress?
    public var remotePort: UInt16
    /// Host names the remote address is known by: the flow's own host name first, then
    /// names recorded from DNS answers. Normalized (lowercase, no trailing dot).
    public var hostnames: [String]

    public init(
        process: ProcessIdentity,
        processInstance: ProcessInstance? = nil,
        direction: TrafficDirection = .outbound,
        proto: TransportProtocol,
        remoteAddress: IPAddress?,
        remotePort: UInt16,
        hostnames: [String] = []
    ) {
        self.process = process
        self.processInstance = processInstance
        self.direction = direction
        self.proto = proto
        self.remoteAddress = remoteAddress
        self.remotePort = remotePort
        self.hostnames = hostnames.compactMap(DomainName.normalize)
    }

    /// The best name to show for the destination.
    public var displayHost: String {
        hostnames.first ?? remoteAddress?.description ?? "unknown"
    }
}

/// Why a flow got its verdict.
public enum VerdictReason: String, Codable, Sendable {
    case rule
    case blocklist
    /// The user answered an alert.
    case alert
    /// Alert mode, but the alert timed out or no app was connected.
    case defaultPolicy
    case silentAllow
    case silentDeny
    /// The extension hit an internal limit (too many pending alerts).
    case overflow
    /// Ask mode, a DNS lookup (port 53) no rule covers. macOS attributes lookups to the app
    /// that asked, so alerting would ask twice per host: once for the name, once for the
    /// connection that follows. The connection still gets its alert.
    case dnsLookup
}

/// What the matcher decided for a flow. `sourceID` is the rule or blocklist responsible.
public enum Decision: Equatable, Sendable {
    case allow(VerdictReason, sourceID: UUID?)
    case deny(VerdictReason, sourceID: UUID?)
    /// No rule matched and the mode is alert: ask the user.
    case ask

    public var action: RuleAction? {
        switch self {
        case .allow: .allow
        case .deny: .deny
        case .ask: nil
        }
    }

    public var reason: VerdictReason? {
        switch self {
        case .allow(let reason, _), .deny(let reason, _): reason
        case .ask: nil
        }
    }

    public var sourceID: UUID? {
        switch self {
        case .allow(_, let id), .deny(_, let id): id
        case .ask: nil
        }
    }

    public static func of(_ action: RuleAction, _ reason: VerdictReason, sourceID: UUID? = nil) -> Decision {
        action == .allow ? .allow(reason, sourceID: sourceID) : .deny(reason, sourceID: sourceID)
    }
}
