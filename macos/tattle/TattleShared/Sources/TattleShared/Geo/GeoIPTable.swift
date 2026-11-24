import Darwin
import Foundation

/// Builds the table `GeoIP` reads from DB-IP's "IP to Country Lite" download
/// (https://db-ip.com/db/download/ip-to-country-lite, CC BY 4.0), which the app fetches
/// at setup and monthly afterwards.
///
/// Table format, little-endian:
///   "TGEO" u32 version=1 u32 codeCount, codeCount x 2 ASCII bytes,
///   u32 v4Count u32 v6Count,
///   v4Count x u32 range start, v4Count x u8 code index,
///   v6Count x u64 start high bits, v6Count x u64 start low bits, v6Count x u8 code index.
/// Ranges are sorted and contiguous: an address belongs to the last range starting at or
/// below it. Code "ZZ" marks reserved and private space.
public enum GeoIPTable {
    public enum BuildError: Error, Equatable {
        case notGzip
        case malformedLine(Int)
        case unsorted
        case tooManyCountries
        case empty
    }

    /// The monthly download for the month containing `date` (UTC).
    public static func sourceURL(for date: Date) -> URL {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let parts = calendar.dateComponents([.year, .month], from: date)
        let name = String(format: "dbip-country-lite-%04d-%02d.csv.gz", parts.year ?? 2000, parts.month ?? 1)
        return URL(string: "https://download.db-ip.com/free/\(name)")!
    }

    /// Converts the gzipped CSV download into an uncompressed table.
    public static func build(gzippedCSV: Data) throws -> Data {
        try build(csv: gunzip(gzippedCSV))
    }

    /// Converts CSV lines of `first address,last address,country code` into a table.
    public static func build(csv: Data) throws -> Data {
        var codes: [String] = []
        var index: [String: UInt8] = [:]
        var v4Starts: [UInt32] = [], v4Codes: [UInt8] = []
        var v6High: [UInt64] = [], v6Low: [UInt64] = [], v6Codes: [UInt8] = []
        v4Starts.reserveCapacity(400_000)
        v6High.reserveCapacity(400_000)

        var lineNumber = 0
        try csv.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            for line in raw.split(separator: UInt8(ascii: "\n"), omittingEmptySubsequences: true) {
                lineNumber += 1
                let fields = line.split(separator: UInt8(ascii: ","), omittingEmptySubsequences: false)
                guard fields.count >= 3 else { throw BuildError.malformedLine(lineNumber) }
                let codeBytes = Array(fields[2].filter { $0 != UInt8(ascii: "\r") && $0 != UInt8(ascii: "\"") })
                guard codeBytes.count == 2, codeBytes.allSatisfy({ (65...90).contains($0) }) else {
                    throw BuildError.malformedLine(lineNumber)
                }
                let code = String(decoding: codeBytes, as: UTF8.self)
                let codeIndex: UInt8
                if let existing = index[code] {
                    codeIndex = existing
                } else {
                    guard codes.count < 255 else { throw BuildError.tooManyCountries }
                    codeIndex = UInt8(codes.count)
                    index[code] = codeIndex
                    codes.append(code)
                }
                let address = String(decoding: fields[0].filter { $0 != UInt8(ascii: "\"") }, as: UTF8.self)
                var v4 = in_addr()
                var v6 = in6_addr()
                if inet_pton(AF_INET, address, &v4) == 1 {
                    let start = UInt32(bigEndian: v4.s_addr)
                    if let last = v4Starts.last, start <= last { throw BuildError.unsorted }
                    if v4Codes.last == codeIndex { continue }  // merge with the previous range
                    v4Starts.append(start)
                    v4Codes.append(codeIndex)
                } else if inet_pton(AF_INET6, address, &v6) == 1 {
                    let bytes = withUnsafeBytes(of: v6) { Array($0) }
                    let high = bytes[0..<8].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
                    let low = bytes[8..<16].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
                    if let lastHigh = v6High.last, let lastLow = v6Low.last, (high, low) <= (lastHigh, lastLow) {
                        throw BuildError.unsorted
                    }
                    if v6Codes.last == codeIndex { continue }
                    v6High.append(high)
                    v6Low.append(low)
                    v6Codes.append(codeIndex)
                } else {
                    throw BuildError.malformedLine(lineNumber)
                }
            }
        }
        guard !v4Starts.isEmpty || !v6High.isEmpty else { throw BuildError.empty }

        var out = Data("TGEO".utf8)
        func put<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { out.append(contentsOf: $0) } }
        put(UInt32(1))
        put(UInt32(codes.count))
        codes.forEach { out.append(contentsOf: Array($0.utf8)) }
        put(UInt32(v4Starts.count))
        put(UInt32(v6High.count))
        v4Starts.forEach(put)
        out.append(contentsOf: v4Codes)
        v6High.forEach(put)
        v6Low.forEach(put)
        out.append(contentsOf: v6Codes)
        return out
    }

    /// Decompresses a single-member gzip file (RFC 1952).
    public static func gunzip(_ data: Data) throws -> Data {
        let bytes = [UInt8](data)
        guard bytes.count >= 18, bytes[0] == 0x1F, bytes[1] == 0x8B, bytes[2] == 8 else { throw BuildError.notGzip }
        let flags = bytes[3]
        var offset = 10
        if flags & 0x04 != 0 {  // FEXTRA
            guard offset + 2 <= bytes.count else { throw BuildError.notGzip }
            offset += 2 + Int(bytes[offset]) | Int(bytes[offset + 1]) << 8
        }
        for flag: UInt8 in [0x08, 0x10] where flags & flag != 0 {  // FNAME, FCOMMENT: zero-terminated
            while offset < bytes.count, bytes[offset] != 0 { offset += 1 }
            offset += 1
        }
        if flags & 0x02 != 0 { offset += 2 }  // FHCRC
        guard offset < bytes.count - 8 else { throw BuildError.notGzip }
        let deflated = Data(bytes[offset..<(bytes.count - 8)])
        guard let inflated = try? (deflated as NSData).decompressed(using: .zlib) as Data else { throw BuildError.notGzip }
        // The trailer's size field (mod 2^32) guards against a truncated download.
        let expected = bytes[(bytes.count - 4)...].reversed().reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        guard UInt32(truncatingIfNeeded: inflated.count) == expected else { throw BuildError.notGzip }
        return inflated
    }
}
