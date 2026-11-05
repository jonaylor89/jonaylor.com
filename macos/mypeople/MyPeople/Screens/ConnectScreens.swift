import AppKit
import MyPeopleKit
import SwiftUI

struct PhoneView: View {
    @Environment(AppModel.self) private var model
    @State private var minutes = 10
    @State private var noPhotos = false
    @State private var noEnrich = false
    @State private var exportPath = ""
    @State private var exportNoPhotos = false
    @State private var send = false
    @State private var editsPath = ""
    @State private var editsNoEnrich = false
    @State private var memoryPath = ""

    var body: some View {
        let pairing = model.latestJob("transfer_qr")
        Page(title: "Phone", subtitle: "Exchange memory with your phone directly, with no server.") {
            SectionTitle(text: "Bluetooth")
            Muted("Shows a private QR for your phone to scan. Your phone's edits are applied first, then it receives fresh memory. Don't share the QR.")
            if model.status?.extras.bluetooth == false {
                Requirement(text: "Bluetooth needs the CLI's bluetooth extra. Reinstall it with [bluetooth].")
            }
            if let job = pairing, job.isRunning {
                qr(job)
            } else {
                Form {
                    Stepper("Valid for \(minutes) minutes", value: $minutes, in: 1...60)
                    Toggle("Send without photos", isOn: $noPhotos)
                    Toggle("Leave model-backed requests for later", isOn: $noEnrich)
                }
                .formStyle(.columns)
                Button("Show Pairing QR") {
                    Task { await model.startJob("transfer_qr", jobParams(["minutes": .int(minutes), "no_photos": .bool(noPhotos), "no_enrich": .bool(noEnrich)])) }
                }
                .disabled(!model.isReady || model.status?.extras.bluetooth == false)
            }
            if let pairing { JobPanel(job: pairing, logHeight: 120) }

            SectionTitle(text: "Encrypted files")
            Muted("For USB or Files. Your phone asks for the transfer passphrase once\(model.status?.transferKey == true ? "." : "; it's created privately on your first export.")")
            CardBox {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Export memory for your phone").font(.headline)
                    PickFileField(title: "Save to", path: $exportPath, mode: .save("MyPeople-memory.sherloq"))
                    Toggle("Smaller file, without photos", isOn: $exportNoPhotos)
                    Toggle("Open Bluetooth File Exchange afterwards", isOn: $send)
                    Button("Export") {
                        Task { await model.startJob("transfer_export", jobParams(["path": .string(exportPath), "no_photos": .bool(exportNoPhotos), "send": .bool(send)])) }
                    }
                    .disabled(exportPath.isEmpty || !model.isReady)
                }
            }
            CardBox {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Import edits from your phone").font(.headline)
                    PickFileField(title: "Edits file", path: $editsPath, mode: .file, placeholder: "MyPeople-edits.sherloq")
                    Toggle("Leave model-backed requests for later", isOn: $editsNoEnrich)
                    Button("Import Edits") {
                        Task { await model.startJob("transfer_import", jobParams(["path": .string(editsPath), "no_enrich": .bool(editsNoEnrich)])) }
                    }
                    .disabled(editsPath.isEmpty || !model.isReady)
                    Muted("Afterwards, export a new memory file and send it back, to acknowledge these edits on your phone.", font: .caption)
                }
            }
            CardBox {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Merge another Mac's memory file").font(.headline)
                    PickFileField(title: "Memory file", path: $memoryPath, mode: .file, placeholder: "MyPeople-memory.sherloq")
                    Button("Reconcile") {
                        Task { await model.startJob("transfer_merge", ["path": .string(memoryPath)]) }
                    }
                    .disabled(memoryPath.isEmpty || !model.isReady)
                    Muted("Reconciles contact changes only. No messages are imported.", font: .caption)
                }
            }
            if let job = model.latestJob("transfer_export", "transfer_import", "transfer_merge") { JobPanel(job: job, logHeight: 100) }
        }
    }

    private func qr(_ job: Job) -> some View {
        CardBox {
            HStack(alignment: .top, spacing: 18) {
                if let path = job.qrPath, let image = NSImage(contentsOfFile: path) {
                    Image(nsImage: image)
                        .interpolation(.none)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 240, height: 240)
                        .background(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .accessibilityLabel("Pairing QR code")
                } else {
                    ProgressView().frame(width: 240, height: 240)
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Scan this with MyPeople on your phone").font(.headline)
                    if let expires = job.qrExpires {
                        Text("Expires \(expires, style: .relative)").font(.callout).foregroundStyle(Kin.onSurfaceVariant)
                    }
                    Button("Stop") { model.cancel(job) }
                }
            }
        }
    }
}

struct SyncView: View {
    @Environment(AppModel.self) private var model
    @State private var url = ""
    @State private var token = ""
    @State private var saving = false
    @State private var setupError: String?
    @State private var noEnrich = false
    @State private var full = false
    @State private var watch = false
    @State private var interval = 300

    @State private var data = ""
    @State private var host = ""
    @State private var port = ""
    @State private var devices: ServerDevices?
    @State private var deviceName = ""
    @State private var deviceRole = "phone"
    @State private var issuedToken: (name: String, token: String)?
    @State private var serverError: String?

    private var configured: Bool { model.status?.sync.configured == true }

    var body: some View {
        Page(title: "Sync", subtitle: "Keep your phone in step through a server you run. Entirely optional.") {
            SectionTitle(text: "This Mac")
            if let current = model.status?.sync.url {
                LabeledContent("Server") { Text(verbatim: current).textSelection(.enabled) }
            } else {
                Muted("Not connected to a server yet.")
            }
            Form {
                TextField("Server address", text: $url, prompt: Text(verbatim: "https://your-server.tailnet.ts.net"))
                SecureField("Mac device token", text: $token)
            }
            .formStyle(.columns)
            Muted("Use HTTPS, usually with Tailscale Serve. The token is stored privately and is never shown again. Connecting to a new server pushes everything to it.", font: .caption)
            if let setupError { Text(setupError).foregroundStyle(Kin.error) }
            Button(configured ? "Replace Connection" : "Connect") { Task { await setUp() } }
                .disabled(saving || url.isEmpty || token.isEmpty || !model.isReady)

            Form {
                Toggle("Apply edits only, leaving enrichment requests for later", isOn: $noEnrich)
                Toggle("Push every record again, not only what changed", isOn: $full)
                Toggle("Keep syncing", isOn: $watch)
                if watch { Stepper("Every \(interval) seconds", value: $interval, in: 30...3600, step: 30) }
            }
            .formStyle(.columns)
            .padding(.top, 8)
            let running = model.latestJob("sync")?.isRunning == true
            Button(watch ? "Start Syncing" : "Sync Now") {
                Task { await model.startJob("sync", jobParams(["no_enrich": .bool(noEnrich), "full": .bool(full), "watch": watch ? .int(interval) : nil])) }
            }
            .disabled(!configured || running || !model.isReady)
            if let job = model.latestJob("sync") { JobPanel(job: job) }

            SectionTitle(text: "Sync server")
            Muted("Run the server on this Mac. Each device gets its own token, and only its hash is kept.")
            Form {
                PickFileField(title: "Data folder", path: $data, mode: .folder, placeholder: devices?.data ?? "The usual place")
                TextField("Address", text: $host, prompt: Text(verbatim: "127.0.0.1"))
                TextField("Port", text: $port, prompt: Text("8765"))
            }
            .formStyle(.columns)
            let serving = model.latestJob("server_run")
            HStack {
                if let serving, serving.isRunning {
                    Button("Stop Server") { model.cancel(serving) }
                } else {
                    Button("Start Server") {
                        Task { await model.startJob("server_run", jobParams(["data": stringValue(data), "host": stringValue(host), "port": intValue(port)])) }
                    }
                    .disabled(!model.isReady)
                }
            }
            if let serving { JobPanel(job: serving, logHeight: 110) }

            SectionTitle(text: "Devices")
            if let serverError { Text(serverError).foregroundStyle(Kin.error) }
            if let issuedToken {
                CardBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Token for \(issuedToken.name)").font(.headline)
                        Muted("Copy it now. It can't be shown again.")
                        HStack {
                            Text(verbatim: issuedToken.token).font(.system(.callout, design: .monospaced)).textSelection(.enabled).lineLimit(2)
                            Spacer()
                            Button("Copy") { copyToPasteboard(issuedToken.token) }
                            Button("Done") { self.issuedToken = nil }
                        }
                    }
                }
            }
            if let devices, devices.devices.isEmpty {
                Muted(devices.exists ? "No devices yet." : "No server here yet. Adding a device creates one.")
            }
            ForEach(devices?.devices ?? []) { device in
                HStack {
                    Label(device.name, systemImage: device.role == "phone" ? "iphone" : "laptopcomputer")
                    MetaLabel(text: device.role)
                    Spacer()
                    Button("Remove…") { remove(device.name) }
                }
            }
            HStack {
                TextField("Device name", text: $deviceName).textFieldStyle(.roundedBorder)
                Picker("Role", selection: $deviceRole) {
                    Text("Phone").tag("phone")
                    Text("Mac").tag("mac")
                }
                .labelsHidden()
                .frame(width: 100)
                Button("Add Device") { add() }.disabled(deviceName.trimmingCharacters(in: .whitespaces).isEmpty || !model.isReady)
            }
        }
        .task(id: data) { await loadDevices() }
    }

    private var dataParam: [String: JSONValue] { data.isEmpty ? [:] : ["data": .string(data)] }

    private func setUp() async {
        saving = true
        defer { saving = false }
        do {
            let _: NoReply = try await model.call("sync.setup", ["url": .string(url.trimmingCharacters(in: .whitespaces)), "token": .string(token.trimmingCharacters(in: .whitespacesAndNewlines))])
            token = ""
            url = ""
            setupError = nil
            model.refreshStatus()
            model.show("Connected. Sync to push your memory there.")
        } catch {
            setupError = error.localizedDescription
        }
    }

    private func loadDevices() async {
        do {
            devices = try await model.call("server.devices", .object(dataParam))
            serverError = nil
        } catch {
            serverError = error.localizedDescription
        }
    }

    private func add() {
        let name = deviceName.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                struct Issued: Decodable, Sendable { var token: String }
                var params = dataParam
                params["name"] = .string(name)
                params["role"] = .string(deviceRole)
                let issued: Issued = try await model.call("server.addDevice", .object(params))
                issuedToken = (name, issued.token)
                deviceName = ""
                serverError = nil
                await loadDevices()
            } catch {
                serverError = error.localizedDescription
            }
        }
    }

    private func remove(_ name: String) {
        let alert = NSAlert()
        alert.messageText = "Remove \(name)?"
        alert.informativeText = "Its token stops working immediately."
        alert.addButton(withTitle: "Remove")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        Task {
            do {
                var params = dataParam
                params["name"] = .string(name)
                struct Removed: Decodable, Sendable { var removed: Bool }
                let _: Removed = try await model.call("server.removeDevice", .object(params))
                await loadDevices()
            } catch {
                serverError = error.localizedDescription
            }
        }
    }
}

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
