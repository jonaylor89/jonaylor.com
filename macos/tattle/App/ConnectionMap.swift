import SwiftUI
import TattleShared
import os

/// Map data: bundled country outlines, and the IP-to-country table `CountryData` downloads.
final class GeoData: Sendable {
    struct Country: Sendable {
        let code: String
        let name: String
        /// Where its dot goes: longitude, latitude.
        let label: CGPoint
    }

    static let shared = GeoData()

    private let table = OSAllocatedUnfairLock<GeoIP?>(initialState: nil)
    var geoIP: GeoIP? { table.withLock { $0 } }
    let countries: [String: Country]
    /// Land in map coordinates (0...1 on both axes; see `project`).
    let land: Path

    /// Latitudes shown; Antarctica and the far north add nothing.
    static let north = 84.0, south = -58.0
    static let aspectRatio = 360 / (north - south)

    private init() {
        struct Entry: Decodable { let c: String, n: String, l: [Double], p: [[Double]] }
        let entries = Bundle.main.url(forResource: "countries", withExtension: "json")
            .flatMap { try? Data(contentsOf: $0) }
            .flatMap { try? JSONDecoder().decode([Entry].self, from: $0) } ?? []
        var countries: [String: Country] = [:]
        var land = Path()
        for entry in entries {
            if !entry.c.isEmpty, entry.l.count == 2 {
                countries[entry.c] = Country(code: entry.c, name: entry.n, label: CGPoint(x: entry.l[0], y: entry.l[1]))
            }
            for ring in entry.p where ring.count >= 6 {
                let points = stride(from: 0, to: ring.count - 1, by: 2).map { Self.project(lon: ring[$0], lat: ring[$0 + 1]) }
                land.addLines(points)
                land.closeSubpath()
            }
        }
        self.countries = countries
        self.land = land
    }

    /// Equirectangular projection into the unit square.
    static func project(lon: Double, lat: Double) -> CGPoint {
        CGPoint(x: (lon + 180) / 360, y: (north - min(max(lat, south), north)) / (north - south))
    }

    func install(_ geoIP: GeoIP) {
        table.withLock { $0 = geoIP }
    }

    func country(for address: String?) -> Country? {
        guard let address, let code = geoIP?.country(for: address) else { return nil }
        return countries[code]
    }

    /// Loads the outlines off the main thread so the first map draw doesn't wait for them.
    static func preload() {
        Task.detached(priority: .utility) { _ = GeoData.shared }
    }
}

/// Keeps the IP-to-country table: downloads DB-IP's monthly file at setup and when the
/// stored one is over a month old, converts it on this Mac, and stores the result in
/// Application Support. Nothing else about connections is ever sent anywhere.
@MainActor
@Observable
final class CountryData {
    enum State: Equatable {
        case missing
        case downloading
        case ready(updated: Date)
        case failed(String)
    }

    private(set) var state: State = .missing
    private var started = false
    private let logger = Logger(subsystem: "dev.jonaylor.Tattle", category: "map")
    private static let maxAge: TimeInterval = 32 * 86_400
    private nonisolated static let maxDownload = 64 << 20

    private nonisolated static var fileURL: URL? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        return support.appendingPathComponent(Bundle.main.bundleIdentifier ?? "dev.jonaylor.Tattle")
            .appendingPathComponent("ip-country.dat")
    }

    /// Loads the stored table and downloads a new one if it's missing or stale. Runs once.
    func start() {
        guard !started else { return }
        started = true
        Task {
            if let (geo, updated) = await Self.loadStored() {
                GeoData.shared.install(geo)
                state = .ready(updated: updated)
                if Date().timeIntervalSince(updated) < Self.maxAge { return }
            }
            // The first download often races the filter starting up (a new install or an
            // update restarts it and drops connections), so retry with growing delays.
            var delay = 60.0
            while true {
                await update()
                if case .ready = state { return }
                try? await Task.sleep(for: .seconds(delay))
                delay = min(delay * 4, 3600)
            }
        }
    }

    /// Downloads and installs the current month's table.
    func update() async {
        guard state != .downloading else { return }
        let previous = state
        state = .downloading
        do {
            let geo = try await Self.download()
            GeoData.shared.install(geo)
            state = .ready(updated: Date())
            logger.info("Country table updated: \(geo.rangeCount) ranges")
        } catch {
            logger.error("Country table download failed: \(String(describing: error), privacy: .public)")
            // Keep using an older table if there is one.
            if case .ready = previous { state = previous } else { state = .failed(Self.describe(error)) }
        }
    }

    private nonisolated static func loadStored() async -> (GeoIP, Date)? {
        guard let url = fileURL,
              let data = try? Data(contentsOf: url),
              let geo = try? GeoIP(compressed: data) else { return nil }
        let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
        return (geo, modified ?? .distantPast)
    }

    private nonisolated static func download() async throws -> GeoIP {
        let session = URLSession(configuration: .ephemeral)
        defer { session.finishTasksAndInvalidate() }
        // A new month's file appears a day or so into the month; fall back to last month's.
        let now = Date()
        var lastError: Error = URLError(.badServerResponse)
        for date in [now, now.addingTimeInterval(-28 * 86_400)] {
            let url = GeoIPTable.sourceURL(for: date)
            guard url.scheme == "https" else { continue }
            do {
                let (data, response) = try await session.data(from: url)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.fileDoesNotExist) }
                guard data.count <= maxDownload else { throw URLError(.dataLengthExceedsMaximum) }
                let table = try GeoIPTable.build(gzippedCSV: data)
                let geo = try GeoIP(table: table)
                if let file = fileURL {
                    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try ((table as NSData).compressed(using: .zlib) as Data).write(to: file, options: .atomic)
                }
                return geo
            } catch {
                Logger(subsystem: "dev.jonaylor.Tattle", category: "map")
                    .error("\(url.lastPathComponent, privacy: .public): \(String(describing: error), privacy: .public)")
                lastError = error
            }
        }
        throw lastError
    }

    private static func describe(_ error: Error) -> String {
        if error is GeoIPTable.BuildError { return "The downloaded file wasn't a country table." }
        return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}

extension GeoData.Country {
    var flag: String {
        String(String.UnicodeScalarView(code.unicodeScalars.compactMap { UnicodeScalar(127_397 + $0.value) }))
    }
}

/// Where connections went recently: a dot per destination country, sized by connection count,
/// with arcs from this Mac's region. Red marks countries where connections were denied.
struct ConnectionMap: View {
    let connections: [ConnectionRecord]
    var window: TimeInterval = 600
    /// The map's width; its height follows from the projection. A menu bar panel sizes to
    /// its content, so the map can't take its size from the space around it.
    var width: CGFloat = 316
    @State private var hovered: String?

    struct Destination: Identifiable {
        let country: GeoData.Country
        var count = 0
        var denied = 0
        var apps: [String: Int] = [:]
        var id: String { country.code }
        var topApps: String {
            apps.sorted { $0.value > $1.value }.prefix(3).map(\.key).joined(separator: ", ")
        }
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
            let destinations = destinations(at: context.date)
            VStack(alignment: .leading, spacing: 6) {
                map(destinations)
                legend(destinations)
            }
        }
    }

    private func map(_ destinations: [Destination]) -> some View {
        let geo = GeoData.shared
        let home = Locale.current.region.flatMap { geo.countries[$0.identifier] }
        let peak = Double(destinations.map(\.count).max() ?? 1)
        return Canvas { context, size in
            let scale = CGAffineTransform(scaleX: size.width, y: size.height)
            func point(_ country: GeoData.Country) -> CGPoint {
                GeoData.project(lon: country.label.x, lat: country.label.y).applying(scale)
            }
            context.fill(geo.land.applying(scale), with: .color(.primary.opacity(0.12)))

            if let home {
                let origin = point(home)
                for destination in destinations where destination.country.code != home.code {
                    let target = point(destination.country)
                    var arc = Path()
                    arc.move(to: origin)
                    let mid = CGPoint(x: (origin.x + target.x) / 2, y: (origin.y + target.y) / 2)
                    let lift = min(hypot(target.x - origin.x, target.y - origin.y) * 0.3, size.height * 0.35)
                    arc.addQuadCurve(to: target, control: CGPoint(x: mid.x, y: mid.y - lift))
                    context.stroke(arc, with: .color(color(destination).opacity(0.35)), lineWidth: 1)
                }
                let mark = CGRect(x: origin.x - 2.5, y: origin.y - 2.5, width: 5, height: 5)
                context.fill(Path(ellipseIn: mark), with: .color(.primary.opacity(0.7)))
            }

            for destination in destinations {
                let center = point(destination.country)
                let radius = 2.5 + 5 * sqrt(Double(destination.count) / peak)
                let dot = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
                context.fill(Path(ellipseIn: dot), with: .color(color(destination).opacity(0.85)))
                if destination.id == hovered {
                    context.stroke(Path(ellipseIn: dot.insetBy(dx: -2, dy: -2)), with: .color(.primary), lineWidth: 1.5)
                }
            }
        }
        .frame(width: width, height: width / GeoData.aspectRatio)
        .overlay {
            GeometryReader { proxy in
                Color.clear.contentShape(Rectangle())
                    .onContinuousHover { phase in
                        guard case .active(let location) = phase else { hovered = nil; return }
                        hovered = nearest(destinations, to: location, in: proxy.size)
                    }
            }
        }
        .overlay(alignment: .topLeading) { tooltip(destinations) }
        .overlay {
            if GeoData.shared.geoIP == nil {
                Text("Country data isn't downloaded yet. See Settings → Map data.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(6)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 6))
            } else if destinations.isEmpty {
                Text("No connections to other countries in the last \(Int(window / 60)) minutes")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(6)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 6))
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Map of connection destinations")
        .accessibilityValue(destinations.prefix(5).map { "\($0.country.name), \($0.count)" }.joined(separator: "; "))
    }

    @ViewBuilder private func tooltip(_ destinations: [Destination]) -> some View {
        if let hovered, let destination = destinations.first(where: { $0.id == hovered }) {
            VStack(alignment: .leading, spacing: 1) {
                Text("\(destination.country.flag) \(destination.country.name)").font(.caption.weight(.semibold))
                Text("\(destination.count) connections" + (destination.denied > 0 ? ", \(destination.denied) denied" : ""))
                    .font(.caption2)
                Text(destination.topApps).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            .padding(6)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 6))
            .padding(4)
            .allowsHitTesting(false)
        }
    }

    private func legend(_ destinations: [Destination]) -> some View {
        HStack(spacing: 10) {
            ForEach(destinations.prefix(4)) { destination in
                HStack(spacing: 3) {
                    Text(destination.country.flag)
                    Text(destination.country.code).foregroundStyle(destination.denied > 0 ? color(destination) : .primary)
                    Text("\(destination.count)").foregroundStyle(.secondary).monospacedDigit()
                }
                .help(destination.country.name)
            }
            Spacer(minLength: 0)
            if destinations.count > 4 {
                Text("+\(destinations.count - 4) more").foregroundStyle(.secondary)
            }
        }
        .font(.caption)
    }

    private func color(_ destination: Destination) -> Color {
        destination.denied * 2 > destination.count ? .red : destination.denied > 0 ? .orange : .accentColor
    }

    private func nearest(_ destinations: [Destination], to location: CGPoint, in size: CGSize) -> String? {
        destinations.map { destination -> (String, CGFloat) in
            let p = GeoData.project(lon: destination.country.label.x, lat: destination.country.label.y)
            return (destination.id, hypot(p.x * size.width - location.x, p.y * size.height - location.y))
        }
        .filter { $0.1 < 14 }
        .min { $0.1 < $1.1 }?.0
    }

    /// Countries reached in the window, most connections first.
    private func destinations(at now: Date) -> [Destination] {
        let geo = GeoData.shared
        var byCountry: [String: Destination] = [:]
        for record in connections {
            guard now.timeIntervalSince(record.time) < window else { break }
            guard let country = geo.country(for: record.remoteAddress) else { continue }
            var entry = byCountry[country.code] ?? Destination(country: country)
            entry.count += 1
            if record.action == .deny { entry.denied += 1 }
            entry.apps[record.process.displayName, default: 0] += 1
            byCountry[country.code] = entry
        }
        return byCountry.values.sorted { ($0.count, $0.id) > ($1.count, $1.id) }
    }
}
