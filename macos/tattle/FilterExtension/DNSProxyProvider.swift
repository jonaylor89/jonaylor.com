import Foundation
import Network
@preconcurrency import NetworkExtension
import TattleShared
import os

/// Forwards the Mac's DNS queries to the DNS-over-HTTPS resolver chosen in Settings, and
/// records every answer's host name → address mappings so domain rules can match flows
/// that only show an IP. Needs macOS 15 (the app only enables it there).
///
/// When the resolver fails, the query goes to the original DNS server instead if the user
/// allowed that fallback, otherwise the client gets SERVFAIL.
final class DNSProxyProvider: NEDNSProxyProvider, @unchecked Sendable {
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Tattle.FilterExtension", category: "dns")
    private var runtime: ExtensionRuntime { .shared }
    private let resolver = DoHResolver()

    override func startProxy(options: [String: Any]? = nil, completionHandler: @escaping (Error?) -> Void) {
        runtime.service.dnsProxyRunning = true
        logger.info("DNS proxy started")
        completionHandler(nil)
    }

    override func stopProxy(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        runtime.service.dnsProxyRunning = false
        logger.info("DNS proxy stopped, reason \(reason.rawValue)")
        completionHandler()
    }

    override func handleNewFlow(_ flow: NEAppProxyFlow) -> Bool {
        guard #available(macOS 15.0, *) else { return false }
        if let udp = flow as? NEAppProxyUDPFlow {
            handleUDP(udp)
            return true
        }
        if let tcp = flow as? NEAppProxyTCPFlow {
            handleTCP(tcp)
            return true
        }
        return false
    }

    // MARK: UDP

    @available(macOS 15.0, *)
    private func handleUDP(_ flow: NEAppProxyUDPFlow) {
        nonisolated(unsafe) let flow = flow
        flow.open(withLocalFlowEndpoint: nil) { [weak self] error in
            guard error == nil else { return }
            self?.readDatagrams(flow)
        }
    }

    @available(macOS 15.0, *)
    private func readDatagrams(_ flow: NEAppProxyUDPFlow) {
        nonisolated(unsafe) let flow = flow
        flow.readDatagrams { [weak self] datagrams, error in
            guard let self, error == nil, let datagrams, !datagrams.isEmpty else {
                flow.closeReadWithError(nil)
                flow.closeWriteWithError(nil)
                return
            }
            for (query, endpoint) in datagrams {
                self.answer(query, originalServer: endpoint, proto: .udp) { response in
                    flow.writeDatagrams([(response, endpoint)]) { _ in }
                }
            }
            self.readDatagrams(flow)
        }
    }

    // MARK: TCP (length-prefixed messages, RFC 1035 §4.2.2)

    @available(macOS 15.0, *)
    private func handleTCP(_ flow: NEAppProxyTCPFlow) {
        nonisolated(unsafe) let flow = flow
        let server = flow.remoteFlowEndpoint
        flow.open(withLocalFlowEndpoint: nil) { [weak self] error in
            guard error == nil else { return }
            self?.readTCP(flow, server: server, buffer: Data())
        }
    }

    @available(macOS 15.0, *)
    private func readTCP(_ flow: NEAppProxyTCPFlow, server: NWEndpoint, buffer: Data) {
        nonisolated(unsafe) let flow = flow
        flow.readData { [weak self] data, error in
            guard let self, error == nil, let data, !data.isEmpty, buffer.count + data.count <= 1 << 17 else {
                flow.closeReadWithError(nil)
                flow.closeWriteWithError(nil)
                return
            }
            var pending = buffer + data
            while pending.count >= 2 {
                let length = Int(pending[pending.startIndex]) << 8 | Int(pending[pending.startIndex + 1])
                guard pending.count >= 2 + length else { break }
                let query = Data(pending.dropFirst(2).prefix(length))
                pending = Data(pending.dropFirst(2 + length))
                self.answer(query, originalServer: server, proto: .tcp) { response in
                    var framed = Data([UInt8(response.count >> 8), UInt8(response.count & 0xFF)])
                    framed.append(response)
                    flow.write(framed) { _ in }
                }
            }
            self.readTCP(flow, server: server, buffer: pending)
        }
    }

    // MARK: Resolution

    private func answer(_ query: Data, originalServer: NWEndpoint, proto: NWParameters, reply: @escaping @Sendable (Data) -> Void) {
        let settings = runtime.service.currentSettings.dns
        let hostnames = runtime.service.hostnames
        let logger = logger
        let resolver = resolver
        Task {
            var response: Data?
            if settings.enabled, let url = URL(string: settings.resolverURL) {
                do {
                    response = try await resolver.resolve(query, via: url)
                } catch {
                    logger.debug("DoH query failed: \(error.localizedDescription, privacy: .public)")
                }
            }
            if response == nil, !settings.enabled || settings.fallbackToSystemDNS {
                response = try? await PlainDNS.query(query, server: originalServer, parameters: proto)
            }
            guard let response = response ?? DNSMessage.serverFailure(for: query) else { return }
            if let message = try? DNSMessage(parsing: response) {
                for mapping in message.addressMappings() {
                    hostnames.record(hostname: mapping.hostname, address: mapping.address, ttl: TimeInterval(mapping.ttl))
                }
            }
            reply(response)
        }
    }
}

/// RFC 8484 DNS-over-HTTPS client.
final class DoHResolver: Sendable {
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.httpMaximumConnectionsPerHost = 4
        return URLSession(configuration: configuration)
    }()

    func resolve(_ query: Data, via url: URL) async throws -> Data {
        guard url.scheme == "https", query.count <= 65_535 else { throw URLError(.unsupportedURL) }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/dns-message", forHTTPHeaderField: "Content-Type")
        request.setValue("application/dns-message", forHTTPHeaderField: "Accept")
        request.httpBody = query
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, data.count >= 12, data.count <= 65_535 else {
            throw URLError(.badServerResponse)
        }
        return data
    }
}

/// Sends one query to the server the client originally asked, for the fallback path.
enum PlainDNS {
    static func query(_ query: Data, server: NWEndpoint, parameters: NWParameters) async throws -> Data {
        let connection = NWConnection(to: server, using: parameters)
        let isTCP = parameters === NWParameters.tcp
        defer { connection.cancel() }
        return try await withCheckedThrowingContinuation { continuation in
            let once = OnceFlag()
            let finish: @Sendable (Result<Data, Error>) -> Void = { result in
                guard once.claim() else { return }
                continuation.resume(with: result)
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) { finish(.failure(URLError(.timedOut))) }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    var payload = query
                    if isTCP { payload = Data([UInt8(query.count >> 8), UInt8(query.count & 0xFF)]) + query }
                    connection.send(content: payload, completion: .contentProcessed { error in
                        if let error { finish(.failure(error)) }
                    })
                    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_537) { data, _, _, error in
                        if let error { return finish(.failure(error)) }
                        guard var data else { return finish(.failure(URLError(.zeroByteResource))) }
                        if isTCP { data = Data(data.dropFirst(2)) }
                        finish(.success(data))
                    }
                case .failed(let error):
                    finish(.failure(error))
                default:
                    break
                }
            }
            connection.start(queue: DispatchQueue.global())
        }
    }
}
