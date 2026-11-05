import AppKit
import MyPeopleKit
import SwiftUI

struct PhoneView: View {
    @Environment(AppModel.self) private var model
    @State private var minutes = 10
    @State private var noPhotos = false
    @State private var exportPath = ""
    @State private var exportNoPhotos = false
    @State private var send = false
    @State private var editsPath = ""
    @State private var memoryPath = ""

    var body: some View {
        let pairing = model.latestJob("transfer_qr")
        Page(title: "Phone", subtitle: "Exchange contacts, notes and facts directly with your phone.") {
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
                }
                .formStyle(.columns)
                Button("Show Pairing QR") {
                    Task { await model.startJob("transfer_qr", jobParams(["minutes": .int(minutes), "no_photos": .bool(noPhotos)])) }
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
                    Button("Import Edits") {
                        Task { await model.startJob("transfer_import", jobParams(["path": .string(editsPath)])) }
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
                    Muted("Brings over contact changes, notes and facts. Messages stay on the other Mac.", font: .caption)
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
