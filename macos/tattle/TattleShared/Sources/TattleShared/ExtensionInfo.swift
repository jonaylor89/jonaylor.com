import Foundation

/// Identifiers that the app and the filter extension must agree on.
///
/// They are not hard-coded: the build writes them into the extension's Info.plist from
/// `Config/Signing.xcconfig`, so a fork that changes the bundle prefix needs no code change.
/// The extension reads its own Info.plist; the app reads the one inside its embedded
/// `.systemextension` bundle.
public struct ExtensionInfo: Equatable, Sendable {
    /// Bundle identifier of the filter system extension.
    public let bundleIdentifier: String
    /// Mach service the extension's XPC listener registers. It has to start with an
    /// app group the extension is entitled to.
    public let machServiceName: String

    public init(bundleIdentifier: String, machServiceName: String) {
        self.bundleIdentifier = bundleIdentifier
        self.machServiceName = machServiceName
    }

    public enum ParseError: Error, Equatable {
        case missingBundleIdentifier
        case missingMachServiceName
    }

    /// Reads the identifiers from an extension's Info.plist dictionary.
    public init(infoDictionary: [String: Any]) throws {
        guard let bundleIdentifier = infoDictionary["CFBundleIdentifier"] as? String, !bundleIdentifier.isEmpty else {
            throw ParseError.missingBundleIdentifier
        }
        guard
            let networkExtension = infoDictionary["NetworkExtension"] as? [String: Any],
            let machServiceName = networkExtension["NEMachServiceName"] as? String,
            !machServiceName.isEmpty
        else {
            throw ParseError.missingMachServiceName
        }
        self.init(bundleIdentifier: bundleIdentifier, machServiceName: machServiceName)
    }

    /// Finds the single system extension embedded in an app bundle
    /// (`Contents/Library/SystemExtensions/*.systemextension`) and reads its identifiers.
    public static func embedded(in appBundle: Bundle) -> ExtensionInfo? {
        let directory = appBundle.bundleURL.appending(path: "Contents/Library/SystemExtensions", directoryHint: .isDirectory)
        let candidates = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        guard
            let url = candidates.first(where: { $0.pathExtension == "systemextension" }),
            let info = Bundle(url: url)?.infoDictionary
        else { return nil }
        return try? ExtensionInfo(infoDictionary: info)
    }
}
