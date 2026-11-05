import Foundation

// The screen logic, ported from Android's Logic.kt and Derived.kt so each screen means the same
// thing on both platforms. LogicTest.kt's cases live on in DerivationsTests.swift.

public struct Records: Sendable, Equatable {
    public var people: [Int: Person] = [:]
    public var events: [String: Event] = [:]
    public var profiles: [String: Profile] = [:]
    public var moments: [String: Moment] = [:]
    public var dupes: [String: Dupes] = [:]

    public init(people: [Int: Person] = [:], events: [String: Event] = [:], profiles: [String: Profile] = [:],
                moments: [String: Moment] = [:], dupes: [String: Dupes] = [:]) {
        self.people = people; self.events = events; self.profiles = profiles; self.moments = moments; self.dupes = dupes
    }
}

private let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
private let anniversaryTypes: Set<String> = ["birthday", "loss", "wedding", "engagement", "birth"]

private func isDigits(_ s: Substring) -> Bool { !s.isEmpty && s.utf8.allSatisfy { (48...57).contains($0) } }

/// The date itself if it's a real one in a form the database stores, otherwise empty.
public func normalizeDate(_ raw: String) -> String {
    let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("--") {
        let parts = s.dropFirst(2).split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].count == 2, parts[1].count == 2, isDigits(parts[0]), isDigits(parts[1]),
              LocalDay(year: 2000, month: Int(parts[0])!, day: Int(parts[1])!) != nil else { return "" }
        return s
    }
    let parts = s.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.allSatisfy(isDigits), parts[0].count == 4 else { return "" }
    switch parts.count {
    case 1: return s
    case 2: return parts[1].count == 2 && (1...12).contains(Int(parts[1])!) ? s : ""
    case 3: return parts[1].count == 2 && parts[2].count == 2 && LocalDay(s) != nil ? s : ""
    default: return ""
    }
}

public func formatDate(_ raw: String?) -> String {
    let s = raw ?? ""
    if normalizeDate(s).isEmpty { return "date unknown" }
    if s.hasPrefix("--") {
        let parts = s.dropFirst(2).split(separator: "-")
        return "\(months[Int(parts[0])! - 1]) \(Int(parts[1])!)"
    }
    let parts = s.split(separator: "-")
    switch parts.count {
    case 3: return "\(months[Int(parts[1])! - 1]) \(Int(parts[2])!), \(parts[0])"
    case 2: return "\(months[Int(parts[1])! - 1]) \(parts[0])"
    default: return s
    }
}

public func whenKnown(_ e: Event) -> String {
    e.date.isEmpty || e.date.hasPrefix("--") ? String(e.createdAt.prefix(10)) : e.date
}

public extension Event {
    /// Written by you, as opposed to read from messages or imported.
    var isManual: Bool { source == "manual" }
    var isNote: Bool { type == "note" }
    /// Where this came from, in words. Keep in step with `factOrigin` in Logic.kt.
    var origin: String {
        switch source {
        case "manual": "Added by you"
        case "note": "Derived from your note"
        case "vcard": "Imported from a vCard"
        case "google": "Imported from Google"
        case "linkedin": "Imported from LinkedIn"
        default: "Derived from \(source)"
        }
    }
}

/// Latest job, home and school, preferring anything over the address book's stale copy.
public func currentProfile(_ events: some Collection<Event>) -> [String: Event] {
    var best: [String: Event] = [:]
    for e in events where ["job", "move", "education"].contains(e.type) {
        guard let current = best[e.type] else { best[e.type] = e; continue }
        let a = (e.source != "vcard" ? 1 : 0, whenKnown(e)), b = (current.source != "vcard" ? 1 : 0, whenKnown(current))
        if a >= b { best[e.type] = e }
    }
    return best
}

public func contactSortKey(_ name: String) -> String {
    let folded = name.trimmingCharacters(in: .whitespacesAndNewlines).decomposedStringWithCanonicalMapping
    var scalars = String.UnicodeScalarView()
    for scalar in folded.unicodeScalars {
        switch scalar.properties.generalCategory {
        case .nonspacingMark, .spacingMark, .enclosingMark: continue
        default: scalars.append(scalar)
        }
    }
    return String(scalars).lowercased()
}

/// The same letter buckets for alphabetical ordering and section headers.
public func contactLetter(_ name: String) -> String {
    guard let first = contactSortKey(name).first, first.isLetter else { return "#" }
    return String(first).uppercased()
}

public func formatPhone(_ raw: String) -> String {
    let d = Array(raw)
    guard d.count == 10, d.allSatisfy({ $0.isASCII && $0.isNumber }) else { return raw }
    return "(\(String(d[0..<3]))) \(String(d[3..<6]))-\(String(d[6..<10]))"
}

public func weekOf(_ raw: String?) -> LocalDay? { LocalDay(raw)?.mondayOfWeek }

public struct Upcoming: Sendable, Equatable {
    public var eventId: String
    public var event: Event
    public var on: LocalDay
    public var label: String
    public var isAnniversary: Bool { anniversaryTypes.contains(event.type) }
}

public enum PeopleSort: String, Sendable, CaseIterable { case name, favorites, closeness, trash }

public extension Records {
    func eventsFor(_ id: Int) -> [(id: String, event: Event)] {
        events.filter { $0.value.personId == id }.map { (id: $0.key, event: $0.value) }
            .sorted { (whenKnown($0.event), $1.id) > (whenKnown($1.event), $0.id) }
    }

    func search(_ query: String, sort: PeopleSort = .name) -> [(id: Int, person: Person)] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let digits = q.allSatisfy { $0.isNumber || "()+- .".contains($0) } ? q.filter(\.isNumber) : ""
        let trash = sort == .trash
        let found: [(id: Int, person: Person)] = people.compactMap { id, p in
            guard p.trashed == trash else { return nil }
            if q.isEmpty { return (id, p) }
            let card = p.contactCard
            if p.name.lowercased().contains(q) || p.aliases.contains(where: { $0.lowercased().contains(q) })
                || card.fields.contains(where: { $0.value.lowercased().contains(q) }) { return (id, p) }
            if !digits.isEmpty, card.fields.contains(where: { f in
                f.kind == "phone" && (f.value.filter(\.isNumber).contains(digits) || (card.dialTarget(f)?.number.filter(\.isNumber).contains(digits) ?? false))
            }) { return (id, p) }
            return nil
        }
        let keyed = found.map { (entry: $0, key: contactSortKey($0.person.name)) }
        func alpha(_ a: (entry: (id: Int, person: Person), key: String), _ b: (entry: (id: Int, person: Person), key: String)) -> Bool {
            let aLetter = a.key.first?.isLetter == true, bLetter = b.key.first?.isLetter == true
            if aLetter != bLetter { return aLetter }
            return a.key != b.key ? a.key < b.key : a.entry.id < b.entry.id
        }
        switch sort {
        case .name, .trash: return keyed.sorted(by: alpha).map(\.entry)
        case .favorites: return keyed.filter { $0.entry.person.isFavorite }.sorted(by: alpha).map(\.entry)
        case .closeness:
            return keyed.sorted { a, b in
                a.entry.person.closeness != b.entry.person.closeness ? a.entry.person.closeness > b.entry.person.closeness : alpha(a, b)
            }.map(\.entry)
        }
    }

    /// New moments from the last week, today's first.
    func today(_ today: LocalDay) -> [(key: String, moment: Moment)] {
        moments.compactMap { key, m -> (key: String, moment: Moment)? in
            guard m.status == "new", people[m.personId]?.trashed == false, let d = LocalDay(m.surfacedOn),
                  d <= today, d >= today.adding(days: -7) else { return nil }
            return (key, m)
        }.sorted { a, b in
            let ta = a.moment.surfacedOn == today.description, tb = b.moment.surfacedOn == today.description
            if ta != tb { return ta }
            if a.moment.surfacedOn != b.moment.surfacedOn { return a.moment.surfacedOn > b.moment.surfacedOn }
            return a.moment.score != b.moment.score ? a.moment.score > b.moment.score : a.key < b.key
        }
    }

    func upcoming(_ today: LocalDay) -> [Upcoming] {
        let found: [Upcoming] = events.compactMap { id, e in
            guard let person = people[e.personId], !person.muted, !person.trashed else { return nil }
            let date = LocalDay(e.date.count == 10 ? e.date : nil)
            var monthDay: (month: Int, day: Int)?
            if e.date.hasPrefix("--"), !normalizeDate(e.date).isEmpty {
                let parts = e.date.dropFirst(2).split(separator: "-")
                monthDay = (Int(parts[0])!, Int(parts[1])!)
            } else if let date {
                monthDay = (date.month, date.day)
            }
            let anniversary = anniversaryTypes.contains(e.type)
            var on: LocalDay?
            if anniversary, let monthDay {
                func occurrence(_ year: Int) -> LocalDay {
                    LocalDay(year: year, month: monthDay.month, day: monthDay.day) ?? LocalDay(year: year, month: 3, day: 1)!
                }
                let next = occurrence(today.year)
                on = next < today ? occurrence(today.year + 1) : next
            } else if ["plan", "trip"].contains(e.type) {
                on = date
            }
            guard let on, on >= today, on <= today.adding(days: 60) else { return nil }
            if let date, anniversary, on < date { return nil }
            let years = date.map { on.year - $0.year }
            if anniversary, e.type != "birthday", let years, years < 1 { return nil }
            let label: String
            if e.type == "birthday" {
                label = years.map { "Birthday · turns \($0)" } ?? "Birthday"
            } else if anniversary {
                label = years.map { "\($0) \($0 == 1 ? "year" : "years") since · \(e.type)" } ?? "Anniversary · \(e.type)"
            } else {
                label = e.type.prefix(1).uppercased() + e.type.dropFirst()
            }
            return Upcoming(eventId: id, event: e, on: on, label: label)
        }
        return found.sorted { a, b in
            if a.on != b.on { return a.on < b.on }
            let an = people[a.event.personId]?.name ?? "", bn = people[b.event.personId]?.name ?? ""
            return an != bn ? an < bn : a.eventId < b.eventId
        }
    }

    func favorites() -> [(id: Int, person: Person)] {
        people.filter { $0.value.isFavorite && !$0.value.trashed }.map { (id: $0.key, person: $0.value) }
            .sorted { ($0.person.name.lowercased(), $0.id) < ($1.person.name.lowercased(), $1.id) }
    }

    func recentlyInTouch(limit: Int = 3) -> [(id: Int, person: Person)] {
        people.filter { $0.value.lastContact != nil && !$0.value.trashed }.map { (id: $0.key, person: $0.value) }
            .sorted { ($0.person.lastContact ?? "", $1.id) > ($1.person.lastContact ?? "", $0.id) }
            .prefix(limit).map { $0 }
    }

    func suggestedProfiles() -> [(id: String, profile: Profile)] {
        profiles.filter { $0.value.status == "suggested" && people[$0.value.personId] != nil }.map { (id: $0.key, profile: $0.value) }
            .sorted { a, b in
                let sa = a.profile.assessment == "supported", sb = b.profile.assessment == "supported"
                if sa != sb { return sa }
                return a.profile.confidence != b.profile.confidence ? a.profile.confidence > b.profile.confidence : a.id < b.id
            }
    }

    func confirmedProfiles(_ id: Int) -> [Profile] {
        profiles.values.filter { $0.personId == id && $0.status == "confirmed" }.sorted { $0.url < $1.url }
    }

    func duplicateGroups() -> [(key: String, group: Dupes)] {
        dupes.filter { $0.value.personIds.filter { people[$0] != nil }.count >= 2 }.map { (key: $0.key, group: $0.value) }
            .sorted { $0.key < $1.key }
    }

    func conflicted() -> [(id: Int, person: Person)] {
        people.filter { !$0.value.conflicts.isEmpty }.map { (id: $0.key, person: $0.value) }
            .sorted { ($0.person.name.lowercased(), $0.id) < ($1.person.name.lowercased(), $1.id) }
    }

    /// Someone may have been merged since a screen opened: their contact id still finds them.
    func resolve(id: Int, uid: String) -> Int? {
        if !uid.isEmpty, let found = people.first(where: { $0.value.contactUid == uid || $0.value.contactAliases.contains(uid) }) {
            return found.key
        }
        return people[id] == nil ? nil : id
    }
}

/// Only web links open from data the app didn't write itself: a scraped profile could hold anything.
public func safeWebURL(_ raw: String) -> URL? {
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.unicodeScalars.contains(where: { $0.value < 0x21 || $0.value == 0x7f }),
          let url = URL(string: value.contains("://") ? value : "https://\(value)"),
          let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let host = url.host, !host.isEmpty else { return nil }
    return url
}

/// Mirrors Android's palette choice: Java's String.hashCode, floor-modulo the palette size.
public func paletteIndex(_ seed: String, count: Int = 6) -> Int {
    var hash: Int32 = 0
    for unit in seed.utf16 { hash = hash &* 31 &+ Int32(unit) }
    let m = Int(hash) % count
    return m < 0 ? m + count : m
}

/// The first letters of up to two words that begin with a letter or digit.
public func initials(_ name: String) -> String {
    let words = name.split(whereSeparator: \.isWhitespace).filter { $0.first?.isLetter == true || $0.first?.isNumber == true }
    return words.prefix(2).compactMap { $0.first.map { String($0).uppercased() } }.joined()
}
