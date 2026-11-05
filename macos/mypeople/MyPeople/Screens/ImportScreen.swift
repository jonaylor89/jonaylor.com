import MyPeopleKit
import SwiftUI

/// Contacts from a .vcf file. Messages and other sources are imported with the CLI.
struct ImportView: View {
    @Environment(AppModel.self) private var model
    @State private var path = ""

    var body: some View {
        Page(title: "Import vCard", subtitle: "Add or update contacts from a .vcf file.", maxWidth: 620) {
            Form {
                PickFileField(title: "File", path: $path, mode: .file, placeholder: "contacts.vcf")
            }
            .formStyle(.columns)
            Button("Import") {
                Task { await model.startJob("import_vcf", ["path": .string(path)]) }
            }
            .keyboardShortcut(.defaultAction)
            .disabled(path.isEmpty || !model.isReady)
            Muted("To import messages or other sources, and read them for facts, use the mypeople command-line tool.", font: .caption)
            if let job = model.latestJob("import_vcf") { JobPanel(job: job) }
        }
    }
}
