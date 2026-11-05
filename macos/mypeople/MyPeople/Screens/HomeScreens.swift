import MyPeopleKit
import SwiftUI

private func capitalized(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }

struct TodayView: View {
    @Environment(AppModel.self) private var model
    @State private var previewing = false

    var body: some View {
        let day = LocalDay.today()
        let moments = model.derived("today:\(day)") { $0.today(day) }
        let recent = model.derived("recent") { $0.recentlyInTouch() }
        Page(title: "Keep people close.", subtitle: "A little memory. A reason to reach out.") {
            CardBox {
                HStack(spacing: 18) {
                    Text("\(day.day)").font(Kin.display(44))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: "\(Date().formatted(.dateTime.weekday(.wide))) · \(Date().formatted(.dateTime.month(.wide).year()))")
                            .font(.caption).foregroundStyle(Kin.onSurfaceVariant)
                        Text("Small moments. Lasting connections.").font(.headline)
                        Muted(moments.isEmpty ? "No nudges today. Reconnect at your own pace."
                            : "\(moments.count) reason\(moments.count == 1 ? "" : "s") to reach out, when it feels right.")
                    }
                }
            }
            if moments.isEmpty && recent.isEmpty {
                ContentUnavailableView {
                    Label("A quiet day", systemImage: "leaf")
                } description: {
                    Text("Nothing needs a nudge. A familiar name can be a good place to start.")
                } actions: {
                    Button("Explore your people") { model.go(.people) }
                }
            }
            ForEach(moments, id: \.key) { key, moment in
                CardBox {
                    VStack(alignment: .leading, spacing: 10) {
                        PersonLinkRow(id: moment.personId, detail: moment.surfacedOn == day.description ? "A moment for today" : formatDate(moment.surfacedOn))
                        Text(moment.reason).fixedSize(horizontal: false, vertical: true)
                        if let context = moment.context, !context.isEmpty { Muted(context) }
                        HStack {
                            Button { status(key, "done") } label: { Label("Done", systemImage: "checkmark") }
                            Button("Dismiss") { status(key, "dismissed") }
                        }
                    }
                }
            }
            if !recent.isEmpty {
                HStack {
                    SectionTitle(text: "Recently in touch")
                    Spacer()
                    Button("View all") { model.go(.people) }.buttonStyle(.link).padding(.top, 14)
                }
                CardBox {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(recent, id: \.id) { id, person in
                            PersonLinkRow(id: id, detail: "Last contact · \(formatDate(person.lastContact.map { String($0.prefix(10)) }))")
                        }
                    }
                }
            }
        }
        .toolbar {
            Button { previewing = true } label: { Label("Preview a Day", systemImage: "calendar.badge.clock") }
                .help("See what another day would surface, without marking anything as shown")
        }
        .sheet(isPresented: $previewing) { MomentPreview() }
    }

    private func status(_ key: String, _ value: String) {
        model.edit("moment_status", ["key": .string(key), "status": .string(value)])
    }
}

/// `mypeople today --preview --date -n`: what a day would surface, recording nothing.
private struct MomentPreview: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var date = Date()
    @State private var limit = 5
    @State private var items: [PreviewMoments.Item] = []
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Preview a day").font(.title2.weight(.semibold))
            Muted("Shows what MyPeople would surface. Nothing is marked as shown.")
            HStack {
                DatePicker("Date", selection: $date, displayedComponents: .date)
                Stepper("Up to \(limit)", value: $limit, in: 1...20)
            }
            if let error { Text(error).foregroundStyle(Kin.error) }
            List(items) { item in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(item.name).font(.headline)
                        Spacer()
                        MetaLabel(text: item.kind.replacingOccurrences(of: "_", with: " ").capitalized)
                    }
                    Text(item.reason)
                    if let context = item.context, !context.isEmpty { Muted(context) }
                }
                .padding(.vertical, 2)
            }
            .overlay { if items.isEmpty && error == nil { ContentUnavailableView("Nothing would surface", systemImage: "leaf") } }
            HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(20)
        .frame(width: 520, height: 480)
        .task(id: "\(date)-\(limit)") { await load() }
    }

    private func load() async {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        guard let day = LocalDay(year: c.year ?? 0, month: c.month ?? 0, day: c.day ?? 0) else { return }
        do {
            let reply: PreviewMoments = try await model.call("moments.preview", ["date": .string(day.description), "limit": .int(limit)])
            items = reply.moments
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct FeedView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let day = LocalDay.today()
        let weeks = model.derived("feed:\(day)") { $0.feedByWeek(day) }
        Page(title: "Feed", subtitle: "What people told you in the last 90 days, with where it came from.") {
            if weeks.isEmpty {
                ContentUnavailableView("No recent news", systemImage: "text.quote", description: Text("Facts from conversations in the last 90 days will appear here, with their sources."))
            }
            ForEach(weeks, id: \.week) { week, events in
                SectionTitle(text: "Week of \(formatDate(week.description))")
                ForEach(events, id: \.id) { _, event in
                    CardBox {
                        VStack(alignment: .leading, spacing: 8) {
                            PersonLinkRow(id: event.personId, detail: capitalized(event.type))
                            Text(event.value).fixedSize(horizontal: false, vertical: true)
                            Muted("Said on \(formatDate(event.saidAt.map { String($0.prefix(10)) })) · \(event.source)", font: .caption)
                        }
                    }
                }
            }
        }
    }
}

struct UpcomingView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let day = LocalDay.today()
        let upcoming = model.derived("upcoming:\(day)") { $0.upcoming(day) }
        Page(title: "Upcoming", subtitle: "The next 60 days.") {
            if upcoming.isEmpty {
                ContentUnavailableView("Room to be spontaneous", systemImage: "calendar", description: Text("Birthdays, anniversaries, trips and dated plans will appear here."))
            }
            ForEach(upcoming, id: \.eventId) { item in
                CardBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(formatDate(item.on.description), systemImage: "calendar")
                            .font(.callout.weight(.semibold)).foregroundStyle(Kin.tertiary)
                        PersonLinkRow(id: item.event.personId)
                        HStack {
                            MetaLabel(text: item.label)
                            Text(item.event.value).font(.callout)
                        }
                    }
                }
            }
        }
    }
}

struct AskView: View {
    @Environment(AppModel.self) private var model
    @State private var question = ""
    @FocusState private var focused: Bool

    var body: some View {
        Page(title: "Ask", subtitle: "A question about the people you know, answered from your memory.") {
            HStack {
                TextField("Who do I know in Lisbon?", text: $question, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .onSubmit(ask)
                Button("Ask", action: ask)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.isReady)
            }
            if let llm = model.status?.llm {
                Muted("Answered by \(llm.model)\(llm.local ? " on this Mac" : ", so relevant facts leave this Mac"). Change it in Settings.", font: .caption)
            }
            ForEach(model.asks.reversed(), id: \.jobId) { ask in
                CardBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(ask.question).font(.headline).textSelection(.enabled)
                        if let job = model.jobs[ask.jobId] {
                            if job.isRunning && job.lines.isEmpty {
                                HStack(spacing: 8) {
                                    ProgressView().controlSize(.small)
                                    Muted("Thinking…")
                                }
                            }
                            Text(job.outputLines.joined(separator: "\n"))
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            if job.isRunning {
                                Button("Stop") { model.cancel(job) }
                            } else if job.status == .failed {
                                Text(job.message.isEmpty ? "That didn't work." : job.message).foregroundStyle(Kin.error)
                            }
                        }
                    }
                }
            }
        }
        .onAppear { focused = true }
    }

    private func ask() {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, model.isReady else { return }
        question = ""
        Task {
            if let id = await model.startJob("ask", ["question": .string(text)]) {
                model.asks.append((question: text, jobId: id))
            }
        }
    }
}
