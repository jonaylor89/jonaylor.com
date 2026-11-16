import AppKit
import MyPeopleKit
import SwiftUI

struct PhotoChooserSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let person: Person
    var addPhoto: () -> Void
    @State private var choices: PhotoChoices?
    @State private var selected = ""
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?

    private var groups: [[PhotoCandidate]] {
        Dictionary(grouping: choices?.candidates ?? [], by: \.hash).values.sorted { $0[0].id < $1[0].id }
    }
    private var preview: PhotoCandidate? {
        choices?.candidates.first { $0.id == (selected.isEmpty ? choices?.automaticSelected : selected) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Contact Photo").font(.title2.bold())
            Text(person.name).font(.headline)
            Muted("Your choice stays selected when new photos arrive. Automatic chooses a current, good-quality photo.")
            if loading { ProgressView("Loading photos…") }
            if let error {
                Text(error).foregroundStyle(Kin.error)
                Button("Reload Photos") { Task { await load() } }.disabled(saving)
            }
            if let choices {
                if choices.conflict {
                    Label("Different photos were chosen on your devices. Choose again to resolve this.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(Kin.error)
                }
                if choices.unavailablePreference {
                    Muted("Your preferred photo is unavailable. A temporary photo is shown; your preference is preserved until you choose again.")
                }
                HStack {
                    Spacer()
                    image(preview).frame(width: 160, height: 160)
                    Spacer()
                }
                if let preview {
                    let resolution = preview.width > 0 && preview.height > 0 ? "\(preview.width) × \(preview.height)" : "Resolution unknown"
                    Muted("\(preview.sourceLabel) · \(resolution) · \(preview.sourceUpdatedAt.isEmpty ? "Photo date unknown" : String(preview.sourceUpdatedAt.prefix(10)))", font: .caption)
                }
                Picker("Selection", selection: Binding(get: { selected.isEmpty }, set: { selected = $0 ? "" : choices.selected })) {
                    Text("Automatic").tag(true)
                    Text("Choose a Photo").tag(false)
                }
                .pickerStyle(.radioGroup)
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 108))], spacing: 12) {
                        ForEach(groups.indices, id: \.self) { index in
                            let copies = groups[index]
                            let candidate = copies.first { $0.id == selected } ?? copies[0]
                            let chosen = copies.contains { $0.id == selected }
                            let sources = Array(Set(copies.map(\.sourceLabel))).sorted().joined(separator: " · ")
                            Button { selected = candidate.id } label: {
                                VStack(spacing: 6) {
                                    image(candidate).frame(height: 96).frame(maxWidth: .infinity).clipped()
                                    Text(sources).font(.caption).lineLimit(2)
                                    if chosen { Label("Selected", systemImage: "checkmark.circle.fill").font(.caption) }
                                }
                                .padding(8)
                                .frame(maxWidth: .infinity)
                                .background(chosen ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(chosen ? Color.accentColor : Color.secondary.opacity(0.3), lineWidth: chosen ? 2 : 1))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(sources) photo")
                            .accessibilityAddTraits(chosen ? .isSelected : [])
                            .help(candidate.sourceUpdatedAt.isEmpty ? "Photo date unknown" : "Updated \(candidate.sourceUpdatedAt)")
                        }
                    }
                }
                if groups.isEmpty { Muted("No photos yet. Add a photo, or import profile pictures from your accounts.") }
            }
            Spacer(minLength: 0)
            HStack {
                Button("Add Photo…", action: addPhoto).disabled(saving)
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(saving)
                Button(saving ? "Saving…" : "Save") { Task { await save() } }
                    .keyboardShortcut(.defaultAction).disabled(choices == nil || saving || !model.isReady)
            }
        }
        .padding(24)
        .frame(width: 540, height: 650)
        .interactiveDismissDisabled(saving)
        .task { await load() }
    }

    @ViewBuilder private func image(_ candidate: PhotoCandidate?) -> some View {
        if let path = candidate?.path, let image = NSImage(contentsOfFile: path) {
            Image(nsImage: image).resizable().scaledToFit()
        } else {
            Image(systemName: "person.crop.circle").resizable().scaledToFit().foregroundStyle(.secondary)
        }
    }

    private func load() async {
        loading = true; error = nil
        defer { loading = false }
        do {
            let result: PhotoChoices = try await model.call("contact.photos", ["uid": .string(person.contactUid)])
            choices = result; selected = result.preferred
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        saving = true; error = nil
        defer { saving = false }
        do {
            let _: NoReply = try await model.call("contact.photo.choose", ["uid": .string(person.contactUid), "candidate": .string(selected), "observed": JSONValue(strings: choices?.observed ?? [])])
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
