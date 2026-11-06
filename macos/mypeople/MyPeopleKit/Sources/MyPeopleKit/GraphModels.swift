import Foundation

/// Wire models for the new graph engine. Swift deliberately does not reduce history or
/// implement identity/split rules. The existing app still uses the legacy engine view
/// until the graph projection and RPC cutover is complete.
public struct GraphOperation: Codable, Sendable, Equatable {
    public let id: String
    public let kind: String
    public let target: String
    public let payload: [String: JSONValue]
    public let replaces: [String]
}

public struct GraphCommit: Codable, Sendable, Equatable {
    public let id: String
    public let collection: String
    public let peer: String
    public let recordedAt: String
    public let version: Int
    public let parents: [String]
    public let operations: [GraphOperation]

    enum CodingKeys: String, CodingKey {
        case id, collection, peer, version, parents, operations
        case recordedAt = "recorded_at"
    }
}

public struct GraphAlternative: Codable, Sendable, Equatable {
    public let operation: String
    public let value: JSONValue
}

/// Domain endpoints and provisional values are supplied by the Python engine.
/// Alternatives remain explicit; rendering a provisional value never resolves one.
public struct GraphRecord: Codable, Sendable, Equatable {
    public let id: String
    public let type: String
    public let from: String?
    public let to: String?
    public let properties: [String: JSONValue]
    public let conflicts: [String: [GraphAlternative]]
}
