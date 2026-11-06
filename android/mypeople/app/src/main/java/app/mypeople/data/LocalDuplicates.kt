package app.mypeople.data

import java.text.Normalizer
import java.util.Locale
import kotlinx.collections.immutable.*

/** Keys of duplicate groups found on this phone; the Mac's own groups never use this prefix. */
const val LOCAL_DUPES_PREFIX = "local:"
private const val MAX_CANDIDATES = 3 // as the Mac: a first name shared by more full names is too common
private val marks = Regex("\\p{M}+")
private val letters = Regex("[\\p{L}]{2,}")

private fun fold(text: String) = Normalizer.normalize(text, Normalizer.Form.NFKD).replace(marks, "").lowercase(Locale.ROOT)
private fun looksLikeIdentifier(name: String) = '@' in name || name.none { it.isLetter() }
private fun phoneKey(value: String) = value.filter(Char::isDigit).takeIf { it.length >= 7 }?.takeLast(10)

/**
 * Possible duplicates involving contacts added or changed on this phone since the last sync,
 * so they can be reviewed before the Mac has seen them. Uses the Mac's rules (a shared full
 * name; a lone first name beside at most three full names) plus a shared phone number or
 * email. Groups the Mac already sent, or that a "Not the same person" choice covers, are left
 * out. After the next sync the Mac's list, which remembers every choice, takes over.
 */
fun localDuplicates(records: Records, touched: Set<String>, distinct: List<Set<Int>>): Map<String, Dupes> {
    val live = records.people.filterValues { !it.trashed }
    val mine = live.filterValues { it.contact_uid.isNotEmpty() && it.contact_uid in touched }
    if (mine.isEmpty()) return emptyMap()
    val byName = live.entries.filterNot { looksLikeIdentifier(it.value.name) }.groupBy { it.value.name.lowercase(Locale.ROOT).split(Regex("\\s+")).filter(String::isNotEmpty).joinToString(" ") }
    val byFirst = live.entries.mapNotNull { e -> fold(e.value.name).split(Regex("\\s+")).filter(String::isNotEmpty).takeIf { it.size >= 2 && it[0].length >= 2 }?.let { it[0] to e.key } }
        .groupBy({ it.first }, { it.second })
    val lone = live.entries.filter { it.value.name.trim().let { n -> ' ' !in n && letters.matches(n) } }.groupBy({ fold(it.value.name.trim()) }, { it.key })
    fun keys(p: Person, kind: String) = p.contactFields().filter { it.kind == kind }.mapNotNull { if (kind == "phone") phoneKey(it.value) else it.value.trim().lowercase(Locale.ROOT).ifEmpty { null } }.toSet()
    val byPhone = HashMap<String, MutableSet<Int>>(); val byEmail = HashMap<String, MutableSet<Int>>()
    live.forEach { (id, p) -> keys(p, "phone").forEach { byPhone.getOrPut(it) { mutableSetOf() }.add(id) }; keys(p, "email").forEach { byEmail.getOrPut(it) { mutableSetOf() }.add(id) } }
    val covered = records.dupes.values.map { it.person_ids.toSet() } + distinct
    val out = LinkedHashMap<String, Dupes>()
    fun offer(ids: Collection<Int>, clue: String) {
        val group = ids.distinct().sorted()
        if (group.size < 2 || covered.any { it.containsAll(group) }) return
        val key = LOCAL_DUPES_PREFIX + group.joinToString("-")
        val old = out[key]
        out[key] = Dupes(group, ((old?.clues ?: emptyList()) + clue).distinct())
    }
    for ((id, person) in mine) {
        byName[person.name.lowercase(Locale.ROOT).split(Regex("\\s+")).filter(String::isNotEmpty).joinToString(" ")]
            ?.takeIf { !looksLikeIdentifier(person.name) }?.let { offer(it.map { e -> e.key }, "Same name") }
        val words = fold(person.name).split(Regex("\\s+")).filter(String::isNotEmpty)
        // A lone first name next to the few full names it could be short for, in either direction.
        val first = if (words.size == 1 && letters.matches(person.name.trim())) words[0] else words.firstOrNull()?.takeIf { words.size >= 2 }
        if (first != null) {
            val full = byFirst[first].orEmpty()
            if (full.size in 1..MAX_CANDIDATES) lone[first]?.forEach { short -> offer(listOf(short) + full, "A first name that could be short for a full name") }
        }
        val phones = keys(person, "phone"); val emails = keys(person, "email")
        // A number or address shared by many records (an office line) says little on its own.
        phones.forEach { k -> byPhone[k]?.takeIf { it.size <= MAX_CANDIDATES + 1 }?.let { offer(it, "Same phone number") } }
        emails.forEach { k -> byEmail[k]?.takeIf { it.size <= MAX_CANDIDATES + 1 }?.let { offer(it, "Same email address") } }
    }
    return out.mapValues { (_, d) -> d.copy(clues = d.clues + "Found on this phone from changes since your last sync") }
}

/** Disposable immutable candidate index for complete graph projections. Normalize
 * only changed people; query indexed buckets, never reparse every contact card.
 * The legacy/touched-contact reducer above remains the compatibility reference. */
internal class GraphDuplicateIndex private constructor(
    private val keys: PersistentMap<Int, List<List<String>>>,
    private val buckets: PersistentMap<Pair<Int, String>, PersistentSet<Int>>,
) {
    constructor() : this(persistentHashMapOf(), persistentHashMapOf())

    fun updated(people: Map<Int, Person>, dirty: Set<Int>): GraphDuplicateIndex {
        val nextKeys = keys.builder(); val nextBuckets = buckets.builder()
        for (id in dirty) {
            val p = people[id]?.takeUnless { it.trashed }
            val next = p?.let {
                val words = fold(it.name).split(Regex("\\s+")).filter(String::isNotEmpty)
                fun fields(kind: String) = it.contactFields().filter { f -> f.kind == kind }.mapNotNull { f ->
                    if (kind == "phone") phoneKey(f.value) else f.value.trim().lowercase(Locale.ROOT).ifEmpty { null }
                }.distinct()
                listOf(
                    if (looksLikeIdentifier(it.name)) emptyList() else listOf(it.name.lowercase(Locale.ROOT).split(Regex("\\s+")).filter(String::isNotEmpty).joinToString(" ")),
                    if (words.size >= 2 && words[0].length >= 2) listOf(words[0]) else emptyList(),
                    if (it.name.trim().let { n -> ' ' !in n && letters.matches(n) }) listOf(fold(it.name.trim())) else emptyList(),
                    fields("phone"), fields("email"),
                )
            }
            val old = keys[id]
            if (next == old) continue
            old?.forEachIndexed { kind, values -> values.forEach { value ->
                val key = kind to value
                val remaining = nextBuckets.getValue(key).remove(id)
                if (remaining.isEmpty()) nextBuckets.remove(key) else nextBuckets[key] = remaining
            } }
            next?.forEachIndexed { kind, values -> values.forEach { value ->
                val key = kind to value
                nextBuckets[key] = (nextBuckets[key] ?: persistentHashSetOf()).add(id)
            } }
            if (next == null) nextKeys.remove(id) else nextKeys[id] = next
        }
        if (nextKeys.build() === keys) return this
        return GraphDuplicateIndex(nextKeys.build(), nextBuckets.build())
    }

    fun groups(distinct: List<Set<Int>>): Map<String, Dupes> {
        val out = linkedMapOf<String, Dupes>()
        fun offer(ids: Collection<Int>, clue: String) {
            if (ids.size < 2 || distinct.any { it.containsAll(ids) }) return
            val sorted = ids.sorted()
            val key = LOCAL_DUPES_PREFIX + sorted.joinToString("-")
            val old = out[key]
            out[key] = Dupes(sorted, (old?.clues.orEmpty() + clue).distinct())
        }
        // Same clue ordering as localDuplicates, even when keys collide.
        for (kind in listOf(0, 1, 3, 4)) for ((key, ids) in buckets) {
            if (key.first != kind) continue
            when (kind) {
                0 -> offer(ids, "Same name")
                1 -> if (ids.size in 1..MAX_CANDIDATES) buckets[2 to key.second].orEmpty().forEach { short -> offer(ids + short, "A first name that could be short for a full name") }
                3 -> if (ids.size <= MAX_CANDIDATES + 1) offer(ids, "Same phone number")
                4 -> if (ids.size <= MAX_CANDIDATES + 1) offer(ids, "Same email address")
            }
        }
        return out.mapValues { (_, d) -> d.copy(clues = d.clues + "Found on this phone from changes since your last sync") }
    }
}
