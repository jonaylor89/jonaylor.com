import AppKit
import MyPeopleKit
import SwiftUI

struct GoogleView: View {
    @Environment(AppModel.self) private var model
    @State private var photos = false
    @State private var noNotes = false
    @State private var create = false
    @State private var person: Int?
    @State private var minMessages = ""
    @State private var showCount = ""
    @State private var showNotes = false
    @State private var showFields = false
    @State private var confirmingApply = false
    @State private var useGoogle = false
    @State private var confirmingRecovery = false

    var body: some View {
        let google = model.status?.google
        Page(title: "Google", subtitle: "Enrich Google Contacts from your memory, without deleting or merging anything there.") {
            SectionTitle(text: "Account")
            if google?.client == false {
                Requirement(text: "Google needs an OAuth client file first. See the CLI's README for how to make one; it stays private on this Mac.")
            }
            HStack {
                Label(google?.signedIn == true ? "Signed in" : "Not signed in", systemImage: google?.signedIn == true ? "checkmark.circle.fill" : "person.crop.circle.badge.questionmark")
                Spacer()
                Button(google?.signedIn == true ? "Sign In Again" : "Sign In") {
                    Task { await model.startJob("google_login") }
                }
                .disabled(google?.client != true || !model.isReady)
            }
            if let job = model.latestJob("google_login") { JobPanel(job: job, logHeight: 80) }

            SectionTitle(text: "Update Google Contacts")
            Muted("Always preview first. Nothing changes in Google until you apply.")
            Form {
                Toggle("Upload photos to contacts that have none", isOn: $photos)
                Toggle("Leave Google notes alone", isOn: $noNotes)
                Toggle("Create contacts for people Google doesn't have", isOn: $create)
                PersonPicker(title: "Only for", anyoneLabel: "Everyone", selection: $person)
                if create && person == nil {
                    TextField("Messages needed to create someone", text: $minMessages, prompt: Text("20"))
                }
                TextField("Changes to list in the preview", text: $showCount, prompt: Text("25"))
                Toggle("Show proposed notes in the preview", isOn: $showNotes)
                Toggle("Show proposed fields in the preview", isOn: $showFields)
            }
            .formStyle(.columns)
            HStack {
                Button("Preview") { run(apply: false) }.keyboardShortcut(.defaultAction).disabled(google?.signedIn != true || !model.isReady)
                Button("Apply to Google…") { confirmingApply = true }.disabled(google?.signedIn != true || !model.isReady)
            }
            if let job = model.latestJob("google_sync") { JobPanel(job: job, logHeight: 240) }

            SectionTitle(text: "Recover phone numbers")
            Muted("Older imports can lose a number's country code. This looks for the original in linked sources and repairs only what's unambiguous, after a backup. Concurrent and manual changes are kept.")
            Toggle("Also read original Google Contacts (never writes to Google)", isOn: $useGoogle).disabled(google?.signedIn != true)
            HStack {
                Button("Preview Recovery") { recover(apply: false) }.disabled(!model.isReady)
                Button("Back Up and Apply…") { confirmingRecovery = true }.disabled(!model.isReady)
            }
            if let job = model.latestJob("recover_phones") { JobPanel(job: job, logHeight: 180) }
        }
        .confirmationDialog("Apply these changes to Google Contacts?", isPresented: $confirmingApply) {
            Button("Apply") { run(apply: true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("MyPeople only adds to Google: it doesn't delete or merge there. To roll back, use Undo Changes in Google Contacts' settings.")
        }
        .confirmationDialog("Back up, then repair phone numbers?", isPresented: $confirmingRecovery) {
            Button("Back Up and Apply") { recover(apply: true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Only unambiguous repairs are made, and a backup is written first.")
        }
    }

    private func run(apply: Bool) {
        Task {
            await model.startJob("google_sync", jobParams([
                "apply": .bool(apply), "photos": .bool(photos), "no_notes": .bool(noNotes), "create": .bool(create),
                "person_ids": person.map { JSONValue(ints: [$0]) }, "min_messages": create && person == nil ? intValue(minMessages) : nil,
                "show": apply ? nil : intValue(showCount), "show_notes": .bool(!apply && showNotes), "show_fields": .bool(!apply && showFields),
            ]))
        }
    }

    private func recover(apply: Bool) {
        Task { await model.startJob("recover_phones", jobParams(["google": .bool(useGoogle), "apply": .bool(apply)])) }
    }
}
