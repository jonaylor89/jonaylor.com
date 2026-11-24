import Foundation

public enum DomainName {
    /// Lowercases, strips one trailing dot, and checks the result is a plausible DNS name:
    /// 1–253 characters, labels of 1–63 letters, digits, hyphens or underscores, not
    /// starting or ending with a hyphen. IP address literals are rejected.
    public static func normalize(_ name: String) -> String? {
        var value = name.lowercased()
        if value.hasSuffix(".") { value.removeLast() }
        guard !value.isEmpty, value.utf8.count <= 253 else { return nil }
        guard IPAddress(value) == nil else { return nil }
        for label in value.split(separator: ".", omittingEmptySubsequences: false) {
            guard (1...63).contains(label.utf8.count), label.first != "-", label.last != "-" else { return nil }
            guard label.utf8.allSatisfy(isLabelByte) else { return nil }
        }
        return value
    }

    private static func isLabelByte(_ byte: UInt8) -> Bool {
        switch byte {
        case UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "-"), UInt8(ascii: "_"): true
        default: false
        }
    }

    /// The name and each parent domain: "a.b.c" → ["a.b.c", "b.c", "c"].
    public static func suffixes(of name: String) -> [Substring] {
        var result: [Substring] = [Substring(name)]
        var index = name.startIndex
        while let dot = name[index...].firstIndex(of: ".") {
            index = name.index(after: dot)
            result.append(name[index...])
        }
        return result
    }
}
