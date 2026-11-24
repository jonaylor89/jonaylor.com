import TattleShared
import SwiftUI

/// Live, searchable list of connections the filter has seen.
struct ConnectionsView: View {
    @Bindable var store: TattleStore
    @State private var selection: Set<ConnectionRecord.ID> = []
    @State private var draft: Rule?
    @State private var filter: RuleAction?

    private var rows: [ConnectionRecord] {
        guard let filter else { return store.connections }
        return store.connections.filter { $0.action == filter }
    }

    var body: some View {
        Table(rows, selection: $selection) {
            TableColumn("Time") { record in
                Text(record.time, format: .dateTime.hour().minute().second())
                    .monospacedDigit()
            }
            .width(min: 70, ideal: 80, max: 90)
            TableColumn("App") { record in
                HStack(spacing: 6) {
                    Image(nsImage: AppIcon.forExecutable(record.process.path))
                        .resizable()
                        .frame(width: 16, height: 16)
                    Text(record.process.displayName)
                }
                .help(record.process.path)
            }
            .width(min: 120, ideal: 160)
            TableColumn("Destination") { record in
                Text(record.displayHost)
                    .help(record.remoteAddress ?? "")
            }
            .width(min: 160, ideal: 240)
            TableColumn("Port") { record in
                Text("\(record.proto == .any ? "" : record.proto.rawValue.uppercased()) \(record.remotePort)")
                    .monospacedDigit()
            }
            .width(min: 60, ideal: 80, max: 100)
            TableColumn("Verdict") { record in
                VerdictLabel(action: record.action, reason: record.reason)
                    .help(store.sourceName(for: record) ?? "")
            }
            .width(min: 120, ideal: 150)
            TableColumn("Traffic") { record in
                Text("↓\(record.bytesIn.bytesText) ↑\(record.bytesOut.bytesText)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            .width(min: 110, ideal: 140)
        }
        .contextMenu(forSelectionType: ConnectionRecord.ID.self) { ids in
            if let record = store.connections.first(where: { ids.contains($0.id) }) {
                // No lasting rule is possible for a process that can't be identified.
                if record.process.isSigned || record.process.isLocated {
                    Button("Allow \(record.process.displayName) to \(record.displayHost)…") { draft = rule(for: record, .allow) }
                    Button("Deny \(record.process.displayName) to \(record.displayHost)…") { draft = rule(for: record, .deny) }
                    Divider()
                }
                Button("Copy Destination") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(record.displayHost, forType: .string)
                }
            }
        }
        .searchable(text: $store.connectionSearch, prompt: "App, host or address")
        .toolbar {
            Picker("Show", selection: $filter) {
                Text("All").tag(RuleAction?.none)
                Text("Allowed").tag(RuleAction?.some(.allow))
                Text("Denied").tag(RuleAction?.some(.deny))
            }
            .pickerStyle(.segmented)
        }
        .overlay {
            if rows.isEmpty {
                ContentUnavailableView(
                    store.reachable ? "No connections yet" : "Filter not running",
                    systemImage: "network",
                    description: Text(store.reachable ? "Connections appear here as apps make them." : "Install and turn on the filter in Setup.")
                )
            }
        }
        .sheet(item: $draft) { rule in
            RuleEditor(store: store, rule: rule, isNew: true)
        }
        .navigationTitle("Connections")
    }

    private func rule(for record: ConnectionRecord, _ action: RuleAction) -> Rule {
        let remote: RemoteMatch = record.remoteHost.flatMap(DomainName.normalize).map { .host($0) }
            ?? record.remoteAddress.flatMap(IPAddress.init).map { .ip($0) } ?? .any
        return Rule(process: ProcessMatch(identity: record.process), remote: remote, port: .single(record.remotePort), proto: record.proto, action: action)
    }
}

struct VerdictLabel: View {
    let action: RuleAction
    let reason: VerdictReason

    var body: some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: action == .allow ? "checkmark.circle.fill" : "xmark.octagon.fill")
                .foregroundStyle(action == .allow ? .green : .red)
        }
    }

    private var text: String {
        let verb = action == .allow ? "Allowed" : "Denied"
        let why: String = switch reason {
        case .rule: "rule"
        case .blocklist: "blocklist"
        case .alert: "you"
        case .defaultPolicy: "no answer"
        case .silentAllow, .silentDeny: "silent mode"
        case .overflow: "too many alerts"
        case .dnsLookup: "DNS lookup"
        }
        return "\(verb) · \(why)"
    }
}

/// Connections decided without the user, grouped for review.
struct ReviewView: View {
    let store: TattleStore

    var body: some View {
        List(store.reviewItems) { item in
            HStack(spacing: 12) {
                Image(nsImage: AppIcon.forExecutable(item.process.path))
                    .resizable()
                    .frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(item.process.displayName) → \(item.host)")
                        .font(.body.weight(.medium))
                    Text("\(item.count) connection\(item.count == 1 ? "" : "s"), last \(item.lastSeen.formatted(.relative(presentation: .named))) · \(item.action == .allow ? "allowed" : "denied")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if item.process.isSigned || item.process.isLocated {
                    Button("Always Allow") { Task { await store.decide(item, .allow) } }
                    Button("Always Deny") { Task { await store.decide(item, .deny) } }
                }
                Button("Dismiss") { Task { await store.markReviewed(item) } }
            }
            .padding(.vertical, 4)
        }
        .overlay {
            if store.reviewItems.isEmpty {
                ContentUnavailableView(
                    "Nothing to review", systemImage: "checkmark.circle",
                    description: Text("Connections allowed or denied without asking you (silent modes and unanswered alerts) show up here.")
                )
            }
        }
        .toolbar {
            Button("Dismiss All") { Task { await store.markReviewed(nil) } }
                .disabled(store.reviewItems.isEmpty)
        }
        .task { await store.reloadReview() }
        .navigationTitle("Review")
    }
}
