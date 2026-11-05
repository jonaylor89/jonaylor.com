import Foundation

// What the engine publishes (cli/mypeople/src/mypeople/publish.py), matching Android's Model.kt.
// Ids are database ids. The shared fixture engine-view.json keeps Python and Swift in step.

public struct Identifier: Sendable, Equatable, Hashable, Codable {
    public var kind: String
    public var value: String
    public init(kind: String, value: String) { self.kind = kind; self.value = value }
}

public struct ChannelCount: Sendable, Equatable, Codable {
    public var channel: String
    public var count: Int
    public init(channel: String, count: Int) { self.channel = channel; self.count = count }
}

public struct ContactConflict: Sendable, Equatable, Codable {
    public var change: String
    public var value: JSONValue
    public init(change: String, value: JSONValue) { self.change = change; self.value = value }
}

public struct ContactField: Sendable, Equatable, Codable {
    public var kind: String
    public var value: String
    public var label: String
    public var preferred: Bool
    public var structured: String
    public var region: String
    /// Where Call and Message go, from the engine's phone library. Empty means it won't guess.
    /// Display only: these two are never sent back, since the stored card doesn't have them.
    public private(set) var dial: String?
    public private(set) var dialExtension: String
    /// Keys this app doesn't know about, such as `user_added`. They survive an edit untouched.
    var extra: [String: JSONValue]

    public init(kind: String, value: String = "", label: String = "", preferred: Bool = false,
                structured: String = "", region: String = "") {
        self.kind = kind; self.value = value; self.label = label; self.preferred = preferred
        self.structured = structured; self.region = region; dial = nil; dialExtension = ""; extra = [:]
    }

    private static let known: Set<String> = ["kind", "value", "label", "preferred", "structured", "region", "dial", "dial_ext"]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        func s(_ key: String) -> String { c.value(AnyKey(key), default: "") }
        kind = s("kind"); value = s("value"); label = s("label"); structured = s("structured"); region = s("region")
        preferred = c.value(AnyKey("preferred"), default: false)
        dial = c.optional(AnyKey("dial")); dialExtension = s("dial_ext")
        extra = [:]
        for key in c.allKeys where !Self.known.contains(key.stringValue) {
            extra[key.stringValue] = c.optional(key) ?? .null
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        for (key, value) in extra { try c.encode(value, forKey: AnyKey(key)) }
        try c.encode(kind, forKey: AnyKey("kind"))
        try c.encode(value, forKey: AnyKey("value"))
        try c.encode(label, forKey: AnyKey("label"))
        try c.encode(preferred, forKey: AnyKey("preferred"))
        try c.encode(structured, forKey: AnyKey("structured"))
        try c.encode(region, forKey: AnyKey("region"))
    }
}

public struct ContactCard: Sendable, Equatable, Codable {
    public var name: String
    public var given = "", family = "", middle = "", prefix = "", suffix = "", phonetic = ""
    public var fields: [ContactField] = []
    public var birthday = "", organization = "", title = "", notes = "", photo = ""
    public var favorite = false
    public var preferredChannel = ""
    public var region = "US"
    public var legacyUnverified = false
    /// Every other key the card holds, notably `originals` and `source_records`. An edit must never
    /// drop them, and a newer CLI may add more.
    var extra: [String: JSONValue] = [:]

    public init(name: String, region: String = "US", fields: [ContactField] = [], legacyUnverified: Bool = false) {
        self.name = name; self.region = region; self.fields = fields; self.legacyUnverified = legacyUnverified
    }

    public var hasOriginals: Bool { !(extra["originals"]?.array ?? []).isEmpty }

    nonisolated(unsafe) private static let strings: [(String, WritableKeyPath<ContactCard, String>)] = [
        ("name", \.name), ("given", \.given), ("family", \.family), ("middle", \.middle), ("prefix", \.prefix), ("suffix", \.suffix),
        ("phonetic", \.phonetic), ("birthday", \.birthday), ("organization", \.organization), ("title", \.title), ("notes", \.notes),
        ("photo", \.photo), ("preferred_channel", \.preferredChannel), ("region", \.region),
    ]
    private static let known = Set(strings.map(\.0) + ["fields", "favorite", "legacy_unverified"])

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        name = ""
        for (key, path) in Self.strings { self[keyPath: path] = c.value(AnyKey(key), default: self[keyPath: path]) }
        fields = c.value(AnyKey("fields"), default: [])
        favorite = c.value(AnyKey("favorite"), default: false)
        legacyUnverified = c.value(AnyKey("legacy_unverified"), default: false)
        for key in c.allKeys where !Self.known.contains(key.stringValue) {
            extra[key.stringValue] = c.optional(key) ?? .null
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        for (key, value) in extra { try c.encode(value, forKey: AnyKey(key)) }
        for (key, path) in Self.strings { try c.encode(self[keyPath: path], forKey: AnyKey(key)) }
        try c.encode(fields, forKey: AnyKey("fields"))
        try c.encode(favorite, forKey: AnyKey("favorite"))
        try c.encode(legacyUnverified, forKey: AnyKey("legacy_unverified"))
    }

    /// Old matching keys have no reliable country: never silently turn them into +1.
    public func canNormalizePhone(_ field: ContactField) -> Bool {
        !legacyUnverified || hasInternationalPrefix(field.value)
    }

    public func first(_ kind: String) -> ContactField? {
        let matching = fields.filter { $0.kind == kind }
        return matching.first(where: \.preferred) ?? matching.first
    }
}

public func hasInternationalPrefix(_ raw: String) -> Bool {
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return value.hasPrefix("+") || value.hasPrefix("tel:+")
}

/// A number's targets for handing off to FaceTime and Messages, or nil if it shouldn't be dialled.
public struct DialTarget: Sendable, Equatable {
    public var number: String
    public var ext: String
    public var telURL: URL? { URL(string: "tel:\(number)" + (ext.isEmpty ? "" : ";ext=\(ext)")) }
    public var messageURL: URL? { URL(string: "sms:\(number)") }
}

public extension ContactCard {
    func dialTarget(_ field: ContactField) -> DialTarget? {
        guard field.kind == "phone", canNormalizePhone(field) else { return nil }
        if let dial = field.dial {
            return dial.isEmpty ? nil : DialTarget(number: dial, ext: field.dialExtension)
        }
        // A person with no card yet has only identifiers: use an explicitly international one.
        let digits = field.value.filter { $0.isNumber || $0 == "+" }
        return hasInternationalPrefix(field.value) && digits.count > 1 ? DialTarget(number: digits, ext: "") : nil
    }
}

public struct Person: Sendable, Equatable, Decodable {
    public var name: String
    public var contactUid = ""
    public var contactAliases: [String] = []
    public var card: ContactCard?
    public var trashed = false
    public var canUndoMerge = false
    public var conflicts: [String: [ContactConflict]] = [:]
    public var aliases: [String] = []
    public var identifiers: [Identifier] = []
    public var avatarPath: String?
    public var category = "unknown"
    public var closeness = 0.0
    public var cadenceDays: Double?
    public var trend = "none"
    public var days365 = 0
    public var muted = false
    public var channels: [ChannelCount] = []
    public var firstContact: String?
    public var lastContact: String?

    public init(name: String, contactUid: String = "", aliases: [String] = [], identifiers: [Identifier] = [],
                card: ContactCard? = nil, closeness: Double = 0, channels: [ChannelCount] = [], lastContact: String? = nil,
                trashed: Bool = false, muted: Bool = false) {
        self.name = name; self.contactUid = contactUid; self.aliases = aliases; self.identifiers = identifiers
        self.card = card; self.closeness = closeness; self.channels = channels; self.lastContact = lastContact
        self.trashed = trashed; self.muted = muted
    }

    enum CodingKeys: String, CodingKey {
        case name, card, trashed, aliases, identifiers, category, closeness, trend, muted, channels
        case contactUid = "contact_uid", contactAliases = "contact_aliases", canUndoMerge = "can_undo_merge"
        case conflicts = "contact_conflicts", avatarPath = "avatar_path", cadenceDays = "cadence_days"
        case days365 = "days_365", firstContact = "first_contact", lastContact = "last_contact"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.value(.name, default: "")
        contactUid = c.value(.contactUid, default: "")
        contactAliases = c.value(.contactAliases, default: [])
        card = c.optional(.card)
        trashed = c.value(.trashed, default: false)
        canUndoMerge = c.value(.canUndoMerge, default: false)
        conflicts = c.value(.conflicts, default: [:])
        aliases = c.value(.aliases, default: [])
        identifiers = c.value(.identifiers, default: [])
        avatarPath = c.optional(.avatarPath)
        category = c.value(.category, default: "unknown")
        closeness = c.value(.closeness, default: 0)
        cadenceDays = c.optional(.cadenceDays)
        trend = c.value(.trend, default: "none")
        days365 = c.value(.days365, default: 0)
        muted = c.value(.muted, default: false)
        channels = c.value(.channels, default: [])
        firstContact = c.optional(.firstContact)
        lastContact = c.optional(.lastContact)
    }

    /// What to show for someone with no card yet: their known numbers and addresses, marked unverified.
    public var contactCard: ContactCard {
        card ?? ContactCard(name: name, fields: identifiers.filter { ["phone", "email"].contains($0.kind) }
            .map { ContactField(kind: $0.kind, value: $0.value) }, legacyUnverified: true)
    }

    public var isFavorite: Bool { card?.favorite == true }
    /// Stays the same when a name changes, so a person keeps their colours.
    public var paletteSeed: String { contactUid.isEmpty ? name : contactUid }
}

public struct Event: Sendable, Equatable, Decodable {
    public var personId: Int
    public var type: String
    public var value: String
    public var date = ""
    public var confidence = 1.0
    public var source = ""
    public var evidence: String?
    public var saidAt: String?
    public var createdAt = ""

    public init(personId: Int, type: String, value: String, date: String = "", source: String = "", saidAt: String? = nil, createdAt: String = "") {
        self.personId = personId; self.type = type; self.value = value; self.date = date
        self.source = source; self.saidAt = saidAt; self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
        case type, value, date, confidence, source, evidence
        case personId = "person_id", saidAt = "said_at", createdAt = "created_at"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        personId = try c.decode(Int.self, forKey: .personId)
        type = c.value(.type, default: "other")
        value = c.value(.value, default: "")
        date = c.value(.date, default: "")
        confidence = c.value(.confidence, default: 1)
        source = c.value(.source, default: "")
        evidence = c.optional(.evidence)
        saidAt = c.optional(.saidAt)
        createdAt = c.value(.createdAt, default: "")
    }
}

public struct Profile: Sendable, Equatable, Decodable {
    public var personId: Int
    public var site: String
    public var url: String
    public var title = ""
    public var status = "suggested"
    public var assessment = "possible"
    public var reason = ""
    public var confidence = 0.0

    public init(personId: Int, site: String, url: String, status: String = "suggested", assessment: String = "possible", confidence: Double = 0) {
        self.personId = personId; self.site = site; self.url = url
        self.status = status; self.assessment = assessment; self.confidence = confidence
    }

    enum CodingKeys: String, CodingKey {
        case site, url, title, status, assessment, reason, confidence
        case personId = "person_id"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        personId = try c.decode(Int.self, forKey: .personId)
        site = c.value(.site, default: "")
        url = c.value(.url, default: "")
        title = c.value(.title, default: "")
        status = c.value(.status, default: "suggested")
        assessment = c.value(.assessment, default: "possible")
        reason = c.value(.reason, default: "")
        confidence = c.value(.confidence, default: 0)
    }
}

public struct Moment: Sendable, Equatable, Decodable {
    public var personId: Int
    public var kind: String
    public var reason: String
    public var context: String?
    public var score = 0.0
    public var surfacedOn: String
    public var status = "new"

    public init(personId: Int, kind: String = "life", reason: String = "", context: String? = nil, score: Double = 0, surfacedOn: String, status: String = "new") {
        self.personId = personId; self.kind = kind; self.reason = reason; self.context = context
        self.score = score; self.surfacedOn = surfacedOn; self.status = status
    }

    enum CodingKeys: String, CodingKey {
        case kind, reason, context, score, status
        case personId = "person_id", surfacedOn = "surfaced_on"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        personId = try c.decode(Int.self, forKey: .personId)
        kind = c.value(.kind, default: "")
        reason = c.value(.reason, default: "")
        context = c.optional(.context)
        score = c.value(.score, default: 0)
        surfacedOn = c.value(.surfacedOn, default: "")
        status = c.value(.status, default: "new")
    }
}

public struct Dupes: Sendable, Equatable, Decodable {
    public var personIds: [Int]
    public var clues: [String]

    public init(personIds: [Int], clues: [String] = []) { self.personIds = personIds; self.clues = clues }

    enum CodingKeys: String, CodingKey { case clues; case personIds = "person_ids" }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        personIds = c.value(.personIds, default: [])
        clues = c.value(.clues, default: [])
    }
}

public let eventTypes = ["birthday", "job", "education", "move", "engagement", "wedding", "birth", "loss", "health", "trip", "achievement", "plan", "interest", "family", "promise", "other"]
public let categories = ["family", "partner", "friend", "work", "acquaintance", "unknown"]
