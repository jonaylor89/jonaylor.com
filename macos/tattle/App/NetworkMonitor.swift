import CoreLocation
import CoreWLAN
import Foundation
import Network
import TattleShared

/// Tells the extension which network the Mac is on, so profiles can switch automatically.
/// The extension sees interfaces itself, but only the app can read the Wi-Fi name, and
/// macOS only reveals it to apps the user has granted Location access.
@MainActor
final class NetworkMonitor: NSObject, CLLocationManagerDelegate {
    private let monitor = NWPathMonitor()
    private let location = CLLocationManager()
    private let onChange: @MainActor (NetworkContext) -> Void
    private var last: NetworkContext?

    init(onChange: @escaping @MainActor (NetworkContext) -> Void) {
        self.onChange = onChange
        super.init()
        location.delegate = self
        monitor.pathUpdateHandler = { [weak self] path in
            let interfaces = path.availableInterfaces.map(\.name)
            Task { @MainActor in self?.report(interfaces: interfaces) }
        }
        monitor.start(queue: DispatchQueue(label: "Tattle.network"))
    }

    /// Asks for Location access, needed to read the Wi-Fi name. Only called when the user
    /// sets up a profile that switches by Wi-Fi network.
    func requestWiFiNameAccess() {
        if location.authorizationStatus == .notDetermined { location.requestWhenInUseAuthorization() }
    }

    var canReadWiFiName: Bool { location.authorizationStatus == .authorizedAlways }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in self.report(interfaces: self.last?.interfaces ?? []) }
    }

    private func report(interfaces: [String]) {
        let ssid = CWWiFiClient.shared().interface()?.ssid()
        let context = NetworkContext(ssid: ssid, interfaces: interfaces)
        guard context != last else { return }
        last = context
        onChange(context)
    }
}
