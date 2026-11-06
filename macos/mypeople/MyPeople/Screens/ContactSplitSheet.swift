import Foundation
import MyPeopleKit
import SwiftUI

/// A selection and confirmation surface only. Python validates the snapshot and moves exact edges.
struct ContactSplitSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let uid: String
    let originalName: String
    var completed: (ContactSplitReply) -> Void

    @State private var snapshot: ContactAssociations?
    @State private var selected: Set<String> = []
    @State private var name = ""
    @State private var search = ""
    @State private var kind = ""
    @State private var review: ContactSplitRequest?
    @State private var loading = false
    @State private var saving = false
    @State private var error: String?
    @State private var requiresReload = false

    private var associations: [ContactAssociation] { snapshot?.associations ?? [] }
    private var selectedAssociations: [ContactAssociation] { associations.filter { selected.contains($0.id) } }
    private var visible: [ContactAssociation] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return associations.filter { item in
            (kind.isEmpty || item.kind == kind) && (query.isEmpty ||
                [item.label, item.kind, item.detail ?? "", item.source ?? "", item.objectId, item.id,
                 item.channel ?? "", item.at ?? "", item.thread ?? "", item.ownerUid ?? "",
                 item.properties?["source"]?.string ?? "", item.properties?["predicate"]?.string ?? ""]
                    .contains { $0.localizedStandardContains(query) })
        }
    }
    private var canReview: Bool {
        model.isReady && snapshot != nil && !requiresReload && !loading && !saving &&
            !selected.isEmpty && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if let error {
                VStack(alignment: .leading, spacing: 8) {
                    Label { Text(verbatim: error).textSelection(.enabled) } icon: { Image(systemName: "exclamationmark.triangle") }
                    Button("Reload Associations") { Task { await load() } }
                        .disabled(loading || saving || !model.isReady)
                }
                .foregroundStyle(Kin.onErrorContainer)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Kin.errorContainer, in: RoundedRectangle(cornerRadius: 10))
            }
            if !model.isReady {
                Label("The engine is unavailable. Reconnect before loading or splitting.", systemImage: "bolt.slash")
                    .foregroundStyle(Kin.error)
            }
            if loading {
                Spacer()
                ProgressView("Loading exact associations…").frame(maxWidth: .infinity)
                Spacer()
            } else if let review {
                reviewContent(review)
            } else if snapshot != nil {
                selectionContent
            } else {
                ContentUnavailableView("Associations unavailable", systemImage: "arrow.triangle.branch",
                                       description: Text("Reload to choose which records belong to the separate person."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            footer
        }
        .padding(20)
        .frame(width: 720, height: 700)
        .interactiveDismissDisabled(saving)
        .task { await load() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(review == nil ? "Split into a separate contact" : "Review split")
                .font(.title2.weight(.semibold))
            Text(verbatim: "From \(snapshot?.name ?? originalName)").font(.headline)
            Muted(requiresReload ? "Reload associations before continuing. Your proposed name is kept."
                  : review == nil ? "1 · Select exact associations → 2 · Review → Create contact"
                  : "Nothing has changed yet. Check every selected association before creating the contact.", font: .callout)
        }
    }

    private var selectionContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("New person’s name", text: $name).textFieldStyle(.roundedBorder)
                .accessibilityLabel("New person’s name")
            Muted("Only checked associations move. A phone number does not automatically select its messages, notes or facts. A message batch or thread row moves the full scope described by its label.", font: .callout)
            HStack {
                TextField("Search associations", text: $search).textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Search associations")
                Picker("Kind", selection: $kind) {
                    Text("All kinds").tag("")
                    ForEach(Array(Set(associations.map(\.kind))).sorted(), id: \.self) { value in
                        Text(verbatim: "\(kindTitle(value)) (\(associations.filter { $0.kind == value }.count))").tag(value)
                    }
                }
                .frame(width: 210)
            }
            HStack {
                Text("\(selected.count) selected of \(associations.count)").font(.callout.weight(.medium))
                Spacer()
                Button("Select Shown (\(visible.count))") { selected.formUnion(visible.map(\.id)) }
                    .disabled(visible.isEmpty)
                Button("Clear Selection") { selected.removeAll() }.disabled(selected.isEmpty)
            }
            if associations.isEmpty {
                ContentUnavailableView("No associations to move", systemImage: "person.crop.circle",
                                       description: Text("This contact has no selectable associations. Nothing will be changed."))
            } else if visible.isEmpty {
                ContentUnavailableView.search(text: search)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(visible) { item in
                            Toggle(isOn: Binding(get: { selected.contains(item.id) }, set: { checked in
                                if checked { selected.insert(item.id) } else { selected.remove(item.id) }
                            })) {
                                AssociationDescription(item: item)
                            }
                            .toggleStyle(.checkbox)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(selected.contains(item.id) ? Kin.secondaryContainer : Kin.surfaceLow,
                                        in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }
        }
        .disabled(requiresReload || saving)
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private func reviewContent(_ request: ContactSplitRequest) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: "Create “\(request.name)”").font(.headline)
                Text(verbatim: "Move \(request.edges.count) selected associations to the new person. \(associations.count - request.edges.count) unselected associations stay with \(snapshot?.name ?? originalName).")
                Muted("The original person and recorded history are kept. This is not a merge undo. Message attribution changes only for selected message, batch or thread edges.", font: .callout)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Kin.secondaryContainer, in: RoundedRectangle(cornerRadius: 10))
            Text("Moving to the new person").font(.headline)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(selectedAssociations) { item in
                        AssociationDescription(item: item)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Kin.surfaceLow, in: RoundedRectangle(cornerRadius: 8))
                    }
                    DisclosureGroup("Staying with the original person (\(associations.count - request.edges.count))") {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(associations.filter { !selected.contains($0.id) }) { item in
                                AssociationDescription(item: item).padding(.vertical, 4)
                            }
                        }
                    }
                    .padding(.top, 8)
                }
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private var footer: some View {
        HStack {
            if saving { ProgressView().controlSize(.small); Text("Creating contact…").font(.callout) }
            Spacer()
            Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(saving)
            if review != nil {
                Button("Back") { review = nil }.disabled(saving)
                Button("Create Separate Contact") { Task { await split() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(saving || requiresReload || !model.isReady)
            } else {
                Button("Review Split…") { prepareReview() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canReview)
            }
        }
    }

    private func load() async {
        guard !loading, !saving else { return }
        loading = true
        error = nil
        requiresReload = false
        review = nil
        snapshot = nil
        selected.removeAll()
        search = ""
        kind = ""
        defer { loading = false }
        do {
            let loaded = try await model.contactAssociations(uid: uid)
            try loaded.validateSnapshot()
            snapshot = loaded
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func prepareReview() {
        guard canReview, let snapshot else { return }
        error = nil
        review = ContactSplitRequest(uid: snapshot.uid,
                                     name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                                     edges: selectedAssociations.map(\.id), heads: snapshot.heads)
    }

    private func split() async {
        guard let request = review, !saving, !requiresReload, model.isReady else { return }
        saving = true
        error = nil
        defer { saving = false }
        do {
            let reply = try await model.splitContact(request)
            dismiss()
            completed(reply)
        } catch {
            requiresReload = true
            if let engineError = error as? EngineError, engineError.isStaleAssociationSelection {
                self.error = "These associations changed after you loaded them. Nothing was split. Reload and select again; your new person’s name is kept. \(error.localizedDescription)"
            } else {
                // A lost response can follow a successful write. Never offer a blind mutation retry.
                self.error = "The split could not be confirmed: \(error.localizedDescription) Reload before trying again and check People for the new contact."
            }
        }
    }
}

private func kindTitle(_ kind: String) -> String {
    kind.replacingOccurrences(of: "_", with: " ").capitalized
}

private struct AssociationDescription: View {
    let item: ContactAssociation

    private var evidenceText: String? {
        guard let evidence = item.properties?["evidence"], evidence != .null else { return nil }
        if case .string(let text) = evidence { return text.isEmpty ? nil : text }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? encoder.encode(evidence)).map { String(decoding: $0, as: UTF8.self) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: item.label.isEmpty ? "(No label)" : item.label)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if item.label.count > 240 || item.label.filter({ $0 == "\n" }).count >= 4 {
                DisclosureGroup("Full text") {
                    Text(verbatim: item.label).font(.callout).textSelection(.enabled)
                }
            }
            Text(verbatim: [kindTitle(item.kind), item.properties?["predicate"]?.string ?? "",
                            item.properties?["label"]?.string ?? "", item.properties?["status"]?.string ?? "",
                            item.source ?? item.properties?["source"]?.string ?? "",
                            item.channel ?? "", item.at ?? item.properties?["said_at"]?.string ?? "",
                            item.properties?["direction"]?.string ?? ""]
                .filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.caption).foregroundStyle(Kin.onSurfaceVariant)
            if let thread = item.thread, !thread.isEmpty {
                Text(verbatim: "Thread: \(thread)").font(.caption).textSelection(.enabled)
            }
            if let detail = item.detail, !detail.isEmpty {
                Text(verbatim: detail).font(.callout).textSelection(.enabled)
            }
            if let evidence = evidenceText {
                DisclosureGroup("Evidence") { Text(verbatim: evidence).font(.callout).textSelection(.enabled) }
            }
            DisclosureGroup("Exact association") {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: "Edge: \(item.id)")
                    Text(verbatim: "Object: \(item.objectId)")
                    if let owner = item.ownerUid { Text(verbatim: "Original attribution: \(owner)") }
                    if let conversation = item.conversationId { Text(verbatim: "Conversation: \(conversation)") }
                    if let sourceRef = item.properties?["source_ref"]?.string { Text(verbatim: "Source reference: \(sourceRef)") }
                }
                .font(.caption.monospaced()).textSelection(.enabled)
            }
            .font(.caption).foregroundStyle(Kin.onSurfaceVariant)
        }
    }
}
