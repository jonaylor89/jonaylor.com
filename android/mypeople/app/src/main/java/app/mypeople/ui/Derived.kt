package app.mypeople.ui

import app.mypeople.data.*
import java.time.LocalDate

/**
 * Screen data derived from one Records snapshot. Tabs re-entering composition reuse it
 * instead of recomputing on the main thread, and [prewarm] fills it off the main thread
 * as soon as records change. Only the latest snapshot is kept.
 */
object Derived {
    private var owner: Records? = null
    private val values = HashMap<String, Any?>()

    @Suppress("UNCHECKED_CAST")
    fun <T> of(records: Records, key: String, compute: () -> T): T {
        synchronized(this) {
            if (owner !== records) { owner = records; values.clear() }
            if (key in values) return values[key] as T
        }
        val value = compute()
        synchronized(this) { if (owner === records) values[key] = value }
        return value
    }

    /** Everything the three tabs need at rest; call from a background dispatcher. */
    fun prewarm(records: Records, today: LocalDate) {
        val results = records.searchPeople("", "name")
        records.sections("", "name", results)
        records.profileByPerson(); records.favorites()
        records.moments(today); records.feedByWeek(today); records.upcomingSoon(today); records.recentlyInTouch()
        records.suggestedProfiles(); records.duplicateGroups()
    }
}

fun Records.searchPeople(query: String, sort: String) = Derived.of(this, "search:$sort:$query") {
    search(query, if (sort == "trash") "name" else sort, trash = sort == "trash")
}
fun Records.sections(query: String, sort: String, results: List<Map.Entry<Int, Person>>) = Derived.of(this, "sections:$sort:$query") {
    if (sort != "closeness") peopleSections(results.map { it.value.name }) else emptyList()
}
fun Records.profileByPerson() = Derived.of(this, "profiles") { events.values.groupBy { it.person_id }.mapValues { currentProfile(it.value) } }
fun Records.favorites() = Derived.of(this, "favorites") { people.entries.filter { it.value.card?.favorite == true && !it.value.trashed }.sortedBy { it.value.name.lowercase() } }
fun Records.moments(today: LocalDate) = Derived.of(this, "today:$today") { today(today) }
fun Records.feedByWeek(today: LocalDate) = Derived.of(this, "feed:$today") { feed(today).groupBy { weekOf(it.value.said_at.orEmpty()) } }
fun Records.upcomingSoon(today: LocalDate) = Derived.of(this, "upcoming:$today") { upcoming(today) }
fun Records.recentlyInTouch() = Derived.of(this, "recent") { people.entries.filter { it.value.last_contact != null && !it.value.trashed }.sortedByDescending { it.value.last_contact }.take(3) }
fun Records.suggestedProfiles() = Derived.of(this, "review-profiles") {
    profiles.entries.filter { it.value.status == "suggested" && it.value.person_id in people }
        .sortedWith(compareByDescending<Map.Entry<String, Profile>> { it.value.assessment == "supported" }.thenByDescending { it.value.confidence })
}
fun Records.duplicateGroups() = Derived.of(this, "review-groups") { dupes.entries.filter { it.value.person_ids.count { id -> id in people } >= 2 } }
