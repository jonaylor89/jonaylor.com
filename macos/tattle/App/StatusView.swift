import TattleShared
import SwiftUI

/// Setup and overview: extension install state, the filter switch, and service status.
struct StatusView: View {
    let filter: FilterController
    let store: TattleStore

    var body: some View {
        Form {
            Section("Filter extension") {
                LabeledContent("Status", value: extensionStatus)
                HStack {
                    Button("Install") { filter.installExtension() }
                        .disabled(filter.extensionInfo == nil || filter.extensionState == .activated)
                    Button("Uninstall", role: .destructive) { filter.uninstallExtension() }
                        .disabled(filter.extensionState != .activated)
                }
            }

            Section {
                Toggle("Filter network connections", isOn: Binding(
                    get: { filter.filterEnabled },
                    set: { enabled in Task { await filter.setFilterEnabled(enabled) } }
                ))
                .disabled(filter.extensionState != .activated)
                if let status = store.status {
                    Picker("Mode", selection: Binding(
                        get: { status.settings.mode },
                        set: { mode in Task { await store.update { $0.mode = mode } } }
                    )) {
                        ForEach(FilterMode.allCases, id: \.self) { Text(ModeText.name($0)).tag($0) }
                    }
                    Text(ModeText.explanation(status.settings.mode))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Content filter")
            } footer: {
                Text("Loopback traffic (127.0.0.1, ::1) is never filtered. If the filter extension stops responding, macOS lets connections through.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let status = store.status {
                Section("Overview") {
                    LabeledContent("Version", value: status.version)
                    LabeledContent("Rules", value: status.ruleCount.formatted())
                    LabeledContent("Blocklist entries", value: status.blocklistEntryCount.formatted())
                    LabeledContent("Connections logged", value: status.connectionsLogged.formatted())
                    LabeledContent("Active profile", value: status.activeProfileName ?? "None")
                    LabeledContent("Pending alerts", value: status.pendingAlerts.formatted())
                    LabeledContent("DNS-over-HTTPS", value: status.dnsProxyRunning ? "Running" : "Off")
                }
            } else if filter.filterEnabled {
                Section {
                    Text("Waiting for the filter extension to answer…").foregroundStyle(.secondary)
                }
            }

            if let error = filter.lastError ?? store.lastError {
                Section {
                    Text(error).foregroundStyle(.red)
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Setup")
    }

    private var extensionStatus: String {
        switch filter.extensionState {
        case .unknown: "Checking…"
        case .notInstalled: "Not installed"
        case .needsApproval: "Waiting for approval in System Settings → General → Login Items & Extensions"
        case .activated: "Installed"
        case .needsReboot: "Restart your Mac to finish"
        case .failed(let message): "Failed: \(message)"
        }
    }
}

enum ModeText {
    static func name(_ mode: FilterMode) -> String {
        switch mode {
        case .alert: "Ask"
        case .silentAllow: "Silently allow"
        case .silentDeny: "Silently deny"
        }
    }

    static func explanation(_ mode: FilterMode) -> String {
        switch mode {
        case .alert: "Connections without a matching rule show an alert."
        case .silentAllow: "Connections without a matching rule are allowed and listed in Review."
        case .silentDeny: "Connections without a matching rule are denied and listed in Review."
        }
    }
}

/// Preferences stored in the extension.
struct SettingsView: View {
    let filter: FilterController
    let store: TattleStore
    @State private var resolver = ""
    @State private var confirmErase = false

    var body: some View {
        Form {
            if let settings = store.status?.settings {
                Section("Alerts") {
                    Picker("When nobody answers", selection: binding(\.defaultPolicy, settings)) {
                        Text("Allow the connection").tag(RuleAction.allow)
                        Text("Deny the connection").tag(RuleAction.deny)
                    }
                    Picker("Answer timeout", selection: binding(\.alertTimeout, settings)) {
                        ForEach([10.0, 20, 30, 60, 120, 300], id: \.self) { Text("\(Int($0)) seconds").tag($0) }
                    }
                }

                Section {
                    Stepper("Keep connections for \(settings.connectionRetentionDays) days", value: binding(\.connectionRetentionDays, settings), in: 1...365)
                    Stepper("Keep traffic statistics for \(settings.trafficRetentionDays) days", value: binding(\.trafficRetentionDays, settings), in: 1...730)
                    Button("Erase Connection History and Statistics…", role: .destructive) { confirmErase = true }
                } header: {
                    Text("History")
                } footer: {
                    Text("History stays on this Mac. Tattle sends nothing anywhere except blocklist downloads and, when on, your DNS queries to the resolver below.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section {
                    Toggle("Encrypt DNS (DNS-over-HTTPS)", isOn: Binding(
                        get: { settings.dns.enabled && filter.dnsProxyEnabled },
                        set: { enabled in
                            Task {
                                await store.update { $0.dns.enabled = enabled }
                                await filter.setDNSProxyEnabled(enabled)
                            }
                        }
                    ))
                    .disabled(!filter.dnsProxySupported || filter.extensionState != .activated)
                    Picker("Resolver", selection: Binding(
                        get: { DNSSettings.presets.first { $0.url == settings.dns.resolverURL }?.url ?? "custom" },
                        set: { url in if url != "custom" { Task { await store.update { $0.dns.resolverURL = url } } } }
                    )) {
                        ForEach(DNSSettings.presets, id: \.url) { Text($0.name).tag($0.url) }
                        Text("Custom").tag("custom")
                    }
                    HStack {
                        TextField("Resolver URL", text: $resolver, prompt: Text("https://1.1.1.1/dns-query"))
                        Button("Use") { Task { await store.update { $0.dns.resolverURL = resolver } } }
                            .disabled(resolver == settings.dns.resolverURL)
                    }
                    Toggle("Fall back to the network's DNS if the resolver fails", isOn: binding(\.dns.fallbackToSystemDNS, settings))
                } header: {
                    Text("DNS")
                } footer: {
                    Text(filter.dnsProxySupported
                         ? "Use the resolver's IP address in the URL so finding the resolver doesn't itself need DNS. Without fallback, lookups fail while the resolver is unreachable."
                         : "DNS-over-HTTPS needs macOS 15 or later.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .onAppear { resolver = settings.dns.resolverURL }
                .onChange(of: settings.dns.resolverURL) { resolver = settings.dns.resolverURL }
            } else {
                Text("Turn on the filter in Setup to change settings.").foregroundStyle(.secondary)
            }

            Section("Map data") {
                LabeledContent("Country table") {
                    HStack {
                        switch store.countryData.state {
                        case .missing: Text("Not downloaded")
                        case .downloading: ProgressView().controlSize(.small); Text("Downloading…")
                        case .ready(let updated): Text("Updated \(updated.formatted(date: .abbreviated, time: .omitted))")
                        case .failed(let message): Text(message).foregroundStyle(.red)
                        }
                        Button("Update Now") { Task { await store.countryData.update() } }
                            .disabled(store.countryData.state == .downloading)
                    }
                }
                Text("Tattle downloads DB-IP's free country table at setup and once a month, then finds countries on this Mac. Addresses are never looked up online.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Link("IP geolocation by DB-IP (CC BY 4.0)", destination: URL(string: "https://db-ip.com")!)
                Link("Country outlines from Natural Earth", destination: URL(string: "https://www.naturalearthdata.com")!)
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("Erase all connection history and traffic statistics?", isPresented: $confirmErase) {
            Button("Erase", role: .destructive) { Task { await store.eraseHistory() } }
        }
        .navigationTitle("Settings")
    }

    private func binding<Value>(_ keyPath: WritableKeyPath<TattleShared.Settings, Value>, _ settings: TattleShared.Settings) -> Binding<Value> {
        Binding(get: { settings[keyPath: keyPath] }, set: { value in Task { await store.update { $0[keyPath: keyPath] = value } } })
    }
}
