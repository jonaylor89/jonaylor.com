import AppKit
import MyPeopleKit
import SwiftUI
import UniformTypeIdentifiers

private struct DraftField: Identifiable, Equatable {
    let id = UUID()
    var field: ContactField
}

private struct SaveRequest: Encodable, Sendable {
    var uid: String?
    var card: ContactCard
    var fingerprint: String?
}

private func capitalized(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }

private func kindTitle(_ kind: String) -> String { kind == "im" ? "IM" : capitalized(kind) }

/// A real address-book editor, needing no model. It edits the complete stored card, loaded fresh,
/// and the engine refuses a save if the card changed since then.
struct ContactEditorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var uid: String?
    var saved: (SavedContact) -> Void

    @State private var card = ContactCard(name: "", region: Locale.current.region?.identifier ?? "US")
    @State private var fields: [DraftField] = []
    @State private var original: ContactCard?
    @State private var originalFields: [ContactField] = []
    @State private var fingerprint: String?
    @State private var loading = true
    @State private var loadError: String?
    @State private var saving = false
    @State private var error: String?
    @State private var showNameFields = false
    @State private var confirmDiscard = false
    @State private var changedElsewhere = false
    @State private var choosingPhoto = false

    private var edited: ContactCard {
        var result = card
        result.fields = fields.map(\.field)
        return result
    }

    private var isDirty: Bool {
        if uid == nil { return !card.name.isEmpty || !fields.isEmpty }
        guard let original else { return false }
        return edited != original
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Cancel") { isDirty ? (confirmDiscard = true) : dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(saving)
                Spacer()
                Text(uid == nil ? "New Contact" : "Edit Contact").font(.headline)
                Spacer()
                Button(saving ? "Saving…" : "Save") { Task { await save() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(saving || loading || loadError != nil || card.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(14)
            Divider()
            if let loadError {
                ContentUnavailableView("Couldn't load this contact", systemImage: "exclamationmark.triangle", description: Text(loadError))
            } else if loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                form
            }
        }
        .frame(width: 560, height: 680)
        .interactiveDismissDisabled(isDirty || saving)
        .task { await load() }
        .confirmationDialog("Discard unsaved changes?", isPresented: $confirmDiscard) {
            Button("Discard", role: .destructive) { dismiss() }
            Button("Keep Editing", role: .cancel) {}
        }
        .alert("This contact changed while you were editing", isPresented: $changedElsewhere) {
            Button("Keep My Draft", role: .cancel) {}
            Button("Discard Draft and Reload", role: .destructive) { Task { await load() } }
        } message: {
            Text("Something else updated it, such as your phone or a sync. Saving now could undo that, so nothing was saved. Your draft is still here: copy what you need, then reload.")
        }
        .fileImporter(isPresented: $choosingPhoto, allowedContentTypes: [.jpeg, .png]) { result in
            if case .success(let url) = result { choosePhoto(url) }
        }
    }

    private var form: some View {
        Form {
            Section {
                Muted("Details you maintain. Never overwritten by AI. Social profile links you add are confirmed for profile discovery and photo lookup.")
                if let error {
                    Text(error).foregroundStyle(Kin.error).textSelection(.enabled)
                }
                HStack(spacing: 14) {
                    photoPreview
                    VStack(alignment: .leading) {
                        Button("Choose Photo…") { choosingPhoto = true }
                        if !card.photo.isEmpty { Button("Remove Photo") { card.photo = "" } }
                    }
                }
                TextField("Display name", text: $card.name, prompt: Text("Required"))
                DisclosureGroup("More name fields", isExpanded: $showNameFields) {
                    TextField("Given name", text: $card.given)
                    TextField("Family name", text: $card.family)
                    TextField("Middle name", text: $card.middle)
                    TextField("Name prefix", text: $card.prefix)
                    TextField("Name suffix", text: $card.suffix)
                    TextField("Phonetic name", text: $card.phonetic)
                }
            }
            Section("Contact details") {
                if original?.legacyUnverified == true {
                    Toggle("I checked the original numbers and country codes. These details are ready for your phone.", isOn: Binding(
                        get: { !card.legacyUnverified }, set: { card.legacyUnverified = !$0 }))
                }
                TextField("Country for local numbers", text: Binding(get: { card.region }, set: { card.region = String($0.uppercased().prefix(2)) }), prompt: Text(verbatim: "US, DE, GB…"))
                Muted("International +country numbers are kept as they are.", font: .caption)
            }
            ForEach($fields) { $draft in
                Section(kindTitle(draft.field.kind)) {
                    TextField(kindTitle(draft.field.kind), text: Binding(get: { draft.field.value }, set: { value in
                        draft.field.value = value
                        if draft.field.kind == "address" { draft.field.structured = "" }
                    }), axis: draft.field.kind == "address" ? .vertical : .horizontal)
                    TextField("Label (Mobile, Work, Home…)", text: $draft.field.label)
                    if draft.field.kind == "phone" {
                        TextField("Country override (optional)", text: Binding(get: { draft.field.region }, set: { draft.field.region = String($0.uppercased().prefix(2)) }))
                    }
                    Toggle("Preferred \(draft.field.kind)", isOn: Binding(get: { draft.field.preferred }, set: { setPreferred(draft, $0) }))
                    Button("Remove Field", role: .destructive) { fields.removeAll { $0.id == draft.id } }
                }
            }
            Section("Add") {
                HStack {
                    ForEach(["phone", "email", "address", "website", "im", "anniversary"], id: \.self) { kind in
                        Button(kindTitle(kind)) { fields.append(DraftField(field: ContactField(kind: kind))) }
                    }
                }
            }
            Section("About") {
                TextField("Birthday (YYYY-MM-DD or --MM-DD)", text: $card.birthday)
                TextField("Organization", text: $card.organization)
                TextField("Job title", text: $card.title)
                TextField("Contact notes (no AI processing)", text: $card.notes, axis: .vertical).lineLimit(3...8)
                Picker("Preferred way to reach out", selection: $card.preferredChannel) {
                    Text("Ask").tag("")
                    Text("Call").tag("call")
                    Text("Text").tag("text")
                    Text("Email").tag("email")
                }
                Toggle("Pin to favorites", isOn: $card.favorite)
                if original?.hasOriginals == true {
                    Muted("Original vCard properties are retained for lossless recovery and export.", font: .caption)
                }
            }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder private var photoPreview: some View {
        if !card.photo.isEmpty, let data = Data(base64Encoded: card.photo), let image = NSImage(data: data) {
            Image(nsImage: image).resizable().scaledToFill().frame(width: 72, height: 72).clipShape(Circle())
        } else {
            Avatar(name: card.name, seed: uid ?? card.name, size: 72)
        }
    }

    private func setPreferred(_ draft: DraftField, _ preferred: Bool) {
        for index in fields.indices {
            if fields[index].id == draft.id {
                fields[index].field.preferred = preferred
            } else if preferred && fields[index].field.kind == draft.field.kind {
                fields[index].field.preferred = false
            }
        }
    }

    private func choosePhoto(_ url: URL) {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url), data.count <= 2 * 1024 * 1024,
              data.starts(with: [0xff, 0xd8, 0xff]) || data.starts(with: [0x89, 0x50, 0x4e, 0x47]) else {
            error = "Choose a JPEG or PNG smaller than 2 MiB."
            return
        }
        card.photo = data.base64EncodedString()
        error = nil
    }

    private func load() async {
        guard let uid else {
            loading = false
            return
        }
        loading = true
        defer { loading = false }
        do {
            let loaded: LoadedContact = try await model.call("contact.get", ["uid": .string(uid)])
            card = loaded.card
            original = loaded.card
            fingerprint = loaded.fingerprint
            fields = loaded.card.fields.map { DraftField(field: $0) }
            error = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        var card = edited
        card.name = card.name.trimmingCharacters(in: .whitespacesAndNewlines)
        // A field left empty is a field not added.
        card.fields.removeAll { $0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if !card.birthday.isEmpty && normalizeDate(card.birthday).isEmpty {
            error = "Use YYYY-MM-DD or --MM-DD for birthdays."
            return
        }
        do {
            let result: SavedContact = try await model.call("contact.save", encoding: SaveRequest(uid: uid, card: card, fingerprint: fingerprint))
            saved(result)
            dismiss()
        } catch let failure as EngineError where failure.isConflict {
            changedElsewhere = true
        } catch {
            self.error = error.localizedDescription
        }
    }
}
