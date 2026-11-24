import Foundation
import Testing
@testable import TattleShared

@Suite struct GeoIPTests {
    /// Builds a table the way scripts/build-geodata.py does.
    static func table(codes: [String], v4: [(UInt32, UInt8)], v6: [(UInt64, UInt64, UInt8)]) -> Data {
        var out = Data("TGEO".utf8)
        func put<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { out.append(contentsOf: $0) } }
        put(UInt32(1))
        put(UInt32(codes.count))
        codes.forEach { out.append(contentsOf: Array($0.utf8)) }
        put(UInt32(v4.count))
        put(UInt32(v6.count))
        v4.forEach { put($0.0) }
        out.append(contentsOf: v4.map(\.1))
        v6.forEach { put($0.0) }
        v6.forEach { put($0.1) }
        out.append(contentsOf: v6.map(\.2))
        return out
    }

    static let sample = table(
        codes: ["ZZ", "US", "DE", "JP"],
        v4: [(0, 0), (0x0100_0000, 1), (0x0A00_0000, 0), (0x0B00_0000, 2), (0xC000_0000, 3)],
        v6: [(0, 0, 0), (0x2001_0000_0000_0000, 0, 1), (0x2001_0000_0000_0000, 0x8000_0000_0000_0000, 2), (0x2002_0000_0000_0000, 0, 0)]
    )

    @Test func findsTheRangeContainingAnAddress() throws {
        let geo = try GeoIP(table: Self.sample)
        #expect(geo.rangeCount == 9)
        #expect(geo.country(for: "1.0.0.0") == "US")
        #expect(geo.country(for: "9.255.255.255") == "US")
        #expect(geo.country(for: "11.2.3.4") == "DE")
        #expect(geo.country(for: "255.255.255.255") == "JP")
        #expect(geo.country(for: "::ffff:11.2.3.4") == "DE")
        #expect(geo.country(for: "2001::1") == "US")
        // The low 64 bits matter: this range starts halfway through a /64.
        #expect(geo.country(for: "2001::8000:0:0:1") == "DE")
        #expect(geo.country(for: "2001::7fff:ffff:ffff:ffff") == "US")
    }

    @Test func privateReservedAndInvalidAddressesHaveNoCountry() throws {
        let geo = try GeoIP(table: Self.sample)
        for address in ["0.0.0.1", "10.1.2.3", "::1", "2002::1", "fe80::1%en0", "example.com", "", "1.2.3"] {
            #expect(geo.country(for: address) == nil, "\(address)")
        }
    }

    @Test func rejectsDamagedTables() {
        let good = Self.sample
        for bad in [Data(), Data("TGEX".utf8) + good.dropFirst(4), good.dropLast(), good + Data([0])] {
            #expect(throws: GeoIP.LoadError.corrupt) { try GeoIP(table: Data(bad)) }
        }
        // A code index outside the code list.
        var badIndex = good
        badIndex[badIndex.count - 1] = 9
        #expect(throws: GeoIP.LoadError.corrupt) { try GeoIP(table: badIndex) }
        #expect(throws: GeoIP.LoadError.corrupt) { try GeoIP(compressed: Data([1, 2, 3])) }
    }

    /// A gzipped excerpt in DB-IP's format, including adjacent ranges of one country.
    static let download = Data(base64Encoded: "H4sIAAAAAAAA/zPQMwBBHQM9I1NTGNaJiuIyhEpAaJCgYyhY0BAqaAwWdPYDC5pABc1hglZWOkYGBgZWaUCAnwBZBlRqCNEBpMyxqAkNhqqxABkKhhDVBGzQcXHlAgDM4Mp74wAAAA==")!

    @Test func buildsTablesFromTheDBIPDownload() throws {
        let table = try GeoIPTable.build(gzippedCSV: Self.download)
        let geo = try GeoIP(table: table)
        #expect(geo.rangeCount == 6)  // the two adjacent CN ranges merge
        #expect(geo.country(for: "1.0.0.9") == "AU")
        #expect(geo.country(for: "1.0.6.1") == "CN")
        #expect(geo.country(for: "0.1.2.3") == nil)
        #expect(geo.country(for: "2001::1") == "US")
        #expect(geo.country(for: "2001::8000:0:0:5") == "DE")
        // Round trip through the compressed form the app stores.
        let stored = try (table as NSData).compressed(using: .zlib) as Data
        #expect(try GeoIP(compressed: stored).country(for: "1.0.0.1") == "AU")
    }

    @Test func rejectsBadDownloads() {
        #expect(throws: GeoIPTable.BuildError.notGzip) { try GeoIPTable.gunzip(Data("not gzip at all, sorry".utf8)) }
        // Truncated in transfer: the trailer no longer matches.
        #expect(throws: GeoIPTable.BuildError.notGzip) { try GeoIPTable.gunzip(Self.download.dropLast(3)) }
        let cases: [(String, GeoIPTable.BuildError)] = [
            ("", .empty),
            ("1.0.0.0,1.0.0.255\n", .malformedLine(1)),
            ("1.0.0.0,1.0.0.255,AU\nnonsense,x,US\n", .malformedLine(2)),
            ("1.0.0.0,1.0.0.255,usa\n", .malformedLine(1)),
            ("1.0.1.0,1.0.1.255,AU\n1.0.0.0,1.0.0.255,CN\n", .unsorted),
        ]
        for (csv, error) in cases {
            #expect(throws: error) { try GeoIPTable.build(csv: Data(csv.utf8)) }
        }
    }

    @Test func downloadsTheCurrentMonthsFile() {
        let date = Date(timeIntervalSince1970: 1_795_000_000)  // 2026-11-18
        #expect(GeoIPTable.sourceURL(for: date).absoluteString == "https://download.db-ip.com/free/dbip-country-lite-2026-11.csv.gz")
    }
}
