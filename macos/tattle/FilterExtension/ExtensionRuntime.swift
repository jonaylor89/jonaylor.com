import Foundation
import Network
import TattleShared
import os

/// State shared by the filter and DNS proxy providers, which macOS runs in this one process:
/// the database, the service, the identity cache and the XPC listener.
final class ExtensionRuntime: @unchecked Sendable {
    static let shared = ExtensionRuntime()

    let service: FilterService
    let identities = IdentityCache()
    /// Resolves code signatures for flows whose process isn't cached yet.
    let identityQueue = DispatchQueue(label: "Tattle.identity", qos: .userInitiated, attributes: .concurrent)
    let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Tattle.FilterExtension", category: "runtime")

    private let listener: XPCListener?
    private let pathMonitor = NWPathMonitor()

    private init() {
        let bundleID = Bundle.main.bundleIdentifier ?? ""
        // The app's identifier is the extension's minus ".FilterExtension".
        let prefix = bundleID.hasSuffix(".FilterExtension") ? String(bundleID.dropLast(".FilterExtension".count)) : bundleID
        let signing = CodeIdentity.current()

        let database: TattleDatabase
        do {
            database = try TattleDatabase(path: try Self.databasePath())
        } catch {
            // Keep filtering with defaults rather than fail; nothing persists until fixed.
            Logger(subsystem: bundleID, category: "runtime").fault("Opening the database failed, using memory: \(String(describing: error), privacy: .public)")
            database = try! TattleDatabase()
        }

        service = FilterService(database: database, configuration: .init(
            version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?",
            bootSession: Self.bootSession(),
            tattleSigningID: prefix,
            tattleTeamID: signing?.teamID,
            fetchBlocklist: Self.fetch
        ))
        service.start()

        if let info = try? ExtensionInfo(infoDictionary: Bundle.main.infoDictionary ?? [:]), let teamID = signing?.teamID {
            listener = XPCListener(
                machServiceName: info.machServiceName, service: service, teamID: teamID,
                appSigningID: prefix, cliSigningID: prefix + ".ctl"
            )
        } else {
            // Unsigned development build: no one can be verified, so no one may connect.
            listener = nil
            logger.error("Not signed by a team; the XPC service is disabled.")
        }

        pathMonitor.pathUpdateHandler = { [service] path in
            service.interfacesChanged(path.availableInterfaces.map(\.name))
        }
        pathMonitor.start(queue: DispatchQueue(label: "Tattle.path"))
    }

    private static func databasePath() throws -> String {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appending(path: "Tattle", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return directory.appending(path: "tattle.sqlite").path(percentEncoded: false)
    }

    /// Identifies this boot, so until-restart rules expire after a restart.
    private static func bootSession() -> String {
        var size = 0
        if sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 0 {
            var buffer = [UInt8](repeating: 0, count: size)
            if sysctlbyname("kern.bootsessionuuid", &buffer, &size, nil, 0) == 0 {
                return String(decoding: buffer.prefix { $0 != 0 }, as: UTF8.self)
            }
        }
        var boottime = timeval()
        size = MemoryLayout<timeval>.size
        sysctlbyname("kern.boottime", &boottime, &size, nil, 0)
        return "boot-\(boottime.tv_sec)"
    }

    static let maxBlocklistBytes = 64 * 1024 * 1024

    /// Downloads a blocklist: HTTPS only, no cookies or cache, size-capped.
    @Sendable static func fetch(_ url: URL) async throws -> Data {
        guard url.scheme == "https" else { throw URLError(.unsupportedURL) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 120
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        let (bytes, response) = try await session.bytes(from: url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count > maxBlocklistBytes { throw URLError(.dataLengthExceedsMaximum) }
        }
        return data
    }
}
