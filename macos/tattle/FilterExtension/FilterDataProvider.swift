import Foundation
import Network
@preconcurrency import NetworkExtension
import TattleShared
import os

/// The content filter. For each new outbound flow it resolves the process, asks the
/// service for a verdict from memory, and either answers immediately or pauses the flow
/// while the user decides. It never waits on disk, the network or the app on the filter
/// thread: code-signature checks for new processes and alerts run on other queues and
/// finish with `resumeFlow`.
// NetworkExtension calls providers from its own threads and documents resumeFlow as
// thread-safe; the only state here is the shared runtime, which is itself thread-safe.
final class FilterDataProvider: NEFilterDataProvider, @unchecked Sendable {
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Tattle.FilterExtension", category: "filter")
    private var runtime: ExtensionRuntime { .shared }

    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        _ = runtime  // open the database and XPC listener before the first flow
        // Loopback traffic never reaches handleNewFlow. Everything else does.
        let settings = NEFilterSettings(rules: Self.loopbackRules(), defaultAction: .filterData)
        nonisolated(unsafe) let completion = completionHandler
        apply(settings) { [logger] error in
            if let error {
                logger.error("Failed to apply filter settings: \(error.localizedDescription, privacy: .public)")
            } else {
                logger.info("Filter started")
            }
            completion(error)
        }
    }

    override func stopFilter(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        logger.info("Filter stopped, reason \(reason.rawValue)")
        runtime.service.flush()
        completionHandler()
    }

    override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        guard let socketFlow = flow as? NEFilterSocketFlow, socketFlow.direction == .outbound else { return .allow() }
        let remote = socketFlow.remote
        let address = remote.flatMap { IPAddress($0.host) }
        // Second line of defence for loopback, in case the filter-level rules don't apply.
        if address?.isLoopback == true { return .allow() }

        let service = runtime.service
        var hostnames: [String] = []
        if let name = socketFlow.remoteHostname, !name.isEmpty {
            hostnames.append(name)
            if let address { service.hostnames.record(hostname: name, address: address) }
        } else if let remote, address == nil {
            hostnames.append(remote.host)
        }
        if let address { hostnames += service.hostnames.hostnames(for: address) }

        let proto: TransportProtocol = switch socketFlow.socketProtocol {
        case IPPROTO_TCP: .tcp
        case IPPROTO_UDP: .udp
        default: .any
        }
        let token = flow.sourceAppAuditToken
        let instance = token.flatMap(CodeIdentity.processInstance)
        let partial = FlowInfo(
            process: .unknown(), processInstance: instance, proto: proto, remoteAddress: address,
            remotePort: remote?.port ?? 0, hostnames: hostnames
        )

        if let instance, let identity = runtime.identities.identity(for: instance) {
            var info = partial
            info.process = identity
            switch decide(flow, info: info) {
            case .now(let verdict): return verdict
            case .waitingForAlert: return .pause()
            }
        }

        // First flow from this process: check its signature off the filter thread.
        runtime.identityQueue.async { [weak self, runtime] in
            let identity = token.map(CodeIdentity.resolve) ?? .unknown()
            // Cache failures too: a process whose signature can't be read once won't become
            // readable later, and retrying on every flow is expensive.
            if let instance { runtime.identities.store(identity, for: instance) }
            var info = partial
            info.process = identity
            guard let self else { return }
            // An alert resumes the flow itself once answered.
            if case .now(let verdict) = self.decide(flow, info: info) { self.resumeFlow(flow, with: verdict) }
        }
        return .pause()
    }

    private enum Outcome {
        case now(NEFilterNewFlowVerdict)
        /// An alert is pending; it calls `resumeFlow` when answered or timed out.
        case waitingForAlert
    }

    /// Decides from memory, or starts an alert.
    private func decide(_ flow: NEFilterFlow, info: FlowInfo) -> Outcome {
        let service = runtime.service
        let flowID = flow.identifier
        let decision = service.decide(info)
        guard decision == .ask else {
            service.record(flowID: flowID, flow: info, decision: decision)
            return .now(Self.newFlowVerdict(decision))
        }
        let immediate = service.requestAlert(flowID: flowID, flow: info) { [weak self] decision in
            self?.resumeFlow(flow, with: Self.newFlowVerdict(decision))
        }
        if let immediate { return .now(Self.newFlowVerdict(immediate)) }
        return .waitingForAlert
    }

    private static func newFlowVerdict(_ decision: Decision) -> NEFilterNewFlowVerdict {
        guard decision.action == .allow else { return .drop() }
        let verdict = NEFilterNewFlowVerdict.allow()
        // Byte counts for traffic statistics arrive in handle(_ report:).
        verdict.shouldReport = true
        verdict.statisticsReportFrequency = .low
        return verdict
    }

    override func handle(_ report: NEFilterReport) {
        guard let flow = report.flow, report.event == .statistics || report.event == .flowClosed else { return }
        runtime.service.updateBytes(
            flowID: flow.identifier, bytesIn: Int64(report.bytesInboundCount), bytesOut: Int64(report.bytesOutboundCount),
            closed: report.event == .flowClosed
        )
    }

    private static func loopbackRules() -> [NEFilterRule] {
        [("127.0.0.0", 8), ("::1", 128)].map { address, prefix in
            NEFilterRule(networkRule: remoteNetworkRule(address: address, prefix: prefix), action: .allow)
        }
    }

    private static func remoteNetworkRule(address: String, prefix: Int) -> NENetworkRule {
        if #available(macOS 15.0, *) {
            return NENetworkRule(
                remoteNetworkEndpoint: .hostPort(host: NWEndpoint.Host(address), port: 0), remotePrefix: prefix,
                localNetworkEndpoint: nil, localPrefix: 0,
                protocol: .any, direction: .any
            )
        }
        return NENetworkRule(
            __remoteNetwork: __NWHostEndpoint(hostname: address, port: "0"), remotePrefix: prefix,
            localNetwork: nil, localPrefix: 0,
            protocol: .any, direction: .any
        )
    }
}
