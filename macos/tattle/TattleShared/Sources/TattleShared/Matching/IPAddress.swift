import Foundation
import Network

/// An IPv4 or IPv6 address stored as raw bytes (4 or 16). IPv4-mapped IPv6 addresses are
/// stored as IPv4 so both spellings match the same rules.
public struct IPAddress: Hashable, Sendable, Comparable, CustomStringConvertible {
    public let bytes: [UInt8]

    public var isIPv4: Bool { bytes.count == 4 }
    public var bitCount: Int { bytes.count * 8 }

    public init?(_ string: String) {
        let trimmed = string.split(separator: "%", maxSplits: 1).first.map(String.init) ?? string
        if !trimmed.contains(":") {
            // Strict dotted quad: inet_aton shorthands such as "1.2.3" or "0x7f.1" are rejected.
            let parts = trimmed.split(separator: ".", omittingEmptySubsequences: false)
            guard parts.count == 4,
                  parts.allSatisfy({ (1...3).contains($0.count) && $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }),
                  let v4 = IPv4Address(trimmed)
            else { return nil }
            bytes = Array(v4.rawValue)
        } else if let v6 = IPv6Address(trimmed) {
            if v6.isIPv4Mapped, let v4 = v6.asIPv4 {
                bytes = Array(v4.rawValue)
            } else {
                bytes = Array(v6.rawValue)
            }
        } else {
            return nil
        }
    }

    init(bytes: [UInt8]) {
        precondition(bytes.count == 4 || bytes.count == 16)
        self.bytes = bytes
    }

    public var description: String {
        if isIPv4 { return "\(IPv4Address(Data(bytes))!)" }
        return "\(IPv6Address(Data(bytes))!)"
    }

    public var isLoopback: Bool {
        if isIPv4 { return bytes[0] == 127 }
        return bytes == [UInt8](repeating: 0, count: 15) + [1]
    }

    /// The address with every bit after `prefixLength` cleared.
    public func masked(to prefixLength: Int) -> IPAddress {
        var result = bytes
        for index in 0..<result.count {
            let bitsBefore = index * 8
            if bitsBefore >= prefixLength {
                result[index] = 0
            } else if prefixLength - bitsBefore < 8 {
                result[index] &= UInt8(truncatingIfNeeded: 0xFF << (8 - (prefixLength - bitsBefore)))
            }
        }
        return IPAddress(bytes: result)
    }

    public static func < (lhs: IPAddress, rhs: IPAddress) -> Bool {
        if lhs.bytes.count != rhs.bytes.count { return lhs.bytes.count < rhs.bytes.count }
        return lhs.bytes.lexicographicallyPrecedes(rhs.bytes)
    }
}

/// A CIDR network such as 10.0.0.0/8 or 2001:db8::/32.
public struct IPNetwork: Hashable, Sendable, CustomStringConvertible {
    /// The network address with host bits cleared.
    public let address: IPAddress
    public let prefixLength: Int

    public init?(address: IPAddress, prefixLength: Int) {
        guard (0...address.bitCount).contains(prefixLength) else { return nil }
        self.address = address.masked(to: prefixLength)
        self.prefixLength = prefixLength
    }

    /// Parses "a.b.c.d/n" or "v6::/n". A bare address is a full-length network.
    public init?(_ string: String) {
        let parts = string.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count <= 2, let address = IPAddress(String(parts[0])) else { return nil }
        var prefix = address.bitCount
        if parts.count == 2 {
            guard let value = Int(parts[1]), String(value) == parts[1] else { return nil }
            // An IPv4-mapped IPv6 network (::ffff:a.b.c.d/n) shrinks to its IPv4 prefix.
            if address.isIPv4, String(parts[0]).contains(":") {
                guard value >= 96 else { return nil }
                prefix = value - 96
            } else {
                prefix = value
            }
        }
        self.init(address: address, prefixLength: prefix)
    }

    public func contains(_ other: IPAddress) -> Bool {
        other.bytes.count == address.bytes.count && other.masked(to: prefixLength) == address
    }

    public var description: String { "\(address)/\(prefixLength)" }
}
