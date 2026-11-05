package app.mypeople.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.MonthDay
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters
import java.util.Locale

val eventTypes = listOf("birthday", "job", "education", "move", "engagement", "wedding", "birth", "loss", "health", "trip", "achievement", "plan", "interest", "family", "promise", "other")
val categories = listOf("family", "partner", "friend", "work", "acquaintance", "unknown")
val opKinds = setOf("contact_change", "contact_save", "contact_trash", "contact_restore", "merge_undo", "rename", "alias_add", "alias_remove", "event_add", "event_forget", "relationship", "profile_status", "merge", "distinct", "moment_status", "note", "extract", "find_profiles", "photos")

@Serializable
data class Records(
    val people: Map<Int, Person> = emptyMap(),
    val events: Map<String, Event> = emptyMap(),
    val profiles: Map<String, Profile> = emptyMap(),
    val moments: Map<String, Moment> = emptyMap(),
    val dupes: Map<String, Dupes> = emptyMap(),
    val contactChanges: Map<String, ContactChange> = emptyMap(),
)

fun Records.applyChanges(changes: List<RecordChange>): Records {
    val people = people.toMutableMap(); val events = events.toMutableMap()
    val profiles = profiles.toMutableMap(); val moments = moments.toMutableMap(); val dupes = dupes.toMutableMap()
    val history = contactChanges.toMutableMap()
    for (r in changes) {
        val data = r.data?.takeUnless { it == JsonNull }
        when (r.kind) {
            "person" -> if (data == null) people.remove(r.id.toInt()) else people[r.id.toInt()] = json.decodeFromJsonElement(data)
            "event" -> if (data == null) events.remove(r.id) else events[r.id] = json.decodeFromJsonElement(data)
            "profile" -> if (data == null) profiles.remove(r.id) else profiles[r.id] = json.decodeFromJsonElement(data)
            "moment" -> if (data == null) moments.remove(r.id) else moments[r.id] = json.decodeFromJsonElement(data)
            "dupes" -> if (data == null) dupes.remove(r.id) else dupes[r.id] = json.decodeFromJsonElement(data)
            "contact_change" -> {
                require(data != null) { "Contact history cannot be deleted." }
                val c = json.decodeFromJsonElement<ContactChange>(data)
                require(c.id == r.id && (history[c.id] == null || history[c.id] == c)) { "Contact history was rewritten." }
                history[c.id] = c
            }
        }
    }
    return Records(people, events, profiles, moments, dupes, history)
}

fun JsonObject.text(key: String): String = (get(key) as? JsonPrimitive)?.contentOrNull.orEmpty()
fun JsonObject.int(key: String): Int? = (get(key) as? JsonPrimitive)?.intOrNull
fun JsonObject.ids(): List<Int> = (get("person_ids") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.intOrNull }.orEmpty()

/** Never mutates the authoritative view. Replaying the same queue is deterministic. */
fun optimistic(base: Records, pending: List<PendingOp>): Records {
    if (pending.all { it.kind == "contact_change" }) return base
    val people = base.people.toMutableMap(); val events = base.events.toMutableMap()
    val profiles = base.profiles.toMutableMap(); val moments = base.moments.toMutableMap(); val dupes = base.dupes.toMutableMap()
    val redirects = mutableMapOf<Int, Int>()
    fun canonical(id: Int): Int = redirects[id]?.let { canonical(it) } ?: id
    pending.forEachIndexed { index, op ->
        if (op.kind == "contact_change") return@forEachIndexed
        val p = op.payload
        val uid = p.text("contact_uid")
        val pid = (people.entries.firstOrNull { uid.isNotEmpty() && (it.value.contact_uid == uid || uid in it.value.contact_aliases) }?.key ?: p.int("person_id"))?.let(::canonical)
        val person = people[pid]
        when (op.kind) {
            "contact_save" -> {
                val card = p["card"]?.let { json.decodeFromJsonElement<ContactCard>(it) }
                val target = pid?.takeIf { it in people } ?: p.int("local_id")
                if (card != null && target != null) people[target] = (people[target] ?: Person(card.name)).copy(name = card.name, card = card, contact_uid = uid)
            }
            "contact_trash" -> if (person != null) people[pid!!] = person.copy(trashed = true)
            "contact_restore" -> if (person != null) people[pid!!] = person.copy(trashed = false)
            "rename" -> if (person != null) people[pid!!] = person.copy(name = p.text("name"), card = person.card?.copy(name = p.text("name")))
            "alias_add" -> if (person != null && person.aliases.none { it.equals(p.text("alias"), true) }) people[pid!!] = person.copy(aliases = person.aliases + p.text("alias"))
            "alias_remove" -> if (person != null) people[pid!!] = person.copy(aliases = person.aliases.filterNot { it.equals(p.text("alias"), true) })
            "event_add" -> if (pid != null && person != null) events[(-index - 1).toString()] = Event(pid, p.text("type"), p.text("value"), normalizeDate(p.text("date")), source = "manual", created_at = op.created_at, said_at = op.created_at)
            "event_forget" -> events.remove(p.text("event_id"))
            "relationship" -> if (person != null) people[pid!!] = person.copy(
                category = p["category"]?.let { if (it == JsonNull) base.people[pid]?.category else p.text("category") } ?: person.category,
                closeness = if ("closeness" in p) (p["closeness"] as? JsonPrimitive)?.doubleOrNull ?: base.people[pid]?.closeness ?: 0.0 else person.closeness,
                cadence_days = if ("cadence_days" in p) (p["cadence_days"] as? JsonPrimitive)?.doubleOrNull else person.cadence_days,
                muted = (p["muted"] as? JsonPrimitive)?.booleanOrNull ?: person.muted,
            )
            "profile_status" -> profiles[p.text("profile_id")]?.let { profiles[p.text("profile_id")] = it.copy(status = p.text("status")) }
            "moment_status" -> moments[p.text("key")]?.let { moments[p.text("key")] = it.copy(status = p.text("status")) }
            "distinct" -> {
                val ids = p.ids().map(::canonical).toSet()
                dupes.entries.removeAll { (_, group) -> group.person_ids.all { canonical(it) in ids } }
            }
            "merge" -> {
                val ids = p.ids().map(::canonical).distinct().filter { it in people }
                // Python keeps the most interaction history; ties resolve by database id.
                val keep = ids.sorted().maxByOrNull { people.getValue(it).channels.sumOf { c -> c.count } }
                if (keep != null && ids.size > 1) {
                    val dropped = ids.filter { it != keep }.toSet()
                    val all = ids.map { people.getValue(it) }
                    val kept = people.getValue(keep)
                    people[keep] = kept.copy(
                        card = if (all.any { it.card != null }) (listOf(kept) + all.filter { it !== kept }).map { it.contactCard() }.reduce(::mergeCards) else null,
                        aliases = all.flatMap { it.aliases }.distinct(), identifiers = all.flatMap { it.identifiers }.distinct(),
                        photo = kept.photo ?: all.firstNotNullOfOrNull { it.photo },
                        channels = all.flatMap { it.channels }.groupBy { it.channel }.map { (c, counts) -> ChannelCount(c, counts.sumOf { it.count }) },
                    )
                    dropped.forEach { people.remove(it); redirects[it] = keep }
                    events.replaceAll { _, e -> if (e.person_id in dropped) e.copy(person_id = keep) else e }
                    profiles.replaceAll { _, e -> if (e.person_id in dropped) e.copy(person_id = keep) else e }
                    moments.replaceAll { _, e -> if (e.person_id in dropped) e.copy(person_id = keep) else e }
                    dupes.replaceAll { _, g -> g.copy(person_ids = g.person_ids.map(::canonical).distinct()) }
                    dupes.entries.removeAll { it.value.person_ids.size < 2 }
                }
            }
        }
    }
    return Records(people, events, profiles, moments, dupes, base.contactChanges)
}

private val full = Regex("\\d{4}-\\d{2}-\\d{2}")
private val partial = Regex("\\d{4}(-\\d{2})?")
fun day(raw: String?): LocalDate? = runCatching { LocalDate.parse(raw?.take(10)) }.getOrNull()
fun normalizeDate(raw: String): String {
    val s = raw.trim()
    return when {
        full.matches(s) -> if (day(s) != null) s else ""
        Regex("--\\d{2}-\\d{2}").matches(s) -> if (runCatching { MonthDay.parse(s) }.isSuccess) s else ""
        partial.matches(s) -> if (runCatching { LocalDate.parse(if (s.length == 4) "$s-01-01" else "$s-01") }.isSuccess) s else ""
        else -> ""
    }
}
fun formatDate(raw: String?): String {
    val s = raw.orEmpty()
    if (normalizeDate(s).isEmpty()) return "date unknown"
    return when {
        s.startsWith("--") -> MonthDay.parse(s).atYear(2000).format(DateTimeFormatter.ofPattern("MMM d", Locale.US))
        s.length == 10 -> LocalDate.parse(s).format(DateTimeFormatter.ofPattern("MMM d, uuuu", Locale.US))
        s.length == 7 -> LocalDate.parse("$s-01").format(DateTimeFormatter.ofPattern("MMM uuuu", Locale.US))
        else -> s
    }
}
fun whenKnown(e: Event): String = if (e.date.isEmpty() || e.date.startsWith("--")) e.created_at.take(10) else e.date
fun currentProfile(events: Collection<Event>): Map<String, Event> = events.filter { it.type in setOf("job", "move", "education") }
    .groupBy { it.type }.mapValues { (_, es) -> es.maxWith(compareBy<Event> { it.source != "vcard" }.thenBy { whenKnown(it) }) }
fun Records.eventsFor(id: Int): Map<String, Event> = events.filterValues { it.person_id == id }.entries.sortedByDescending { whenKnown(it.value) }.associate { it.toPair() }
private val contactCombiningMarks = Regex("\\p{M}+")
private fun contactSortKey(name: String): String =
    java.text.Normalizer.normalize(name.trim(), java.text.Normalizer.Form.NFD)
        .replace(contactCombiningMarks, "").lowercase(Locale.ROOT)

/** Share the same letter buckets between alphabetical ordering and jump navigation. */
fun contactLetter(name: String): Char = contactSortKey(name).firstOrNull()?.takeIf { it.isLetter() }?.uppercaseChar() ?: '#'

fun Records.search(query: String, sort: String = "closeness", trash: Boolean = false): List<Map.Entry<Int, Person>> {
    val q = query.trim().lowercase()
    val digits = if (q.all { it.isDigit() || it in "()+- ." }) q.filter(Char::isDigit) else ""
    val found = people.entries.filter { (_, p) -> p.trashed == trash && (q.isEmpty() || (listOf(p.name) + p.aliases + p.contactFields().map { it.value }).any { it.lowercase().contains(q) } ||
        (digits.isNotEmpty() && p.contactFields().any { it.kind == "phone" && (it.value.filter(Char::isDigit).contains(digits) || (p.contactCard().canNormalizePhone(it) && phoneSmsTarget(it.value, it.region.ifEmpty { p.contactCard().region })?.filter(Char::isDigit)?.contains(digits) == true)) }))
    }
    val sortKeys = found.associate { it.key to contactSortKey(it.value.name) }
    val alpha = compareBy<Map.Entry<Int, Person>> { sortKeys.getValue(it.key).firstOrNull()?.isLetter() != true }
        .thenBy { sortKeys.getValue(it.key) }
    return when (sort) {
        "name" -> found.sortedWith(alpha)
        "favorites" -> found.filter { it.value.card?.favorite == true }.sortedWith(alpha)
        else -> found.sortedWith(compareByDescending<Map.Entry<Int, Person>> { it.value.closeness }.then(alpha))
    }
}
fun Records.today(today: LocalDate): List<Map.Entry<String, Moment>> = moments.entries.filter { (_, m) ->
    val d = day(m.surfaced_on)
    m.status == "new" && people[m.person_id]?.trashed == false && d != null && d <= today && d >= today.minusDays(7)
}.sortedWith(compareByDescending<Map.Entry<String, Moment>> { it.value.surfaced_on == today.toString() }.thenByDescending { it.value.surfaced_on }.thenByDescending { it.value.score })
fun Records.feed(today: LocalDate): List<Map.Entry<String, Event>> = events.entries.filter { (_, e) ->
    val d = day(e.said_at)
    people[e.person_id]?.trashed == false && e.source !in setOf("vcard", "linkedin", "google") && d != null && d >= today.minusDays(90) && d <= today
}.sortedByDescending { it.value.said_at }
fun weekOf(raw: String): LocalDate? = day(raw)?.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
data class Upcoming(val eventId: String, val event: Event, val on: LocalDate, val label: String)
fun Records.upcoming(today: LocalDate): List<Upcoming> = events.mapNotNull { (id, e) ->
    val person = people[e.person_id] ?: return@mapNotNull null
    if (person.muted || person.trashed) return@mapNotNull null
    val date = day(e.date)
    val md = runCatching { if (e.date.startsWith("--")) MonthDay.parse(e.date) else date?.let(MonthDay::from) }.getOrNull()
    val anniversary = e.type in setOf("birthday", "loss", "wedding", "engagement", "birth")
    val on = if (anniversary && md != null) {
        fun occurrence(year: Int): LocalDate = if (md.monthValue == 2 && md.dayOfMonth == 29 && !java.time.Year.isLeap(year.toLong())) LocalDate.of(year, 3, 1) else md.atYear(year)
        occurrence(today.year).let { if (it < today) occurrence(today.year + 1) else it }
    } else if (e.type in setOf("plan", "trip")) date else null
    if (on == null || on < today || on > today.plusDays(60) || (date != null && anniversary && on < date)) return@mapNotNull null
    val years = date?.let { on.year - it.year }
    if (anniversary && e.type != "birthday" && years != null && years < 1) return@mapNotNull null
    val label = when {
        e.type == "birthday" -> if (years != null) "Birthday · turns $years" else "Birthday"
        anniversary -> if (years != null) "$years ${if (years == 1) "year" else "years"} since · ${e.type}" else "Anniversary · ${e.type}"
        else -> e.type.replaceFirstChar { it.uppercase() }
    }
    Upcoming(id, e, on, label)
}.sortedWith(compareBy<Upcoming> { it.on }.thenBy { people[it.event.person_id]?.name })

fun formatPhone(raw: String): String = if (raw.length == 10 && raw.all(Char::isDigit)) "(${raw.take(3)}) ${raw.substring(3, 6)}-${raw.takeLast(4)}" else raw

/** A cursor is committed only with the page it describes. Never infer it from record ids. */
suspend fun pullChanges(initial: Long, fetch: suspend (Long) -> Changes, apply: suspend (Changes) -> Unit) {
    var cursor = initial
    do {
        val page = fetch(cursor)
        check(page.cursor >= cursor && (!page.more || page.cursor > cursor)) { "The server returned a non-advancing cursor." }
        apply(page)
        cursor = page.cursor
    } while (page.more)
}
