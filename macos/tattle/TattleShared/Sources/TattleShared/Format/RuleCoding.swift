import Foundation

// The JSON shape of rules, documented in docs/rule-format.md. Changing it needs a new
// `RuleDocument.currentVersion` and a migration in `RuleDocument.decode`.

extension RemoteMatch: Codable {
    private enum CodingKeys: String, CodingKey { case type, value }
    private enum Kind: String, Codable { case any, host, domain, ip, cidr }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(Kind.self, forKey: .type)
        func value() throws -> String { try container.decode(String.self, forKey: .value) }
        func fail(_ message: String) -> DecodingError {
            .dataCorruptedError(forKey: .value, in: container, debugDescription: message)
        }
        switch kind {
        case .any: self = .any
        case .host: self = .host(try value())
        case .domain: self = .domain(try value())
        case .ip:
            guard let address = IPAddress(try value()) else { throw fail("Invalid IP address") }
            self = .ip(address)
        case .cidr:
            guard let network = IPNetwork(try value()) else { throw fail("Invalid CIDR network") }
            self = .network(network)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .any: try container.encode(Kind.any, forKey: .type)
        case .host(let name): try container.encode(Kind.host, forKey: .type); try container.encode(name, forKey: .value)
        case .domain(let name): try container.encode(Kind.domain, forKey: .type); try container.encode(name, forKey: .value)
        case .ip(let address): try container.encode(Kind.ip, forKey: .type); try container.encode(address.description, forKey: .value)
        case .network(let network): try container.encode(Kind.cidr, forKey: .type); try container.encode(network.description, forKey: .value)
        }
    }
}

extension PortMatch: Codable {
    private enum CodingKeys: String, CodingKey { case type, value, from, to }
    private enum Kind: String, Codable { case any, single, range }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .type) {
        case .any: self = .any
        case .single: self = .single(try container.decode(UInt16.self, forKey: .value))
        case .range: self = .range(try container.decode(UInt16.self, forKey: .from), try container.decode(UInt16.self, forKey: .to))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .any: try container.encode(Kind.any, forKey: .type)
        case .single(let port): try container.encode(Kind.single, forKey: .type); try container.encode(port, forKey: .value)
        case .range(let low, let high):
            try container.encode(Kind.range, forKey: .type)
            try container.encode(low, forKey: .from)
            try container.encode(high, forKey: .to)
        }
    }
}

extension Rule: Codable {
    private enum CodingKeys: String, CodingKey {
        case id, process, direction, remote, port, `protocol`, action, lifetime, profile, enabled
        case created, modified, note, system, boundProcess, bootSession
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(UUID.self, forKey: .id),
            process: try c.decodeIfPresent(ProcessMatch.self, forKey: .process) ?? .any,
            direction: try c.decodeIfPresent(TrafficDirection.self, forKey: .direction) ?? .outbound,
            remote: try c.decodeIfPresent(RemoteMatch.self, forKey: .remote) ?? .any,
            port: try c.decodeIfPresent(PortMatch.self, forKey: .port) ?? .any,
            proto: try c.decodeIfPresent(TransportProtocol.self, forKey: .protocol) ?? .any,
            action: try c.decode(RuleAction.self, forKey: .action),
            lifetime: try c.decodeIfPresent(RuleLifetime.self, forKey: .lifetime) ?? .forever,
            profileID: try c.decodeIfPresent(UUID.self, forKey: .profile),
            enabled: try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true,
            created: try c.decodeIfPresent(Date.self, forKey: .created) ?? Date(),
            modified: try c.decodeIfPresent(Date.self, forKey: .modified),
            note: try c.decodeIfPresent(String.self, forKey: .note),
            isSystem: try c.decodeIfPresent(Bool.self, forKey: .system) ?? false,
            boundProcess: try c.decodeIfPresent(ProcessInstance.self, forKey: .boundProcess),
            bootSession: try c.decodeIfPresent(String.self, forKey: .bootSession)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(process, forKey: .process)
        try c.encode(direction, forKey: .direction)
        try c.encode(remote, forKey: .remote)
        try c.encode(port, forKey: .port)
        try c.encode(proto, forKey: .protocol)
        try c.encode(action, forKey: .action)
        try c.encode(lifetime, forKey: .lifetime)
        try c.encodeIfPresent(profileID, forKey: .profile)
        try c.encode(enabled, forKey: .enabled)
        try c.encode(created, forKey: .created)
        try c.encode(modified, forKey: .modified)
        try c.encodeIfPresent(note, forKey: .note)
        try c.encode(isSystem, forKey: .system)
        try c.encodeIfPresent(boundProcess, forKey: .boundProcess)
        try c.encodeIfPresent(bootSession, forKey: .bootSession)
    }
}

/// A file of exported rules and profiles.
public struct RuleDocument: Codable, Equatable, Sendable {
    public static let formatName = "tattle-rules"
    public static let currentVersion = 1

    public var format: String
    public var version: Int
    public var exported: Date
    public var rules: [Rule]
    public var profiles: [Profile]

    public init(rules: [Rule], profiles: [Profile], exported: Date = Date()) {
        self.format = Self.formatName
        self.version = Self.currentVersion
        self.exported = exported
        // Only permanent rules are portable: the others are tied to this Mac's processes
        // or boot session.
        self.rules = rules.filter { $0.lifetime == .forever }
        self.profiles = profiles
    }

    public static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(Timestamp.format(date))
        }
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    public static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let date = Timestamp.parse(text) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date: \(text)")
            }
            return date
        }
        return decoder
    }

    public func encoded() throws -> Data {
        try Self.makeEncoder().encode(self)
    }

    public enum ImportError: Error, Equatable, CustomStringConvertible {
        case notATattleFile
        case unsupportedVersion(Int)
        case invalidRule(index: Int, reason: String)
        case tooLarge

        public var description: String {
            switch self {
            case .notATattleFile: "This isn't a Tattle rules file."
            case .unsupportedVersion(let version): "This rules file uses version \(version), which this version of Tattle can't read."
            case .invalidRule(let index, let reason): "Rule \(index + 1) is invalid: \(reason)"
            case .tooLarge: "The file has too many rules (the limit is \(RuleDocument.maxRules))."
            }
        }
    }

    public static let maxRules = 100_000

    /// Decodes and validates a file. Every rule is validated; until-quit and until-restart
    /// rules are dropped because they can't carry over from another session.
    public static func decode(_ data: Data) throws -> RuleDocument {
        let document: RuleDocument
        do {
            document = try makeDecoder().decode(RuleDocument.self, from: data)
        } catch {
            throw ImportError.notATattleFile
        }
        guard document.format == formatName else { throw ImportError.notATattleFile }
        guard document.version <= currentVersion else { throw ImportError.unsupportedVersion(document.version) }
        guard document.rules.count <= maxRules, document.profiles.count <= 1000 else { throw ImportError.tooLarge }
        var validated = document
        validated.rules = []
        for (index, rule) in document.rules.enumerated() where rule.lifetime == .forever {
            do {
                var clean = try rule.validated()
                clean.boundProcess = nil
                clean.bootSession = nil
                validated.rules.append(clean)
            } catch {
                throw ImportError.invalidRule(index: index, reason: "\(error)")
            }
        }
        validated.profiles = try document.profiles.map { try $0.validated() }
        return validated
    }
}

/// UTC ISO 8601 timestamps with millisecond precision ("2026-01-02T03:04:05.678Z").
///
/// Dates are kept at whole milliseconds everywhere (`Date.storedPrecision`) and converted
/// through integer milliseconds, so a rule's timestamps (which break precedence ties) are
/// identical before and after a save. Foundation's fractional ISO formatter drifts by a
/// millisecond on about half of all values, so it isn't used.
public enum Timestamp {
    private static let whole = Date.ISO8601FormatStyle()

    static func milliseconds(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    public static func format(_ date: Date) -> String {
        let ms = milliseconds(date)
        let seconds = ms >= 0 ? ms / 1000 : (ms - 999) / 1000
        let fraction = ms - seconds * 1000
        let text = Date(timeIntervalSince1970: Double(seconds)).formatted(whole)  // "...:05Z"
        return String(text.dropLast()) + String(format: ".%03lldZ", fraction)
    }

    /// Accepts "…:05Z" and "…:05.678Z" (extra fraction digits are truncated to milliseconds).
    public static func parse(_ text: String) -> Date? {
        guard text.hasSuffix("Z"), text.count <= 40 else { return nil }
        var base = String(text.dropLast())
        var fraction: Int64 = 0
        if let dot = base.lastIndex(of: ".") {
            let digits = base[base.index(after: dot)...]
            guard !digits.isEmpty, digits.count <= 9, digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
            fraction = Int64(String((digits + "00").prefix(3)))!
            base = String(base[..<dot])
        }
        guard let date = try? whole.parse(base + "Z") else { return nil }
        let seconds = Int64(date.timeIntervalSince1970.rounded())
        return Date(timeIntervalSince1970: Double(seconds * 1000 + fraction) / 1000)
    }
}

extension Date {
    /// This date rounded to whole milliseconds, the precision Tattle stores.
    public var storedPrecision: Date {
        Date(timeIntervalSince1970: Double(Timestamp.milliseconds(self)) / 1000)
    }
}
