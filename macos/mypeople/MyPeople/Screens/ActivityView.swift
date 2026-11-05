import MyPeopleKit
import SwiftUI

struct ActivityView: View {
    @Environment(AppModel.self) private var model
    @State private var selection: Int?
    @State private var input = ""

    var body: some View {
        let jobs = model.jobs.values.sorted { $0.id > $1.id }
        HSplitView {
            List(jobs, selection: $selection) { job in
                VStack(alignment: .leading, spacing: 2) {
                    Text(job.title).lineLimit(1)
                    HStack(spacing: 4) {
                        if job.isRunning { ProgressView().controlSize(.mini) }
                        Text(job.status.label)
                        Text("·")
                        Text(job.started, style: .time)
                    }
                    .font(.caption)
                    .foregroundStyle(job.status == .failed || job.status == .interrupted ? Kin.error : Kin.onSurfaceVariant)
                }
                .tag(job.id)
            }
            .frame(minWidth: 220, idealWidth: 260, maxWidth: 340)
            .overlay {
                if jobs.isEmpty {
                    ContentUnavailableView("Nothing yet", systemImage: "list.bullet.rectangle", description: Text("Imports, reading and everything else that takes a while show up here."))
                }
            }
            Group {
                if let job = selection.flatMap({ model.jobs[$0] }) ?? jobs.first {
                    detail(job)
                } else {
                    Color.clear
                }
            }
            .frame(minWidth: 400, maxWidth: .infinity, maxHeight: .infinity)
            .background(Kin.surface)
        }
    }

    private func detail(_ job: Job) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(job.title).font(Kin.display(22))
                Spacer()
                if job.isRunning { Button("Stop") { model.cancel(job) } }
                Button("Copy Output") { copyToPasteboard(job.lines.joined(separator: "\n")) }.disabled(job.lines.isEmpty)
            }
            Muted("\(job.status.label) · started \(job.started.formatted(date: .abbreviated, time: .standard))" + (job.finished.map { " · ended \($0.formatted(date: .omitted, time: .standard))" } ?? ""), font: .caption)
            if job.status == .interrupted { Muted("The engine stopped while this was running. Anything finished was kept.") }
            if job.droppedLines > 0 { Muted("Earlier output was dropped to save memory (\(job.droppedLines) lines).", font: .caption) }
            ScrollViewReader { proxy in
                ScrollView {
                    Text(verbatim: job.lines.joined(separator: "\n"))
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                    Color.clear.frame(height: 1).id("end")
                }
                .background(Kin.surfaceLow, in: RoundedRectangle(cornerRadius: 8))
                .onChange(of: job.lines.count, initial: true) { proxy.scrollTo("end", anchor: .bottom) }
            }
            if job.isRunning {
                HStack {
                    TextField("Answer a prompt", text: $input).textFieldStyle(.roundedBorder).onSubmit { send(job) }
                    Button("Send") { send(job) }
                }
                Muted("Only needed if it's waiting for an answer. Input goes straight to the running command.", font: .caption)
            }
        }
        .padding(18)
    }

    private func send(_ job: Job) {
        model.answer(job, text: input)
        input = ""
    }
}
