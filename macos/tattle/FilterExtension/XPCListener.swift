import Foundation
import TattleShared
import os

/// Accepts XPC connections from the Tattle app and `tattlectl` only.
///
/// Two checks, both required:
/// 1. `setCodeSigningRequirement`: the system verifies every message comes from code signed
///    by our team with the app's or the CLI's identifier.
/// 2. The caller's identity decides its role: the app may do everything; `tattlectl` may
///    only read unless it runs as root.
final class XPCListener: NSObject, NSXPCListenerDelegate, @unchecked Sendable {
    private let listener: NSXPCListener
    private let service: FilterService
    private let teamID: String
    private let appSigningID: String
    private let cliSigningID: String
    private let requirement: String
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Tattle", category: "xpc")

    init(machServiceName: String, service: FilterService, teamID: String, appSigningID: String, cliSigningID: String) {
        listener = NSXPCListener(machServiceName: machServiceName)
        self.service = service
        self.teamID = teamID
        self.appSigningID = appSigningID
        self.cliSigningID = cliSigningID
        requirement = CodeRequirement.signed(teamID: teamID, identifiers: [appSigningID, cliSigningID])
        super.init()
        listener.delegate = self
        listener.resume()
    }

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        connection.setCodeSigningRequirement(requirement)
        let identity = CodeIdentity.resolve(pid: connection.processIdentifier)
        guard identity.signature == .developer, identity.teamID == teamID else {
            logger.error("Rejected XPC client \(identity.path, privacy: .public)")
            return false
        }
        let caller: Caller
        switch identity.signingID {
        case appSigningID: caller = .app
        case cliSigningID: caller = .cli(isRoot: connection.effectiveUserIdentifier == 0)
        default:
            logger.error("Rejected XPC client \(identity.signingID ?? "?", privacy: .public)")
            return false
        }

        let presenter = caller == .app ? XPCAlertPresenter(connection: connection) : nil
        connection.exportedInterface = NSXPCInterface(with: TattleServiceProtocol.self)
        connection.exportedObject = ServiceEndpoint(service: service, caller: caller, presenter: presenter)
        if presenter != nil {
            connection.remoteObjectInterface = NSXPCInterface(with: TattleClientProtocol.self)
        }
        connection.invalidationHandler = { [service] in
            if let presenter { service.removeAlertPresenter(presenter) }
        }
        connection.interruptionHandler = connection.invalidationHandler
        connection.resume()
        return true
    }
}

/// The object exported on each connection. Decodes, checks and forwards requests.
final class ServiceEndpoint: NSObject, TattleServiceProtocol, @unchecked Sendable {
    private let service: FilterService
    private let caller: Caller
    private let presenter: XPCAlertPresenter?

    init(service: FilterService, caller: Caller, presenter: XPCAlertPresenter?) {
        self.service = service
        self.caller = caller
        self.presenter = presenter
    }

    func perform(_ request: Data, withReply reply: @escaping @Sendable (Data) -> Void) {
        let response: ServiceResponse
        do {
            let decoded = try XPCCoding.decode(ServiceRequest.self, from: request)
            response = service.handle(decoded, caller: caller, presenter: presenter)
        } catch {
            response = .failure("Tattle didn't understand the request.")
        }
        reply(XPCCoding.encode(response))
    }
}

/// Shows alerts through the app on the other end of a connection.
final class XPCAlertPresenter: AlertPresenting, @unchecked Sendable {
    private weak var connection: NSXPCConnection?

    init(connection: NSXPCConnection) {
        self.connection = connection
    }

    func present(_ alert: AlertRequest, reply: @escaping @Sendable (AlertAnswer?) -> Void) {
        let once = OnceFlag()
        let proxy = connection?.remoteObjectProxyWithErrorHandler { _ in
            if once.claim() { reply(nil) }
        } as? TattleClientProtocol
        guard let proxy else {
            if once.claim() { reply(nil) }
            return
        }
        proxy.handleAlert(XPCCoding.encode(alert)) { data in
            guard once.claim() else { return }
            reply(try? XPCCoding.decode(AlertAnswer.self, from: data))
        }
    }
}

final class OnceFlag: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock(initialState: false)
    func claim() -> Bool {
        lock.withLock { done in
            defer { done = true }
            return !done
        }
    }
}
