package app.mypeople.data

import androidx.appfunctions.AppFunctionSerializable
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import java.util.Locale

// What MyPeople answers when an assistant asks through AppFunctions. Read-only, computed from
// the same Records the screens show (queued edits included). Trashed people never appear.
// Evidence quotes, profiles, and relationship scores stay out: answers carry what a person
// would say aloud, not the raw memory.

/** Someone in your MyPeople memory who matched a search. */
@AppFunctionSerializable(isDescribedByKDoc = true)
class PersonMatch(
    /** Pass this to getPersonSummary. Stable until the person is merged with another record. */
    val personId: Int,
    /** The name shown in MyPeople. */
    val name: String,
    /** Nicknames and other names this person goes by. */
    val aliases: List<String>,
    /** family, partner, friend, work, acquaintance, or unknown. */
    val category: String,
    /** Last day you were in touch (yyyy-MM-dd), or null if unknown. */
    val lastContact: String?,
    /** Phone numbers on their contact card. */
    val phones: List<String>,
    /** Email addresses on their contact card. */
    val emails: List<String>,
)

/** One fact MyPeople remembers about a person. */
@AppFunctionSerializable(isDescribedByKDoc = true)
class PersonFact(
    /** birthday, job, education, move, engagement, wedding, birth, loss, health, trip, achievement, plan, interest, family, promise, note, or other. */
    val type: String,
    /** What happened, in a few words. */
    val value: String,
    /** When it happened: yyyy-MM-dd, yyyy-MM, yyyy, or --MM-dd for a yearly date. Null if unknown. */
    val date: String?,
)

/** What MyPeople knows about one person. */
@AppFunctionSerializable(isDescribedByKDoc = true)
class PersonSummary(
    val personId: Int,
    val name: String,
    val aliases: List<String>,
    /** family, partner, friend, work, acquaintance, or unknown. */
    val category: String,
    /** growing, steady, drifting, new, or none: how your contact with them is changing. */
    val trend: String,
    /** How often you want to be in touch, in days, or null if not set. */
    val cadenceDays: Int?,
    /** Last day you were in touch (yyyy-MM-dd), or null if unknown. */
    val lastContact: String?,
    /** Whole days since you were last in touch, or null if unknown. */
    val daysSinceLastContact: Int?,
    /** Their current job, if known. */
    val currentJob: String?,
    /** Where they live now, if known. */
    val currentPlace: String?,
    /** Their current or most recent school, if known. */
    val currentEducation: String?,
    /** True if you muted reminders for this person. */
    val muted: Boolean,
    /** The most recent facts first, at most 15. */
    val recentFacts: List<PersonFact>,
)

/** A reason MyPeople suggested reaching out to someone recently. */
@AppFunctionSerializable(isDescribedByKDoc = true)
class SuggestedMoment(
    /** Identifies this suggestion. */
    val momentId: String,
    val personId: Int,
    val name: String,
    /** The kind of suggestion, such as birthday, anniversary, or catch_up. */
    val kind: String,
    /** Why now, in a sentence. */
    val reason: String,
    /** Extra background, if any. */
    val context: String?,
    /** The day MyPeople suggested it (yyyy-MM-dd). */
    val surfacedOn: String,
)

/** Someone connected to a place. */
@AppFunctionSerializable(isDescribedByKDoc = true)
class PlaceMatch(
    val personId: Int,
    val name: String,
    /** The text that matched, such as an address or "Moved to Denver". */
    val where: String,
    /** address (from their contact card) or move (something they told you). */
    val source: String,
)

/** Someone you're drifting away from. */
@AppFunctionSerializable(isDescribedByKDoc = true)
class DriftingPerson(
    val personId: Int,
    val name: String,
    val category: String,
    /** Last day you were in touch (yyyy-MM-dd), or null if unknown. */
    val lastContact: String?,
    /** Whole days since you were last in touch, or null if unknown. */
    val daysSinceLastContact: Int?,
    /** How often you want to be in touch, in days, or null if not set. */
    val cadenceDays: Int?,
    /** Why this person is listed, in a sentence. */
    val why: String,
)

/** A birthday, anniversary, plan, or trip coming up. */
@AppFunctionSerializable(isDescribedByKDoc = true)
class UpcomingDate(
    val personId: Int,
    val name: String,
    /** The day it falls on (yyyy-MM-dd). */
    val date: String,
    /** birthday, wedding, engagement, birth, loss, plan, or trip. */
    val type: String,
    /** A short label, such as "Birthday · turns 31" or "3 years since · wedding". */
    val label: String,
    /** What MyPeople remembers about it. */
    val detail: String,
)

private fun Records.visible(id: Int): Person? = people[id]?.takeUnless { it.trashed }
private fun daysSince(raw: String?, today: LocalDate): Int? = day(raw)?.let { ChronoUnit.DAYS.between(it, today).toInt() }
private fun Person.fields(kind: String) = contactFields().filter { it.kind == kind }.map { it.value }.distinct()

fun Records.assistantFindPeople(query: String, limit: Int): List<PersonMatch> {
    require(query.isNotBlank()) { "Say who to look for." }
    return search(query).take(limit.coerceIn(1, 20)).map { (id, p) ->
        PersonMatch(id, p.name, p.aliases, p.category, p.last_contact?.take(10), p.fields("phone"), p.fields("email"))
    }
}

fun Records.assistantSummary(personId: Int, today: LocalDate): PersonSummary? {
    val p = visible(personId) ?: return null
    val facts = eventsFor(personId).values
    val profile = currentProfile(facts)
    return PersonSummary(
        personId, p.name, p.aliases, p.category, p.trend, p.cadence_days?.toInt(), p.last_contact?.take(10),
        daysSince(p.last_contact, today), profile["job"]?.value, profile["move"]?.value, profile["education"]?.value, p.muted,
        facts.take(15).map { PersonFact(it.type, it.value, it.date.ifEmpty { null }) },
    )
}

fun Records.assistantMoments(today: LocalDate): List<SuggestedMoment> = today(today).mapNotNull { (key, m) ->
    val p = visible(m.person_id) ?: return@mapNotNull null
    SuggestedMoment(key, m.person_id, p.name, m.kind, m.reason, m.context, m.surfaced_on.take(10))
}

/** Matches where people live now: contact-card addresses and their latest move. */
fun Records.assistantPeopleIn(place: String): List<PlaceMatch> {
    val q = place.trim().lowercase(Locale.ROOT)
    require(q.isNotEmpty()) { "Say which place." }
    val moves = events.values.filter { it.type == "move" && it.value.isNotBlank() }.groupBy { it.person_id }
        .mapValues { (_, es) -> currentProfile(es)["move"] }
    return people.entries.filter { !it.value.trashed }.mapNotNull { (id, p) ->
        p.fields("address").firstOrNull { it.lowercase(Locale.ROOT).contains(q) }?.let { return@mapNotNull PlaceMatch(id, p.name, it, "address") }
        moves[id]?.value?.takeIf { it.lowercase(Locale.ROOT).contains(q) }?.let { PlaceMatch(id, p.name, it, "move") }
    }.sortedByDescending { people.getValue(it.personId).closeness }
}

/** People MyPeople sees drifting, or who are well past the cadence you asked for. Muted people are left out. */
fun Records.assistantDrifting(today: LocalDate, limit: Int): List<DriftingPerson> = people.entries.mapNotNull { (id, p) ->
    if (p.trashed || p.muted) return@mapNotNull null
    val since = daysSince(p.last_contact, today)
    val cadence = p.cadence_days
    val overdue = cadence != null && cadence > 0 && since != null && since > cadence * 1.5
    if (p.trend != "drifting" && !overdue) return@mapNotNull null
    val why = when {
        overdue -> "$since days since you were in touch; you wanted every ${cadence!!.toInt()}."
        since != null -> "You're in touch less than you used to be; last time was $since days ago."
        else -> "You're in touch less than you used to be."
    }
    DriftingPerson(id, p.name, p.category, p.last_contact?.take(10), since, cadence?.toInt(), why) to p.closeness
}.sortedByDescending { it.second }.take(limit.coerceIn(1, 50)).map { it.first }

fun Records.assistantUpcoming(today: LocalDate, days: Int): List<UpcomingDate> {
    val until = today.plusDays(days.coerceIn(1, 60).toLong())
    return upcoming(today).filter { it.on <= until }.mapNotNull { u ->
        val p = visible(u.event.person_id) ?: return@mapNotNull null
        UpcomingDate(u.event.person_id, p.name, u.on.toString(), u.event.type, u.label, u.event.value)
    }
}
