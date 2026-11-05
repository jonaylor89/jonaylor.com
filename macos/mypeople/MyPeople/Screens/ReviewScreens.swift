import AppKit
import MyPeopleKit
import SwiftUI

struct ReviewProfilesView: View {
    @Environment(AppModel.self) private var model
    @State private var items: [ProfileReview.Item] = []
    @State private var diagnostics = false
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        let ids = model.derived("review-profile-ids") { $0.suggestedProfiles().map(\.id) }
        Page(title: "A second look", subtitle: "Good memory starts with getting people right.") {
            Muted("A suggestion is never a confirmed identity. Even a supported assessment needs your confirmation.")
            HStack {
                MetaLabel(text: "\(items.count) suggested profile\(items.count == 1 ? "" : "s")")
                Spacer()
                Toggle("Include inaccessible, conflicting and extra LinkedIn leads", isOn: $diagnostics).toggleStyle(.checkbox).font(.callout)
            }
            if let error { Text(error).foregroundStyle(Kin.error) }
            if loaded && items.isEmpty && error == nil {
                ContentUnavailableView("All caught up", systemImage: "checkmark.circle", description: Text("Suggested public profiles will appear here for your review. Discover finds them."))
            }
            ForEach(items) { item in
                card(item)
            }
        }
        .task(id: "\(ids)\(diagnostics)") { await load() }
    }

    private func card(_ item: ProfileReview.Item) -> some View {
        CardBox {
            VStack(alignment: .leading, spacing: 10) {
                PersonLinkRow(id: item.personId, detail: "\(item.site) · Suggested")
                if let title = item.title, !title.isEmpty { Text(title).font(.title3.weight(.medium)) }
                WebLink(url: item.url)
                if let assessment = item.assessment { MetaLabel(text: "Assessment · \(assessment)") }
                if let reason = item.reason, !reason.isEmpty { Muted(reason) }
                if let snippet = item.snippet, !snippet.isEmpty { Text(String(snippet.prefix(400))).font(.callout).textSelection(.enabled) }
                evidence(item)
                HStack {
                    Button("Confirm Identity") { decide(item, "confirmed") }
                    Button("Reject") { decide(item, "rejected") }
                }
            }
        }
    }

    @ViewBuilder private func evidence(_ item: ProfileReview.Item) -> some View {
        let page = item.evidence["page"]
        let matches = item.evidence["matches"]?.array ?? []
        let sources = Set((item.sources.array ?? []).compactMap { $0["source"]?.string }).sorted()
        DisclosureGroup("Evidence") {
            VStack(alignment: .leading, spacing: 6) {
                Muted("Access: \(page?["access"]?.string ?? "not fetched") · checked: \(page?["observed_at"]?.string ?? "unknown")", font: .caption)
                ForEach(Array(matches.enumerated()), id: \.offset) { _, match in
                    Text(verbatim: "“\(match["quote"]?.string ?? "")”").font(.callout).textSelection(.enabled)
                }
                Muted("Discovered via: \(sources.isEmpty ? "legacy search" : sources.joined(separator: ", "))", font: .caption)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
        }
        .font(.callout)
    }

    private func decide(_ item: ProfileReview.Item, _ status: String) {
        model.perform {
            let _: EditReply = try await model.call("edit.apply", ["kind": "profile_status", "payload": ["profile_id": .int(item.id), "status": .string(status)]])
            await load()
        }
    }

    private func load() async {
        do {
            let reply: ProfileReview = try await model.call("profiles.review", ["include_diagnostics": .bool(diagnostics)])
            items = reply.profiles
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }
}

struct ReviewDuplicatesView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let groups = model.derived("review-groups") { $0.duplicateGroups() }
        Page(title: "A second look", subtitle: "Good memory starts with getting people right.", maxWidth: 960) {
            MetaLabel(text: "\(groups.count) group\(groups.count == 1 ? "" : "s") to review")
            Muted("Compare the details before combining records. Similar names don't always mean the same person.")
            if groups.isEmpty {
                ContentUnavailableView("No duplicates to review", systemImage: "person.2", description: Text("People with potentially overlapping identities will appear side by side here."))
            }
            ForEach(groups, id: \.key) { key, group in
                DuplicateGroupCard(group: group).id(key)
            }
        }
    }
}

private struct DuplicateGroupCard: View {
    @Environment(AppModel.self) private var model
    var group: Dupes
    @State private var cards: [DupeCards.Card] = []
    @State private var selected: Set<Int> = []
    @State private var confirming: [Int]?
    @State private var error: String?

    private var ids: [Int] { group.personIds.filter { model.records.people[$0] != nil } }

    var body: some View {
        CardBox {
            VStack(alignment: .leading, spacing: 12) {
                Text("One person, or different people?").font(.title3.weight(.semibold))
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: 10) {
                        ForEach(ids, id: \.self) { id in record(id) }
                    }
                }
                ForEach(group.clues, id: \.self) { clue in
                    Label { Text(clue).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: "lightbulb") }
                        .font(.callout).foregroundStyle(Kin.onSurfaceVariant)
                }
                if let error { Text(error).foregroundStyle(Kin.error).font(.callout) }
                HStack {
                    Button("Merge Selected (\(selected.count))") { confirming = Array(selected) }.disabled(selected.count < 2)
                    Button("Merge All \(ids.count)") { confirming = ids }
                    Button("Not the Same Person") { distinct() }
                }
            }
        }
        .task(id: ids) { await load() }
        .confirmationDialog("Merge \(confirming?.count ?? 0) people?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })) {
            Button("Merge") { if let confirming { merge(confirming) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Their facts, identifiers and history will be combined. The record with the most conversation history is kept. You can undo from the kept person's page, provided those records haven't changed since.")
        }
    }

    private func record(_ id: Int) -> some View {
        let person = model.records.people[id]
        let card = cards.first { $0.id == id }
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                if let person { Avatar(person) }
                Spacer()
                Toggle("Select \(person?.name ?? "")", isOn: Binding(get: { selected.contains(id) }, set: { if $0 { selected.insert(id) } else { selected.remove(id) } }))
                    .labelsHidden().toggleStyle(.checkbox)
            }
            Button(person?.name ?? "") { model.open(id) }.buttonStyle(.link).font(.headline)
            Muted("Record #\(id)", font: .caption)
            ForEach(person?.contactCard.fields.prefix(8) ?? [], id: \.value) { field in
                Text(field.kind == "phone" ? formatPhone(field.value) : "\(field.value) (\(field.kind))").font(.caption).textSelection(.enabled)
            }
            if let card {
                ForEach(card.ids, id: \.self) { Text($0).font(.caption).foregroundStyle(Kin.onSurfaceVariant) }
                Text(card.channels.map { "\($0.channel) \($0.count)" }.joined(separator: " · ").isEmpty ? "No conversations" : card.channels.map { "\($0.channel) \($0.count)" }.joined(separator: " · ")).font(.caption)
                Muted("First · \(formatDate(card.first.map { String($0.prefix(10)) }))\nLast · \(formatDate(card.last.map { String($0.prefix(10)) }))", font: .caption)
                ForEach(card.now, id: \.self) { Text($0).font(.callout.weight(.medium)) }
                ForEach(card.facts.prefix(5), id: \.self) { Text($0).font(.caption) }
                ForEach(Array(card.said.prefix(3).enumerated()), id: \.offset) { _, said in
                    Text(verbatim: "“\(said.text)”").font(.caption).italic().foregroundStyle(Kin.onSurfaceVariant).lineLimit(3)
                }
            }
        }
        .padding(12)
        .frame(width: 250, alignment: .leading)
        .background(selected.contains(id) ? Kin.secondaryContainer : Kin.surfaceContainer, in: RoundedRectangle(cornerRadius: 10))
    }

    private func load() async {
        guard ids.count >= 2 else { return }
        cards = (try? await model.call("dupes.cards", ["ids": JSONValue(ints: ids)], as: DupeCards.self))?.cards ?? []
    }

    private func merge(_ chosen: [Int]) {
        model.perform {
            struct Merged: Decodable, Sendable { var person_id: Int }
            let merged: Merged = try await model.call("people.merge", ["ids": JSONValue(ints: chosen)])
            model.show("Merged into \(model.name(merged.person_id)). You can undo this from their page.")
        }
    }

    private func distinct() {
        let uids = ids.map { model.records.people[$0]?.contactUid ?? "" }
        model.edit("distinct", ["person_ids": JSONValue(ints: ids), "contact_uids": JSONValue(strings: uids)])
    }
}

struct ReviewConflictsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let people = model.derived("conflicted") { $0.conflicted() }
        Page(title: "Conflicts", subtitle: "The same detail, changed on two devices that hadn't seen each other.") {
            if people.isEmpty {
                ContentUnavailableView("Nothing to reconcile", systemImage: "checkmark.circle", description: Text("If two devices ever change the same detail independently, both versions wait here for you."))
            }
            ForEach(people, id: \.id) { id, person in
                VStack(alignment: .leading, spacing: 8) {
                    PersonLinkRow(id: id)
                    ConflictBox(person: person)
                }
            }
        }
    }
}
