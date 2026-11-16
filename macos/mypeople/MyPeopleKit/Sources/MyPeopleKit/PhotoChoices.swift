import Foundation

public struct PhotoCandidate: Decodable, Sendable, Identifiable {
    public let id: String
    public let hash: String
    public let source: String
    public let sourceIdentity: String
    public let width: Int
    public let height: Int
    public let firstObserved: String
    public let lastObserved: String
    public let sourceUpdatedAt: String
    public let path: String?

    public var sourceLabel: String {
        switch source {
        case "groupme": "GroupMe"
        case "whatsapp": "WhatsApp"
        case "google": "Google Contacts"
        case "linkedin": "LinkedIn"
        case "manual": "Added by you"
        case "unknown": "Imported photo"
        default: source.capitalized
        }
    }

    enum CodingKeys: String, CodingKey {
        case id, hash, source, width, height, path
        case sourceIdentity = "source_identity", firstObserved = "first_observed"
        case lastObserved = "last_observed", sourceUpdatedAt = "source_updated_at"
    }
}

public struct PhotoChoices: Decodable, Sendable {
    public let candidates: [PhotoCandidate]
    public let selected: String
    public let preferred: String
    public let automatic: Bool
    public let automaticSelected: String
    public let conflict: Bool
    public let observed: [String]
    public let unavailablePreference: Bool

    enum CodingKeys: String, CodingKey {
        case candidates, selected, preferred, automatic, conflict, observed
        case automaticSelected = "automatic_selected"
        case unavailablePreference = "unavailable_preference"
    }
}
