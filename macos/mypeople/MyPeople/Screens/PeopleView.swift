import AppKit
import MyPeopleKit
import SwiftUI
import UniformTypeIdentifiers

struct PeopleView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var sort = PeopleSort.name
    @State private var merging: [Int]?
    @State private var trashing: [Int]?
    @FocusState private var searchFocused: Bool

    var body: some View {
        @Bindable var model = model
        HSplitView {
            list
                .frame(minWidth: 280, idealWidth: 320, maxWidth: 420)
            detail
                .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
                .background(Kin.surface)
        }
        .toolbar {
            Button { model.newContact() } label: { Label("New Contact", systemImage: "plus") }
                .disabled(!model.isReady)
        }
        .onChange(of: model.searchFocusRequest, initial: true) { searchFocused = model.searchFocusRequest > 0 }
        .confirmationDialog(mergeTitle, isPresented: Binding(get: { merging != nil }, set: { if !$0 { merging = nil } })) {
            Button("Merge") { if let merging { merge(merging) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Their facts, identifiers and history will be combined. The record with the most conversation history is kept. You can undo from the kept person's page, provided those records haven't changed since.")
        }
        .confirmationDialog(trashTitle, isPresented: Binding(get: { trashing != nil }, set: { if !$0 { trashing = nil } })) {
            Button("Move to Trash", role: .destructive) { if let trashing { setTrashed(trashing, true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("They're hidden from your people and, after the next sync, from your phone. You can restore them from Trash.")
        }
    }

    private var mergeTitle: String { "Merge \(merging?.count ?? 0) people?" }
    private var trashTitle: String { "Move \(trashing?.count ?? 0) to Trash?" }

    private var results: [(id: Int, person: Person)] {
        model.derived("search:\(sort.rawValue):\(query)") { $0.search(query, sort: sort) }
    }

    private var list: some View {
        @Bindable var model = model
        let results = results
        return VStack(spacing: 0) {
            VStack(spacing: 8) {
                TextField("Name, nickname, number or email", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .focused($searchFocused)
                Picker("Sort", selection: $sort) {
                    Text("A–Z").tag(PeopleSort.name)
                    Text("Favorites").tag(PeopleSort.favorites)
                    Text("Closest").tag(PeopleSort.closeness)
                    Text("Trash").tag(PeopleSort.trash)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            .padding(10)
            ScrollViewReader { proxy in
                HStack(spacing: 0) {
                    table(results)
                    if sort != .closeness && query.isEmpty && results.count > 30 {
                        LetterRail(letters: letters(results)) { letter in proxy.scrollTo("section-\(letter)", anchor: .top) }
                    }
                }
            }
            HStack {
                Text("\(results.count.formatted()) \(results.count == 1 ? "person" : "people")")
                    .font(.caption).foregroundStyle(Kin.onSurfaceVariant)
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
        }
    }

    private func letters(_ results: [(id: Int, person: Person)]) -> [String] {
        var seen: [String] = []
        for entry in results {
            let letter = contactLetter(entry.person.name)
            if seen.last != letter { seen.append(letter) }
        }
        return seen
    }

    private func table(_ results: [(id: Int, person: Person)]) -> some View {
        @Bindable var model = model
        return List(selection: $model.selectedPeople) {
            if sort == .closeness {
                ForEach(results, id: \.id) { row($0.id, $0.person) }
            } else {
                ForEach(sections(results), id: \.letter) { section in
                    Section {
                        ForEach(section.rows, id: \.id) { row($0.id, $0.person) }
                    } header: {
                        Text(section.letter).id("section-\(section.letter)")
                    }
                }
            }
        }
        .listStyle(.inset)
        .contextMenu(forSelectionType: Int.self) { ids in
            menu(Array(ids))
        }
        .overlay {
            if results.isEmpty {
                switch (query.isEmpty, sort) {
                case (false, _): ContentUnavailableView.search(text: query)
                case (true, .trash): ContentUnavailableView("Trash is empty", systemImage: "trash")
                case (true, .favorites): ContentUnavailableView("No favorites yet", systemImage: "star", description: Text("Star someone to keep them here."))
                default:
                    ContentUnavailableView {
                        Label("No one yet", systemImage: "person.2")
                    } description: {
                        Text("Import your contacts or messages to begin.")
                    } actions: {
                        Button("Import") { model.go(.importData) }
                    }
                }
            }
        }
    }

    private func row(_ id: Int, _ person: Person) -> some View {
        let job = person.card.map { [$0.title, $0.organization].filter { !$0.isEmpty }.joined(separator: " · ") } ?? ""
        return PersonRowContent(person: person, detail: person.aliases.first ?? job, size: 30)
            .overlay(alignment: .trailing) {
                if person.isFavorite { Image(systemName: "star.fill").font(.caption2).foregroundStyle(PersonPalette.of(person.paletteSeed).accent) }
            }
            .tag(id)
    }

    private func sections(_ results: [(id: Int, person: Person)]) -> [(letter: String, rows: [(id: Int, person: Person)])] {
        var out: [(letter: String, rows: [(id: Int, person: Person)])] = []
        for entry in results {
            let letter = contactLetter(entry.person.name)
            if out.last?.letter == letter { out[out.count - 1].rows.append(entry) } else { out.append((letter, [entry])) }
        }
        return out
    }

    @ViewBuilder private func menu(_ ids: [Int]) -> some View {
        if ids.count >= 2 {
            Button("Merge \(ids.count) People…") { merging = ids }
        }
        if !ids.isEmpty {
            Button(ids.count == 1 ? "Export vCard…" : "Export \(ids.count) vCards…") { export(ids) }
            Divider()
            if ids.allSatisfy({ model.records.people[$0]?.trashed == true }) {
                Button("Restore") { setTrashed(ids, false) }
            } else {
                Button("Move to Trash…", role: .destructive) { trashing = ids }
            }
        }
    }

    @ViewBuilder private var detail: some View {
        let selected = Array(model.selectedPeople).filter { model.records.people[$0] != nil }
        if selected.count == 1, let person = model.records.people[selected[0]] {
            NavigationStack {
                PersonView(route: PersonRoute(id: selected[0], uid: person.contactUid), titled: false)
            }
            .id(selected[0])
        } else if selected.count > 1 {
            VStack(spacing: 14) {
                HStack(spacing: -10) {
                    ForEach(selected.prefix(5), id: \.self) { id in
                        if let person = model.records.people[id] { Avatar(person, size: 52).overlay(Circle().stroke(Kin.surface, lineWidth: 2)) }
                    }
                }
                Text("\(selected.count) people selected").font(Kin.display(22))
                HStack {
                    Button("Merge…") { merging = selected }
                    Button("Export vCards…") { export(selected) }
                    if selected.allSatisfy({ model.records.people[$0]?.trashed == true }) {
                        Button("Restore") { setTrashed(selected, false) }
                    } else {
                        Button("Move to Trash…") { trashing = selected }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView("Choose someone", systemImage: "person.crop.circle", description: Text("Select one person to see their story, or several to merge or export them."))
        }
    }

    private func merge(_ ids: [Int]) {
        model.perform {
            struct Merged: Decodable, Sendable { var person_id: Int }
            let merged: Merged = try await model.call("people.merge", ["ids": JSONValue(ints: ids)])
            model.selectedPeople = [merged.person_id]
            model.show("Merged into \(model.name(merged.person_id)). You can undo this from their page.")
        }
    }

    private func setTrashed(_ ids: [Int], _ trashed: Bool) {
        let people = ids.compactMap { model.records.people[$0] }
        model.perform {
            for person in people {
                let _: NoReply = try await model.call("contact.trash", ["uid": .string(person.contactUid), "trashed": .bool(trashed)])
            }
            model.selectedPeople = []
        }
    }

    private func export(_ ids: [Int]) {
        exportVCards(model: model, people: ids.compactMap { model.records.people[$0] })
    }
}

@MainActor
func exportVCards(model: AppModel, people: [Person]) {
    let panel = NSSavePanel()
    panel.allowedContentTypes = [.vCard]
    panel.nameFieldStringValue = people.count == 1 ? "\(people[0].name).vcf" : "MyPeople Contacts.vcf"
    panel.message = "Contact files hold private details. Keep this somewhere safe."
    guard panel.runModal() == .OK, let url = panel.url else { return }
    model.perform {
        struct Exported: Decodable, Sendable { var count: Int }
        let reply: Exported = try await model.call("contact.export", ["uids": JSONValue(strings: people.map(\.contactUid)), "path": .string(url.path)])
        model.show("Exported \(reply.count) contact\(reply.count == 1 ? "" : "s").")
    }
}

private struct LetterRail: View {
    var letters: [String]
    var jump: (String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(letters, id: \.self) { letter in
                Button(letter) { jump(letter) }
                    .buttonStyle(.plain)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Kin.onSurfaceVariant)
                    .frame(width: 16)
                    .frame(maxHeight: 15)
            }
        }
        .padding(.vertical, 4)
    }
}
