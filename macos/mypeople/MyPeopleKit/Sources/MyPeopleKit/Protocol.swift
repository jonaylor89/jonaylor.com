import Foundation

// The wire format of `mypeople app-server`: see cli/mypeople/src/mypeople/appserver.py.

public let engineProtocolVersion = 4

public enum EngineError: Error, Equatable, LocalizedError {
    /// A refusal from the engine. Codes include stale, conflict, invalid, not_found, busy, database, model and internal.
    case rpc(code: String, message: String)
    case stopped
    case malformed(String)

    public var errorDescription: String? {
        switch self {
        case .rpc(_, let message): message
        case .stopped: "MyPeople's engine isn't running. Reconnect before continuing."
        case .malformed(let detail): "Unexpected reply from the engine: \(detail)"
        }
    }

    public var isConflict: Bool { if case .rpc("conflict", _) = self { true } else { false } }
}

public struct Hello: Sendable, Decodable {
    public var protocolVersion: Int
    public var version: String
    public var db: String
    enum CodingKeys: String, CodingKey { case version, db; case protocolVersion = "protocol" }
}

/// One record of the published view. A record this version doesn't recognize is carried as `unknown`
/// rather than failing the whole frame.
public enum ViewRecord: Sendable, Decodable {
    case person(Int, Person)
    case event(String, Event)
    case profile(String, Profile)
    case moment(String, Moment)
    case dupes(String, Dupes)
    case unknown

    enum CodingKeys: String, CodingKey { case kind, id, data }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind), id = try c.decode(String.self, forKey: .id)
        do {
            switch kind {
            case "person":
                guard let number = Int(id) else { self = .unknown; return }
                self = .person(number, try c.decode(Person.self, forKey: .data))
            case "event": self = .event(id, try c.decode(Event.self, forKey: .data))
            case "profile": self = .profile(id, try c.decode(Profile.self, forKey: .data))
            case "moment": self = .moment(id, try c.decode(Moment.self, forKey: .data))
            case "dupes": self = .dupes(id, try c.decode(Dupes.self, forKey: .data))
            default: self = .unknown
            }
        } catch {
            self = .unknown
        }
    }
}

public struct ViewDeletion: Sendable, Decodable {
    public var kind: String
    public var id: String
}

public struct ViewDelta: Sendable, Decodable {
    public var version: Int
    public var upserts: [ViewRecord]
    public var deletes: [ViewDeletion]
}

public struct ViewSnapshot: Sendable, Decodable {
    public var version: Int
    public var records: [ViewRecord]
}

public extension Records {
    init(snapshot: [ViewRecord]) {
        self.init()
        apply(upserts: snapshot, deletes: [])
    }

    mutating func apply(_ delta: ViewDelta) { apply(upserts: delta.upserts, deletes: delta.deletes) }

    private mutating func apply(upserts: [ViewRecord], deletes: [ViewDeletion]) {
        for record in upserts {
            switch record {
            case .person(let id, let v): people[id] = v
            case .event(let id, let v): events[id] = v
            case .profile(let id, let v): profiles[id] = v
            case .moment(let id, let v): moments[id] = v
            case .dupes(let id, let v): dupes[id] = v
            case .unknown: break
            }
        }
        for d in deletes {
            switch d.kind {
            case "person": if let id = Int(d.id) { people[id] = nil }
            case "event": events[d.id] = nil
            case "profile": profiles[d.id] = nil
            case "moment": moments[d.id] = nil
            case "dupes": dupes[d.id] = nil
            default: break
            }
        }
    }
}

public enum EngineEvent: Sendable {
    case viewDelta(ViewDelta)
    case viewState(refreshing: Bool, error: String?)
    case jobStarted(JobStarted)
    case jobOutput(id: Int, line: String)
    case jobProgress(id: Int, event: JSONValue)
    case jobFinished(JobFinished)
    case unknown(String)
}

public struct JobStarted: Sendable, Decodable {
    public var id: Int
    public var kind: String
    public var params: JSONValue
}

public struct JobFinished: Sendable, Decodable {
    public var id: Int
    public var kind: String
    public var code: Int
    /// succeeded, failed or cancelled.
    public var status: String
    public var message: String
}

/// `contact.get`: the full stored card, and what `contact.save` must quote back.
public struct LoadedContact: Sendable, Decodable {
    public var uid: String
    public var card: ContactCard
    public var fingerprint: String
}

public struct SavedContact: Sendable, Decodable {
    public var uid: String
    public var personId: Int
    enum CodingKeys: String, CodingKey { case uid; case personId = "person_id" }
}

public struct NoReply: Sendable, Decodable { public init(from decoder: Decoder) throws {} }

public struct EditReply: Sendable, Decodable { public var message: String? }

public struct StartedJob: Sendable, Decodable { public var id: Int }

public struct SystemStatus: Sendable, Decodable {
    public struct LLM: Sendable, Decodable {
        public var backend: String
        public var model: String
        public var local: Bool
        public var choices: [String]
    }
    public struct Secrets: Sendable, Decodable {
        public var path: String
        public var exists: Bool
        public var keys: [String: Bool]
    }
    public struct Extras: Sendable, Decodable {
        public var bluetooth: Bool
    }
    public struct Sources: Sendable, Decodable {
        public var imessage: Bool
        public var whatsapp: Bool
        public var mino: Bool
    }
    public struct Google: Sendable, Decodable {
        public var client: Bool
        public var signedIn: Bool
        enum CodingKeys: String, CodingKey { case client; case signedIn = "signed_in" }
    }
    public var db: String
    public var version: String
    public var python: String
    public var llm: LLM
    public var secrets: Secrets
    public var piAuth: Bool
    public var transferKey: Bool
    /// False: refused. Nil: nothing on this Mac to test it against.
    public var fullDiskAccess: Bool?
    public var extras: Extras
    public var sqlcipher: Bool
    public var sources: Sources
    public var google: Google

    enum CodingKeys: String, CodingKey {
        case db, version, python, llm, secrets, extras, sqlcipher, sources, google
        case piAuth = "pi_auth", transferKey = "transfer_key", fullDiskAccess = "full_disk_access"
    }
}

public struct MeReply: Sendable, Decodable {
    public struct Me: Sendable, Decodable {
        public var id: Int
        public var name: String
        public var aliases: [String]
        public var identifiers: [Identifier]
    }
    public var person: Me?
}

public struct PreviewMoments: Sendable, Decodable {
    public struct Item: Sendable, Decodable, Identifiable {
        public var key: String
        public var personId: Int
        public var name: String
        public var kind: String
        public var reason: String
        public var context: String?
        public var score: Double
        public var id: String { key }
        enum CodingKeys: String, CodingKey { case key, name, kind, reason, context, score; case personId = "person_id" }
    }
    public var moments: [Item]
}

public struct ProfileReview: Sendable, Decodable {
    public struct Item: Sendable, Decodable, Identifiable {
        public var id: Int
        public var personId: Int
        public var name: String
        public var site: String
        public var url: String
        public var title: String?
        public var snippet: String?
        public var reason: String?
        public var assessment: String?
        public var confidence: Double?
        public var evidence: JSONValue
        public var sources: JSONValue
        enum CodingKeys: String, CodingKey {
            case id, name, site, url, title, snippet, reason, assessment, confidence, evidence, sources
            case personId = "person_id"
        }
    }
    public var profiles: [Item]
}

public struct DupeCards: Sendable, Decodable {
    public struct Card: Sendable, Decodable, Identifiable {
        public struct Said: Sendable, Decodable { public var date: String; public var text: String }
        public var id: Int
        public var name: String
        public var ids: [String]
        public var channels: [ChannelCount]
        public var first: String?
        public var last: String?
        public var closeness: Double?
        public var now: [String]
        public var facts: [String]
        public var said: [Said]
        public var photos: [String]
    }
    public var cards: [Card]
    public var clues: [String]
}

public struct ContactHistory: Sendable, Decodable {
    public struct Change: Sendable, Decodable, Identifiable {
        public var id: String
        public var contactUid: String
        public var values: [String: JSONValue]
        public var addedFields: [JSONValue]
        public var removedFields: Int
        public var links: [String]
        public var parents: Int
        enum CodingKeys: String, CodingKey {
            case id, values, links, parents
            case contactUid = "contact_uid", addedFields = "added_fields", removedFields = "removed_fields"
        }
    }
    public var changes: [Change]
    public var total: Int
}

public struct MigrationReport: Sendable, Decodable {
    public struct Legacy: Sendable, Decodable, Hashable {
        public var id: Int
        public var name: String
        public var action: String
    }
    public struct Shared: Sendable, Decodable, Hashable {
        public var kind: String
        public var value: String
        public var people: [Int]
    }
    public struct Invalid: Sendable, Decodable, Hashable {
        public var id: Int
        public var value: String
    }
    public var contacts: Int
    public var trashed: Int
    public var legacy: [Legacy]
    public var shared: [Shared]
    public var invalid: [Invalid]
    enum CodingKeys: String, CodingKey {
        case contacts, trashed
        case legacy = "legacy_without_originals", shared = "shared_identifiers", invalid = "invalid_numbers"
    }
}

public struct UnnamedConversations: Sendable, Decodable {
    public struct Conversation: Sendable, Decodable, Identifiable {
        public struct Message: Sendable, Decodable { public var at: String; public var mine: Bool; public var text: String }
        public var accountId: String
        public var link: String
        /// Authors of tweets they sent you, which can identify who this is.
        public var tweetsShared: [String]
        public var messages: [Message]
        public var id: String { accountId }
        enum CodingKeys: String, CodingKey { case link, messages; case accountId = "account_id", tweetsShared = "tweets_shared" }
    }
    public var conversations: [Conversation]
}
