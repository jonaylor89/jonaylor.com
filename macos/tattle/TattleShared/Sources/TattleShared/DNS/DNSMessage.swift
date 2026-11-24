import Foundation

/// Just enough of the DNS wire format (RFC 1035) to read questions and the address records
/// in answers. Parsing is defensive: the input comes from the network.
public struct DNSMessage: Equatable, Sendable {
    public struct Record: Equatable, Sendable {
        public var name: String
        public var type: UInt16
        public var ttl: UInt32
        /// For A/AAAA records.
        public var address: IPAddress?
        /// For CNAME records.
        public var target: String?
    }

    public static let typeA: UInt16 = 1
    public static let typeCNAME: UInt16 = 5
    public static let typeAAAA: UInt16 = 28

    public var id: UInt16
    public var isResponse: Bool
    public var responseCode: UInt8
    public var questions: [(name: String, type: UInt16)]
    public var answers: [Record]

    public static func == (lhs: DNSMessage, rhs: DNSMessage) -> Bool {
        lhs.id == rhs.id && lhs.isResponse == rhs.isResponse && lhs.responseCode == rhs.responseCode
            && lhs.questions.map(\.name) == rhs.questions.map(\.name) && lhs.questions.map(\.type) == rhs.questions.map(\.type)
            && lhs.answers == rhs.answers
    }

    public enum ParseError: Error { case truncated, malformedName, tooManyRecords }

    public init(parsing data: Data) throws {
        var reader = Reader(bytes: [UInt8](data))
        id = try reader.u16()
        let flags = try reader.u16()
        isResponse = flags & 0x8000 != 0
        responseCode = UInt8(flags & 0x000F)
        let questionCount = Int(try reader.u16())
        let answerCount = Int(try reader.u16())
        _ = try reader.u16()  // authority
        _ = try reader.u16()  // additional
        guard questionCount <= 16, answerCount <= 256 else { throw ParseError.tooManyRecords }

        questions = []
        for _ in 0..<questionCount {
            let name = try reader.name()
            let type = try reader.u16()
            _ = try reader.u16()  // class
            questions.append((name, type))
        }
        answers = []
        for _ in 0..<answerCount {
            let name = try reader.name()
            let type = try reader.u16()
            _ = try reader.u16()  // class
            let ttl = try reader.u32()
            let length = Int(try reader.u16())
            let start = reader.offset
            guard start + length <= reader.bytes.count else { throw ParseError.truncated }
            var record = Record(name: name, type: type, ttl: ttl)
            switch type {
            case Self.typeA where length == 4, Self.typeAAAA where length == 16:
                record.address = IPAddress(bytes: Array(reader.bytes[start..<start + length]))
            case Self.typeCNAME:
                record.target = try reader.name()
            default:
                break
            }
            reader.offset = start + length
            answers.append(record)
        }
    }

    /// Host name → addresses from the answers, following CNAME chains back to the question
    /// name, so "www.example.com CNAME edge.cdn.net; edge.cdn.net A 1.2.3.4" maps both
    /// names to 1.2.3.4.
    public func addressMappings() -> [(hostname: String, address: IPAddress, ttl: UInt32)] {
        var aliases: [String: Set<String>] = [:]  // target → names that point at it
        for record in answers {
            if let target = record.target { aliases[target.lowercased(), default: []].insert(record.name.lowercased()) }
        }
        var result: [(String, IPAddress, UInt32)] = []
        for record in answers {
            guard let address = record.address else { continue }
            var names: Set<String> = [record.name.lowercased()]
            var frontier = names
            for _ in 0..<8 where !frontier.isEmpty {  // bounded CNAME depth
                frontier = Set(frontier.flatMap { aliases[$0] ?? [] }).subtracting(names)
                names.formUnion(frontier)
            }
            for name in names {
                if let normalized = DomainName.normalize(name) { result.append((normalized, address, record.ttl)) }
            }
        }
        return result
    }

    /// A SERVFAIL reply to a query, used when no resolver could answer.
    public static func serverFailure(for query: Data) -> Data? {
        guard query.count >= 12 else { return nil }
        var bytes = [UInt8](query)
        bytes[2] = (bytes[2] | 0x80) & 0xF9  // QR=1, keep opcode/RD, clear AA/TC
        bytes[3] = (bytes[3] & 0xF0) | 0x02 | 0x80  // RA=1, RCODE=SERVFAIL
        return Data(bytes)
    }

    struct Reader {
        let bytes: [UInt8]
        var offset = 0

        mutating func u8() throws -> UInt8 {
            guard offset < bytes.count else { throw ParseError.truncated }
            defer { offset += 1 }
            return bytes[offset]
        }

        mutating func u16() throws -> UInt16 { UInt16(try u8()) << 8 | UInt16(try u8()) }
        mutating func u32() throws -> UInt32 { UInt32(try u16()) << 16 | UInt32(try u16()) }

        /// Reads a possibly compressed name. Pointers may only point backwards, which also
        /// rules out loops.
        mutating func name() throws -> String {
            var labels: [String] = []
            var position = offset
            var jumped = false
            var totalLength = 0
            while true {
                guard position < bytes.count else { throw ParseError.truncated }
                let length = Int(bytes[position])
                if length == 0 {
                    if !jumped { offset = position + 1 }
                    break
                }
                if length & 0xC0 == 0xC0 {
                    guard position + 1 < bytes.count else { throw ParseError.truncated }
                    let pointer = (length & 0x3F) << 8 | Int(bytes[position + 1])
                    guard pointer < position else { throw ParseError.malformedName }
                    if !jumped { offset = position + 2 }
                    jumped = true
                    position = pointer
                    continue
                }
                guard length <= 63, position + 1 + length <= bytes.count else { throw ParseError.malformedName }
                totalLength += length + 1
                guard totalLength <= 255 else { throw ParseError.malformedName }
                labels.append(String(decoding: bytes[(position + 1)...(position + length)], as: UTF8.self))
                position += 1 + length
            }
            return labels.joined(separator: ".")
        }
    }
}

extension DNSMessage {
    /// Builds a query; used by tests and the DoH health check.
    public static func query(id: UInt16, name: String, type: UInt16) -> Data {
        var bytes: [UInt8] = [UInt8(id >> 8), UInt8(id & 0xFF), 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]
        for label in name.split(separator: ".") {
            bytes.append(UInt8(label.utf8.count))
            bytes.append(contentsOf: label.utf8)
        }
        bytes += [0, UInt8(type >> 8), UInt8(type & 0xFF), 0, 1]
        return Data(bytes)
    }
}
