import AppKit
import CoreText
import MyPeopleKit
import SwiftUI

@main
struct MyPeopleApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()

    init() {
        // Otherwise a window closed before quitting stays closed at the next launch, leaving no window
        // and no engine. The scene modifiers defaultLaunchBehavior and restorationBehavior don't prevent it.
        UserDefaults.standard.register(defaults: ["ApplePersistenceIgnoreState": true])
        Self.registerFonts()
    }

    var body: some Scene {
        // One window: the model holds one selection and one screen, so a second would just mirror it.
        Window("MyPeople", id: "main") {
            RootView()
                .environment(model)
                .frame(minWidth: 900, minHeight: 600)
                .task {
                    delegate.onTerminate = { [model] in model.stopEngine() }
                    delegate.runningWork = { [model] in model.jobs.values.filter(\.isRunning).map(\.title) }
                    await model.start()
                }
        }
        .defaultSize(width: 1180, height: 780)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Contact") { model.newContact() }
                    .keyboardShortcut("n")
                    .disabled(!model.isReady)
            }
            CommandGroup(after: .sidebar) {
                Button("Find People") { model.focusSearch() }
                    .keyboardShortcut("f")
                Button("Refresh Memory") { model.refreshView() }
                    .keyboardShortcut("r")
                    .disabled(!model.isReady)
                Divider()
                Button("Activity") { model.go(.activity) }
                    .keyboardShortcut("0")
            }
            PersonCommands()
        }

        Settings {
            SettingsView()
                .environment(model)
        }
    }

    private static func registerFonts() {
        guard let url = Bundle.main.url(forResource: "BricolageGrotesque", withExtension: "ttf") else { return }
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor var onTerminate: (() -> Void)?
    @MainActor var runningWork: (() -> [String])?

    /// Quitting stops whatever is running, so it asks first.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        MainActor.assumeIsolated {
            let running = runningWork?() ?? []
            guard let first = running.first else { return .terminateNow }
            let alert = NSAlert()
            alert.messageText = running.count == 1 ? "Stop “\(first)” and quit?" : "Stop \(running.count) running tasks and quit?"
            alert.informativeText = "Finished work is kept, and anything interrupted can be started again."
            alert.addButton(withTitle: "Stop and Quit")
            alert.addButton(withTitle: "Keep Running")
            return alert.runModal() == .alertFirstButtonReturn ? .terminateNow : .terminateCancel
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // The engine finishes by itself once its stdin closes, including stopping running jobs.
        MainActor.assumeIsolated { onTerminate?() }
    }

    /// Stays open with the window closed, as Mail does: running work carries on, and the Dock icon
    /// brings the window back.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

/// Edit (⌘E) applies to whichever person is on screen.
struct EditPersonKey: FocusedValueKey { typealias Value = () -> Void }
extension FocusedValues {
    var editPerson: (() -> Void)? {
        get { self[EditPersonKey.self] }
        set { self[EditPersonKey.self] = newValue }
    }
}

struct PersonCommands: Commands {
    @FocusedValue(\.editPerson) private var edit

    var body: some Commands {
        CommandMenu("Person") {
            Button("Edit Contact") { edit?() }
                .keyboardShortcut("e")
                .disabled(edit == nil)
        }
    }
}
