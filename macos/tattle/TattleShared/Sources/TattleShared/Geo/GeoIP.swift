import Darwin
import Foundation

/// Offline IP address to country lookup over a bundled table (see `scripts/build-geodata.py`).
/// Nothing is ever looked up online.
public struct GeoIP: Sendable {
    public enum LoadError: Error, Equatable {
        case corrupt
    }

    private let codes: [String]
    private let v4Starts: [UInt32]
    private let v4Codes: [UInt8]
    private let v6High: [UInt64]
    private let v6Low: [UInt64]
    private let v6Codes: [UInt8]

    public var rangeCount: Int { v4Starts.count + v6High.count }

    /// Reads a table compressed with raw deflate, as the build script writes it.
    public init(compressed: Data) throws {
        guard let raw = try? (compressed as NSData).decompressed(using: .zlib) as Data else { throw LoadError.corrupt }
        try self.init(table: raw)
    }

    /// Reads an uncompressed table.
    public init(table data: Data) throws {
        var reader = Reader(data: data)
        guard try reader.bytes(4) == Array("TGEO".utf8), try reader.u32() == 1 else { throw LoadError.corrupt }
        let codeCount = Int(try reader.u32())
        var codes: [String] = []
        codes.reserveCapacity(codeCount)
        for _ in 0..<codeCount {
            codes.append(String(decoding: try reader.bytes(2), as: UTF8.self))
        }
        let v4Count = Int(try reader.u32())
        let v6Count = Int(try reader.u32())
        v4Starts = try reader.array(UInt32.self, count: v4Count)
        v4Codes = try reader.bytes(v4Count)
        v6High = try reader.array(UInt64.self, count: v6Count)
        v6Low = try reader.array(UInt64.self, count: v6Count)
        v6Codes = try reader.bytes(v6Count)
        guard reader.atEnd, (v4Codes + v6Codes).allSatisfy({ Int($0) < codeCount }) else { throw LoadError.corrupt }
        self.codes = codes
    }

    /// The two-letter country code for an IPv4 or IPv6 address, or nil for private,
    /// reserved, unknown, or unparsable addresses.
    public func country(for address: String) -> String? {
        var v4 = in_addr()
        var v6 = in6_addr()
        let index: UInt8?
        if inet_pton(AF_INET, address, &v4) == 1 {
            index = lookup(UInt32(bigEndian: v4.s_addr))
        } else if inet_pton(AF_INET6, Self.withoutZone(address), &v6) == 1 {
            let bytes = withUnsafeBytes(of: v6) { Array($0) }
            let high = bytes[0..<8].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
            let low = bytes[8..<16].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
            // IPv4-mapped addresses (::ffff:a.b.c.d) live in the IPv4 table.
            if high == 0, low >> 32 == 0xFFFF {
                index = lookup(UInt32(truncatingIfNeeded: low))
            } else {
                index = lookup(high: high, low: low)
            }
        } else {
            return nil
        }
        guard let index, let code = codes[safe: Int(index)], code != "ZZ" else { return nil }
        return code
    }

    private func lookup(_ address: UInt32) -> UInt8? {
        // Last start <= address.
        var low = 0, high = v4Starts.count
        while low < high {
            let mid = (low + high) / 2
            if v4Starts[mid] <= address { low = mid + 1 } else { high = mid }
        }
        return low == 0 ? nil : v4Codes[low - 1]
    }

    private func lookup(high addressHigh: UInt64, low addressLow: UInt64) -> UInt8? {
        var low = 0, high = v6High.count
        while low < high {
            let mid = (low + high) / 2
            if (v6High[mid], v6Low[mid]) <= (addressHigh, addressLow) { low = mid + 1 } else { high = mid }
        }
        return low == 0 ? nil : v6Codes[low - 1]
    }

    private static func withoutZone(_ address: String) -> String {
        address.split(separator: "%", maxSplits: 1).first.map(String.init) ?? address
    }
}

private struct Reader {
    let data: Data
    var offset = 0

    var atEnd: Bool { offset == data.count }

    mutating func bytes(_ count: Int) throws -> [UInt8] {
        guard count >= 0, data.count - offset >= count else { throw GeoIP.LoadError.corrupt }
        defer { offset += count }
        let start = data.startIndex + offset
        return Array(data[start..<start + count])
    }

    mutating func u32() throws -> UInt32 {
        try array(UInt32.self, count: 1)[0]
    }

    mutating func array<T: FixedWidthInteger>(_: T.Type, count: Int) throws -> [T] {
        let size = MemoryLayout<T>.size
        guard count >= 0, count <= (data.count - offset) / size else { throw GeoIP.LoadError.corrupt }
        let start = data.startIndex + offset
        defer { offset += count * size }
        return data[start..<start + count * size].withUnsafeBytes { raw in
            (0..<count).map { T(littleEndian: raw.loadUnaligned(fromByteOffset: $0 * size, as: T.self)) }
        }
    }
}

extension Array {
    fileprivate subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
