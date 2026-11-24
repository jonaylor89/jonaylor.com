import AppKit
import Observation
import TattleShared
import SwiftUI

/// Receives alerts from the extension over XPC and shows them one at a time in a floating
/// panel. If the user doesn't answer before the extension's timeout, the panel moves on;
/// the extension has already applied the default policy by then.
@MainActor
@Observable
final class AlertCenter: NSObject, TattleClientProtocol {
    struct Pending: Identifiable {
        let request: AlertRequest
        let receivedAt: Date
        let reply: @Sendable (Data) -> Void
        var id: UUID { request.id }
        var deadline: Date { receivedAt.addingTimeInterval(request.timeout) }
    }

    private(set) var queue: [Pending] = []
    var current: Pending? { queue.first }
    private var panel: NSPanel?

    nonisolated func handleAlert(_ alert: Data, withReply reply: @escaping @Sendable (Data) -> Void) {
        guard let request = try? XPCCoding.decode(AlertRequest.self, from: alert) else {
            reply(Data())
            return
        }
        Task { @MainActor in self.enqueue(Pending(request: request, receivedAt: Date(), reply: reply)) }
    }

    private func enqueue(_ pending: Pending) {
        queue.append(pending)
        if queue.count == 1 { show() }
        scheduleExpiry(pending)
    }

    func answer(_ answer: AlertAnswer) {
        guard let current else { return }
        current.reply(XPCCoding.encode(answer))
        advance()
    }

    private func scheduleExpiry(_ pending: Pending) {
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(pending.deadline.timeIntervalSinceNow, 0)))
            guard let self, let index = self.queue.firstIndex(where: { $0.id == pending.id }) else { return }
            self.queue[index].reply(Data())  // too late; the extension ignores it
            if index == 0 { self.advance() } else { self.queue.remove(at: index) }
        }
    }

    private func advance() {
        if !queue.isEmpty { queue.removeFirst() }
        if queue.isEmpty { panel?.orderOut(nil) } else { show() }
    }

    private func show() {
        if panel == nil {
            let panel = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 460, height: 320),
                styleMask: [.titled, .nonactivatingPanel, .fullSizeContentView],
                backing: .buffered, defer: false
            )
            panel.title = "Tattle"
            panel.titlebarAppearsTransparent = true
            panel.level = .floating
            panel.isFloatingPanel = true
            panel.hidesOnDeactivate = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.contentView = NSHostingView(rootView: AlertView(center: self))
            self.panel = panel
        }
        panel?.center()
        panel?.orderFrontRegardless()
    }
}
