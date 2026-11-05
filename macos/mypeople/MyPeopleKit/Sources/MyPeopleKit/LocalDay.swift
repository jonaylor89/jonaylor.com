import Foundation

/// A date with no time zone, for comparing the view's date strings. Plain calendar arithmetic:
/// Calendar would bring locale and time-zone behaviour that these comparisons must not have.
public struct LocalDay: Sendable, Hashable, Comparable, CustomStringConvertible {
    public let year: Int
    public let month: Int
    public let day: Int

    public init?(year: Int, month: Int, day: Int) {
        guard (1...12).contains(month), day >= 1, day <= Self.daysIn(month: month, year: year) else { return nil }
        self.year = year; self.month = month; self.day = day
    }

    /// Reads the first ten characters of an ISO date or timestamp, like Android's `day()`.
    public init?(_ raw: String?) {
        guard let raw, raw.utf8.count >= 10 else { return nil }
        let head = Array(raw.utf8.prefix(10))
        guard head[4] == 45, head[7] == 45, let y = Self.digits(head[0..<4]), let m = Self.digits(head[5..<7]), let d = Self.digits(head[8..<10]) else { return nil }
        self.init(year: y, month: m, day: d)
    }

    public static func today(_ now: Date = Date(), calendar: Calendar = .current) -> LocalDay {
        let c = calendar.dateComponents([.year, .month, .day], from: now)
        return LocalDay(year: c.year!, month: c.month!, day: c.day!)!
    }

    private static func digits(_ bytes: ArraySlice<UInt8>) -> Int? {
        var value = 0
        for b in bytes {
            guard (48...57).contains(b) else { return nil }
            value = value * 10 + Int(b - 48)
        }
        return value
    }

    public static func isLeap(_ year: Int) -> Bool { (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 }

    public static func daysIn(month: Int, year: Int) -> Int {
        switch month {
        case 2: isLeap(year) ? 29 : 28
        case 4, 6, 9, 11: 30
        default: 31
        }
    }

    /// Days since 1970-01-01, by Howard Hinnant's civil-date algorithm.
    public var ordinal: Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097 + doe - 719468
    }

    public init(ordinal: Int) {
        let z = ordinal + 719468
        let era = (z >= 0 ? z : z - 146096) / 146097
        let doe = z - era * 146097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        day = doy - (153 * mp + 2) / 5 + 1
        month = mp < 10 ? mp + 3 : mp - 9
        year = yoe + era * 400 + (month <= 2 ? 1 : 0)
    }

    public func adding(days: Int) -> LocalDay { LocalDay(ordinal: ordinal + days) }

    /// 1970-01-01 was a Thursday, so Monday is day 4 of the cycle.
    public var mondayOfWeek: LocalDay { adding(days: -((ordinal + 3) % 7 + 7) % 7) }

    public var description: String { String(format: "%04d-%02d-%02d", year, month, day) }

    public static func < (a: LocalDay, b: LocalDay) -> Bool { (a.year, a.month, a.day) < (b.year, b.month, b.day) }
}
