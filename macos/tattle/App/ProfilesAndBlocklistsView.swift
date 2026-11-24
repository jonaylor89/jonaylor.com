import TattleShared
import SwiftUI

/// Profiles: named rule sets that switch with the network.
struct ProfilesView: View {
    let store: TattleStore
    let requestWiFiAccess: () -> Void
    @State private var editing: Profile?

    var body: some View {
        Form {
            Section {
                Toggle("Switch profiles automatically", isOn: Binding(
                    get: { store.status?.settings.automaticProfiles ?? true },
                    set: { value in Task { await store.update { $0.automaticProfiles = value } } }
                ))
                LabeledContent("Active profile", value: store.status?.activeProfileName ?? "None (rules for all profiles only)")
                if let network = store.status?.network {
                    LabeledContent("Network", value: [network.ssid.map { "Wi-Fi “\($0)”" }, network.interfaces.isEmpty ? nil : network.interfaces.joined(separator: ", ")]
                        .compactMap { $0 }.joined(separator: " · "))
                }
            } footer: {
                Text("Rules marked “All profiles” always apply. When a profile is active, its rules apply too. Automatic switching picks the first profile whose Wi-Fi network or interface matches; otherwise the profile you chose stays active.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Profiles") {
                ForEach(store.profiles) { profile in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(profile.name)
                            Text(conditions(profile))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if store.status?.settings.activeProfileID == profile.id {
                            Text("Chosen").font(.caption).foregroundStyle(.secondary)
                        } else {
                            Button("Use") { Task { await store.activate(profile) } }
                        }
                        Button("Edit…") { editing = profile }
                        Button(role: .destructive) { Task { await store.delete(profile) } } label: { Image(systemName: "trash") }
                            .help("Delete the profile and its rules")
                    }
                }
                Button("Use No Profile") { Task { await store.activate(nil) } }
                    .disabled(store.status?.settings.activeProfileID == nil)
                Button("New Profile…") { editing = Profile(name: "") }
            }
        }
        .formStyle(.grouped)
        .sheet(item: $editing) { profile in
            ProfileEditor(store: store, profile: profile, requestWiFiAccess: requestWiFiAccess)
        }
        .task { await store.reloadProfiles(); await store.reloadStatus() }
        .navigationTitle("Profiles")
    }

    private func conditions(_ profile: Profile) -> String {
        let parts = profile.ssids.map { "Wi-Fi “\($0)”" } + profile.interfaces.map { "interface \($0)" }
        return parts.isEmpty ? "Manual only" : parts.joined(separator: ", ")
    }
}

private struct ProfileEditor: View {
    let store: TattleStore
    @State var profile: Profile
    let requestWiFiAccess: () -> Void
    @State private var ssids: String
    @State private var interfaces: String
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    init(store: TattleStore, profile: Profile, requestWiFiAccess: @escaping () -> Void) {
        self.store = store
        self.requestWiFiAccess = requestWiFiAccess
        _profile = State(initialValue: profile)
        _ssids = State(initialValue: profile.ssids.joined(separator: ", "))
        _interfaces = State(initialValue: profile.interfaces.joined(separator: ", "))
    }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                TextField("Name", text: $profile.name)
                TextField("Wi-Fi networks", text: $ssids, prompt: Text("Comma-separated, e.g. Office, Office-5G"))
                TextField("Interfaces", text: $interfaces, prompt: Text("Comma-separated, e.g. utun3, en7"))
                if let ssid = store.status?.network.ssid {
                    Button("Add Current Wi-Fi (“\(ssid)”)") { ssids = ([ssids, ssid].filter { !$0.isEmpty }).joined(separator: ", ") }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .formStyle(.grouped)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save") { save() }.keyboardShortcut(.defaultAction)
            }
            .padding()
        }
        .frame(width: 440, height: 300)
    }

    private func save() {
        func split(_ text: String) -> [String] {
            text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        profile.ssids = split(ssids)
        profile.interfaces = split(interfaces)
        if !profile.ssids.isEmpty { requestWiFiAccess() }
        Task {
            if await store.save(profile) { dismiss() } else { error = store.lastError }
        }
    }
}

/// Blocklist subscriptions.
struct BlocklistsView: View {
    let store: TattleStore
    @State private var adding = false
    @State private var name = ""
    @State private var url = ""

    var body: some View {
        Form {
            Section {
                ForEach(store.blocklists) { list in
                    HStack(alignment: .top) {
                        Toggle("", isOn: Binding(get: { list.enabled }, set: { enabled in
                            var copy = list
                            copy.enabled = enabled
                            Task { await store.save(copy) }
                        }))
                        .labelsHidden()
                        VStack(alignment: .leading, spacing: 2) {
                            Text(list.name)
                            Text(list.url).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                            Text(details(list)).font(.caption).foregroundStyle(.secondary)
                            if let error = list.lastError { Text(error).font(.caption).foregroundStyle(.red) }
                        }
                        Spacer()
                        Picker("Refresh", selection: Binding(get: { list.refreshHours }, set: { hours in
                            var copy = list
                            copy.refreshHours = hours
                            Task { await store.save(copy) }
                        })) {
                            Text("Hourly").tag(1)
                            Text("Daily").tag(24)
                            Text("Weekly").tag(168)
                        }
                        .labelsHidden()
                        .frame(width: 100)
                        Button { Task { await store.refresh(list) } } label: { Image(systemName: "arrow.clockwise") }
                            .help("Refresh now")
                        Button(role: .destructive) { Task { await store.delete(list) } } label: { Image(systemName: "trash") }
                    }
                }
            } header: {
                Text("Subscriptions")
            } footer: {
                Text("Lists in hosts format (“0.0.0.0 ads.example.com”) or one domain per line. Entries also block subdomains. Your own rules always take priority over lists.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section {
                Button("Add List…") { adding = true }
                Button("Refresh All Now") { Task { await store.refresh(nil) } }
            }
        }
        .formStyle(.grouped)
        .sheet(isPresented: $adding) {
            VStack(spacing: 0) {
                Form {
                    TextField("Name", text: $name, prompt: Text("Ads and trackers"))
                    TextField("URL", text: $url, prompt: Text("https://example.com/hosts.txt"))
                    if let error = store.lastError { Text(error).foregroundStyle(.red) }
                }
                .formStyle(.grouped)
                HStack {
                    Spacer()
                    Button("Cancel") { adding = false }.keyboardShortcut(.cancelAction)
                    Button("Subscribe") {
                        Task {
                            if await store.save(Blocklist(name: name, url: url)) {
                                adding = false
                                name = ""
                                url = ""
                            }
                        }
                    }
                    .keyboardShortcut(.defaultAction)
                }
                .padding()
            }
            .frame(width: 460, height: 220)
        }
        .task { await store.reloadBlocklists() }
        .navigationTitle("Blocklists")
    }

    private func details(_ list: Blocklist) -> String {
        var parts = ["\(list.entryCount.formatted()) entries", "\(list.hitCount.formatted()) blocked"]
        if let updated = list.lastUpdated { parts.append("updated \(updated.formatted(.relative(presentation: .named)))") } else { parts.append("not downloaded yet") }
        return parts.joined(separator: " · ")
    }
}
