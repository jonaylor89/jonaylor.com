import Foundation
import Testing
@testable import MyPeopleKit

extension EngineIntegrationTests {
    @Test func photoChoiceUsesRealEngineAndPreservesCandidates() async throws {
        let uid = "72000000-0000-4000-8000-000000000001"
        let seed = """
from mypeople import db, identity, photos
c = db.connect()
p = identity.create_person(c, 'Synthetic Photo Person')
c.execute('UPDATE people SET contact_uid=? WHERE id=?', ('\(uid)', p))
c.commit()
for source, size in [('groupme', 128), ('whatsapp', 512)]:
    image = b'\\x89PNG\\r\\n\\x1a\\n' + b'\\0' * 8 + size.to_bytes(4, 'big') * 2
    photos.save(c, p, source, image, source_identity='synthetic')
c.commit()
c.close()
"""
        let h = try await Harness(seed: seed)
        do {
            let initial: PhotoChoices = try await h.client.call("contact.photos", ["uid": .string(uid)])
            #expect(initial.candidates.count == 2)
            #expect(initial.automatic)
            let groupme = try #require(initial.candidates.first { $0.source == "groupme" })
            #expect(groupme.sourceIdentity == "synthetic")
            #expect(groupme.path != nil)
            let _: NoReply = try await h.client.call("contact.photo.choose", ["uid": .string(uid), "candidate": .string(groupme.id), "observed": JSONValue(strings: initial.observed)])
            let pinned: PhotoChoices = try await h.client.call("contact.photos", ["uid": .string(uid)])
            #expect(pinned.preferred == groupme.id && pinned.selected == groupme.id)
            #expect(pinned.candidates.count == 2)
            let _: NoReply = try await h.client.call("contact.photo.choose", ["uid": .string(uid), "candidate": .string("")])
            let automatic: PhotoChoices = try await h.client.call("contact.photos", ["uid": .string(uid)])
            #expect(automatic.automatic && automatic.preferred.isEmpty)
            #expect(automatic.candidates.count == 2)
            #expect(automatic.selected != groupme.id)
            await h.finish()
        } catch {
            await h.finish()
            throw error
        }
    }
}
