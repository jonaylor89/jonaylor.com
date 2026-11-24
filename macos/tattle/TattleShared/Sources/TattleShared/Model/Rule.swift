import Foundation

/// What a rule does with a matching flow.
public enum RuleAction: String, Codable, Sendable, CaseIterable {
    case allow
    case deny
}

/// How long a rule lives.
public enum RuleLifetime: String, Codable, Sendable, CaseIterable {
    /// Applies to the one flow that prompted it. Never stored.
    case once
    /// Applies until the process that prompted it exits.
    case untilQuit
    /// Applies until the Mac restarts.
    case untilRestart
    /// Applies until deleted.
    case forever
}

public enum TrafficDirection: String, Codable, Sendable, CaseIterable {
    case outbound
    case inbound
    case any
}

public enum TransportProtocol: String, Codable, Sendable, CaseIterable {
    case tcp
    case udp
    case any
}

/// Which processes a rule applies to. Every non-nil field must match; all nil means any process.
///
/// `signingID` only matches processes whose code signature is valid, and `teamID` must
/// match too. Apple platform binaries carry the team ID `ProcessMatch.appleTeamID`. Unsigned
/// or ad-hoc-signed processes have no signing ID, so only `path` rules can match them.
public struct ProcessMatch: Codable, Hashable, Sendable {
    /// Team ID used for binaries signed by Apple (they have no team identifier).
    public static let appleTeamID = "apple"

    public var signingID: String?
    public var teamID: String?
    public var path: String?

    public init(signingID: String? = nil, teamID: String? = nil, path: String? = nil) {
        self.signingID = signingID
        self.teamID = teamID
        self.path = path
    }

    public static let any = ProcessMatch()

    public var isAny: Bool { signingID == nil && teamID == nil && path == nil }

    /// The rule for a specific process: its signing identity plus its path. Unsigned
    /// processes are matched by path alone.
    public init(identity: ProcessIdentity) {
        if identity.isSigned {
            self.init(signingID: identity.signingID, teamID: identity.teamID, path: identity.path)
        } else {
            self.init(path: identity.path)
        }
    }

    public func matches(_ identity: ProcessIdentity) -> Bool {
        if let signingID {
            guard identity.isSigned, identity.signingID == signingID else { return false }
        }
        if let teamID {
            guard identity.isSigned, identity.teamID == teamID else { return false }
        }
        if let path, identity.path != path { return false }
        return true
    }
}

/// Which remote endpoints a rule applies to.
public enum RemoteMatch: Hashable, Sendable {
    case any
    /// Exactly this host name.
    case host(String)
    /// This domain and all of its subdomains.
    case domain(String)
    /// Exactly this IP address.
    case ip(IPAddress)
    /// Any address in this network.
    case network(IPNetwork)

    public var isAny: Bool { self == .any }
}

public enum PortMatch: Hashable, Sendable {
    case any
    case single(UInt16)
    case range(UInt16, UInt16)

    public func contains(_ port: UInt16) -> Bool {
        switch self {
        case .any: true
        case .single(let value): port == value
        case .range(let low, let high): (low...high).contains(port)
        }
    }
}

/// One firewall rule. See `docs/rule-format.md` for semantics and the JSON format.
public struct Rule: Identifiable, Hashable, Sendable {
    public var id: UUID
    public var process: ProcessMatch
    public var direction: TrafficDirection
    public var remote: RemoteMatch
    public var port: PortMatch
    public var proto: TransportProtocol
    public var action: RuleAction
    public var lifetime: RuleLifetime
    /// nil: the rule applies in every profile.
    public var profileID: UUID?
    public var enabled: Bool
    public var created: Date
    public var modified: Date
    public var note: String?
    /// Part of the built-in "System" group that keeps macOS connected.
    public var isSystem: Bool
    /// For `untilQuit`: the process instance the rule is bound to.
    public var boundProcess: ProcessInstance?
    /// For `untilRestart`: the boot session the rule was created in.
    public var bootSession: String?

    public init(
        id: UUID = UUID(),
        process: ProcessMatch = .any,
        direction: TrafficDirection = .outbound,
        remote: RemoteMatch = .any,
        port: PortMatch = .any,
        proto: TransportProtocol = .any,
        action: RuleAction,
        lifetime: RuleLifetime = .forever,
        profileID: UUID? = nil,
        enabled: Bool = true,
        created: Date = Date(),
        modified: Date? = nil,
        note: String? = nil,
        isSystem: Bool = false,
        boundProcess: ProcessInstance? = nil,
        bootSession: String? = nil
    ) {
        self.id = id
        self.process = process
        self.direction = direction
        self.remote = remote
        self.port = port
        self.proto = proto
        self.action = action
        self.lifetime = lifetime
        self.profileID = profileID
        self.enabled = enabled
        self.created = created.storedPrecision
        self.modified = (modified ?? created).storedPrecision
        self.note = note
        self.isSystem = isSystem
        self.boundProcess = boundProcess
        self.bootSession = bootSession
    }

    /// Specific rules name a destination; general rules apply to any destination.
    public var isSpecific: Bool { !remote.isAny }

    /// Precedence tier: deny-specific (3) > allow-specific (2) > deny-general (1) > allow-general (0).
    public var tier: Int {
        (isSpecific ? 2 : 0) + (action == .deny ? 1 : 0)
    }

    /// True when this rule beats `other` for the same flow. Higher tier wins; ties go to the
    /// most recently modified rule, then to the larger ID so the order is total.
    public func outranks(_ other: Rule) -> Bool {
        if tier != other.tier { return tier > other.tier }
        if modified != other.modified { return modified > other.modified }
        return id.uuidString > other.id.uuidString
    }

    /// Everything about the flow except the remote endpoint, which the index checks.
    func matchesNonRemote(_ flow: FlowInfo) -> Bool {
        guard direction == .any || direction == flow.direction else { return false }
        guard proto == .any || proto == flow.proto else { return false }
        guard port.contains(flow.remotePort) else { return false }
        if let boundProcess, boundProcess != flow.processInstance { return false }
        return process.matches(flow.process)
    }
}

/// A single run of a process: its PID plus the kernel's PID version, which changes when
/// a PID is reused.
public struct ProcessInstance: Codable, Hashable, Sendable {
    public var pid: Int32
    public var pidVersion: Int32

    public init(pid: Int32, pidVersion: Int32) {
        self.pid = pid
        self.pidVersion = pidVersion
    }
}

// MARK: - Validation

public struct RuleValidationError: Error, Equatable, CustomStringConvertible {
    public let description: String
    init(_ description: String) { self.description = description }
}

extension Rule {
    static let maxFieldLength = 1024

    /// Rejects rules that could never match or that carry oversized or malformed fields.
    /// Everything arriving over XPC or from an import file goes through this.
    public func validated() throws -> Rule {
        var rule = self
        for (name, value) in [("signing ID", process.signingID), ("team ID", process.teamID), ("path", process.path), ("note", note)] {
            if let value, value.utf8.count > Self.maxFieldLength {
                throw RuleValidationError("The \(name) is too long.")
            }
        }
        if let signingID = process.signingID, signingID.isEmpty { throw RuleValidationError("The signing ID is empty.") }
        if let teamID = process.teamID, teamID.isEmpty { throw RuleValidationError("The team ID is empty.") }
        if let path = process.path, !path.hasPrefix("/") { throw RuleValidationError("The path must be absolute.") }
        switch remote {
        case .any, .ip, .network: break
        case .host(let name):
            guard let normalized = DomainName.normalize(name) else { throw RuleValidationError("“\(name)” isn't a valid host name.") }
            rule.remote = .host(normalized)
        case .domain(let name):
            guard let normalized = DomainName.normalize(name) else { throw RuleValidationError("“\(name)” isn't a valid domain.") }
            rule.remote = .domain(normalized)
        }
        if case .range(let low, let high) = port, low > high {
            throw RuleValidationError("The port range starts after it ends.")
        }
        if lifetime == .once { throw RuleValidationError("Rules that apply once aren't stored.") }
        if lifetime == .untilQuit, boundProcess == nil { throw RuleValidationError("An until-quit rule needs a process.") }
        return rule
    }
}
