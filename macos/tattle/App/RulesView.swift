import TattleShared
import SwiftUI
import UniformTypeIdentifiers

/// All rules, grouped into the built-in System rules and the user's own.
struct RulesView: View {
    let store: TattleStore
    @State private var selection: Set<Rule.ID> = []
    @State private var editing: Rule?
    @State private var creating: Rule?
    @State private var search = ""
    @State private var exporting: RulesFile?
    @State private var importing = false
    @State private var replaceOnImport = false
    @State private var message: String?

    private var filtered: [Rule] {
        let rules = store.rules.sorted { $0.modified > $1.modified }
        guard !search.isEmpty else { return rules }
        return rules.filter { RuleText.summary($0).localizedCaseInsensitiveContains(search) || ($0.note ?? "").localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        List(selection: $selection) {
            section("Your rules", filtered.filter { !$0.isSystem })
            section("System", filtered.filter(\.isSystem), footer: "These keep macOS connected (DNS, network setup, time, certificates, updates). Edit or disable them with care.")
        }
        .searchable(text: $search, prompt: "Filter rules")
        .contextMenu(forSelectionType: Rule.ID.self) { ids in
            Button("Edit…") { editing = store.rules.first { ids.contains($0.id) } }
                .disabled(ids.count != 1)
            Button("Delete", role: .destructive) { delete(ids) }
        } primaryAction: { ids in
            editing = store.rules.first { ids.contains($0.id) }
        }
        .onDeleteCommand { delete(selection) }
        .toolbar {
            Button { creating = Rule(remote: .any, action: .deny) } label: { Label("New Rule", systemImage: "plus") }
            Button { delete(selection) } label: { Label("Delete", systemImage: "trash") }
                .disabled(selection.isEmpty)
            Menu {
                Button("Export Rules…") {
                    Task { if let data = await store.exportRules() { exporting = RulesFile(data: data) } }
                }
                Button("Import Rules…") { replaceOnImport = false; importing = true }
                Button("Import and Replace My Rules…") { replaceOnImport = true; importing = true }
            } label: { Label("Import/Export", systemImage: "square.and.arrow.up.on.square") }
        }
        .sheet(item: $editing) { rule in RuleEditor(store: store, rule: rule, isNew: false) }
        .sheet(item: $creating) { rule in RuleEditor(store: store, rule: rule, isNew: true) }
        .fileExporter(isPresented: Binding(get: { exporting != nil }, set: { if !$0 { exporting = nil } }),
                      document: exporting, contentType: .json, defaultFilename: "Tattle Rules.json") { _ in }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            guard case .success(let url) = result else { return }
            Task {
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: url) else { return }
                if let count = await store.importRules(data, replace: replaceOnImport) {
                    message = "Imported \(count) rule\(count == 1 ? "" : "s")."
                }
            }
        }
        .alert(message ?? "", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {}
        .task { await store.reloadRules(); await store.reloadProfiles() }
        .navigationTitle("Rules")
    }

    @ViewBuilder
    private func section(_ title: String, _ rules: [Rule], footer: String? = nil) -> some View {
        Section {
            ForEach(rules) { rule in
                RuleRow(rule: rule, profileName: store.profileName(rule.profileID)) { enabled in
                    Task { await store.setEnabled(rule, enabled) }
                }
                .tag(rule.id)
            }
        } header: {
            Text("\(title) (\(rules.count))")
        } footer: {
            if let footer { Text(footer).font(.caption).foregroundStyle(.secondary) }
        }
    }

    private func delete(_ ids: Set<Rule.ID>) {
        let doomed = store.rules.filter { ids.contains($0.id) }
        guard !doomed.isEmpty else { return }
        Task { await store.delete(doomed) }
        selection = []
    }
}

private struct RuleRow: View {
    let rule: Rule
    let profileName: String
    let setEnabled: @MainActor @Sendable (Bool) -> Void

    var body: some View {
        HStack(spacing: 10) {
            Toggle("", isOn: Binding(get: { rule.enabled }, set: setEnabled))
                .labelsHidden()
                .toggleStyle(.checkbox)
            Image(systemName: rule.action == .allow ? "checkmark.circle.fill" : "xmark.octagon.fill")
                .foregroundStyle(rule.action == .allow ? .green : .red)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(RuleText.process(rule.process, bound: rule.boundProcess)) → \(RuleText.remote(rule.remote))")
                HStack(spacing: 8) {
                    Text(RuleText.port(rule.port, rule.proto))
                    if rule.lifetime != .forever { Text(RuleText.lifetime(rule)) }
                    if rule.profileID != nil { Text(profileName) }
                    if let note = rule.note, !note.isEmpty { Text(note).italic() }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .opacity(rule.enabled ? 1 : 0.5)
    }
}

struct RulesFile: FileDocument {
    static let readableContentTypes: [UTType] = [.json]
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

/// Creates or edits one rule.
struct RuleEditor: View {
    let store: TattleStore
    let isNew: Bool
    @State private var rule: Rule
    @State private var remoteKind: RemoteKind
    @State private var remoteText: String
    @State private var portKind: PortKind
    @State private var portLow: String
    @State private var portHigh: String
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    enum RemoteKind: String, CaseIterable { case any = "Any host", host = "Host", domain = "Domain and subdomains", ip = "IP address", cidr = "Network (CIDR)" }
    enum PortKind: String, CaseIterable { case any = "Any port", single = "Port", range = "Port range" }

    init(store: TattleStore, rule: Rule, isNew: Bool) {
        self.store = store
        self.isNew = isNew
        _rule = State(initialValue: rule)
        let (kind, text): (RemoteKind, String) = switch rule.remote {
        case .any: (.any, "")
        case .host(let name): (.host, name)
        case .domain(let name): (.domain, name)
        case .ip(let address): (.ip, address.description)
        case .network(let network): (.cidr, network.description)
        }
        _remoteKind = State(initialValue: kind)
        _remoteText = State(initialValue: text)
        let (portKind, low, high): (PortKind, String, String) = switch rule.port {
        case .any: (.any, "", "")
        case .single(let value): (.single, "\(value)", "")
        case .range(let a, let b): (.range, "\(a)", "\(b)")
        }
        _portKind = State(initialValue: portKind)
        _portLow = State(initialValue: low)
        _portHigh = State(initialValue: high)
    }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    Picker("Action", selection: $rule.action) {
                        Text("Allow").tag(RuleAction.allow)
                        Text("Deny").tag(RuleAction.deny)
                    }
                    .pickerStyle(.segmented)
                }
                Section("Process") {
                    optionalField("Signing ID", $rule.process.signingID, prompt: "Any (e.g. com.apple.Safari)")
                    optionalField("Team ID", $rule.process.teamID, prompt: "Any (\"apple\" for Apple software)")
                    optionalField("Path", $rule.process.path, prompt: "Any path")
                }
                Section("Destination") {
                    Picker("Remote", selection: $remoteKind) {
                        ForEach(RemoteKind.allCases, id: \.self) { Text($0.rawValue) }
                    }
                    if remoteKind != .any {
                        TextField(remoteKind.rawValue, text: $remoteText, prompt: Text(remotePrompt))
                    }
                    Picker("Port", selection: $portKind) {
                        ForEach(PortKind.allCases, id: \.self) { Text($0.rawValue) }
                    }
                    if portKind != .any {
                        HStack {
                            TextField(portKind == .range ? "From" : "Port", text: $portLow)
                            if portKind == .range { TextField("To", text: $portHigh) }
                        }
                    }
                    Picker("Protocol", selection: $rule.proto) {
                        Text("Any").tag(TransportProtocol.any)
                        Text("TCP").tag(TransportProtocol.tcp)
                        Text("UDP").tag(TransportProtocol.udp)
                    }
                    Picker("Direction", selection: $rule.direction) {
                        Text("Outbound").tag(TrafficDirection.outbound)
                        Text("Any").tag(TrafficDirection.any)
                    }
                }
                Section {
                    Picker("Profile", selection: $rule.profileID) {
                        Text("All profiles").tag(UUID?.none)
                        ForEach(store.profiles) { Text($0.name).tag(UUID?.some($0.id)) }
                    }
                    Toggle("Enabled", isOn: $rule.enabled)
                    optionalField("Note", $rule.note, prompt: "Optional")
                    if rule.lifetime != .forever {
                        LabeledContent("Lifetime", value: RuleText.lifetime(rule))
                    }
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
            }
            .formStyle(.grouped)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(isNew ? "Add Rule" : "Save") { save() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding()
        }
        .frame(width: 480, height: 640)
    }

    private var remotePrompt: String {
        switch remoteKind {
        case .any: ""
        case .host: "www.example.com"
        case .domain: "example.com"
        case .ip: "93.184.216.34"
        case .cidr: "10.0.0.0/8"
        }
    }

    private func optionalField(_ label: String, _ value: Binding<String?>, prompt: String) -> some View {
        TextField(label, text: Binding(get: { value.wrappedValue ?? "" }, set: { value.wrappedValue = $0.isEmpty ? nil : $0 }), prompt: Text(prompt))
    }

    private func save() {
        let text = remoteText.trimmingCharacters(in: .whitespaces)
        switch remoteKind {
        case .any: rule.remote = .any
        case .host: rule.remote = .host(text)
        case .domain: rule.remote = .domain(text)
        case .ip:
            guard let address = IPAddress(text) else { error = "“\(text)” isn't an IP address."; return }
            rule.remote = .ip(address)
        case .cidr:
            guard let network = IPNetwork(text) else { error = "“\(text)” isn't a network like 10.0.0.0/8."; return }
            rule.remote = .network(network)
        }
        switch portKind {
        case .any: rule.port = .any
        case .single:
            guard let port = UInt16(portLow) else { error = "Enter a port from 0 to 65535."; return }
            rule.port = .single(port)
        case .range:
            guard let low = UInt16(portLow), let high = UInt16(portHigh), low <= high else { error = "Enter a range like 8000–8100."; return }
            rule.port = .range(low, high)
        }
        Task {
            if await store.save(rule) {
                dismiss()
            } else {
                error = store.lastError ?? "Tattle couldn't save the rule."
            }
        }
    }
}
