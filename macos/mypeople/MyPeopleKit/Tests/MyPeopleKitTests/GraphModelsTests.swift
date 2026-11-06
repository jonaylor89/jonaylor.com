import Foundation
import Testing
@testable import MyPeopleKit

struct GraphModelsTests {
    @Test func pythonAndAndroidGraphFixtureRoundTrips() throws {
        // One fixture shared by all three implementations, not a hand-maintained Swift copy.
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { root.deleteLastPathComponent() }
        let path = root.appendingPathComponent("android/mypeople/app/src/test/resources/versioned-graph.json")
        struct Fixture: Decodable { let commits: [GraphCommit] }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: path))
        #expect(fixture.commits.count == 3)
        #expect(fixture.commits[0].operations[1].payload["properties"]?["display"] == "Cameron 🌲")
        #expect(fixture.commits[1].operations[0].replaces.count == 1)
        let encoded = try JSONEncoder().encode(fixture.commits)
        #expect(try JSONDecoder().decode([GraphCommit].self, from: encoded) == fixture.commits)
        let value = try JSONDecoder().decode(JSONValue.self, from: encoded)
        #expect(value.array?.first?["recorded_at"] == "2026-01-01T00:00:00+00:00")
        #expect(value.array?.first?["recordedAt"] == nil)
    }

    @Test func graphRecordsRetainConflictAlternatives() throws {
        let json = #"{"id":"phone","type":"ContactPoint","properties":{"label":"work"},"conflicts":{"label":[{"operation":"a","value":"home"},{"operation":"b","value":"work"}]}}"#
        let record = try JSONDecoder().decode(GraphRecord.self, from: Data(json.utf8))
        #expect(record.conflicts["label"]?.count == 2)
        #expect(record.properties["label"] == "work")
        #expect(record.from == nil)
    }
}
