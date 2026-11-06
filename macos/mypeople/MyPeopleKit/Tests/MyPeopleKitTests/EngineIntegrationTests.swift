import Foundation
import Testing
@testable import MyPeopleKit

/// The real Python engine, from Swift, on real pipes, against a throwaway database under a throwaway
/// HOME. Set MYPEOPLE_SKIP_ENGINE_TESTS to skip, such as on a machine without uv.
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["MYPEOPLE_SKIP_ENGINE_TESTS"] == nil))
struct EngineIntegrationTests {
    actor Sink {
        var events: [EngineEvent] = []
        func add(_ event: EngineEvent) { events.append(event) }
    }

    final class Harness: Sendable {
        let home: URL
        let transport: ProcessTransport
        let client: EngineClient
        let sink = Sink()

        init(seed: String? = nil) async throws {
            home = FileManager.default.temporaryDirectory.appendingPathComponent("mypeople-engine-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: home.appendingPathComponent(".mypeople"), withIntermediateDirectories: true)
            let shell = await EngineLocator.loginShellPath()
            // Always test this checkout, never whatever happens to be installed.
            let locator = EngineLocator(shellPath: shell, isExecutable: { FileManager.default.isExecutableFile(atPath: $0) && $0.hasSuffix("/uv") })
            let command = try #require(locator.locate(), "uv and this repository's checkout are required")

            let realHome = NSHomeDirectory()
            var env = EngineLocator.childEnvironment(shellPath: shell)
            env["HOME"] = home.path
            env["MYPEOPLE_DB"] = home.appendingPathComponent(".mypeople/test.db").path
            env["MYPEOPLE_ENV_FILE"] = "/dev/null"
            env["MYPEOPLE_PI_AUTH"] = "/dev/null"
            // uv keeps its own caches under the real home, so moving HOME doesn't mean downloading again.
            env["UV_CACHE_DIR"] = env["UV_CACHE_DIR"] ?? realHome + "/.cache/uv"
            env["UV_PYTHON_INSTALL_DIR"] = env["UV_PYTHON_INSTALL_DIR"] ?? realHome + "/.local/share/uv/python"
            env["UV_PROJECT_ENVIRONMENT"] = home.appendingPathComponent("venv").path
            // The core is what's under test; --all-extras would pull in browser and OSINT packages.
            let arguments = command.arguments.filter { $0 != "--all-extras" }
            if let seed {
                let process = Process()
                process.executableURL = command.executable
                process.arguments = Array(arguments.dropLast(2)) + ["python", "-c", seed]
                process.environment = env
                process.standardOutput = FileHandle.nullDevice
                let errors = Pipe()
                process.standardError = errors
                try process.run()
                let diagnostics = errors.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                try #require(process.terminationStatus == 0, "Synthetic seed failed: \(String(decoding: diagnostics, as: UTF8.self))")
            }
            transport = try ProcessTransport(executable: command.executable, arguments: arguments, environment: env)
            let sink = self.sink
            client = EngineClient(transport: transport) { await sink.add($0) }
            let client = self.client
            Task { await client.run() }
        }

        func finish() async {
            await client.stop()
            try? FileManager.default.removeItem(at: home)
        }
    }

    @Test func aFullConversationWithTheRealEngine() async throws {
        let h = try await Harness()
        let client = h.client
        do {
            let hello: Hello = try await client.call("app.hello")
            #expect(hello.protocolVersion == engineProtocolVersion)
            #expect(hello.db.hasSuffix("test.db"), "must be the throwaway database: \(hello.db)")

            var snapshot: ViewSnapshot = try await client.call("view.snapshot")
            #expect(snapshot.records.isEmpty)

            struct Create: Encodable, Sendable { var card: ContactCard }
            var card = ContactCard(name: "Ada Lovelace", region: "GB", fields: [ContactField(kind: "phone", value: "020 7946 0000", label: "Mobile")])
            card.notes = "línea 🦋"
            let saved: SavedContact = try await client.call("contact.save", encoding: Create(card: card))

            // The edit's delta came first, so the model would already show it.
            let events = await h.sink.events
            let deltas = events.compactMap { if case .viewDelta(let d) = $0 { d } else { nil } }
            var records = Records()
            deltas.forEach { records.apply($0) }
            let person = try #require(records.people[saved.personId])
            #expect(person.name == "Ada Lovelace")
            #expect(person.card?.notes == "línea 🦋")
            let phone = try #require(person.card?.first("phone"))
            #expect(person.card?.dialTarget(phone)?.number == "+442079460000")

            // Load, edit, save through Swift's model: nothing the engine stored may change by itself.
            struct Save: Encodable, Sendable { var uid: String; var card: ContactCard; var fingerprint: String }
            let loaded: LoadedContact = try await client.call("contact.get", ["uid": .string(saved.uid)])
            let unchanged: SavedContact = try await client.call("contact.save", encoding: Save(uid: saved.uid, card: loaded.card, fingerprint: loaded.fingerprint))
            #expect(unchanged.uid == saved.uid)
            let reloaded: LoadedContact = try await client.call("contact.get", ["uid": .string(saved.uid)])
            #expect(reloaded.card == loaded.card)
            #expect(reloaded.fingerprint == loaded.fingerprint)

            // A stale editor is refused, and its draft is the caller's to keep.
            await #expect(throws: EngineError.self) {
                let _: SavedContact = try await client.call("contact.save", encoding: Save(uid: saved.uid, card: loaded.card, fingerprint: "stale"))
            }

            let added: EditReply = try await client.call("edit.apply", ["kind": "event_add", "payload": ["person_id": .int(saved.personId), "type": "job", "value": "Analyst", "date": "1843"]])
            #expect(added.message == "Added.")

            snapshot = try await client.call("view.snapshot")
            let fresh = Records(snapshot: snapshot.records)
            #expect(fresh.events.values.contains { $0.value == "Analyst" })

            let status: SystemStatus = try await client.call("system.status")
            #expect(status.db.hasSuffix("test.db"))

            // A note is saved through the same edit path as a fact, with no model behind it.
            let noted: EditReply = try await client.call("edit.apply", ["kind": "note", "payload": ["person_id": .int(saved.personId), "text": "Allergic to peanuts"]])
            #expect(noted.message == "Noted.")
            snapshot = try await client.call("view.snapshot")
            let note = Records(snapshot: snapshot.records).events.values.first { $0.isNote }
            #expect(note?.value == "Allergic to peanuts" && note?.isManual == true)

            let vcard = h.home.appendingPathComponent("people.vcf")
            try "BEGIN:VCARD\nVERSION:3.0\nFN:Katherine Johnson\nEND:VCARD\n".write(to: vcard, atomically: true, encoding: .utf8)
            let job: StartedJob = try await client.call("job.start", ["kind": "import", "params": ["source": "vcf", "path": .string(vcard.path)]])
            var finished: JobFinished?
            for _ in 0..<400 {
                let all = await h.sink.events
                finished = all.compactMap { if case .jobFinished(let f) = $0, f.id == job.id { f } else { nil } }.first
                if finished != nil { break }
                try await Task.sleep(for: .milliseconds(50))
            }
            #expect(finished?.status == "succeeded")
        } catch {
            Issue.record("engine conversation failed: \(error)\n\(h.transport.diagnostics())")
        }
        await h.finish()
    }

    /// Every reply a screen decodes, from the real engine, so a change on either side fails here.
    @Test func everyScreensRepliesDecode() async throws {
        let h = try await Harness()
        let client = h.client
        do {
            struct Create: Encodable, Sendable { var card: ContactCard }
            struct Merged: Decodable, Sendable { var person_id: Int }
            func person(_ name: String, _ phone: String) async throws -> SavedContact {
                try await client.call("contact.save", encoding: Create(card: ContactCard(name: name, region: "US", fields: [ContactField(kind: "phone", value: phone)])))
            }
            let ada = try await person("Ada Lovelace", "+14155550101")
            let twin = try await person("Ada Lovelace", "+14155550102")
            let me = try await person("Example Owner", "+14155550103")
            let lost: SavedContact = try await client.call("contact.save", encoding: Create(card: ContactCard(name: "No Country", region: "US", fields: [ContactField(kind: "phone", value: "12")])))

            let nobody: MeReply = try await client.call("me.get")
            #expect(nobody.person == nil)
            let mine: MeReply = try await client.call("me.set", ["ids": JSONValue(ints: [me.personId])])
            #expect(mine.person?.name == "Example Owner")

            let cards: DupeCards = try await client.call("dupes.cards", ["ids": JSONValue(ints: [ada.personId, twin.personId])])
            #expect(cards.cards.map(\.id).sorted() == [ada.personId, twin.personId].sorted())

            let history: ContactHistory = try await client.call("contact.history", ["uid": .string(ada.uid)])
            #expect(history.total >= 1)
            #expect(history.changes.first?.id.isEmpty == false)

            let report: MigrationReport = try await client.call("report.migration")
            #expect(report.contacts >= 3)
            #expect(report.invalid.contains { $0.id == lost.personId })

            let today = LocalDay.today().description
            let _: EditReply = try await client.call("edit.apply", ["kind": "event_add", "payload": ["person_id": .int(ada.personId), "type": "birthday", "value": "Birthday", "date": .string(String("--" + today.dropFirst(5)))]])
            let preview: PreviewMoments = try await client.call("moments.preview", ["date": .string(today), "limit": 5])
            #expect(preview.moments.contains { $0.personId == ada.personId })

            let review: ProfileReview = try await client.call("profiles.review", ["include_diagnostics": true])
            #expect(review.profiles.isEmpty)

            // Merge last, because it changes who's who. The view must follow it.
            let merged: Merged = try await client.call("people.merge", ["ids": JSONValue(ints: [ada.personId, twin.personId])])
            let snapshot: ViewSnapshot = try await client.call("view.snapshot")
            let records = Records(snapshot: snapshot.records)
            #expect(records.resolve(id: ada.personId, uid: ada.uid) == merged.person_id)
            #expect(records.resolve(id: twin.personId, uid: twin.uid) == merged.person_id)
            #expect(records.people[merged.person_id]?.canUndoMerge == true)

            let vcf = h.home.appendingPathComponent("out.vcf")
            struct Exported: Decodable, Sendable { var count: Int; var path: String }
            let exported: Exported = try await client.call("contact.export", ["uids": JSONValue(strings: [ada.uid]), "path": .string(vcf.path)])
            #expect(exported.count == 1)
            #expect(try String(contentsOf: vcf, encoding: .utf8).contains("BEGIN:VCARD"))
        } catch {
            Issue.record("engine conversation failed: \(error)\n\(h.transport.diagnostics())")
        }
        await h.finish()
    }

    @Test func splittingExactSyntheticAttributionAndRejectingStaleReview() async throws {
        // Python owns even fixture mutations. This subprocess and the engine share only this test's
        // throwaway HOME/DB; credentials and model authentication are explicitly disabled above.
        let h = try await Harness(seed: #"""
from mypeople import db, contacts
conn = db.connect()
person = contacts.save(conn, '11111111-1111-4111-8111-111111111111', {
    'name': 'Cameron Example', 'region': 'US', 'fields': [
        {'kind': 'phone', 'value': '+14155550101', 'label': 'Cameron A'},
        {'kind': 'phone', 'value': '+14155550102', 'label': 'Cameron B'}]})
for value, kind in [('Cameron A note', 'note'), ('Cameron B note', 'note'), ('Cameron B builds bridges', 'job')]:
    conn.execute('INSERT INTO events (person_id,type,value,confidence,source,evidence) VALUES (?,?,?,1,?,?)',
                 (person, kind, value, 'manual', 'Synthetic evidence: ' + value))
for suffix in ['a', 'b']:
    conn.execute('INSERT INTO interactions (person_id,at,channel,direction,text,thread,source_ref) VALUES (?,?,?,?,?,?,?)',
                 (person, '2026-01-02T12:00:00', 'whatsapp', 'in', 'See you at the café', 'thread-' + suffix, 'synthetic:' + suffix))
conn.execute('INSERT INTO profiles (person_id,site,url,confidence,status) VALUES (?,?,?,1,?)',
             (person, 'Example', 'https://example.invalid/cameron-b', 'confirmed'))
conn.commit()
conn.close()
"""#)
        let client = h.client
        do {
            let hello: Hello = try await client.call("app.hello")
            #expect(URL(fileURLWithPath: hello.db).resolvingSymlinksInPath().path.hasPrefix(h.home.resolvingSymlinksInPath().path + "/"))
            let uid = "11111111-1111-4111-8111-111111111111"
            let before = try await client.contactAssociations(uid: uid)
            try before.validateSnapshot()
            #expect(Set(before.associations.map(\.kind)).isSuperset(of: ["phone", "note", "fact", "message", "profile"]))
            #expect(before.associations.filter { $0.kind == "message" }.count == 2)

            let _: NoReply = try await client.call("contact.patch", ["uid": .string(uid), "values": ["name": "Cameron Example Updated"]])
            let stale = ContactSplitRequest(uid: before.uid, name: "Cameron B", edges: [before.associations[0].id], heads: before.heads)
            do {
                _ = try await client.splitContact(stale)
                Issue.record("A review with stale heads must never mutate the graph")
            } catch let error as EngineError {
                #expect(error.isStaleAssociationSelection, "Expected stale refusal, got \(error)")
            }
            let unchanged: ViewSnapshot = try await client.call("view.snapshot")
            #expect(Records(snapshot: unchanged.records).people.count == 1)

            let loaded = try await client.contactAssociations(uid: uid)
            try loaded.validateSnapshot()
            let chosen = loaded.associations.filter {
                ($0.kind == "phone" && $0.label.contains("0102")) ||
                ($0.kind == "note" && $0.label == "Cameron B note") ||
                ($0.kind == "fact" && $0.label == "Cameron B builds bridges") ||
                ($0.kind == "message" && $0.thread == "thread-b") ||
                ($0.kind == "profile" && $0.label == "https://example.invalid/cameron-b")
            }
            #expect(chosen.count == 5)
            let reply = try await client.splitContact(ContactSplitRequest(uid: loaded.uid, name: "Cameron B", edges: chosen.map(\.id), heads: loaded.heads))
            #expect(reply.contactUid != uid)
            #expect(reply.personId > 0)

            // Navigation can use the reply immediately: the mutation's view delta preceded it.
            var records = Records()
            for event in await h.sink.events {
                if case .viewDelta(let delta) = event { records.apply(delta) }
            }
            #expect(records.people[reply.personId]?.name == "Cameron B")
            #expect(records.people[reply.personId]?.contactUid == reply.contactUid)

            let remaining = try await client.contactAssociations(uid: uid)
            let moved = try await client.contactAssociations(uid: reply.contactUid)
            let chosenEdges = Set(chosen.map(\.id))
            let chosenObjects = Set(chosen.map(\.objectId))
            let originalObjects = Set(loaded.associations.map(\.objectId))
            #expect(Set(remaining.associations.map(\.id)) == Set(loaded.associations.map(\.id)).subtracting(chosenEdges))
            #expect(Set(moved.associations.map(\.objectId)).intersection(originalObjects) == chosenObjects)
            #expect(Set(reply.review) == Set(remaining.associations.map(\.id)))
            #expect(remaining.associations.contains { $0.kind == "message" && $0.thread == "thread-a" })
            #expect(!remaining.associations.contains { $0.kind == "message" && $0.thread == "thread-b" })
            #expect(remaining.name == "Cameron Example Updated")

            // All engine-supplied kinds are selectable, including a previous primary name.
            // Python must keep the explicitly requested new name as the new card's display name.
            let oldName = try #require(remaining.associations.first { $0.kind == "name" })
            let named = try await client.splitContact(ContactSplitRequest(uid: remaining.uid, name: "Explicit New Display Name", edges: [oldName.id], heads: remaining.heads))
            let namedAssociations = try await client.contactAssociations(uid: named.contactUid)
            #expect(namedAssociations.name == "Explicit New Display Name")
            #expect(namedAssociations.associations.contains { $0.objectId == oldName.objectId })
        } catch {
            Issue.record("split conversation failed: \(error)\n\(h.transport.diagnostics())")
        }
        await h.finish()
    }

    @Test func closingStdinEndsTheEngineAndTheStream() async throws {
        let h = try await Harness()
        let hello: Hello = try await h.client.call("app.hello")
        #expect(hello.protocolVersion == engineProtocolVersion)
        await h.finish()
        await #expect(throws: EngineError.self) {
            for _ in 0..<200 {
                let _: Hello = try await h.client.call("app.hello")
                try await Task.sleep(for: .milliseconds(50))
            }
        }
    }
}
