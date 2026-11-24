import TattleShared
import SwiftUI

@main
struct TattleApp: App {
    @State private var filter = FilterController()
    @State private var store = TattleStore()
    @State private var network: NetworkMonitor?

    var body: some Scene {
        MenuBarExtra {
            MenuBarView(filter: filter, store: store)
                .task { start() }
        } label: {
            MenuBarLabel(filter: filter, store: store)
                .task { start() }
        }
        .menuBarExtraStyle(.window)

        Window("Tattle", id: "main") {
            MainView(filter: filter, store: store, requestWiFiAccess: { network?.requestWiFiNameAccess() })
                .onAppear { store.startPolling() }
                .onDisappear { store.stopPolling() }
        }
        .defaultSize(width: 980, height: 620)
    }

    /// Starts background work once: the alert channel and network reporting.
    private func start() {
        guard network == nil else { return }
        GeoData.preload()
        store.countryData.start()
        filter.refresh()
        store.runInBackground()
        network = NetworkMonitor { [store] context in Task { await store.networkChanged(context) } }
    }
}

/// The menu bar icon: an open eye while filtering, closed when off or denying silently,
/// with a dot when something waits for you.
private struct MenuBarLabel: View {
    let filter: FilterController
    let store: TattleStore

    var body: some View {
        let closed = !filter.filterEnabled || store.status?.settings.mode == .silentDeny
        let waiting = (store.status?.pendingAlerts ?? 0) > 0
        Image(systemName: closed ? "eye.slash" : waiting ? "eye.trianglebadge.exclamationmark" : "eye")
            .accessibilityLabel(waiting ? "Tattle: connections waiting for an answer" : "Tattle")
    }
}

private struct MainView: View {
    let filter: FilterController
    let store: TattleStore
    let requestWiFiAccess: () -> Void
    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            List(AppSection.allCases, selection: $store.section) { item in
                Label(item.rawValue, systemImage: item.icon)
                    .badge(item == .review ? store.reviewItems.count : 0)
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190)
        } detail: {
            switch store.section ?? .connections {
            case .connections: ConnectionsView(store: store)
            case .review: ReviewView(store: store)
            case .rules: RulesView(store: store)
            case .profiles: ProfilesView(store: store, requestWiFiAccess: requestWiFiAccess)
            case .blocklists: BlocklistsView(store: store)
            case .traffic: TrafficView(store: store)
            case .setup: StatusView(filter: filter, store: store)
            case .settings: SettingsView(filter: filter, store: store)
            }
        }
        .task { filter.refresh() }
    }
}
