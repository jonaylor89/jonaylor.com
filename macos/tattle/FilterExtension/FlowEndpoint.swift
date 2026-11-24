import Network
@preconcurrency import NetworkExtension

/// A flow's remote address and port as plain values.
struct FlowEndpoint: Equatable {
    let host: String
    let port: UInt16
}

extension NEFilterSocketFlow {
    /// The remote endpoint. macOS 15 replaced the NetworkExtension endpoint classes with
    /// Network framework types; the SDK still exposes the old ones to Swift under `__` names,
    /// which macOS 14 needs.
    var remote: FlowEndpoint? {
        if #available(macOS 15.0, *) {
            guard case .hostPort(let host, let port) = remoteFlowEndpoint else { return nil }
            return FlowEndpoint(host: host.addressString, port: port.rawValue)
        }
        guard let endpoint = __remoteEndpoint as? __NWHostEndpoint else { return nil }
        return FlowEndpoint(host: endpoint.hostname, port: UInt16(endpoint.port) ?? 0)
    }
}

extension NWEndpoint.Host {
    /// The address or name without an interface scope suffix.
    var addressString: String {
        switch self {
        case .ipv4(let address): "\(address)".split(separator: "%").first.map(String.init) ?? "\(address)"
        case .ipv6(let address): "\(address)".split(separator: "%").first.map(String.init) ?? "\(address)"
        case .name(let name, _): name
        @unknown default: "\(self)"
        }
    }
}
