import Foundation

/// Exact graph associations supplied by Python. No identity inference or graph reduction lives here.
public struct ContactAssociation: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let kind: String
    public let label: String
    public let objectId: String
    public let detail: String?
    public let source: String?
    public let ownerUid: String?
    public let thread: String?
    public let conversationId: String?
    public let channel: String?
    public let at: String?
    public let properties: [String: JSONValue]?

    enum CodingKeys: String, CodingKey {
        case id, kind, label, detail, source, thread, channel, at, properties
        case objectId = "object_id", ownerUid = "owner_uid", conversationId = "conversation_id"
    }
}

/// A complete selection snapshot. Heads must be quoted unchanged when submitting a split.
public struct ContactAssociations: Decodable, Sendable, Equatable {
    public let uid: String
    public let name: String
    public let heads: [String]
    public let associations: [ContactAssociation]

    /// Validate wire identities without interpreting or reducing any graph rules.
    public func validateSnapshot() throws {
        let identities = [uid] + heads + associations.flatMap { [$0.id, $0.objectId] }
        guard identities.allSatisfy({ UUID(uuidString: $0) != nil }),
              Set(heads).count == heads.count,
              Set(associations.map(\.id)).count == associations.count else {
            throw EngineError.malformed("Association identities are invalid or duplicated. Update the CLI and reload.")
        }
    }
}

public struct ContactAssociationsRequest: Encodable, Sendable {
    public let uid: String
    public init(uid: String) { self.uid = uid }
}

/// IDs are the engine's exact association edges, never object IDs or inferred groups.
public struct ContactSplitRequest: Encodable, Sendable, Equatable {
    public let uid: String
    public let name: String
    public let edges: [String]
    public let heads: [String]

    public init(uid: String, name: String, edges: [String], heads: [String]) {
        self.uid = uid
        self.name = name
        self.edges = edges
        self.heads = heads
    }
}

public struct ContactSplitReply: Decodable, Sendable, Equatable {
    public let personId: Int
    public let contactUid: String
    /// Exact associations the engine kept with the original contact, for follow-up review.
    public let review: [String]
    public let heads: [String]?

    enum CodingKeys: String, CodingKey {
        case review, heads
        case personId = "person_id", contactUid = "contact_uid"
    }
}

public extension EngineError {
    /// Both the graph-specific stale refusal and the editor's compare-and-swap refusal need reload.
    var isStaleAssociationSelection: Bool {
        switch self {
        case .rpc(let code, _): code == "stale" || code == "stale_heads" || code == "conflict"
        default: false
        }
    }
}

public extension EngineClient {
    func contactAssociations(uid: String) async throws -> ContactAssociations {
        try await call("contact.associations", encoding: ContactAssociationsRequest(uid: uid))
    }

    func splitContact(_ request: ContactSplitRequest) async throws -> ContactSplitReply {
        try await call("contact.split", encoding: request)
    }
}
