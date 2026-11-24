import AppKit
import TattleShared
import SwiftUI

/// The connection alert: who, where, and how long the answer should last.
struct AlertView: View {
    let center: AlertCenter
    @State private var lifetime: RuleLifetime = .forever
    @State private var anyHost = false
    @State private var anyPort = false

    var body: some View {
        if let pending = center.current {
            content(pending)
                .id(pending.id)
                .onAppear { reset(for: pending) }
                .onChange(of: pending.id) { reset(for: pending) }
        }
    }

    private func content(_ pending: AlertCenter.Pending) -> some View {
        let request = pending.request
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                Image(nsImage: AppIcon.forExecutable(request.process.path))
                    .resizable()
                    .frame(width: 56, height: 56)
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(request.process.displayName) wants to connect to \(request.displayHost)")
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(destinationLine(request))
                        .foregroundStyle(.secondary)
                    SignatureLabel(process: request.process)
                        .font(.caption)
                }
            }

            Form {
                Picker("Remember", selection: $lifetime) {
                    Text("Only this time").tag(RuleLifetime.once)
                    Text("Until \(request.process.displayName) quits").tag(RuleLifetime.untilQuit)
                    if remembersIdentity(request) {
                        Text("Until restart").tag(RuleLifetime.untilRestart)
                        Text("Forever").tag(RuleLifetime.forever)
                    }
                }
                if !remembersIdentity(request) {
                    Text("Tattle can't recognise this process again after it quits, so it can only remember your answer while it runs.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Toggle("Any host", isOn: $anyHost)
                    .disabled(lifetime == .once)
                Toggle("Any port", isOn: $anyPort)
                    .disabled(lifetime == .once)
            }
            .formStyle(.columns)

            HStack {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let remaining = max(Int(pending.deadline.timeIntervalSince(context.date).rounded(.up)), 0)
                    Text("\(request.defaultPolicy == .allow ? "Allowing" : "Denying") in \(remaining)s")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                if center.queue.count > 1 {
                    Text("· \(center.queue.count - 1) more waiting")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Deny") { respond(.deny) }
                    .keyboardShortcut(.cancelAction)
                Button("Allow") { respond(.allow) }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    /// Signed or at least located processes can be recognised later; others only by PID.
    private func remembersIdentity(_ request: AlertRequest) -> Bool {
        request.process.isSigned || request.process.isLocated
    }

    private func reset(for pending: AlertCenter.Pending) {
        lifetime = remembersIdentity(pending.request) ? .forever : .untilQuit
        anyHost = false
        anyPort = false
    }

    private func destinationLine(_ request: AlertRequest) -> String {
        var parts = ["\(request.proto == .any ? "" : request.proto.rawValue.uppercased() + " ")port \(request.remotePort)"]
        if let address = request.remoteAddress, request.remoteHost != nil { parts.append(address) }
        if let pid = request.pid { parts.append("PID \(pid)") }
        return parts.joined(separator: " · ")
    }

    private func respond(_ action: RuleAction) {
        center.answer(AlertAnswer(action: action, lifetime: lifetime, anyHost: anyHost, anyPort: anyPort))
    }
}

struct SignatureLabel: View {
    let process: ProcessIdentity

    var body: some View {
        switch process.signature {
        case .apple:
            Label("Signed by Apple · \(process.signingID ?? "")", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
        case .developer:
            Label("Signed by team \(process.teamID ?? "?") · \(process.signingID ?? "")", systemImage: "checkmark.seal").foregroundStyle(.green)
        case .adHoc:
            Label("Ad-hoc signature: identity can't be verified", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
        case .unsigned:
            Label("Not signed: identity can't be verified", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        case .invalid:
            Label("Invalid signature", systemImage: "xmark.seal.fill").foregroundStyle(.red)
        case .unknown where process.isLocated:
            Label("Code signature can't be checked", systemImage: "questionmark.circle").foregroundStyle(.orange)
        case .unknown:
            Label("Can't be verified: its program file is gone (often replaced by an update while it kept running)", systemImage: "questionmark.circle")
                .foregroundStyle(.orange)
        }
    }
}

enum AppIcon {
    /// The icon of the app bundle containing the executable, or the executable's own icon.
    static func forExecutable(_ path: String) -> NSImage {
        var bundlePath = path
        if let range = path.range(of: ".app/", options: .backwards) {
            bundlePath = String(path[..<range.lowerBound]) + ".app"
        }
        return NSWorkspace.shared.icon(forFile: bundlePath)
    }
}

/// Plain-language descriptions of rules.
enum RuleText {
    static func process(_ match: ProcessMatch, bound: ProcessInstance? = nil) -> String {
        if match.isAny { return bound.map { "Process \($0.pid) (this run only)" } ?? "Any process" }
        if let path = match.path { return ProcessIdentity(signingID: nil, teamID: nil, path: path, signature: .unknown).displayName }
        if let signingID = match.signingID { return signingID }
        if let team = match.teamID { return team == ProcessMatch.appleTeamID ? "Apple software" : "Team \(team)" }
        return "Any process"
    }

    static func remote(_ remote: RemoteMatch) -> String {
        switch remote {
        case .any: "Any host"
        case .host(let name): name
        case .domain(let name): "\(name) and subdomains"
        case .ip(let address): address.description
        case .network(let network): network.description
        }
    }

    static func port(_ port: PortMatch, _ proto: TransportProtocol) -> String {
        let protoText = proto == .any ? "" : proto.rawValue.uppercased() + " "
        switch port {
        case .any: return proto == .any ? "Any port" : "\(protoText)any port"
        case .single(let value): return "\(protoText)\(value)"
        case .range(let low, let high): return "\(protoText)\(low)–\(high)"
        }
    }

    static func lifetime(_ rule: Rule) -> String {
        switch rule.lifetime {
        case .once: "Once"
        case .untilQuit: "Until quit"
        case .untilRestart: "Until restart"
        case .forever: "Forever"
        }
    }

    static func summary(_ rule: Rule) -> String {
        "\(rule.action == .allow ? "Allow" : "Deny") \(process(rule.process, bound: rule.boundProcess)) → \(remote(rule.remote))"
    }
}

extension Int64 {
    var bytesText: String { ByteCountFormatter.string(fromByteCount: self, countStyle: .file) }
}
