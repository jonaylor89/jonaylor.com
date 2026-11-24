import Foundation
import os

/// Talks to the filter extension's XPC service. Used by the app and `tattlectl`.
///
/// The connection is created lazily and recreated after it's invalidated (for example
/// when the extension restarts). The client checks the extension's code signature: it must
/// be signed by `teamID` with the extension's bundle identifier.
public final class TattleXPCClient: @unchecked Sendable {
    private let machServiceName: String
    private let serverRequirement: String?
    private let exportedObject: TattleClientProtocol?
    private let lock = NSLock()
    private var connection: NSXPCConnection?
    private let onReconnect: (@Sendable (TattleXPCClient) -> Void)?

    /// - Parameters:
    ///   - extensionInfo: where to connect.
    ///   - teamID: the team the extension must be signed by; nil skips the check (tests).
    ///   - alertHandler: exported to the extension so it can ask for alerts (app only).
    ///   - onReconnect: called after a dropped connection is re-established, so the app can
    ///     register for alerts again.
    public init(
        extensionInfo: ExtensionInfo, teamID: String?, alertHandler: TattleClientProtocol? = nil,
        onReconnect: (@Sendable (TattleXPCClient) -> Void)? = nil
    ) {
        machServiceName = extensionInfo.machServiceName
        serverRequirement = teamID.map {
            CodeRequirement.signed(teamID: $0, identifiers: [extensionInfo.bundleIdentifier])
        }
        exportedObject = alertHandler
        self.onReconnect = onReconnect
    }

    /// Returns the connection and whether it replaces an earlier, dropped one.
    private func currentConnection() -> (NSXPCConnection, isReconnect: Bool) {
        lock.withLock {
            if let connection { return (connection, false) }
            connectionsCreated += 1
            // The extension's Mach service lives in the system domain.
            let connection = NSXPCConnection(machServiceName: machServiceName, options: .privileged)
            connection.remoteObjectInterface = NSXPCInterface(with: TattleServiceProtocol.self)
            if let exportedObject {
                connection.exportedInterface = NSXPCInterface(with: TattleClientProtocol.self)
                connection.exportedObject = exportedObject
            }
            if let serverRequirement { connection.setCodeSigningRequirement(serverRequirement) }
            connection.invalidationHandler = { [weak self] in self?.dropConnection() }
            connection.interruptionHandler = { [weak self] in self?.dropConnection() }
            connection.resume()
            self.connection = connection
            return (connection, connectionsCreated > 1)
        }
    }

    private var connectionsCreated = 0

    private func dropConnection() {
        let old = lock.withLock {
            defer { connection = nil }
            return connection
        }
        old?.invalidate()
    }

    public func invalidate() { dropConnection() }

    /// Sends a request and waits for the response. Throws when the extension can't be
    /// reached; a `.failure` response is returned, not thrown.
    public func send(_ request: ServiceRequest, timeout: TimeInterval = 30) async throws -> ServiceResponse {
        let (connection, wasReconnect) = currentConnection()
        let payload = XPCCoding.encode(request)
        let data: Data = try await withCheckedThrowingContinuation { continuation in
            let once = Once()
            let proxy = connection.remoteObjectProxyWithErrorHandler { error in
                once.run { continuation.resume(throwing: XPCError.connectionFailed(error.localizedDescription)) }
            } as? TattleServiceProtocol
            guard let proxy else {
                once.run { continuation.resume(throwing: XPCError.extensionNotAvailable) }
                return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                once.run { continuation.resume(throwing: XPCError.connectionFailed("timed out")) }
            }
            proxy.perform(payload) { reply in
                once.run { continuation.resume(returning: reply) }
            }
        }
        if wasReconnect, request != .registerForAlerts { onReconnect?(self) }
        return try XPCCoding.decode(ServiceResponse.self, from: data)
    }
}

/// Runs a closure at most once, from any thread.
final class Once: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock(initialState: false)
    func run(_ body: () -> Void) {
        let first = lock.withLock { done in
            defer { done = true }
            return !done
        }
        if first { body() }
    }
}

public enum CodeRequirement {
    /// A requirement for code signed with an Apple-issued certificate (development or
    /// Developer ID) by `teamID`, with one of the given signing identifiers.
    public static func signed(teamID: String, identifiers: [String]) -> String {
        let ids = identifiers.map { "identifier \"\(escape($0))\"" }.joined(separator: " or ")
        return "anchor apple generic and certificate leaf[subject.OU] = \"\(escape(teamID))\" and (\(ids))"
    }

    private static func escape(_ value: String) -> String {
        value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    }
}
