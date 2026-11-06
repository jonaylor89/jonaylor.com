import AppKit
import MyPeopleKit
import SwiftUI

struct SettingsView: View {
    @AppStorage("settingsTab") private var tab = "general"

    var body: some View {
        TabView(selection: $tab) {
            GeneralSettings().tabItem { Label("General", systemImage: "gearshape") }.tag("general")
            ContactsSettings().tabItem { Label("Contacts", systemImage: "person.crop.rectangle.stack") }.tag("contacts")
            SystemSettings().tabItem { Label("System", systemImage: "stethoscope") }.tag("system")
        }
        .frame(width: 560, height: 520)
    }
}

private struct GeneralSettings: View {
    @Environment(AppModel.self) private var model
    @State private var me: MeReply.Me?
    @State private var chosen: Int?
    @State private var enginePath = ""
    @State private var error: String?

    var body: some View {
        Form {
            Section("Model") {
                if let llm = model.status?.llm {
                    Picker("Reads messages and answers questions with", selection: Binding(get: { llm.backend }, set: { model.setBackend($0) })) {
                        ForEach(llm.choices, id: \.self) { Text($0).tag($0) }
                    }
                    Muted(llm.local ? "\(llm.model), running on this Mac. Nothing leaves it." : "\(llm.model). Anything it reads is sent to that service.", font: .caption)
                } else {
                    Muted("Available once the engine is running.")
                }
            }
            Section("You") {
                if let me {
                    LabeledContent("You are") { Text(verbatim: "\(me.name) (#\(me.id))") }
                    if !me.aliases.isEmpty { LabeledContent("Also called") { Text(me.aliases.joined(separator: ", ")) } }
                    LabeledContent("Addresses and numbers") {
                        Text(me.identifiers.isEmpty ? "None yet" : me.identifiers.map(\.value).joined(separator: ", ")).textSelection(.enabled).multilineTextAlignment(.trailing)
                    }
                } else {
                    Muted("MyPeople doesn't know which record is you yet. Your own addresses and numbers would otherwise become people.")
                }
                PersonPicker(title: "Mark as you", anyoneLabel: "No one chosen", selection: $chosen)
                Button("Mark as You") { setMe() }.disabled(chosen == nil)
                if let error { Text(error).foregroundStyle(Kin.error) }
            }
            Section("Command-line tool") {
                LabeledContent("Using") { Text(verbatim: model.engineDescription).textSelection(.enabled).multilineTextAlignment(.trailing) }
                PickFileField(title: "Use a specific one", path: $enginePath, mode: .file, placeholder: "Find it automatically")
                Button("Save and Restart Engine") {
                    model.enginePath = enginePath
                    model.stopEngine()
                    model.reconnect()
                }
            }
        }
        .formStyle(.grouped)
        .task {
            enginePath = model.enginePath
            await loadMe()
        }
    }

    private func loadMe() async {
        me = (try? await model.call("me.get", as: MeReply.self))?.person
    }

    private func setMe() {
        guard let chosen else { return }
        Task {
            do {
                let reply: MeReply = try await model.call("me.set", ["ids": JSONValue(ints: [chosen])])
                me = reply.person
                self.chosen = nil
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

private struct ContactsSettings: View {
    @Environment(AppModel.self) private var model
    @State private var report: MigrationReport?
    @State private var error: String?

    var body: some View {
        Form {
            Section("vCards") {
                Button("Import a vCard File…") {
                    model.go(.importData)
                    NSApp.keyWindow?.close()
                }
                Button("Export All Contacts…") {
                    let people = model.records.people.values.filter { !$0.trashed && !$0.contactUid.isEmpty }
                    exportVCards(model: model, people: Array(people))
                }
                Muted("Exports hold your full cards, including photos and original properties. Keep the file somewhere safe.", font: .caption)
            }
            Section("Migration report") {
                Muted("Which contacts still have legacy numbers, numbers that need a country or format check, and identifiers shared between people. Review them; nothing is merged automatically.")
                Button("Run Report") { Task { await run() } }
                if let error { Text(error).foregroundStyle(Kin.error) }
                if let report {
                    LabeledContent("Contacts", value: report.contacts.formatted())
                    LabeledContent("In trash", value: report.trashed.formatted())
                    LabeledContent("Need original contact re-import", value: report.legacy.count.formatted())
                    ForEach(report.legacy.prefix(30), id: \.self) { line("\($0.name) (#\($0.id))") }
                    LabeledContent("Numbers to check", value: report.invalid.count.formatted())
                    ForEach(report.invalid.prefix(30), id: \.self) { line("\(model.name($0.id)): \($0.value)") }
                    LabeledContent("Shared identifiers", value: report.shared.count.formatted())
                    ForEach(report.shared.prefix(30), id: \.self) { shared in
                        line("\(shared.value): \(shared.people.map(model.name).joined(separator: ", "))")
                    }
                }
            }
        }
        .formStyle(.grouped)
    }

    private func line(_ text: String) -> some View {
        Text(verbatim: text).font(.caption).foregroundStyle(Kin.onSurfaceVariant).textSelection(.enabled)
    }

    private func run() async {
        do {
            report = try await model.call("report.migration")
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct SystemSettings: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Form {
            if let status = model.status {
                Section("Memory") {
                    LabeledContent("Database") { Text(verbatim: status.db).textSelection(.enabled).multilineTextAlignment(.trailing) }
                    LabeledContent("CLI", value: status.version)
                    LabeledContent("Python", value: status.python)
                }
                Section("Permissions") {
                    row("Full Disk Access", status.fullDiskAccess != false, status.fullDiskAccess == nil ? "Nothing to read yet" : nil)
                    if status.fullDiskAccess == false { FullDiskAccessNote() }
                }
                Section("Optional features") {
                    row("Bluetooth pairing", status.extras.bluetooth)
                    row("SQLCipher, for Signal", status.sqlcipher)
                    if !status.extras.bluetooth {
                        HStack {
                            Text(verbatim: EngineLocator.installHint).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                            Spacer()
                            Button("Copy") { copyToPasteboard(EngineLocator.installHint) }
                        }
                    }
                }
                Section("Credentials") {
                    Muted("Whether each is present. Values are never shown, and they live in \(status.secrets.path).", font: .caption)
                    ForEach(status.secrets.keys.sorted { $0.key < $1.key }, id: \.key) { key, present in row(key, present) }
                    row("Google", status.google.signedIn)
                    row("Transfer passphrase", status.transferKey)
                    row("Pi sign-in, for Codex", status.piAuth)
                }
            } else {
                Muted("Available once the engine is running.")
            }
        }
        .formStyle(.grouped)
        .onAppear { model.refreshStatus() }
    }

    private func row(_ title: String, _ ok: Bool, _ note: String? = nil) -> some View {
        LabeledContent(title) {
            HStack(spacing: 4) {
                if let note { Text(note).foregroundStyle(Kin.onSurfaceVariant) }
                Image(systemName: ok ? "checkmark.circle.fill" : "minus.circle").foregroundStyle(ok ? Kin.primary : Kin.onSurfaceVariant)
                    .accessibilityLabel(ok ? "Yes" : "No")
            }
        }
    }
}
