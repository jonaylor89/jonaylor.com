import MyPeopleKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Group {
            switch model.state {
            case .starting where !model.hasLoaded:
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Opening your memory…").foregroundStyle(Kin.onSurfaceVariant)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Kin.surface)
            case .failed(let failure):
                EngineFailedView(failure: failure)
            default:
                main
            }
        }
        .sheet(isPresented: $model.creatingContact) {
            ContactEditorView(uid: nil) { saved in
                model.screen = .people
                model.selectedPeople = [saved.personId]
            }
        }
    }

    private var main: some View {
        @Bindable var model = model
        return NavigationSplitView {
            Sidebar()
                .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 260)
        } detail: {
            detail
                .safeAreaInset(edge: .top, spacing: 0) {
                    if model.state == .restarting {
                        Banner(text: "MyPeople's engine stopped and is restarting. You can browse, but editing waits until it's back.", symbol: "bolt.horizontal.circle")
                    } else if let error = model.viewError {
                        Banner(text: "Couldn't refresh your memory: \(error)", symbol: "exclamationmark.triangle")
                    }
                }
                .overlay(alignment: .bottom) {
                    if let notice = model.notice {
                        NoticeView(notice: notice)
                            .padding(16)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
                .animation(.smooth(duration: 0.2), value: model.notice)
        }
        .navigationTitle(model.screen.title)
    }

    @ViewBuilder private var detail: some View {
        @Bindable var model = model
        // People shows a person beside its list, so it doesn't navigate.
        if model.screen == .people {
            PeopleView()
        } else {
            NavigationStack(path: Binding(get: { model.paths[model.screen] ?? [] }, set: { model.paths[model.screen] = $0 })) {
                screen
                    .navigationDestination(for: PersonRoute.self) { PersonView(route: $0) }
            }
            .id(model.screen)
        }
    }

    @ViewBuilder private var screen: some View {
        switch model.screen {
        case .today: TodayView()
        case .feed: FeedView()
        case .upcoming: UpcomingView()
        case .people: EmptyView()
        case .ask: AskView()
        case .profiles: ReviewProfilesView()
        case .duplicates: ReviewDuplicatesView()
        case .conflicts: ReviewConflictsView()
        case .importData: ImportView()
        case .readMessages: ReadMessagesView()
        case .photos: PhotosView()
        case .discover: DiscoverView()
        case .phone: PhoneView()
        case .sync: SyncView()
        case .google: GoogleView()
        case .activity: ActivityView()
        }
    }
}

private struct Sidebar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        List(selection: $model.screen) {
            Section("Memory") { rows([.today, .feed, .upcoming, .people, .ask]) }
            Section("Review") { rows([.profiles, .duplicates, .conflicts]) }
            Section("Bring In") { rows([.importData, .readMessages, .photos, .discover]) }
            Section("Connect") { rows([.phone, .sync, .google]) }
            Section { rows([.activity]) }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            if model.refreshing {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Refreshing").font(.caption).foregroundStyle(Kin.onSurfaceVariant)
                }
                .padding(8)
            }
        }
    }

    private func rows(_ screens: [Screen]) -> some View {
        ForEach(screens) { screen in
            Label(screen.title, systemImage: screen.symbol)
                .badge(badge(screen))
                .tag(screen)
        }
    }

    private func badge(_ screen: Screen) -> Int {
        switch screen {
        case .today: model.derived("today-count:\(LocalDay.today())") { $0.today(LocalDay.today()).count }
        case .profiles: model.derived("profiles-count") { $0.suggestedProfiles().count }
        case .duplicates: model.derived("dupes-count") { $0.duplicateGroups().count }
        case .conflicts: model.derived("conflicts-count") { $0.conflicted().count }
        case .activity: model.runningJobs
        default: 0
        }
    }
}

private struct Banner: View {
    var text: String
    var symbol: String
    var body: some View {
        Label(text, systemImage: symbol)
            .font(.callout)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(Kin.secondaryContainer)
            .foregroundStyle(Kin.onSecondaryContainer)
    }
}

private struct NoticeView: View {
    @Environment(AppModel.self) private var model
    var notice: Notice

    var body: some View {
        HStack(spacing: 10) {
            Text(notice.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            Button { model.notice = nil } label: { Image(systemName: "xmark") }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
        }
        .font(.callout)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .foregroundStyle(notice.isError ? Kin.onErrorContainer : Kin.onSecondaryContainer)
        .background(notice.isError ? Kin.errorContainer : Kin.secondaryContainer, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .shadow(radius: 6, y: 2)
        .frame(maxWidth: 560)
    }
}

/// There's nothing to show until the engine runs, and the fix is always a specific instruction.
struct EngineFailedView: View {
    @Environment(AppModel.self) private var model
    var failure: EngineFailure
    @State private var showDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(failure.title).font(Kin.display(28))
            Text(failure.detail).fixedSize(horizontal: false, vertical: true)
            if failure.showInstall {
                VStack(alignment: .leading, spacing: 6) {
                    Muted("From your MyPeople checkout, in Terminal:")
                    HStack {
                        Text(verbatim: EngineLocator.installHint)
                            .font(.system(.callout, design: .monospaced))
                            .textSelection(.enabled)
                        Spacer()
                        Button("Copy") { copyToPasteboard(EngineLocator.installHint) }
                    }
                    .padding(10)
                    .background(Kin.surfaceLow, in: RoundedRectangle(cornerRadius: 8))
                }
            }
            if !failure.diagnostics.isEmpty {
                DisclosureGroup("Details", isExpanded: $showDetails) {
                    ScrollView {
                        Text(verbatim: failure.diagnostics)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(height: 180)
                }
            }
            HStack {
                Button("Try Again") { model.retry() }.keyboardShortcut(.defaultAction)
                SettingsLink { Text("Open Settings…") }
            }
        }
        .padding(32)
        .frame(maxWidth: 620)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Kin.surface)
    }
}
