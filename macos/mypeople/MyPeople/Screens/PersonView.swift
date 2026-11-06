import AppKit
import MyPeopleKit
import SwiftUI

private enum PersonSheet: String, Identifiable {
    case edit, rename, nicknames, fact, note, relationship, history, split
    var id: String { rawValue }
}

private func capitalized(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }

/// One person's page. It follows them through merges by contact id.
struct PersonView: View {
    @Environment(AppModel.self) private var model
    var route: PersonRoute
    /// Beside the People list, the window's title stays "People".
    var titled = true
    @State private var sheet: PersonSheet?
    @State private var evidence: (id: String, event: Event)?
    @State private var forgetting: String?
    @State private var confirmingTrash = false
    @State private var confirmingUndo = false
    @State private var legacyWarning = false

    private var id: Int? { model.records.resolve(id: route.id, uid: route.uid) }

    var body: some View {
        if let id, let person = model.records.people[id] {
            content(id, person)
                .environment(\.personPalette, PersonPalette.of(person.paletteSeed))
                .navigationTitle(titled ? person.name : "People")
                .focusedSceneValue(\.editPerson) { sheet = .edit }
                .toolbar { toolbar(id, person) }
                .sheet(item: $sheet) { which in sheetContent(which, id, person) }
                .sheet(isPresented: Binding(get: { evidence != nil }, set: { if !$0 { evidence = nil } })) {
                    if let evidence { EvidenceSheet(event: evidence.event) { forgetting = evidence.id; self.evidence = nil } }
                }
                .confirmationDialog("Forget this fact?", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } })) {
                    Button("Forget", role: .destructive) {
                        if let forgetting, let eventId = Int(forgetting) { model.edit("event_forget", ["event_id": .int(eventId)]) }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("It's marked as wrong, so it won't be read back in again.")
                }
                .confirmationDialog("Move \(person.name) to Trash?", isPresented: $confirmingTrash) {
                    Button("Move to Trash", role: .destructive) { setTrashed(person, true) }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("They're hidden from your people and, after the next sync, from your phone. You can restore them from Trash.")
                }
                .confirmationDialog("Undo last merge?", isPresented: $confirmingUndo) {
                    Button("Undo Merge") { model.edit("merge_undo", ["person_id": .int(id)]) }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("This restores the separate records only if they haven't changed since merging. Otherwise nothing changes, and you'll be told why.")
                }
                .alert("Check this number first", isPresented: $legacyWarning) {
                    Button("Edit Contact") { sheet = .edit }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("Verify the original number and country in Edit Contact first. A legacy matching key may be missing its country code.")
                }
        } else {
            ContentUnavailableView("Person unavailable", systemImage: "person.crop.circle.badge.xmark", description: Text("They may have been merged or removed."))
        }
    }

    @ToolbarContentBuilder
    private func toolbar(_ id: Int, _ person: Person) -> some ToolbarContent {
        ToolbarItemGroup {
            Button {
                model.perform {
                    let _: NoReply = try await model.call("contact.patch", ["uid": .string(person.contactUid), "values": ["favorite": .bool(!person.isFavorite)]])
                }
            } label: {
                Label(person.isFavorite ? "Remove from Favorites" : "Add to Favorites", systemImage: person.isFavorite ? "star.fill" : "star")
            }
            Button { sheet = .edit } label: { Label("Edit Contact", systemImage: "pencil") }
            Menu {
                Button("Rename…") { sheet = .rename }
                Button("Nicknames…") { sheet = .nicknames }
                Button("Add Fact…") { sheet = .fact }
                Button("Add Note…") { sheet = .note }
                Button("Relationship Settings…") { sheet = .relationship }
                Divider()
                Button("Export vCard…") { exportVCards(model: model, people: [person]) }
                Button("Contact History…") { sheet = .history }
                Button("Split into Separate Contact…") { sheet = .split }
                    .disabled(!model.isReady)
                if person.canUndoMerge { Button("Undo Last Merge…") { confirmingUndo = true } }
                Divider()
                if person.trashed {
                    Button("Restore") { setTrashed(person, false) }
                } else {
                    Button("Move to Trash…", role: .destructive) { confirmingTrash = true }
                }
            } label: {
                Label("More", systemImage: "ellipsis.circle")
            }
        }
    }

    private func setTrashed(_ person: Person, _ trashed: Bool) {
        model.perform {
            let _: NoReply = try await model.call("contact.trash", ["uid": .string(person.contactUid), "trashed": .bool(trashed)])
        }
    }

    @ViewBuilder private func sheetContent(_ which: PersonSheet, _ id: Int, _ person: Person) -> some View {
        switch which {
        case .edit: ContactEditorView(uid: person.contactUid) { _ in }
        case .rename: RenameSheet(person: person)
        case .nicknames: NicknamesSheet(id: id)
        case .fact: AddFactSheet(id: id, name: person.name)
        case .note: AddNoteSheet(id: id, name: person.name)
        case .relationship: RelationshipSheet(id: id, person: person)
        case .history: HistorySheet(person: person)
        case .split: ContactSplitSheet(uid: person.contactUid, originalName: person.name) { reply in
            model.openSplitContact(reply)
        }
        }
    }

    private func content(_ id: Int, _ person: Person) -> some View {
        let events = model.derived("events:\(id)") { $0.eventsFor(id) }
        let profile = currentProfile(events.map(\.event))
        let links = model.derived("links:\(id)") { $0.confirmedProfiles(id) }
        return ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Hero(person: person, profile: profile)
                ReachActions(person: person) { legacyWarning = true }
                HStack {
                    Button { sheet = .note } label: { Label("Add a Note", systemImage: "square.and.pencil") }
                    Button { sheet = .fact } label: { Label("Add Fact", systemImage: "plus") }
                }
                ContactInfo(person: person, legacy: { legacyWarning = true }, edit: { sheet = .edit })
                if person.trashed { MetaLabel(text: "In trash · kept until you restore it") }

                SectionTitle(text: "Your relationship")
                RelationshipCard(person: person) { sheet = .relationship }

                if !links.isEmpty {
                    SectionTitle(text: "Around the web")
                    CardBox {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(links, id: \.url) { link in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(link.site).font(.headline)
                                    WebLink(url: link.url)
                                    Muted("Confirmed by you", font: .caption)
                                }
                            }
                        }
                    }
                }

                SectionTitle(text: "Notes and facts")
                if events.isEmpty {
                    Muted("Nothing yet. Add a note or a fact above.")
                }
                ForEach(events, id: \.id) { eventId, event in
                    Button { evidence = (eventId, event) } label: {
                        CardBox(padding: 12) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(formatDate(event.date)).font(.caption).foregroundStyle(Kin.onSurfaceVariant)
                                Text(event.value).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                                Label(event.isNote ? event.origin : "\(event.type) · \(event.origin)", systemImage: event.isManual ? "pencil" : "sparkles")
                                    .font(.caption).foregroundStyle(Kin.onSurfaceVariant)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button(event.isNote ? "Forget Note…" : "Forget Fact…") { forgetting = eventId }
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(Kin.surface)
    }
}

extension EnvironmentValues {
    @Entry var personPalette: PersonPalette?
}

private struct Hero: View {
    @Environment(\.personPalette) private var palette
    var person: Person
    var profile: [String: Event]

    var body: some View {
        let card = person.contactCard
        let work = [card.title, card.organization].filter { !$0.isEmpty }.joined(separator: " · ")
        let meta = !card.phonetic.isEmpty ? card.phonetic : !person.aliases.isEmpty ? person.aliases.joined(separator: " · ") : !work.isEmpty ? work : profile["job"]?.value
        let chips = [person.category == "unknown" ? nil : capitalized(person.category), person.isFavorite ? "Favorite" : nil, person.muted ? "Nudges muted" : nil].compactMap { $0 }
        VStack(spacing: 10) {
            Avatar(person, size: 88)
            Text(person.name).font(Kin.display(34)).multilineTextAlignment(.center).textSelection(.enabled)
            if let meta { Muted(meta).multilineTextAlignment(.center) }
            if !chips.isEmpty {
                HStack(spacing: 6) { ForEach(chips, id: \.self) { MetaLabel(text: $0) } }
            }
        }
        .padding(.vertical, 24)
        .padding(.horizontal, 20)
        .frame(maxWidth: .infinity)
        .background(palette?.wash ?? Kin.surfaceLow, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
}

/// Ways to reach someone. Their preferred channel comes first, in their accent; actions they have no
/// details for are hidden, never disabled.
private struct ReachActions: View {
    @Environment(\.personPalette) private var palette
    var person: Person
    var legacy: () -> Void

    var body: some View {
        let card = person.contactCard
        let phone = card.first("phone"), email = card.first("email")
        var actions: [(channel: String, title: String, symbol: String, run: () -> Void)] = []
        if let phone {
            actions.append(("call", "Call", "phone.fill", { reach(card, phone, message: false, legacy: legacy) }))
            actions.append(("text", "Message", "message.fill", { reach(card, phone, message: true, legacy: legacy) }))
        }
        if let email { actions.append(("email", "Email", "envelope.fill", { sendMail(email.value) })) }
        let ordered = actions.filter { $0.channel == card.preferredChannel } + actions.filter { $0.channel != card.preferredChannel }
        return HStack(spacing: 2) {
            ForEach(Array(ordered.enumerated()), id: \.offset) { index, action in
                Button(action: action.run) {
                    VStack(spacing: 3) {
                        Image(systemName: action.symbol)
                        Text(action.title).font(.caption.weight(.medium)).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .padding(.vertical, 4)
                    .foregroundStyle(index == 0 ? (palette?.onAccent ?? Kin.onPrimary) : (palette?.onContainer ?? Kin.onSecondaryContainer))
                    .background(index == 0 ? (palette?.accent ?? Kin.primary) : (palette?.container ?? Kin.secondaryContainer))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

@MainActor private func reach(_ card: ContactCard, _ field: ContactField, message: Bool, legacy: () -> Void) {
    guard let target = card.dialTarget(field), let url = message ? target.messageURL : target.telURL else {
        legacy()
        return
    }
    NSWorkspace.shared.open(url)
}

@MainActor private func sendMail(_ address: String) {
    var parts = URLComponents()
    parts.scheme = "mailto"
    parts.path = address.trimmingCharacters(in: .whitespacesAndNewlines)
    if let url = parts.url { NSWorkspace.shared.open(url) }
}

@MainActor private func openMaps(_ address: String) {
    var parts = URLComponents(string: "https://maps.apple.com/")
    parts?.queryItems = [URLQueryItem(name: "q", value: address)]
    if let url = parts?.url { NSWorkspace.shared.open(url) }
}

private struct ContactInfo: View {
    @Environment(AppModel.self) private var model
    @Environment(\.personPalette) private var palette
    var person: Person
    var legacy: () -> Void
    var edit: () -> Void

    private static let order = ["phone", "email", "address", "website"]

    var body: some View {
        let card = person.contactCard
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "Contact info")
            if !person.conflicts.isEmpty { ConflictBox(person: person) }
            if person.card == nil || card.legacyUnverified {
                Muted("Legacy matching numbers may lack country codes. Re-import your original contacts before relying on these for international calls.")
            }
            let fields = card.fields.enumerated().sorted { a, b in
                let ai = Self.order.firstIndex(of: a.element.kind) ?? Self.order.count, bi = Self.order.firstIndex(of: b.element.kind) ?? Self.order.count
                if ai != bi { return ai < bi }
                if a.element.preferred != b.element.preferred { return a.element.preferred }
                return a.offset < b.offset
            }.map(\.element)
            let work = [card.title, card.organization].filter { !$0.isEmpty }.joined(separator: " · ")
            if fields.isEmpty && work.isEmpty && card.birthday.isEmpty && card.notes.isEmpty {
                Muted("No details yet. Add a number or email in Edit Contact.")
            }
            VStack(spacing: 2) {
                ForEach(Array(fields.enumerated()), id: \.offset) { _, field in
                    row(card, field)
                }
                if !work.isEmpty { InfoRow(symbol: "person.2", value: work, label: "Work") }
                if !card.birthday.isEmpty { InfoRow(symbol: "gift", value: formatDate(card.birthday), label: "Birthday") }
                if !card.notes.isEmpty { InfoRow(symbol: "note.text", value: card.notes, label: "Your contact notes") }
            }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }

    @ViewBuilder private func row(_ card: ContactCard, _ field: ContactField) -> some View {
        let label = [field.label.isEmpty ? capitalized(field.kind) : field.label, field.preferred ? "Default" : ""].filter { !$0.isEmpty }.joined(separator: " · ")
        switch field.kind {
        case "phone":
            let unusable = card.dialTarget(field) == nil
            InfoRow(symbol: "phone", value: formatPhone(field.value), label: unusable ? "\(label) · check this number" : label,
                    action: { reach(card, field, message: false, legacy: legacy) }, trailing: ("Message", "message")) {
                reach(card, field, message: true, legacy: legacy)
            }
        case "email":
            InfoRow(symbol: "envelope", value: field.value, label: label, action: { sendMail(field.value) })
        case "address":
            InfoRow(symbol: "house", value: field.value, label: label, trailing: ("Directions", "map")) { openMaps(field.value) }
        case "website":
            InfoRow(symbol: "link", value: field.value, label: label, action: safeWebURL(field.value).map { url in { NSWorkspace.shared.open(url) } })
        default:
            InfoRow(symbol: "text.alignleft", value: field.value, label: label)
        }
    }
}

private struct InfoRow: View {
    @Environment(\.personPalette) private var palette
    var symbol: String
    var value: String
    var label: String
    var action: (() -> Void)?
    var trailing: (title: String, symbol: String)?
    var onTrailing: () -> Void = {}

    var body: some View {
        HStack(spacing: 12) {
            let content = HStack(spacing: 12) {
                Image(systemName: symbol).frame(width: 20).foregroundStyle(palette?.accent ?? Kin.primary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(value).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                    if !label.isEmpty { Text(label).font(.caption).foregroundStyle(Kin.onSurfaceVariant) }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
            if let action {
                Button(action: action) { content }.buttonStyle(.plain)
            } else {
                content
            }
            if let trailing {
                Button(action: onTrailing) { Image(systemName: trailing.symbol) }
                    .buttonStyle(.borderless)
                    .help(trailing.title)
                    .accessibilityLabel(trailing.title)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Kin.surfaceLow)
        .contextMenu {
            Button("Copy") { copyToPasteboard(value) }
        }
    }
}

/// Two devices changed the same detail independently. Neither edit is lost until someone chooses.
struct ConflictBox: View {
    @Environment(AppModel.self) private var model
    var person: Person

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Two versions, safely kept").font(.headline)
            Text("These details changed independently on different devices. Choose a version to share; neither edit has been lost.").font(.callout)
            ForEach(person.conflicts.sorted { $0.key < $1.key }, id: \.key) { field, choices in
                Text(field == "_trashed" ? "Trash status" : capitalized(field.replacingOccurrences(of: "_", with: " "))).font(.callout.weight(.semibold))
                ForEach(choices, id: \.change) { choice in
                    Button {
                        model.perform {
                            let _: NoReply = try await model.call("contact.resolve", ["uid": .string(person.contactUid), "field": .string(field), "change": .string(choice.change)])
                        }
                    } label: {
                        Text(verbatim: "Keep “\(describe(field, choice))”").lineLimit(3).multilineTextAlignment(.leading)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(Kin.onErrorContainer)
        .background(Kin.errorContainer, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func describe(_ field: String, _ choice: ContactConflict) -> String {
        switch field {
        case "photo": return "Photo · \(choice.change.prefix(8))"
        case "_trashed": return choice.value.bool == true ? "In trash" : "Active contact"
        default:
            let text = choice.value.displayText
            return text.isEmpty ? "(empty)" : String(text.prefix(160))
        }
    }
}

private struct RelationshipCard: View {
    @Environment(\.personPalette) private var palette
    var person: Person
    var adjust: () -> Void

    var body: some View {
        CardBox {
            VStack(alignment: .leading, spacing: 8) {
                if person.category != "unknown" || person.muted {
                    HStack {
                        if person.category != "unknown" { MetaLabel(text: capitalized(person.category)) }
                        if person.muted { MetaLabel(text: "Nudges muted") }
                    }
                }
                Text("Closeness · \(Int((person.closeness * 100).rounded()))%").font(.callout.weight(.medium))
                ProgressView(value: min(max(person.closeness, 0), 1)).tint(palette?.accent ?? Kin.primary)
                Text(person.cadenceDays.map { "Usually talk every ~\(Int($0.rounded())) days" } ?? "Still learning your rhythm")
                Muted("Last contact · \(formatDate(person.lastContact.map { String($0.prefix(10)) })) · Trend · \(person.trend)", font: .caption)
                if !person.channels.isEmpty {
                    Muted(person.channels.map { "\($0.channel) \($0.count)" }.joined(separator: " · "), font: .caption)
                }
                Button("Adjust your rhythm", action: adjust).buttonStyle(.link)
            }
        }
    }
}

private struct EvidenceSheet: View {
    @Environment(\.dismiss) private var dismiss
    var event: Event
    var forget: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Behind this fact").font(.title2.weight(.semibold))
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(event.value).textSelection(.enabled)
                    let quote = event.evidence?.isEmpty == false ? "“\(event.evidence!)”" : event.isManual ? "Your own words." : "No evidence quote was published for this fact."
                    Text(verbatim: quote)
                        .textSelection(.enabled)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Kin.secondaryContainer, in: RoundedRectangle(cornerRadius: 10))
                    Muted("\(event.origin) · \(event.isManual ? "on" : "said on") \(formatDate(event.saidAt.map { String($0.prefix(10)) }))", font: .caption)
                }
            }
            HStack {
                Button("Forget Fact…", role: .destructive, action: forget)
                Spacer()
                Button("Close") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 460, height: 340)
    }
}

// MARK: Editors

private struct SheetFrame<Content: View>: View {
    @Environment(\.dismiss) private var dismiss
    var title: String
    var confirm: String = "Save"
    var canConfirm = true
    var height: CGFloat? = nil
    var onConfirm: () async -> Bool
    @ViewBuilder var content: Content
    @State private var saving = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.title2.weight(.semibold))
            content
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(confirm) {
                    saving = true
                    Task {
                        if await onConfirm() { dismiss() }
                        saving = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canConfirm || saving)
            }
        }
        .padding(20)
        .frame(width: 440, height: height)
    }
}

private struct RenameSheet: View {
    @Environment(AppModel.self) private var model
    var person: Person
    @State private var name: String
    @State private var error: String?

    init(person: Person) { self.person = person; _name = State(initialValue: person.name) }

    var body: some View {
        SheetFrame(title: "Rename", canConfirm: !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, onConfirm: save) {
            TextField("Name", text: $name).textFieldStyle(.roundedBorder)
            if let error { Text(error).foregroundStyle(Kin.error) }
        }
    }

    private func save() async -> Bool {
        do {
            let _: NoReply = try await model.call("contact.patch", ["uid": .string(person.contactUid), "values": ["name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines))]])
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}

private struct NicknamesSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var id: Int
    @State private var nickname = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Nicknames").font(.title2.weight(.semibold))
            let aliases = model.records.people[id]?.aliases ?? []
            if aliases.isEmpty { Muted("None yet. Add one below.") }
            ForEach(aliases, id: \.self) { alias in
                HStack {
                    Text(alias)
                    Spacer()
                    Button("Remove") { model.edit("alias_remove", ["person_id": .int(id), "alias": .string(alias)]) }
                }
            }
            HStack {
                TextField("Nickname", text: $nickname).textFieldStyle(.roundedBorder).onSubmit(add)
                Button("Add", action: add).disabled(nickname.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(20)
        .frame(width: 400)
    }

    private func add() {
        let text = nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        model.edit("alias_add", ["person_id": .int(id), "alias": .string(text)])
        nickname = ""
    }
}

private struct AddFactSheet: View {
    @Environment(AppModel.self) private var model
    var id: Int
    var name: String
    @State private var type = "other"
    @State private var value = ""
    @State private var date = ""
    @State private var error: String?

    private var dateValid: Bool { date.trimmingCharacters(in: .whitespaces).isEmpty || !normalizeDate(date).isEmpty }

    var body: some View {
        SheetFrame(title: "Add a fact about \(name)", canConfirm: !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && dateValid, onConfirm: save) {
            Picker("Type", selection: $type) { ForEach(eventTypes, id: \.self) { Text(capitalized($0)).tag($0) } }
            TextField("Fact", text: $value, axis: .vertical).lineLimit(2...5).textFieldStyle(.roundedBorder)
            TextField("Date (optional)", text: $date).textFieldStyle(.roundedBorder)
            Muted(dateValid ? "YYYY, YYYY-MM, YYYY-MM-DD or --MM-DD" : "Use YYYY, YYYY-MM, YYYY-MM-DD or --MM-DD.", font: .caption)
            if let error { Text(error).foregroundStyle(Kin.error) }
        }
    }

    private func save() async -> Bool {
        do {
            let _: EditReply = try await model.call("edit.apply", ["kind": "event_add", "payload": [
                "person_id": .int(id), "type": .string(type), "value": .string(value.trimmingCharacters(in: .whitespacesAndNewlines)), "date": .string(date.trimmingCharacters(in: .whitespaces)),
            ]])
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}

private struct AddNoteSheet: View {
    @Environment(AppModel.self) private var model
    var id: Int
    var name: String
    @State private var text = ""
    @State private var error: String?

    var body: some View {
        SheetFrame(title: "Add a note about \(name)", confirm: "Add Note", canConfirm: !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, onConfirm: save) {
            TextField("What would you like to remember?", text: $text, axis: .vertical).lineLimit(3...8).textFieldStyle(.roundedBorder)
            Muted("Saved as you wrote it, on their contact.", font: .caption)
            if let error { Text(error).foregroundStyle(Kin.error) }
        }
    }

    private func save() async -> Bool {
        do {
            let _: EditReply = try await model.call("edit.apply", ["kind": "note", "payload": ["person_id": .int(id), "text": .string(text.trimmingCharacters(in: .whitespacesAndNewlines))]])
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}

private struct RelationshipSheet: View {
    @Environment(AppModel.self) private var model
    var id: Int
    @State private var category: String
    @State private var autoCloseness = false
    @State private var closeness: Double
    @State private var cadence: String
    @State private var muted: Bool
    @State private var error: String?

    init(id: Int, person: Person) {
        self.id = id
        _category = State(initialValue: person.category)
        _closeness = State(initialValue: person.closeness)
        _cadence = State(initialValue: person.cadenceDays.map { String(Int($0.rounded())) } ?? "")
        _muted = State(initialValue: person.muted)
    }

    private var cadenceValue: Double? { Double(cadence.trimmingCharacters(in: .whitespaces)).flatMap { $0.isFinite && $0 > 0 ? $0 : nil } }
    private var cadenceValid: Bool { cadence.trimmingCharacters(in: .whitespaces).isEmpty || cadenceValue != nil }

    var body: some View {
        SheetFrame(title: "Relationship settings", canConfirm: cadenceValid, onConfirm: save) {
            Picker("Category", selection: $category) {
                Text("Automatic").tag("Automatic")
                ForEach(categories, id: \.self) { Text(capitalized($0)).tag($0) }
            }
            Toggle("Infer closeness automatically", isOn: $autoCloseness)
            if !autoCloseness {
                LabeledContent("Closeness · \(Int((closeness * 100).rounded()))%") { Slider(value: $closeness, in: 0...1) }
            }
            TextField("Contact cadence in days", text: $cadence).textFieldStyle(.roundedBorder)
            Muted("Leave blank to infer automatically.", font: .caption)
            Toggle("Mute nudges and upcoming", isOn: $muted)
            if let error { Text(error).foregroundStyle(Kin.error) }
        }
    }

    private func save() async -> Bool {
        do {
            let _: EditReply = try await model.call("edit.apply", ["kind": "relationship", "payload": [
                "person_id": .int(id),
                "category": category == "Automatic" ? .null : .string(category),
                "closeness": autoCloseness ? .null : .double(closeness),
                "cadence_days": JSONValue(cadenceValue),
                "muted": .bool(muted),
            ]])
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}

private struct HistorySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var person: Person
    @State private var history: ContactHistory?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Contact history").font(.title2.weight(.semibold))
            Muted("Every change to this card, newest first, from any device. History is never rewritten.")
            if let error { Text(error).foregroundStyle(Kin.error) }
            List(history?.changes ?? []) { change in
                VStack(alignment: .leading, spacing: 3) {
                    Text(summary(change))
                    Text(verbatim: String(change.id.prefix(12))).font(.caption.monospaced()).foregroundStyle(Kin.onSurfaceVariant)
                }
                .textSelection(.enabled)
                .padding(.vertical, 2)
            }
            HStack {
                if let history, history.total > history.changes.count { Muted("Showing the latest \(history.changes.count) of \(history.total).", font: .caption) }
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 560, height: 480)
        .task {
            do {
                history = try await model.call("contact.history", ["uid": .string(person.contactUid)])
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func summary(_ change: ContactHistory.Change) -> String {
        var parts = change.values.sorted { $0.key < $1.key }.map { key, value in
            let shown = value.displayText
            return "\(key.replacingOccurrences(of: "_", with: " ")): \(shown.isEmpty ? "(empty)" : String(shown.prefix(80)))"
        }
        if !change.addedFields.isEmpty { parts.append("\(change.addedFields.count) field\(change.addedFields.count == 1 ? "" : "s") added") }
        if change.removedFields > 0 { parts.append("\(change.removedFields) field\(change.removedFields == 1 ? "" : "s") removed") }
        if !change.links.isEmpty { parts.append("merged \(change.links.count) contact\(change.links.count == 1 ? "" : "s")") }
        return parts.isEmpty ? "No visible change" : parts.joined(separator: " · ")
    }
}
