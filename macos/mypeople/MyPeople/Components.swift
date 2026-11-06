import AppKit
import ImageIO
import MyPeopleKit
import SwiftUI

/// Thumbnails decoded off the main thread and kept for the session.
enum Thumbnails {
    private final class Box: @unchecked Sendable {
        let cache = NSCache<NSString, NSImage>()
        init() { cache.countLimit = 800 }
    }
    private static let box = Box()

    static func cached(_ path: String, size: CGFloat) -> NSImage? { box.cache.object(forKey: "\(path)#\(Int(size))" as NSString) }

    /// Carries an image out of its decoding task. Nothing changes it after that, and not every
    /// SDK marks NSImage as Sendable.
    private struct Decoded: @unchecked Sendable { let image: NSImage }

    @MainActor static func load(_ path: String, size: CGFloat) async -> NSImage? {
        let decoded = await Task.detached(priority: .utility) { () -> Decoded? in
            let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                            kCGImageSourceThumbnailMaxPixelSize: Int(size * 2)]
            guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
            let result = NSImage(cgImage: image, size: NSSize(width: size, height: size))
            box.cache.setObject(result, forKey: "\(path)#\(Int(size))" as NSString)
            return Decoded(image: result)
        }.value
        return decoded?.image
    }
}

struct Avatar: View {
    var name: String
    var seed: String
    var path: String?
    var size: CGFloat = 36
    @State private var image: NSImage?

    init(_ person: Person, size: CGFloat = 36) {
        name = person.name; seed = person.paletteSeed; path = person.avatarPath; self.size = size
    }

    init(name: String, seed: String, path: String? = nil, size: CGFloat = 36) {
        self.name = name; self.seed = seed; self.path = path; self.size = size
    }

    var body: some View {
        let palette = PersonPalette.of(seed)
        ZStack {
            Circle().fill(palette.container)
            if let shown = image ?? path.flatMap({ Thumbnails.cached($0, size: size) }) {
                Image(nsImage: shown).resizable().scaledToFill()
            } else {
                Text(initials(name))
                    .font(.system(size: size * 0.38, weight: .semibold))
                    .foregroundStyle(palette.onContainer)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
        .task(id: path) {
            guard let path else { image = nil; return }
            image = await Thumbnails.load(path, size: size)
        }
    }
}

struct CardBox<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Kin.surfaceLow, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

struct MetaLabel: View {
    var text: String
    var body: some View {
        Text(text)
            .font(.caption.weight(.medium))
            .foregroundStyle(Kin.onSecondaryContainer)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Kin.secondaryContainer, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

struct SectionTitle: View {
    var text: String
    var body: some View {
        Text(text)
            .font(.title3.weight(.semibold))
            .padding(.top, 14)
            .accessibilityAddTraits(.isHeader)
    }
}

struct Muted: View {
    var text: String
    var font: Font = .callout
    init(_ text: String, font: Font = .callout) { self.text = text; self.font = font }
    var body: some View {
        Text(text).font(font).foregroundStyle(Kin.onSurfaceVariant).fixedSize(horizontal: false, vertical: true)
    }
}

/// The standard scrolling page: a headline, then content at a readable width.
struct Page<Content: View>: View {
    var title: String
    var subtitle: String?
    var maxWidth: CGFloat = 760
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(Kin.display(28)).accessibilityAddTraits(.isHeader)
                    if let subtitle { Muted(subtitle) }
                }
                .padding(.bottom, 6)
                content
            }
            .padding(24)
            .frame(maxWidth: maxWidth, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(Kin.surface)
    }
}

struct PersonRowContent: View {
    var person: Person
    var detail: String?
    var size: CGFloat = 36

    var body: some View {
        HStack(spacing: 10) {
            Avatar(person, size: size)
            VStack(alignment: .leading, spacing: 1) {
                Text(person.name).lineLimit(1)
                if let detail, !detail.isEmpty {
                    Text(detail).font(.caption).foregroundStyle(Kin.onSurfaceVariant).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }
}

/// A person's row that opens them.
struct PersonLinkRow: View {
    @Environment(AppModel.self) private var model
    var id: Int
    var detail: String?

    var body: some View {
        if let person = model.records.people[id] {
            NavigationLink(value: PersonRoute(id: id, uid: person.contactUid)) {
                PersonRowContent(person: person, detail: detail)
            }
            .buttonStyle(.plain)
        }
    }
}

struct WebLink: View {
    var url: String
    var body: some View {
        if let safe = safeWebURL(url) {
            Link(destination: safe) {
                Label { Text(verbatim: url).lineLimit(2).multilineTextAlignment(.leading) } icon: { Image(systemName: "arrow.up.forward.square") }
                    .font(.callout)
            }
            .help("Open in your browser")
        } else {
            // Not a web address, so it stays text: scraped data doesn't get to launch anything.
            Text(verbatim: url).font(.callout).foregroundStyle(Kin.onSurfaceVariant).textSelection(.enabled)
        }
    }
}

struct PickFileField: View {
    enum Mode { case file, folder, either, save(String) }
    var title: String
    @Binding var path: String
    var prompt = "Choose…"
    var mode: Mode = .file
    var placeholder = ""

    var body: some View {
        LabeledContent(title) {
            HStack {
                TextField(title, text: $path, prompt: Text(placeholder))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                Button(prompt) { choose() }
            }
        }
    }

    private func choose() {
        if case .save(let name) = mode {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = name
            if panel.runModal() == .OK, let url = panel.url { path = url.path }
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = { if case .folder = mode { false } else { true } }()
        panel.canChooseDirectories = { if case .file = mode { false } else { true } }()
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url { path = url.path }
    }
}

/// The people chooser used by forms: anyone, or one specific person.
struct PersonPicker: View {
    @Environment(AppModel.self) private var model
    var title = "Person"
    var anyoneLabel = "Everyone"
    @Binding var selection: Int?
    @State private var choosing = false
    @State private var query = ""

    var body: some View {
        LabeledContent(title) {
            HStack {
                Text(selection.map(model.name) ?? anyoneLabel).lineLimit(1)
                Button("Choose…") { choosing = true }
                if selection != nil {
                    Button("Clear") { selection = nil }
                }
            }
        }
        .popover(isPresented: $choosing, arrowEdge: .bottom) {
            VStack(spacing: 8) {
                TextField("Search people", text: $query).textFieldStyle(.roundedBorder)
                List(model.records.search(query).prefix(100), id: \.id) { entry in
                    Button {
                        selection = entry.id
                        choosing = false
                    } label: {
                        PersonRowContent(person: entry.person, size: 24)
                    }
                    .buttonStyle(.plain)
                }
                .listStyle(.plain)
            }
            .padding(10)
            .frame(width: 300, height: 340)
        }
    }
}

/// A running or finished job on the screen that started it: status, progress and what it printed.
struct JobPanel: View {
    @Environment(AppModel.self) private var model
    var job: Job
    var logHeight: CGFloat = 170

    var body: some View {
        CardBox {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    switch job.status {
                    case .running: ProgressView().controlSize(.small)
                    case .succeeded: Image(systemName: "checkmark.circle.fill").foregroundStyle(Kin.primary)
                    case .cancelled: Image(systemName: "stop.circle").foregroundStyle(Kin.onSurfaceVariant)
                    case .failed, .interrupted: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Kin.error)
                    }
                    Text(job.title).font(.headline).lineLimit(1)
                    Text(job.status.label).font(.caption).foregroundStyle(Kin.onSurfaceVariant)
                    Spacer()
                    if job.isRunning {
                        Button("Stop") { model.cancel(job) }.help("Stops as Ctrl-C does. Finished work is kept, and a later run picks up where this one stopped.")
                    }
                }
                if job.status == .failed, !job.message.isEmpty {
                    Text(job.message).font(.callout).foregroundStyle(Kin.error).textSelection(.enabled)
                }
                JobLog(job: job, height: logHeight)
            }
        }
    }
}

struct JobLog: View {
    var job: Job
    var height: CGFloat

    var body: some View {
        if !job.outputLines.isEmpty {
            ScrollViewReader { proxy in
                ScrollView {
                    Text(verbatim: job.outputLines.joined(separator: "\n"))
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                    Color.clear.frame(height: 1).id("end")
                }
                // Fits short output; long output scrolls at the panel's height.
                .frame(height: min(height, CGFloat(job.outputLines.count) * 17 + 26))
                .background(Kin.surface, in: RoundedRectangle(cornerRadius: 8))
                .onChange(of: job.lines.count, initial: true) { proxy.scrollTo("end", anchor: .bottom) }
            }
        }
    }
}

/// Explains why something on a form isn't available, instead of failing after pressing Run.
struct Requirement: View {
    var text: String
    var body: some View {
        Label { Text(text).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: "info.circle") }
            .font(.callout)
            .foregroundStyle(Kin.onSurfaceVariant)
    }
}

func copyToPasteboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}

extension Optional where Wrapped == Int {
    /// A form's optional number as a job parameter.
    var json: JSONValue { map(JSONValue.int) ?? .null }
}

/// A job's parameters, leaving out anything left blank or off so the CLI's own defaults apply.
func jobParams(_ values: [String: JSONValue?]) -> JSONValue {
    var out: [String: JSONValue] = [:]
    for (key, value) in values {
        switch value {
        case .none, .some(.null), .some(.bool(false)): continue
        case .some(.string(let s)) where s.trimmingCharacters(in: .whitespaces).isEmpty: continue
        case .some(.array(let a)) where a.isEmpty: continue
        case .some(let v): out[key] = v
        }
    }
    return .object(out)
}

func intValue(_ text: String) -> JSONValue? { Int(text.trimmingCharacters(in: .whitespaces)).map(JSONValue.int) }
func doubleValue(_ text: String) -> JSONValue? { Double(text.trimmingCharacters(in: .whitespaces)).map(JSONValue.double) }
func stringValue(_ text: String) -> JSONValue? { text.isEmpty ? nil : .string(text) }
