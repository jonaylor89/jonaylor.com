import Foundation
import Testing
@testable import MyPeopleKit

// LogicTest.kt's screen-logic cases, unchanged where the logic is shared. The sync and overlay
// cases don't apply here: this app has no outbox, because the database is on the same machine.
struct DerivationsTests {
    let now = LocalDay(year: 2026, month: 10, day: 27)!
    let people: [Int: Person] = [
        1: Person(name: "Sam", aliases: ["Sammy"], identifiers: [Identifier(kind: "phone", value: "5551234567")]),
        2: Person(name: "Samuel", channels: [ChannelCount(channel: "imessage", count: 10)]),
    ]

    func e(type: String = "job", date: String = "", source: String = "imessage", said: String? = "2026-10-25", pid: Int = 1, created: String = "2026-10-01") -> Event {
        Event(personId: pid, type: type, value: "value", date: date, source: source, saidAt: said, createdAt: created)
    }

    @Test func currentProfilePrefersSourceThenDateThenCreation() {
        let oldConversation = e(date: "2020", source: "imessage")
        let addressBook = e(date: "2026", source: "vcard")
        let latest = e(date: "", source: "manual", created: "2026-10-27")
        let education = e(type: "education", date: "--10-10", created: "2026-10-26")
        let result = currentProfile([oldConversation, addressBook, latest, education, e(type: "interest")])
        #expect(result["job"] == latest)
        #expect(result["education"] == education)
        #expect(result.count == 2)
        #expect(currentProfile([oldConversation, addressBook])["job"] == oldConversation)
    }

    @Test func dateFormattingHandlesPartialYearlessUnknownAndInvalid() {
        #expect(formatDate("") == "date unknown")
        #expect(formatDate(nil) == "date unknown")
        #expect(formatDate("2020") == "2020")
        #expect(formatDate("2020-10") == "Oct 2020")
        #expect(formatDate("2020-10-02") == "Oct 2, 2020")
        #expect(formatDate("--02-29") == "Feb 29")
        #expect(formatDate("2026-02-29") == "date unknown")
        #expect(normalizeDate("--13-02") == "")
        #expect(normalizeDate("2026-13") == "")
        #expect(normalizeDate("words") == "")
        #expect(normalizeDate(" 2024-02-29 ") == "2024-02-29")
        #expect(normalizeDate("20") == "")
        #expect(normalizeDate("2024-1") == "")
        #expect(normalizeDate("2024-01-") == "")
    }

    @Test func everyFactSaysWhetherYouWroteItOrItWasDerived() {
        func event(_ type: String, _ source: String) -> Event { Event(personId: 1, type: type, value: "x", source: source) }
        #expect(event("note", "manual").isManual && event("note", "manual").isNote)
        #expect(event("note", "manual").origin == "Added by you")
        #expect(event("job", "manual").isManual && !event("job", "manual").isNote)
        #expect(!event("family", "note").isManual)
        #expect(event("family", "note").origin == "Derived from your note")
        #expect(event("job", "vcard").origin == "Imported from a vCard")
        #expect(event("job", "imessage").origin == "Derived from imessage")
    }

    @Test func todayIsNewOnlyTodayFirstThenLastSevenDays() {
        func m(_ date: String, _ status: String = "new", pid: Int = 1) -> Moment { Moment(personId: pid, reason: "Reason", surfacedOn: date, status: status) }
        var trashed = people
        trashed[3] = Person(name: "Gone", trashed: true)
        let records = Records(people: trashed, moments: [
            "old": m("2026-10-21"), "today": m("2026-10-27"), "done": m("2026-10-27", "done"),
            "ancient": m("2026-10-01"), "future": m("2026-10-28"), "binned": m("2026-10-27", pid: 3), "orphan": m("2026-10-27", pid: 99),
        ])
        #expect(records.today(now).map(\.key) == ["today", "old"])
    }

    @Test func upcomingHandlesRolloverAgesAnniversariesPlansMutedAndPartialDates() {
        var all = people
        all[3] = Person(name: "Muted", muted: true)
        let records = Records(people: all, events: [
            "birthday": e(type: "birthday", date: "1990-11-01"),
            "yearless": e(type: "birthday", date: "--10-28"),
            "loss": e(type: "loss", date: "2020-11-02"),
            "engaged": e(type: "engagement", date: "2023-11-03"),
            "trip": e(type: "trip", date: "2026-12-01"),
            "partial": e(type: "wedding", date: "2020-11"),
            "muted": e(type: "birthday", date: "--11-02", pid: 3),
            "outside": e(type: "plan", date: "2027-01-01"),
            "past": e(type: "trip", date: "2026-10-01"),
        ])
        let result = records.upcoming(now)
        #expect(result.map(\.eventId) == ["yearless", "birthday", "loss", "engaged", "trip"])
        #expect(result[0].label == "Birthday")
        #expect(result[1].label == "Birthday · turns 36")
        #expect(result[2].label == "6 years since · loss")
        #expect(result[4].label == "Trip")
        let rollover = Records(people: people, events: ["b": e(type: "birthday", date: "--01-02")]).upcoming(LocalDay(year: 2026, month: 12, day: 25)!)
        #expect(rollover.first?.on == LocalDay(year: 2027, month: 1, day: 2))
    }

    @Test func leapBirthdayFallsOnMarchFirstOutsideLeapYears() {
        let records = Records(people: people, events: ["b": e(type: "birthday", date: "2000-02-29")])
        #expect(records.upcoming(LocalDay(year: 2027, month: 2, day: 1)!).first?.on == LocalDay(year: 2027, month: 3, day: 1))
        #expect(records.upcoming(LocalDay(year: 2028, month: 2, day: 1)!).first?.on == LocalDay(year: 2028, month: 2, day: 29))
    }

    @Test func upcomingIgnoresAnniversariesBeforeTheyHappened() {
        let records = Records(people: people, events: [
            "future-wedding": e(type: "wedding", date: "2026-11-10"),
            "first-year": e(type: "wedding", date: "2025-11-10"),
        ])
        #expect(records.upcoming(now).map(\.eventId) == ["first-year"])
        #expect(records.upcoming(now)[0].label == "1 year since · wedding")
    }

    @Test func searchSupportsNicknameFormattedPhonesEmailAndClosenessOrdering() {
        var all = people
        all[3] = Person(name: "Other", identifiers: [Identifier(kind: "email", value: "other@example.com")], closeness: 0.9)
        let r = Records(people: all)
        #expect(r.search("", sort: .closeness).first?.id == 3)
        #expect(r.search("SAMMY").map(\.id) == [1])
        #expect(r.search("(555) 123-4567").map(\.id) == [1])
        #expect(r.search("example.com").map(\.id) == [3])
        #expect(formatPhone("5551234567") == "(555) 123-4567")
        #expect(formatPhone("+15551234567") == "+15551234567")
    }

    @Test func searchFindsTheNormalizedNumberToo() throws {
        let card = try JSONDecoder().decode(ContactCard.self, from: Data(#"{"name":"Ada","fields":[{"kind":"phone","value":"020 7946 0000","dial":"+442079460000"}]}"#.utf8))
        let r = Records(people: [1: Person(name: "Ada", card: card), 2: Person(name: "Grace")])
        #expect(r.search("+44 20 7946").map(\.id) == [1])
        #expect(r.search("7946 0000").map(\.id) == [1])
    }

    @Test func sortingFoldsAccentsAndPutsNonLettersLast() {
        let r = Records(people: [
            1: Person(name: "Zoë"), 2: Person(name: "Émile"), 3: Person(name: "adam"), 4: Person(name: "42 Club"), 5: Person(name: "binned", trashed: true),
            6: Person(name: "fav", card: { var c = ContactCard(name: "fav"); c.favorite = true; return c }()),
        ])
        #expect(r.search("").map(\.id) == [3, 2, 6, 1, 4])
        #expect(r.search("", sort: .trash).map(\.id) == [5])
        #expect(r.search("", sort: .favorites).map(\.id) == [6])
        #expect(contactLetter("Émile") == "E")
        #expect(contactLetter("42 Club") == "#")
        #expect(contactLetter("") == "#")
    }

    @Test func reviewSelectorsMatchAndroid() {
        var profile = Profile(personId: 1, site: "x", url: "u", assessment: "possible", confidence: 0.99)
        let supported = Profile(personId: 1, site: "y", url: "v", assessment: "supported", confidence: 0.5)
        let confirmed = Profile(personId: 1, site: "z", url: "w", status: "confirmed")
        let orphan = Profile(personId: 99, site: "o", url: "o")
        let r = Records(people: people, profiles: ["a": profile, "b": supported, "c": confirmed, "d": orphan], dupes: [
            "1-2": Dupes(personIds: [1, 2]), "1-99": Dupes(personIds: [1, 99]),
        ])
        #expect(r.suggestedProfiles().map(\.id) == ["b", "a"])
        #expect(r.confirmedProfiles(1).map(\.site) == ["z"])
        #expect(r.duplicateGroups().map(\.key) == ["1-2"])
        profile.status = "rejected"
        #expect(Records(people: people, profiles: ["a": profile]).suggestedProfiles().isEmpty)
    }

    @Test func recentlyInTouchSkipsTheTrashAndTakesThree() {
        let r = Records(people: [
            1: Person(name: "a", lastContact: "2026-01-01"), 2: Person(name: "b", lastContact: "2026-01-04"), 3: Person(name: "c", lastContact: "2026-01-03"),
            4: Person(name: "d", lastContact: "2026-01-02"), 5: Person(name: "e", lastContact: "2026-02-01", trashed: true), 6: Person(name: "f"),
        ])
        #expect(r.recentlyInTouch().map(\.id) == [2, 3, 4])
    }

    @Test func aMergedPersonIsFoundByTheirContactId() {
        var kept = Person(name: "Kept", contactUid: "keep")
        kept.contactAliases = ["gone"]
        let r = Records(people: [1: kept])
        #expect(r.resolve(id: 7, uid: "gone") == 1)
        #expect(r.resolve(id: 1, uid: "") == 1)
        #expect(r.resolve(id: 7, uid: "unknown") == nil)
    }

    @Test func onlyWebLinksOpen() {
        #expect(safeWebURL("https://example.com/a")?.absoluteString == "https://example.com/a")
        #expect(safeWebURL("HTTP://example.com")?.host == "example.com")
        #expect(safeWebURL("example.com/a")?.absoluteString == "https://example.com/a")
        for hostile in ["javascript:alert(1)", "file:///etc/passwd", "x-apple.systempreferences://a", "ftp://example.com", "https://", "exa mple.com", "http://a\nb", ""] {
            #expect(safeWebURL(hostile) == nil, "\(hostile)")
        }
    }

    @Test func paletteMatchesJavaStringHashCode() {
        // "Ada Lovelace".hashCode() and friends, computed on the JVM.
        #expect(paletteIndex("") == 0)
        #expect(paletteIndex("a") == 97 % 6)
        #expect(paletteIndex("Hello") == floorMod(69609650, 6))
        #expect(paletteIndex("polygenelubricants") == floorMod(Int(Int32.min), 6))
    }
    private func floorMod(_ a: Int, _ b: Int) -> Int { ((a % b) + b) % b }

    @Test func initialsUseTheFirstTwoRealWords() {
        #expect(initials("Ada Lovelace King") == "AL")
        #expect(initials("ada") == "A")
        #expect(initials("(work) Ada 2nd") == "A2")
        #expect(initials("") == "")
    }

    @Test func localDayArithmeticAgreesWithTheCalendar() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        var date = calendar.date(from: DateComponents(year: 1896, month: 2, day: 27))!
        for _ in 0..<3000 {
            let c = calendar.dateComponents([.year, .month, .day, .weekday], from: date)
            let day = LocalDay(year: c.year!, month: c.month!, day: c.day!)!
            #expect(LocalDay(ordinal: day.ordinal) == day)
            #expect(day.adding(days: 1).ordinal == day.ordinal + 1)
            // Gregorian weekday: Sunday is 1.
            #expect((day.ordinal - day.mondayOfWeek.ordinal) == (c.weekday! + 5) % 7)
            date = calendar.date(byAdding: .day, value: 53, to: date)!
        }
        #expect(LocalDay(year: 2026, month: 2, day: 29) == nil)
        #expect(LocalDay("2026-10-27 09:00:00")?.day == 27)
        #expect(LocalDay("2026-10") == nil)
        #expect(LocalDay("not-a-date") == nil)
    }
}
