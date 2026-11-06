import AppKit
import MyPeopleKit
import SwiftUI

private struct ImportSource: Identifiable, Hashable {
    enum PathNeed: Hashable { case none, optional, file, folder, either }
    var id: String
    var title: String
    var symbol: String
    var detail: String
    var path: PathNeed
    var fullDisk = false
    var hint = ""
}

private let importGroups: [(title: String, sources: [ImportSource])] = [
    ("On this Mac", [
        ImportSource(id: "imessage", title: "iMessage", symbol: "message", detail: "Your Messages history on this Mac.", path: .optional, fullDisk: true),
        ImportSource(id: "whatsapp", title: "WhatsApp", symbol: "phone.bubble", detail: "WhatsApp Desktop's messages on this Mac.", path: .optional, fullDisk: true),
        ImportSource(id: "mino", title: "Mino", symbol: "envelope", detail: "Mail stored by the Mino app.", path: .optional),
        ImportSource(id: "signal", title: "Signal", symbol: "lock.shield", detail: "A snapshot exported from Signal Desktop. Only conversation and message fields leave its database, and never keys or attachments.", path: .file, hint: "Signal snapshot (.jsonl)"),
    ]),
    ("Contacts", [
        ImportSource(id: "vcf", title: "vCard File", symbol: "person.crop.square", detail: "A .vcf file, from Contacts or anywhere else. Originals are kept, so nothing is lost.", path: .file, hint: "Contacts.vcf"),
        ImportSource(id: "google", title: "Google Contacts", symbol: "person.crop.rectangle.stack", detail: "Reads your contacts using your Google sign-in. Set that up on the Google screen.", path: .none),
    ]),
    ("From an Export", [
        ImportSource(id: "instagram", title: "Instagram", symbol: "camera", detail: "The unzipped folder from Instagram's Download Your Information.", path: .folder, hint: "instagram-yourname-2026-10-23-abc"),
        ImportSource(id: "linkedin", title: "LinkedIn", symbol: "briefcase", detail: "The unzipped folder from LinkedIn's data export.", path: .folder, hint: "Basic_LinkedInDataExport_10-24-2026"),
        ImportSource(id: "twitter", title: "X", symbol: "at", detail: "An unzipped X archive. Conversations it doesn't name wait for you to say who they're with.", path: .folder, hint: "twitter-2026-10-27-abc"),
        ImportSource(id: "telegram", title: "Telegram", symbol: "paperplane", detail: "Telegram Desktop's JSON export: the folder or its result.json.", path: .either, hint: "result.json"),
        ImportSource(id: "snapchat", title: "Snapchat", symbol: "bolt", detail: "The unzipped Snapchat export folder.", path: .folder, hint: "mydata~1234"),
        ImportSource(id: "gvoice", title: "Google Voice", symbol: "phone", detail: "The Voice folder from Google Takeout.", path: .folder, hint: "Takeout/Voice"),
        ImportSource(id: "mbox", title: "Mail Archive", symbol: "tray.full", detail: "An mbox file. MyPeople needs your own addresses to tell sent mail from received.", path: .file, hint: "All mail.mbox"),
    ]),
]

struct ImportView: View {
    @Environment(AppModel.self) private var model
    @State private var selection = "imessage"
    @State private var path = ""
    @State private var since = ""
    @State private var me = ""
    @State private var names = ""
    @State private var naming = false
    @State private var signalOutput = ""

    private var source: ImportSource {
        importGroups.flatMap(\.sources).first { $0.id == selection } ?? importGroups[0].sources[0]
    }

    private var canRun: Bool {
        guard model.isReady else { return false }
        switch source.path {
        case .file, .folder, .either: if path.isEmpty { return false }
        default: break
        }
        return since.isEmpty || LocalDay(since) != nil
    }

    var body: some View {
        HStack(spacing: 0) {
            List(selection: $selection) {
                ForEach(importGroups, id: \.title) { group in
                    Section(group.title) {
                        ForEach(group.sources) { source in
                            Label(source.title, systemImage: source.symbol).tag(source.id)
                        }
                    }
                }
            }
            .frame(width: 210)
            Divider()
            form
        }
        .onChange(of: selection) { path = ""; names = "" }
        .sheet(isPresented: $naming) { XNamingSheet(root: path) { reimport() } }
    }

    private var form: some View {
        Page(title: "Import \(source.title)", subtitle: source.detail, maxWidth: 620) {
            if source.fullDisk, model.status?.fullDiskAccess == false {
                FullDiskAccessNote()
            }
            if source.fullDisk || source.id == "mino" {
                let found = source.id == "imessage" ? model.status?.sources.imessage : source.id == "whatsapp" ? model.status?.sources.whatsapp : model.status?.sources.mino
                if found == false && path.isEmpty {
                    Requirement(text: "\(source.title) wasn't found in its usual place on this Mac. Choose its data below, if it's somewhere else.")
                }
            }
            if source.id == "signal" { signalHelp }
            if source.id == "google", model.status?.google.signedIn == false {
                HStack {
                    Requirement(text: "Sign in to Google first.")
                    Button("Open Google") { model.go(.google) }.buttonStyle(.link)
                }
            }
            if source.id == "mbox", me.isEmpty {
                Requirement(text: "Enter your addresses, or mark your own record in Settings.")
            }
            Form {
                switch source.path {
                case .none: EmptyView()
                case .optional: PickFileField(title: "Data (optional)", path: $path, mode: .either, placeholder: "The usual place")
                case .file: PickFileField(title: "File", path: $path, mode: .file, placeholder: source.hint)
                case .folder: PickFileField(title: "Folder", path: $path, mode: .folder, placeholder: source.hint)
                case .either: PickFileField(title: "Export", path: $path, mode: .either, placeholder: source.hint)
                }
                if source.id != "vcf" && source.id != "google" {
                    TextField("Only from this date (optional)", text: $since, prompt: Text("YYYY-MM-DD"))
                }
                if source.id == "mbox" {
                    TextField("Your email addresses", text: $me, prompt: Text(verbatim: "you@example.com, you@work.example"))
                }
                if source.id == "twitter" {
                    PickFileField(title: "Names file (optional)", path: $names, mode: .file, placeholder: "One \"ID @handle Display Name\" per line")
                }
            }
            .formStyle(.columns)
            HStack {
                Button("Import") { run() }.keyboardShortcut(.defaultAction).disabled(!canRun)
                if source.id == "twitter" {
                    Button("Name Conversations…") { naming = true }.disabled(path.isEmpty || !model.isReady)
                }
            }
            if let job = model.jobs.values.filter({ $0.kind == "import" && $0.params["source"]?.string == source.id }).max(by: { $0.id < $1.id }) {
                JobPanel(job: job)
            }
        }
    }

    private var signalHelp: some View {
        CardBox {
            VStack(alignment: .leading, spacing: 8) {
                Text("Make a snapshot from Signal Desktop").font(.headline)
                Muted("macOS will ask to use Signal's key from your Keychain. The snapshot holds your messages, so keep it private and delete it after importing.")
                if model.status?.sqlcipher == false {
                    Requirement(text: "This needs SQLCipher. In Terminal: brew install sqlcipher")
                }
                PickFileField(title: "Save to", path: $signalOutput, mode: .save("signal.jsonl"))
                HStack {
                    Button("Export from Signal") {
                        path = signalOutput
                        Task { await model.startJob("signal_export", ["output": .string(signalOutput)]) }
                    }
                    .disabled(signalOutput.isEmpty || !model.isReady)
                }
                if let job = model.latestJob("signal_export") { JobPanel(job: job, logHeight: 90) }
            }
        }
    }

    private func run() {
        let addresses = me.split(whereSeparator: { $0 == "," || $0.isWhitespace }).map(String.init)
        Task {
            await model.startJob("import", jobParams([
                "source": .string(source.id), "path": stringValue(path), "since": stringValue(since),
                "me": JSONValue(strings: addresses), "names": stringValue(names),
            ]))
        }
    }

    private func reimport() {
        run()
    }
}

struct FullDiskAccessNote: View {
    var body: some View {
        CardBox {
            VStack(alignment: .leading, spacing: 8) {
                Text("MyPeople needs Full Disk Access").font(.headline)
                Muted("macOS keeps other apps' messages private until you say otherwise. Turn on MyPeople in Full Disk Access, then come back and import. Anything it starts inherits the permission, and no Terminal needs it.")
                Button("Open Privacy Settings") {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") { NSWorkspace.shared.open(url) }
                }
            }
        }
    }
}

/// `import twitter --review`, as a screen.
private struct XNamingSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var root: String
    var finished: () -> Void
    @State private var todo: [UnnamedConversations.Conversation] = []
    @State private var index = 0
    @State private var name = ""
    @State private var handle = ""
    @State private var linked: Int?
    @State private var named = 0
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Who is this?").font(.title2.weight(.semibold))
            if loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if index >= todo.count {
                ContentUnavailableView(named > 0 ? "\(named) named" : "Nothing to name", systemImage: "checkmark.circle",
                                       description: Text(named > 0 ? "Import the archive again to bring those conversations in." : "The archive names everyone you wrote to, or you've named them already."))
                    .frame(maxHeight: .infinity)
            } else {
                conversation(todo[index])
            }
            if let error { Text(error).foregroundStyle(Kin.error).textSelection(.enabled) }
            HStack {
                if !loading && index < todo.count {
                    Muted("\(index + 1) of \(todo.count)", font: .caption)
                }
                Spacer()
                if index >= todo.count && named > 0 {
                    Button("Import Again") { finished(); dismiss() }.keyboardShortcut(.defaultAction)
                }
                Button(index >= todo.count ? "Done" : "Stop Here") {
                    if named > 0 && index < todo.count { finished() }
                    dismiss()
                }
            }
        }
        .padding(20)
        .frame(width: 560, height: 560)
        .task {
            defer { loading = false }
            do {
                let reply: UnnamedConversations = try await model.call("twitter.unnamed", ["root": .string(root)])
                todo = reply.conversations
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func conversation(_ c: UnnamedConversations.Conversation) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Muted("\(c.messages.count) messages", font: .caption)
                Spacer()
                WebLink(url: c.link)
            }
            if !c.tweetsShared.isEmpty {
                Muted("They sent you tweets by: \(c.tweetsShared.prefix(5).map { "@\($0)" }.joined(separator: ", "))", font: .caption)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(Array(c.messages.suffix(40).enumerated()), id: \.offset) { _, message in
                        HStack(alignment: .top) {
                            Text(String(message.at.prefix(10))).font(.caption.monospacedDigit()).foregroundStyle(Kin.onSurfaceVariant)
                            Text(message.mine ? "you" : "them").font(.caption.weight(.semibold)).frame(width: 32, alignment: .leading)
                            Text(message.text).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(8)
            .background(Kin.surfaceLow, in: RoundedRectangle(cornerRadius: 8))
            Form {
                TextField("Name", text: $name, prompt: Text("Ana Lopez"))
                TextField("@handle", text: $handle, prompt: Text("ana"))
                PersonPicker(title: "Or link to", anyoneLabel: "Someone new", selection: $linked)
            }
            .formStyle(.columns)
            HStack {
                Spacer()
                Button("Skip") { advance() }
                Button("Save") { Task { await save(c) } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty && handle.trimmingCharacters(in: .whitespaces).isEmpty && linked == nil)
            }
        }
    }

    private func advance() {
        index += 1
        name = ""; handle = ""; linked = nil; error = nil
    }

    private func save(_ c: UnnamedConversations.Conversation) async {
        do {
            let cleanHandle = handle.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "@"))
            struct Named: Decodable, Sendable { var person_id: Int }
            let _: Named = try await model.call("twitter.name", [
                "account_id": .string(c.accountId), "name": .string(name.trimmingCharacters(in: .whitespaces)),
                "handle": .string(cleanHandle), "person_id": linked.json,
            ])
            named += 1
            advance()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
