import Charts
import TattleShared
import SwiftUI

/// The menu bar panel: filter switch, mode, live traffic, and what's connecting right now.
struct MenuBarView: View {
    let filter: FilterController
    let store: TattleStore
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if filter.filterEnabled, let status = store.status {
                VStack(alignment: .leading, spacing: 12) {
                    modePicker(status)
                    TrafficGraph(rates: store.rates)
                    ConnectionMap(connections: store.connections)
                    counters(status)
                }
                .padding(12)
                Divider()
                ActiveApps(connections: store.connections) { app in
                    store.connectionSearch = app
                    show(.connections)
                }
                if store.profiles.count > 0 {
                    Divider()
                    profilePicker(status)
                }
            } else {
                offState
            }
            Divider()
            footer
        }
        .frame(width: 340)
        .onAppear { store.startPolling() }
        .onDisappear { store.stopPolling() }
    }

    // MARK: Sections

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: filter.filterEnabled ? "eye.fill" : "eye.slash")
                .font(.title3)
                .foregroundStyle(filter.filterEnabled ? Color.accentColor : .secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text("Tattle").font(.headline)
                Text(headline).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Toggle("Filter", isOn: Binding(
                get: { filter.filterEnabled },
                set: { on in Task { await filter.setFilterEnabled(on) } }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
            .disabled(filter.extensionState != .activated)
            .help(filter.filterEnabled ? "Stop filtering connections" : "Start filtering connections")
        }
        .padding(12)
    }

    private var headline: String {
        guard filter.filterEnabled else { return "Not filtering: every connection is allowed" }
        guard let status = store.status else { return "Connecting to the filter…" }
        if let profile = status.activeProfileName { return "Filtering · profile \(profile)" }
        return "Filtering · \(status.ruleCount) rules"
    }

    private func modePicker(_ status: ServiceStatus) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Picker("Mode", selection: Binding(
                get: { status.settings.mode },
                set: { mode in Task { await store.update { $0.mode = mode } } }
            )) {
                Text("Ask").tag(FilterMode.alert)
                Text("Allow").tag(FilterMode.silentAllow)
                Text("Deny").tag(FilterMode.silentDeny)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            Text(ModeText.explanation(status.settings.mode))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func counters(_ status: ServiceStatus) -> some View {
        HStack(spacing: 6) {
            if let activity = status.activity {
                Counter(value: activity.allowed, label: "allowed", color: .green)
                Counter(value: activity.denied, label: "denied", color: .red)
            }
            Spacer()
            if store.reviewItems.count > 0 {
                Button { show(.review) } label: {
                    Label("\(store.reviewItems.count) to review", systemImage: "tray.full")
                }
                .buttonStyle(.borderless)
                .font(.caption)
                .help("Connections decided without a rule, waiting for you to make one")
            }
            if status.pendingAlerts > 0 {
                Label("\(status.pendingAlerts) waiting", systemImage: "bell.badge")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
    }

    private func profilePicker(_ status: ServiceStatus) -> some View {
        Picker("Profile", selection: Binding(
            get: { status.settings.activeProfileID },
            set: { id in Task { await store.activate(store.profiles.first { $0.id == id }) } }
        )) {
            Text("None").tag(UUID?.none)
            ForEach(store.profiles) { Text($0.name).tag(UUID?.some($0.id)) }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var offState: some View {
        VStack(spacing: 8) {
            Image(systemName: "eye.slash").font(.largeTitle).foregroundStyle(.secondary)
            Text(offMessage)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if filter.extensionState != .activated {
                Button("Set Up…") { show(.setup) }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(20)
    }

    private var offMessage: String {
        if filter.extensionState != .activated { return "The filter extension isn't installed yet." }
        if filter.filterEnabled { return "Connecting to the filter…" }
        return "Turn the filter on to see and control which apps connect."
    }

    private var footer: some View {
        HStack(spacing: 2) {
            FooterButton(title: "Connections", icon: "network") { show(.connections) }
            FooterButton(title: "Rules", icon: "list.bullet.rectangle") { show(.rules) }
            FooterButton(title: "Traffic", icon: "chart.bar.xaxis") { show(.traffic) }
            FooterButton(title: "Settings", icon: "gearshape") { show(.settings) }
            Spacer()
            Button { NSApp.terminate(nil) } label: { Image(systemName: "power") }
                .buttonStyle(.borderless)
                .help("Quit Tattle. The filter keeps running; alerts wait until Tattle is open again.")
                .keyboardShortcut("q")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    private func show(_ section: AppSection) {
        store.section = section
        openWindow(id: "main")
        NSApp.activate()
    }
}

// MARK: - Pieces

private struct Counter: View {
    let value: Int64
    let label: String
    let color: Color

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(value.formatted()).monospacedDigit()
            Text(label).foregroundStyle(.secondary)
        }
        .font(.caption)
    }
}

private struct FooterButton: View {
    let title: String
    let icon: String
    let action: () -> Void

    var body: some View {
        Button(action: action) { Image(systemName: icon).frame(width: 26, height: 22) }
            .buttonStyle(.borderless)
            .help(title)
            .accessibilityLabel(title)
    }
}

/// Download and upload rate over the last couple of minutes, mirrored around a centre line.
private struct TrafficGraph: View {
    let rates: [RateSample]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                RateLabel(icon: "arrow.down", rate: rates.last?.down ?? 0, color: .blue)
                RateLabel(icon: "arrow.up", rate: rates.last?.up ?? 0, color: .orange)
                Spacer()
                Text("last \(Int(Double(TattleStore.rateSamples) * TattleStore.rateInterval / 60)) min")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Chart {
                ForEach(rates) { sample in
                    AreaMark(x: .value("Time", sample.time), y: .value("Down", sample.down), series: .value("Dir", "down"))
                        .foregroundStyle(.blue.opacity(0.55))
                        .interpolationMethod(.monotone)
                    AreaMark(x: .value("Time", sample.time), y: .value("Up", -sample.up), series: .value("Dir", "up"))
                        .foregroundStyle(.orange.opacity(0.55))
                        .interpolationMethod(.monotone)
                }
                RuleMark(y: .value("Zero", 0)).foregroundStyle(.secondary.opacity(0.3)).lineStyle(StrokeStyle(lineWidth: 0.5))
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartYScale(domain: -peak...peak)
            .chartXScale(domain: start...end)
            .frame(height: 56)
            .overlay {
                if rates.isEmpty {
                    Text("Measuring…").font(.caption).foregroundStyle(.tertiary)
                }
            }
            .accessibilityLabel("Traffic graph")
        }
    }

    /// The same scale above and below so download and upload compare at a glance.
    private var peak: Double {
        max(rates.map { max($0.down, $0.up) }.max() ?? 0, 1024) * 1.1
    }

    private var end: Date { rates.last?.time ?? Date() }
    private var start: Date { end.addingTimeInterval(-Double(TattleStore.rateSamples) * TattleStore.rateInterval) }
}

private struct RateLabel: View {
    static let formatter: ByteCountFormatter = {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        formatter.allowsNonnumericFormatting = false  // "0 bytes", not "Zero KB"
        return formatter
    }()

    let icon: String
    let rate: Double
    let color: Color

    var body: some View {
        Label {
            Text(Self.formatter.string(fromByteCount: Int64(rate)) + "/s").monospacedDigit()
        } icon: {
            Image(systemName: icon).foregroundStyle(color)
        }
        .font(.caption)
    }
}

/// The apps that connected in the last minute, most recent first.
private struct ActiveApps: View {
    let connections: [ConnectionRecord]
    let select: (String) -> Void

    private struct Activity: Identifiable {
        let id: String
        let process: ProcessIdentity
        var lastSeen: Date
        var lastHost: String
        var count = 0
        var denied = 0
    }

    private static let window: TimeInterval = 60
    private static let maxRows = 5

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
            let apps = activity(at: context.date)
            VStack(alignment: .leading, spacing: 2) {
                Text("Active in the last minute")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .padding(.bottom, 2)
                if apps.isEmpty {
                    Text("No connections")
                        .font(.callout)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                } else {
                    ForEach(apps) { app in
                        AppRow(
                            process: app.process, host: app.lastHost, count: app.count, denied: app.denied
                        ) { select(app.process.displayName) }
                    }
                }
            }
            .padding(.bottom, 6)
        }
    }

    private func activity(at now: Date) -> [Activity] {
        var byApp: [String: Activity] = [:]
        // Connections are newest first, so the first one seen per app is its latest.
        for record in connections {
            guard now.timeIntervalSince(record.time) < Self.window else { break }
            let key = record.process.appKey + (record.process.name ?? "")
            var entry = byApp[key] ?? Activity(id: key, process: record.process, lastSeen: record.time, lastHost: record.displayHost)
            entry.count += 1
            if record.action == .deny { entry.denied += 1 }
            byApp[key] = entry
        }
        return byApp.values.sorted { $0.lastSeen > $1.lastSeen }.prefix(Self.maxRows).map { $0 }
    }
}

private struct AppRow: View {
    let process: ProcessIdentity
    let host: String
    let count: Int
    let denied: Int
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                icon.frame(width: 20, height: 20)
                VStack(alignment: .leading, spacing: 0) {
                    Text(process.displayName).lineLimit(1)
                    Text(host).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 4)
                if denied > 0 {
                    Text("\(denied) denied")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.red)
                }
                Text("\(count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .help("\(count) connections in the last minute")
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .contentShape(Rectangle())
            .background(hovering ? Color.primary.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 5))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 4)
        .onHover { hovering = $0 }
        .help("Show \(process.displayName)'s connections")
    }

    @ViewBuilder private var icon: some View {
        if process.isLocated {
            Image(nsImage: AppIcon.forExecutable(process.path)).resizable()
        } else {
            Image(systemName: "questionmark.app.dashed").resizable().scaledToFit().foregroundStyle(.secondary)
        }
    }
}
