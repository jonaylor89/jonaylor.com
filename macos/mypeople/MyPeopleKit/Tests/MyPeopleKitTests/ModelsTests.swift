import Foundation
import Testing
@testable import MyPeopleKit

struct ModelsTests {
    func fixture() throws -> (protocolVersion: Int, snapshot: ViewSnapshot) {
        let url = try #require(Bundle.module.url(forResource: "Fixtures/engine-view", withExtension: "json"))
        let data = try Data(contentsOf: url)
        struct Header: Decodable { var `protocol`: Int }
        return (try JSONDecoder().decode(Header.self, from: data).protocol, try JSONDecoder().decode(ViewSnapshot.self, from: data))
    }

    /// test_appserver.py checks this same file against what the engine really sends, so a change to
    /// the record shape fails on whichever side falls behind.
    @Test func sharedFixtureDecodesEveryRecordKind() throws {
        let (version, snapshot) = try fixture()
        #expect(version == engineProtocolVersion)
        let records = Records(snapshot: snapshot.records)
        #expect(snapshot.records.allSatisfy { if case .unknown = $0 { false } else { true } })
        #expect(records.people.count == 4)
        #expect(records.events.count >= 4)
        #expect(records.profiles.count == 2)
        #expect(records.moments.count >= 2)
        #expect(records.dupes.count == 1)
        let ada = try #require(records.people[2])
        #expect(ada.name == "Ada")
        #expect(ada.conflicts["notes"]?.count == 2)
        #expect(ada.channels.first?.channel == "whatsapp")
        #expect(ada.card?.region == "GB")
        let phone = try #require(ada.card?.first("phone"))
        #expect(ada.card?.dialTarget(phone)?.number == "+442079460000")
        #expect(records.people[4]?.avatarPath?.hasSuffix("alan.jpg") == true)
    }

    @Test func aCardRoundTripsEveryKeyItDoesntKnow() throws {
        let original = #"""
        {"name":"Ada","region":"GB","photo":"abc","favorite":true,"legacy_unverified":false,"user_edited":true,"edit_id":"e1",
         "originals":["BEGIN:VCARD"],"source_records":["s1"],"x_future":{"nested":[1,2.5,null,"t"]},
         "fields":[{"kind":"website","value":"https://a.test","label":"","preferred":false,"structured":"","region":"","user_added":true,"x_field":7}]}
        """#
        var card = try JSONDecoder().decode(ContactCard.self, from: Data(original.utf8))
        #expect(card.hasOriginals)
        card.notes = "edited"
        let saved = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(card))
        #expect(saved["notes"] == "edited")
        #expect(saved["originals"] == ["BEGIN:VCARD"])
        #expect(saved["source_records"] == ["s1"])
        #expect(saved["user_edited"] == true)
        #expect(saved["edit_id"] == "e1")
        #expect(saved["x_future"] == ["nested": [1, 2.5, nil, "t"]])
        #expect(saved["photo"] == "abc")
        let field = try #require(saved["fields"]?.array?.first)
        #expect(field["user_added"] == true)
        #expect(field["x_field"] == 7)
        #expect(field["value"] == "https://a.test")
    }

    @Test func editingContactPointValuesKeepsTheEnginesStableObjectIdentity() throws {
        var card = try JSONDecoder().decode(ContactCard.self, from: Data(#"{"name":"Cameron","fields":[{"kind":"phone","value":"+14155550101","label":"Mobile","object_id":"55555555-5555-4555-8555-555555555551"}]}"#.utf8))
        card.fields[0].value = "+14155550102"
        card.fields[0].label = "Work"
        let saved = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(card))
        let field = try #require(saved["fields"]?.array?.first)
        #expect(field["object_id"] == "55555555-5555-4555-8555-555555555551")
        #expect(field["value"] == "+14155550102")
        #expect(field["label"] == "Work")
    }

    @Test func displayHintsAreNeverSavedBack() throws {
        let card = try JSONDecoder().decode(ContactCard.self, from: Data(#"{"name":"A","fields":[{"kind":"phone","value":"1","dial":"+1","dial_ext":"2"}]}"#.utf8))
        let saved = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(card))
        let field = try #require(saved["fields"]?.array?.first)
        #expect(field["dial"] == nil)
        #expect(field["dial_ext"] == nil)
        #expect(card.fields[0].dial == "+1")
    }

    @Test func legacyNumbersAreNeverGuessedAt() throws {
        func field(_ json: String) throws -> ContactField { try JSONDecoder().decode(ContactField.self, from: Data(json.utf8)) }
        let local = try field(#"{"kind":"phone","value":"2079460000","dial":""}"#)
        let international = try field(#"{"kind":"phone","value":"+44 20 7946 0000","dial":"+442079460000","dial_ext":"12"}"#)
        var legacy = ContactCard(name: "L", fields: [local, international], legacyUnverified: true)
        #expect(legacy.dialTarget(local) == nil)
        #expect(legacy.dialTarget(international)?.telURL?.absoluteString == "tel:+442079460000;ext=12")
        #expect(legacy.dialTarget(international)?.messageURL?.absoluteString == "sms:+442079460000")
        legacy.legacyUnverified = false
        #expect(legacy.dialTarget(local) == nil, "the engine said it can't work this one out")
        // Someone with no card has only identifiers.
        let person = Person(name: "P", identifiers: [Identifier(kind: "phone", value: "5551234567"), Identifier(kind: "phone", value: "+1 555 123 4567"), Identifier(kind: "instagram", value: "x")])
        let card = person.contactCard
        #expect(card.legacyUnverified)
        #expect(card.fields.count == 2)
        #expect(card.dialTarget(card.fields[0]) == nil)
        #expect(card.dialTarget(card.fields[1])?.number == "+15551234567")
    }

    @Test func oneBadRecordDoesntCostTheRest() throws {
        let frame = #"""
        {"version":3,"records":[
          {"kind":"person","id":"1","data":{"name":"Ada"}},
          {"kind":"event","id":"9","data":{"no_person_id":true}},
          {"kind":"person","id":"not-a-number","data":{"name":"Bad"}},
          {"kind":"from_the_future","id":"1","data":{}}
        ]}
        """#
        let snapshot = try JSONDecoder().decode(ViewSnapshot.self, from: Data(frame.utf8))
        let records = Records(snapshot: snapshot.records)
        #expect(records.people.map(\.key) == [1])
        #expect(records.people[1]?.category == "unknown")
        #expect(records.events.isEmpty)
    }

    @Test func deltasUpsertAndDelete() throws {
        var records = Records(people: [1: Person(name: "Old"), 2: Person(name: "Gone")], events: ["7": Event(personId: 2, type: "job", value: "x")])
        let delta = try JSONDecoder().decode(ViewDelta.self, from: Data(#"""
        {"version":2,"upserts":[{"kind":"person","id":"1","data":{"name":"New"}}],
         "deletes":[{"kind":"person","id":"2"},{"kind":"event","id":"7"},{"kind":"nonsense","id":"1"}]}
        """#.utf8))
        records.apply(delta)
        #expect(records.people[1]?.name == "New")
        #expect(records.people[2] == nil)
        #expect(records.events.isEmpty)
    }
}
