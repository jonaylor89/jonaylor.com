package app.mypeople.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.util.PriorityQueue
import java.util.UUID

/** Wire v1: immutable causal patches, shared with mypeople/replica.py. No wall-clock winners. */
@Serializable
data class ContactChange(
    val id: String,
    val parents: List<String> = emptyList(),
    val contact_uid: String,
    val values: JsonObject = JsonObject(emptyMap()),
    val adds: Map<String, List<JsonElement>> = emptyMap(),
    val removes: Map<String, List<String>> = emptyMap(),
    val links: List<String> = emptyList(),
    val replaces: Map<String, List<String>> = emptyMap(),
)

@Serializable
data class ReplicaState(
    val enabled: Boolean = false,
    val changes: List<ContactChange> = emptyList(),
    val remoteHeads: List<String> = emptyList(),
    val localIds: Map<String, Int> = emptyMap(),
    val recordHashes: Map<String, String> = emptyMap(),
    val publisher: String? = null,
)

@Serializable
data class ContactConflict(val change: String, val value: JsonElement)

data class ReplicatedContact(
    val uid: String, val members: List<String>, val card: ContactCard,
    val trashed: Boolean, val conflicts: Map<String, List<ContactConflict>>,
    val tags: Map<String, Map<String, JsonElement>>,
    val registers: Map<String, Map<String, JsonElement>>,
    val isMe: Boolean = false,
)

class ContactHistory(input: List<ContactChange> = emptyList(), private val timing: (String, Long) -> Unit = { _, _ -> }) {
    companion object {
        val lists = setOf("fields", "originals", "source_records")
        private val fullJson = Json(json) { encodeDefaults = true }
        fun cardObject(card: ContactCard) = fullJson.encodeToJsonElement(card).jsonObject
        fun scalarValues(card: ContactCard) = JsonObject(cardObject(card).filterKeys { it !in lists && it != "edit_id" })
        fun uuid(value: String) { require(UUID.fromString(value).toString() == value) { "Invalid contact UUID." } }
    }
    val changes: List<ContactChange>
    val byId: Map<String, ContactChange>
    val heads: List<String>
    val contacts: Map<String, ReplicatedContact>
    private val byMember: Map<String, ReplicatedContact>
    private val parentSets = java.util.IdentityHashMap<List<String>, Set<String>>()
    private val ranks: Map<String, Int>
    private fun parentSet(parents: List<String>): Set<String> = parentSets.getOrPut(parents) { parents.toSet() }
    init {
        var mark = System.nanoTime()
        fun stage(name: String) { timing("history_$name", (System.nanoTime() - mark) / 1_000_000); mark = System.nanoTime() }
        require(input.size <= 200_000) { "Contact history exceeds the supported limit." }
        val index = mutableMapOf<String, ContactChange>()
        val validUuids = mutableSetOf<String>()
        val checkedParents = java.util.IdentityHashMap<List<String>, Boolean>()
        fun checkUuid(value: String) { if (validUuids.add(value)) uuid(value) }
        input.forEach { c ->
            checkUuid(c.id); checkUuid(c.contact_uid); c.links.forEach(::checkUuid)
            if (checkedParents.put(c.parents, true) == null) {
                c.parents.forEach(::checkUuid)
                require(parentSet(c.parents).size == c.parents.size) { "Invalid contact parents." }
            }
            require(c.links.size <= 10000) { "Invalid contact parents." }
            require(c.adds.keys.all { it in lists } && c.removes.keys.all { it in lists } && c.values.keys.none { it in lists || it == "edit_id" }) { "Invalid contact patch." }
            require(index[c.id] == null || index[c.id] == c) { "A contact change UUID was reused for different content." }
            index[c.id] = c
        }
        require(index.size <= 100_000) { "Contact history exceeds the supported limit." }
        byId = index
        require(index.values.sumOf { it.parents.size.toLong() } <= 8_000_000) { "Contact history has too many parent edges." }
        stage("validate")
        // Kahn's algorithm over shared parent lists rather than individual edges: a dense
        // DAG has ~a million edges but only a handful of distinct (interned) parent arrays.
        // Every change sharing one array becomes ready at the same moment, so the
        // PriorityQueue order is identical to a per-edge walk.
        class Group(val parents: List<String>, var remaining: Int) { val members = mutableListOf<String>() }
        val groups = java.util.IdentityHashMap<List<String>, Group>()
        index.values.forEach { c -> groups.getOrPut(c.parents) { Group(c.parents, c.parents.size) }.members.add(c.id) }
        val waiting = mutableMapOf<String, MutableList<Group>>()
        val parented = mutableSetOf<String>()
        groups.values.forEach { g -> g.parents.forEach { p ->
            require(p in index) { "Contact history is missing a parent; sync its history first." }
            waiting.getOrPut(p) { mutableListOf() }.add(g); parented.add(p)
        } }
        val ready = PriorityQueue<String>(); groups.values.filter { it.remaining == 0 }.forEach { ready.addAll(it.members) }
        val ordered = ArrayList<ContactChange>(index.size)
        while (ready.isNotEmpty()) {
            val id = ready.remove(); ordered.add(index.getValue(id))
            waiting[id]?.forEach { g -> if (--g.remaining == 0) ready.addAll(g.members) }
        }
        require(ordered.size == index.size) { "Cyclic contact history." }
        changes = ordered
        ranks = HashMap<String, Int>(changes.size * 2).also { m -> changes.forEachIndexed { i, c -> m[c.id] = i } }
        heads = (index.keys - parented).sorted()
        stage("order")
        val created = changes.filter { "name" in it.values }.groupBy { it.contact_uid }.mapValues { (_, list) -> list.map { it.id }.toSet() }
        changes.filter { it.links.isNotEmpty() }.forEach { c ->
            require((listOf(c.contact_uid) + c.links).all { uid -> created[uid].orEmpty().any { it == c.id || observed(it, c.parents) } }) { "A merge references an unobserved contact." }
        }
        stage("merges")
        contacts = reduce()
        stage("reduce")
        byMember = contacts.values.flatMap { c -> c.members.map { it to c } }.toMap()
    }
    fun contact(uid: String): ReplicatedContact? = byMember[uid]
    fun observed(origin: String, heads: List<String>): Boolean {
        val rank = ranks[origin] ?: return false
        if (origin in parentSet(heads)) return true
        val seen = mutableSetOf<String>(); val todo = java.util.ArrayDeque(heads)
        val expanded = java.util.IdentityHashMap<List<String>, Boolean>()
        while (todo.isNotEmpty()) {
            val node = todo.removeLast()
            if (!seen.add(node) || ranks.getValue(node) < rank) continue
            val parents = byId.getValue(node).parents
            if (origin in parentSet(parents)) return true
            if (expanded.put(parents, true) == null) parents.forEach { if (it !in seen && ranks.getValue(it) >= rank) todo.add(it) }
        }
        return false
    }
    fun past(heads: List<String>): Set<String> {
        val seen = mutableSetOf<String>(); val todo = java.util.ArrayDeque(heads)
        val expanded = java.util.IdentityHashMap<List<String>, Boolean>()
        while (todo.isNotEmpty()) {
            val id = todo.removeLast()
            val c = requireNotNull(byId[id]) { "Unknown contact history head." }
            if (seen.add(id) && expanded.put(c.parents, true) == null) todo.addAll(c.parents)
        }
        return seen
    }
    fun missing(heads: List<String>): List<ContactChange> {
        val known = past(heads)
        return changes.filterNot { it.id in known }
    }
    private fun reduce(): Map<String, ReplicatedContact> {
        val roots = mutableMapOf<String, String>()
        fun root(start: String): String {
            roots.putIfAbsent(start, start)
            var uid = start; val trail = mutableListOf<String>()
            while (roots.getValue(uid) != uid) { trail.add(uid); uid = roots.getValue(uid) }
            trail.forEach { roots[it] = uid }
            return uid
        }
        changes.forEach { c ->
            val ids = listOf(c.contact_uid) + c.links
            val r = ids.minOf(::root)
            ids.forEach { roots[root(it)] = r }
        }
        val members = roots.keys.groupBy(::root)
        val scalars = mutableMapOf<String, MutableMap<String, MutableMap<String, JsonElement>>>()
        val additions = mutableMapOf<Pair<String, String>, MutableMap<String, JsonElement>>()
        val removals = mutableSetOf<String>()
        changes.forEach { c ->
            val r = root(c.contact_uid)
            c.values.forEach { (key, value) ->
                val register = scalars.getOrPut(r) { mutableMapOf() }.getOrPut(key) { mutableMapOf() }
                c.replaces[key].orEmpty().forEach { old ->
                    require(observed(old, c.parents) && key in byId.getValue(old).values) { "A contact edit replaces an unobserved value." }
                    register.remove(old)
                }
                register[c.id] = value
            }
            c.adds.forEach { (key, values) -> values.forEachIndexed { i, value -> additions.getOrPut(r to key) { mutableMapOf() }["${c.id}:$key:$i"] = value } }
            c.removes.forEach { (key, tags) -> tags.forEach { tag ->
                require(observed(tag.substringBefore(':'), c.parents) && tag in additions[r to key].orEmpty()) { "A contact edit removes an unobserved addition." }
                removals.add(tag)
            } }
        }
        return members.mapValues { (r, uids) ->
            val values = scalarValues(ContactCard("")).filterKeys { it != "name" }.toMutableMap()
            val conflicts = mutableMapOf<String, List<ContactConflict>>()
            scalars[r].orEmpty().forEach { (key, register) ->
                values[key] = register.getValue(register.keys.max())
                if (register.values.distinct().size > 1) conflicts[key] = register.toSortedMap().map { (id, v) -> ContactConflict(id, v) }
            }
            val tags = lists.associateWith { key -> additions[r to key].orEmpty().filterKeys { it !in removals }.toSortedMap() }
            tags.forEach { (key, entries) -> values[key] = JsonArray(entries.values.distinct()) }
            val trashed = values.remove("_trashed")?.jsonPrimitive?.boolean ?: false
            val isMe = values.remove("_is_me")?.jsonPrimitive?.boolean ?: false
            require("name" in values) { "Contact history references an uncreated contact." }
            val card = json.decodeFromJsonElement<ContactCard>(JsonObject(values))
            card.validate()
            ReplicatedContact(r, uids.sorted(), card, trashed, conflicts, tags, scalars[r].orEmpty(), isMe)
        }
    }
    fun edit(uid: String, card: ContactCard? = null, trashed: Boolean? = null, links: List<String> = emptyList(), values: JsonObject = JsonObject(emptyMap()), id: String = newContactUid()): ContactChange {
        val previous = contact(uid)
        val scalar = values.toMutableMap()
        val adds = mutableMapOf<String, List<JsonElement>>()
        val removes = mutableMapOf<String, List<String>>()
        if (card != null) {
            val before = previous?.card?.let(::scalarValues).orEmpty()
            val defaults = scalarValues(ContactCard(""))
            scalarValues(card).forEach { (key, value) ->
                if (!(previous == null && key != "name" && value == defaults[key] && key !in scalar) && before[key] != value) scalar[key] = value
            }
            val objectCard = cardObject(card)
            lists.forEach { key ->
                val old = previous?.tags?.get(key).orEmpty()
                val wanted = objectCard.getValue(key).jsonArray
                val new = wanted.distinct().filterNot { it in old.values }
                val gone = old.filterValues { it !in wanted }.keys.toList()
                if (new.isNotEmpty()) adds[key] = new
                if (gone.isNotEmpty()) removes[key] = gone
            }
        }
        if (trashed != null && ((previous == null && trashed) || (previous != null && (previous.trashed != trashed || "_trashed" in previous.conflicts)))) scalar["_trashed"] = JsonPrimitive(trashed)
        val scope = (listOf(uid) + links).mapNotNull(::contact).distinctBy { it.uid }
        val replaces = scalar.keys.associateWith { key -> scope.flatMap { it.registers[key].orEmpty().keys }.distinct().sorted() }
        return ContactChange(id, heads, uid, JsonObject(scalar), adds, removes, links, replaces)
    }
    fun plus(changes: List<ContactChange>) = ContactHistory(this.changes + changes, timing)
}

/** Contact identities may be combined, but server-only facts remain a separate projection. */
fun ContactHistory.project(base: Records, localIds: Map<String, Int>): Records {
    val people = base.people.toMutableMap()
    val redirect = mutableMapOf<Int, Int>()
    val grouped = base.people.entries.groupBy { (_, p) -> contact(p.contact_uid)?.uid ?: p.contact_aliases.firstNotNullOfOrNull { contact(it)?.uid } }
    contacts.values.forEach { c ->
        val entries = grouped[c.uid].orEmpty().associate { it.key to it.value }
        if (c.isMe) { entries.keys.forEach(people::remove); return@forEach }
        val target = entries.entries.firstOrNull { it.value.contact_uid == c.uid }?.key
            ?: entries.keys.minOrNull() ?: localIds.getValue(c.uid)
        val all = entries.values.toList()
        val previous = people[target] ?: all.firstOrNull() ?: Person(c.card.name)
        val person = previous.copy(name = c.card.name, contact_uid = c.uid, contact_aliases = c.members.filterNot { it == c.uid }, card = c.card,
            trashed = c.trashed, contact_conflicts = c.conflicts, can_undo_merge = if (c.members.size > 1) false else previous.can_undo_merge,
            aliases = all.flatMap { it.aliases }.distinct(), identifiers = all.flatMap { it.identifiers }.distinct(),
            photo = previous.photo ?: all.firstNotNullOfOrNull { it.photo },
            channels = all.flatMap { it.channels }.groupBy { it.channel }.map { (ch, counts) -> ChannelCount(ch, counts.sumOf { it.count }) })
        entries.keys.forEach { id -> if (id != target) { people.remove(id); redirect[id] = target } }
        people[target] = person
    }
    if (redirect.isEmpty()) return base.copy(people = people)
    return base.copy(people = people,
        events = base.events.mapValues { (_, e) -> redirect[e.person_id]?.let { e.copy(person_id = it) } ?: e },
        profiles = base.profiles.mapValues { (_, e) -> redirect[e.person_id]?.let { e.copy(person_id = it) } ?: e },
        moments = base.moments.mapValues { (_, e) -> redirect[e.person_id]?.let { e.copy(person_id = it) } ?: e },
        dupes = base.dupes.mapValues { (_, d) -> d.copy(person_ids = d.person_ids.map { redirect[it] ?: it }.distinct()) }.filterValues { it.person_ids.size > 1 })
}
