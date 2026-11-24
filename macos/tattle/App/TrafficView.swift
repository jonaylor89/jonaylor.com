import Charts
import TattleShared
import SwiftUI

/// Bytes sent and received over time, per app and per host.
struct TrafficView: View {
    let store: TattleStore
    @State private var range: Range = .day
    @State private var app: String?

    enum Range: String, CaseIterable, Identifiable {
        case hour = "Hour", day = "Day", week = "Week", month = "Month"
        var id: Self { self }
        var interval: TimeInterval {
            switch self {
            case .hour: 3600
            case .day: 86_400
            case .week: 7 * 86_400
            case .month: 30 * 86_400
            }
        }
        var bucketHours: Int {
            switch self {
            case .hour, .day: 1
            case .week: 6
            case .month: 24
            }
        }
    }

    private struct Sample: Identifiable {
        let bucket: Date
        let direction: String
        let bytes: Int64
        var id: String { "\(bucket.timeIntervalSince1970)-\(direction)" }
    }

    private var samples: [Sample] {
        guard let report = store.traffic else { return [] }
        var totals: [Date: (Int64, Int64)] = [:]
        for point in report.series {
            let current = totals[point.bucket] ?? (0, 0)
            totals[point.bucket] = (current.0 + point.bytesIn, current.1 + point.bytesOut)
        }
        return totals.sorted { $0.key < $1.key }.flatMap { bucket, value in
            [Sample(bucket: bucket, direction: "Received", bytes: value.0), Sample(bucket: bucket, direction: "Sent", bytes: value.1)]
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    Picker("Range", selection: $range) {
                        ForEach(Range.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 320)
                    Spacer()
                    if let app, let name = store.traffic?.apps.first(where: { $0.key == app })?.name {
                        Button("Showing \(name) ✕") { self.app = nil }
                    }
                }

                GroupBox {
                    Chart(samples) { sample in
                        BarMark(
                            x: .value("Time", sample.bucket, unit: range.bucketHours >= 24 ? .day : .hour),
                            y: .value("Bytes", sample.bytes)
                        )
                        .foregroundStyle(by: .value("Direction", sample.direction))
                    }
                    .chartYAxis {
                        AxisMarks { value in
                            AxisGridLine()
                            AxisValueLabel { Text((value.as(Int64.self) ?? 0).bytesText) }
                        }
                    }
                    .frame(height: 220)
                    .overlay {
                        if samples.isEmpty {
                            Text("No traffic recorded in this period").foregroundStyle(.secondary)
                        }
                    }
                }

                HStack(alignment: .top, spacing: 20) {
                    totals("Apps", store.traffic?.apps ?? [], selectable: true)
                    totals(app == nil ? "Hosts" : "Hosts for this app", store.traffic?.hosts ?? [], selectable: false)
                }
            }
            .padding()
        }
        .task(id: "\(range.rawValue)|\(app ?? "")") {
            while !Task.isCancelled {
                await store.reloadTraffic(TrafficQuery(since: Date().addingTimeInterval(-range.interval), bucketHours: range.bucketHours, appKey: app))
                try? await Task.sleep(for: .seconds(15))
            }
        }
        .navigationTitle("Traffic")
    }

    private func totals(_ title: String, _ rows: [TrafficTotal], selectable: Bool) -> some View {
        GroupBox(title) {
            let top = Array(rows.prefix(15))
            let maximum = max(top.map(\.total).max() ?? 1, 1)
            VStack(alignment: .leading, spacing: 6) {
                if top.isEmpty { Text("Nothing yet").foregroundStyle(.secondary) }
                ForEach(top) { row in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            if selectable {
                                Button(row.name) { app = row.key }.buttonStyle(.link)
                            } else {
                                Text(row.name)
                            }
                            Spacer()
                            Text("↓\(row.bytesIn.bytesText) ↑\(row.bytesOut.bytesText)")
                                .font(.caption)
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                        }
                        ProgressView(value: Double(row.total), total: Double(maximum))
                            .progressViewStyle(.linear)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
