import Foundation
import NetworkExtension
import Observation
import TattleShared
import SystemExtensions
import os

/// Installs the filter system extension and turns the content filter on and off.
@MainActor
@Observable
final class FilterController {
    enum ExtensionState: Equatable {
        case unknown
        case notInstalled
        case needsApproval
        case activated
        case needsReboot
        case failed(String)
    }

    private(set) var extensionState: ExtensionState = .unknown
    private(set) var filterEnabled = false
    private(set) var dnsProxyEnabled = false
    private(set) var lastError: String?

    /// nil when the app was built without an embedded extension, which only happens with a
    /// broken build. Every action is disabled in that case.
    let extensionInfo = ExtensionInfo.embedded(in: .main)

    /// CFBundleVersion of the extension inside this app. When the installed extension has a
    /// different one, the app replaces it on launch so an updated app brings its extension.
    private let embeddedVersion: String? = {
        let directory = Bundle.main.bundleURL.appending(path: "Contents/Library/SystemExtensions", directoryHint: .isDirectory)
        let url = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil))?
            .first { $0.pathExtension == "systemextension" }
        return url.flatMap { Bundle(url: $0)?.object(forInfoDictionaryKey: "CFBundleVersion") as? String }
    }()
    private var requestedUpgrade = false

    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Tattle", category: "filter-controller")
    private let requestDelegate = RequestDelegate()

    init() {
        requestDelegate.onResult = { [weak self] result in self?.handle(result) }
        NotificationCenter.default.addObserver(
            forName: .NEFilterConfigurationDidChange, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshFilterState() }
        }
    }

    func refresh() {
        guard let extensionInfo else {
            extensionState = .failed("This build of Tattle has no embedded filter extension.")
            return
        }
        submit(.propertiesRequest(forExtensionWithIdentifier: extensionInfo.bundleIdentifier, queue: .main))
        refreshFilterState()
    }

    func installExtension() {
        guard let extensionInfo else { return }
        submit(.activationRequest(forExtensionWithIdentifier: extensionInfo.bundleIdentifier, queue: .main))
    }

    func uninstallExtension() {
        guard let extensionInfo else { return }
        Task {
            await setFilterEnabled(false)
            if dnsProxyEnabled { await setDNSProxyEnabled(false) }
            submit(.deactivationRequest(forExtensionWithIdentifier: extensionInfo.bundleIdentifier, queue: .main))
        }
    }

    func setFilterEnabled(_ enabled: Bool) async {
        guard let extensionInfo else { return }
        let manager = NEFilterManager.shared()
        do {
            try await manager.loadFromPreferences()
            if enabled {
                let configuration = NEFilterProviderConfiguration()
                configuration.filterSockets = true
                configuration.filterPackets = false
                configuration.filterDataProviderBundleIdentifier = extensionInfo.bundleIdentifier
                manager.providerConfiguration = configuration
                manager.localizedDescription = "Tattle"
            }
            manager.isEnabled = enabled
            try await manager.saveToPreferences()
            lastError = nil
        } catch {
            logger.error("Saving filter configuration failed: \(error.localizedDescription, privacy: .public)")
            lastError = error.localizedDescription
        }
        refreshFilterState()
    }

    /// DNS-over-HTTPS runs as a DNS proxy in the same system extension. macOS 15+ only,
    /// because the proxy needs the flow APIs added there.
    var dnsProxySupported: Bool {
        if #available(macOS 15.0, *) { return true }
        return false
    }

    func setDNSProxyEnabled(_ enabled: Bool) async {
        guard let extensionInfo, dnsProxySupported else { return }
        let manager = NEDNSProxyManager.shared()
        do {
            try await manager.loadFromPreferences()
            if enabled {
                let proto = NEDNSProxyProviderProtocol()
                proto.providerBundleIdentifier = extensionInfo.bundleIdentifier
                proto.serverAddress = "Tattle"
                manager.providerProtocol = proto
                manager.localizedDescription = "Tattle DNS"
            }
            manager.isEnabled = enabled
            try await manager.saveToPreferences()
            lastError = nil
        } catch {
            logger.error("Saving DNS proxy configuration failed: \(error.localizedDescription, privacy: .public)")
            lastError = error.localizedDescription
        }
        refreshFilterState()
    }

    private func refreshFilterState() {
        Task {
            let filter = NEFilterManager.shared()
            try? await filter.loadFromPreferences()
            filterEnabled = filter.isEnabled
            let dns = NEDNSProxyManager.shared()
            try? await dns.loadFromPreferences()
            dnsProxyEnabled = dns.isEnabled
        }
    }

    private func submit(_ request: OSSystemExtensionRequest) {
        request.delegate = requestDelegate
        OSSystemExtensionManager.shared.submitRequest(request)
    }

    private func handle(_ result: RequestDelegate.Result) {
        switch result {
        case .needsApproval:
            extensionState = .needsApproval
        case .completed(.completed):
            extensionState = .activated
            lastError = nil
        case .completed(.willCompleteAfterReboot):
            extensionState = .needsReboot
        case .completed:
            extensionState = .unknown
        case .properties(let properties):
            if let active = properties.first(where: { $0.isEnabled && !$0.isUninstalling }) {
                extensionState = .activated
                if let embeddedVersion, active.bundleVersion != embeddedVersion, !requestedUpgrade {
                    requestedUpgrade = true
                    logger.info("Replacing extension \(active.bundleVersion, privacy: .public) with \(embeddedVersion, privacy: .public)")
                    installExtension()
                }
            } else if properties.contains(where: \.isAwaitingUserApproval) {
                extensionState = .needsApproval
            } else {
                extensionState = .notInstalled
            }
        case .failed(let message):
            extensionState = .failed(message)
            lastError = message
        }
    }
}

/// OSSystemExtensionRequestDelegate callbacks arrive on the queue given to the request,
/// which is always the main queue here.
@MainActor
private final class RequestDelegate: NSObject, @preconcurrency OSSystemExtensionRequestDelegate {
    enum Result {
        case needsApproval
        case completed(OSSystemExtensionRequest.Result)
        case properties([OSSystemExtensionProperties])
        case failed(String)
    }

    var onResult: ((Result) -> Void)?

    private func deliver(_ result: Result) {
        onResult?(result)
    }

    func request(
        _ request: OSSystemExtensionRequest,
        actionForReplacingExtension existing: OSSystemExtensionProperties,
        withExtension ext: OSSystemExtensionProperties
    ) -> OSSystemExtensionRequest.ReplacementAction {
        .replace
    }

    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        deliver(.needsApproval)
    }

    func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        deliver(.completed(result))
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        deliver(.failed(error.localizedDescription))
    }

    func request(_ request: OSSystemExtensionRequest, foundProperties properties: [OSSystemExtensionProperties]) {
        deliver(.properties(properties))
    }
}
