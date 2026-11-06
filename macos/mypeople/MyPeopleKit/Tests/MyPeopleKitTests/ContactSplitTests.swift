import Foundation
import Testing
@testable import MyPeopleKit

struct ContactSplitTests {
    private func fixture() throws -> Data {
        let url = try #require(Bundle.module.url(forResource: "contact-associations", withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    @Test func exactEdgesAndAttributionDecodeWithoutGroupingOrDeduplication() throws {
        let loaded = try JSONDecoder().decode(ContactAssociations.self, from: fixture())
        #expect(loaded.associations.count == 9)
        #expect(loaded.heads.count == 2)
        try loaded.validateSnapshot()
        #expect(Set(loaded.associations.map(\.kind)) == ["phone", "email", "note", "fact", "profile", "message", "thread", "future_evidence"])
        let messages = loaded.associations.filter { $0.kind == "message" }
        #expect(messages[0].label == messages[1].label)
        #expect(messages[0].id != messages[1].id)
        #expect(messages[0].objectId != messages[1].objectId)
        #expect(messages[0].detail != messages[1].detail)
        #expect(messages[0].thread == "example-a")
        #expect(messages[0].channel == "whatsapp")
        #expect(messages[0].properties?["direction"] == "in")
        #expect(messages[0].ownerUid == loaded.uid)
        #expect(loaded.associations.first { $0.kind == "note" }?.label == "Met at the café 🦋")
        #expect(loaded.associations.first { $0.kind == "fact" }?.source == "note")
    }

    @Test func onlyExplicitEdgeIdsAndTheExactSnapshotHeadsAreSent() async throws {
        let transport = FakeTransport()
        let result = String(decoding: try fixture(), as: UTF8.self)
        transport.respond = { frame, t in
            let id = frame["id"]!.int!
            if frame["method"] == "contact.associations" {
                t.deliver("{\"id\":\(id),\"result\":\(result)}")
            } else {
                t.deliver("{\"id\":\(id),\"result\":{\"person_id\":42,\"contact_uid\":\"66666666-6666-4666-8666-666666666666\",\"review\":[\"44444444-4444-4444-8444-444444444447\"]}}")
            }
        }
        let client = EngineClient(transport: transport) { _ in }
        Task { await client.run() }
        let loaded = try await client.contactAssociations(uid: "11111111-1111-4111-8111-111111111111")
        let chosen = loaded.associations.filter { ["phone", "note", "fact"].contains($0.kind) } + [loaded.associations[5]]
        let request = ContactSplitRequest(uid: loaded.uid, name: "Cameron A 🦋", edges: chosen.map(\.id), heads: loaded.heads)
        let split = try await client.splitContact(request)
        #expect(split.personId == 42)
        #expect(split.contactUid == "66666666-6666-4666-8666-666666666666")
        #expect(split.review == [loaded.associations[6].id])
        let frame = try #require(transport.sent.last)
        #expect(frame["method"] == "contact.split")
        #expect(frame["params"]?["name"] == "Cameron A 🦋")
        #expect(frame["params"]?["uid"] == .string(loaded.uid))
        #expect(frame["params"]?["edges"] == JSONValue(strings: chosen.map(\.id)))
        #expect(frame["params"]?["heads"] == JSONValue(strings: loaded.heads))
        #expect(!chosen.map(\.id).contains(loaded.associations[6].id), "another message with the same label must not be inferred")
        #expect(Set(chosen.map(\.id)).isDisjoint(with: Set(chosen.map(\.objectId))))
        await client.stop()
    }

    @Test func staleSelectionIsAnExplicitRefusalAndNeverAutomaticallyRetried() async throws {
        let transport = FakeTransport()
        transport.respond = { frame, t in
            t.deliver("{\"id\":\(frame["id"]!.int!),\"error\":{\"code\":\"stale\",\"message\":\"Association heads changed; reload\"}}")
        }
        let client = EngineClient(transport: transport) { _ in }
        Task { await client.run() }
        let loaded = try JSONDecoder().decode(ContactAssociations.self, from: fixture())
        let request = ContactSplitRequest(uid: loaded.uid, name: "Separate Cameron", edges: [loaded.associations[0].id], heads: loaded.heads)
        do {
            _ = try await client.splitContact(request)
            Issue.record("stale selection should be refused")
        } catch let error as EngineError {
            #expect(error.isStaleAssociationSelection)
            #expect(error == .rpc(code: "stale", message: "Association heads changed; reload"))
        }
        #expect(transport.sent.count == 1)
        #expect(EngineError.rpc(code: "conflict", message: "").isStaleAssociationSelection)
        #expect(!EngineError.stopped.isStaleAssociationSelection)
        #expect(!EngineError.rpc(code: "invalid", message: "").isStaleAssociationSelection)
        await client.stop()
    }

    @Test func aLostSplitResponseIsNotAutomaticallyRetried() async throws {
        let transport = FakeTransport()
        transport.respond = { _, t in t.hangUp() }
        let client = EngineClient(transport: transport) { _ in }
        Task { await client.run() }
        let loaded = try JSONDecoder().decode(ContactAssociations.self, from: fixture())
        let request = ContactSplitRequest(uid: loaded.uid, name: "Cameron B", edges: [loaded.associations[0].id], heads: loaded.heads)
        await #expect(throws: EngineError.stopped) { try await client.splitContact(request) }
        #expect(transport.sent.count == 1, "A lost response might follow a committed split; only a person may retry after reloading")
    }

    @Test func invalidOrDuplicateWireIdentitiesRequireReloadInsteadOfSilentlyHidingEdges() throws {
        let loaded = try JSONDecoder().decode(ContactAssociations.self, from: fixture())
        #expect(throws: EngineError.self) {
            try ContactAssociations(uid: loaded.uid, name: loaded.name, heads: loaded.heads,
                                    associations: loaded.associations + [loaded.associations[0]]).validateSnapshot()
        }
        #expect(throws: EngineError.self) {
            try ContactAssociations(uid: loaded.uid, name: loaded.name, heads: loaded.heads + loaded.heads,
                                    associations: loaded.associations).validateSnapshot()
        }
        #expect(throws: EngineError.self) {
            try ContactAssociations(uid: "not-an-identity", name: loaded.name, heads: loaded.heads,
                                    associations: loaded.associations).validateSnapshot()
        }
    }

    @Test func malformedAssociationsCannotBecomeAnEmptySelectionSnapshot() throws {
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(ContactAssociations.self, from: Data(#"{"uid":"x","name":"X","associations":[]}"#.utf8))
        }
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(ContactAssociation.self, from: Data(#"{"id":"edge","kind":"phone","label":"123"}"#.utf8))
        }
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(ContactSplitReply.self, from: Data(#"{"person_id":42,"review":{}}"#.utf8))
        }
    }
}
