package app.mypeople.data

import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import kotlinx.collections.immutable.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable
data class GraphBundle(val collection: String, val heads: List<String> = emptyList(), val commits: List<GraphCommit> = emptyList(), val blobs: Map<String, String> = emptyMap()) {
    // Disposable reducer cache for this immutable bundle, never backup/replication
    // authority. A copied bundle starts uncached; indexed GraphState copies reuse it.
    @kotlinx.serialization.Transient
    internal var reducer: VersionedGraph? = null
    @kotlinx.serialization.Transient
    internal var blobsVerified: Boolean = false
}

@Serializable
data class GraphState(val bundle: GraphBundle, val peer: String = UUID.randomUUID().toString(), val localIds: Map<String, Int> = emptyMap(), val remoteHeads: List<String> = emptyList())

data class GraphAssociation(val id: String, val kind: String, val label: String, val objectId: String)
data class GraphSelection(val uid: String, val heads: List<String>, val associations: List<GraphAssociation>)

/** Graph is the authority; integer ids exist only for the current native screens. */
class GraphStore(val state: GraphState, private val timing: (String, Long) -> Unit = { _, _ -> }) {
    val graph = run {
        val start = System.nanoTime()
        val result = state.bundle.reducer ?: VersionedGraph(state.bundle.commits).also { state.bundle.reducer = it }
        timing("graph_reduce", (System.nanoTime() - start) / 1_000_000)
        result
    }
    private val components by lazy { graph.components() }
    private val membersByPerson get() = components.membersByPerson
    private fun outgoing(id: String) = graph.outgoing(id).filter { graph.active(it.first) }
    private fun incoming(id: String) = graph.incoming(id).filter { graph.active(it.first) }
    private val preferredPeople by lazy {
        val canonical = components.rootByPerson
        buildMap {
            graph.edgesOfType("same_person").forEach { (id, edge) ->
                val preferred = text(id, "preferred_person")
                if (edge.type == "same_person" && graph.active(id) && preferred in canonical) put(canonical.getValue(preferred), preferred)
            }
        }
    }
    private fun primaryName(uid: String): String? {
        val preferred = preferredPeople[uid] ?: uid
        return associated(uid).filter { it.second.type == "has_name" && graph.active(it.second.to!!) }
            .minWithOrNull(compareBy<Pair<String, GraphEntity>> { it.second.from != preferred }.thenBy { (graph.value(it.first, "preferred") as? JsonPrimitive)?.booleanOrNull != true }.thenBy { text(it.second.to!!, "label") == "alias" }.thenBy { it.second.to })?.second?.to
    }
    init {
        require(UUID.fromString(state.peer).toString() == state.peer)
        require(state.localIds.values.distinct().size == state.localIds.size) { "Invalid local graph identity map" }
        require(state.localIds.keys.all { graph.objects[it]?.type == "Person" }) { "Unknown local graph person" }
        require(UUID.fromString(state.bundle.collection).toString() == state.bundle.collection)
        require(graph.collection == null || graph.collection == state.bundle.collection)
        require(state.bundle.heads.toSet() == graph.heads.toSet()) { "Invalid graph frontier" }
        if (!state.bundle.blobsVerified) {
            val start = System.nanoTime()
            verifyBlobs(state.bundle.blobs, graph.ordered)
            timing("graph_blobs", (System.nanoTime() - start) / 1_000_000)
            state.bundle.blobsVerified = true
        }
    }
    private fun verifyBlobs(blobs: Map<String, String>, commits: List<GraphCommit>, available: Map<String, String> = state.bundle.blobs) {
        val buffer = ByteArray(65536)
        blobs.keys.forEach { hash ->
            require(hash.matches(blobHashPattern))
            require(GraphBlobs.open(blobs, hash).use { GraphBlobs.verifiedHash(it, buffer) } == hash) { "Damaged graph blob" }
        }
        verifyReferences(commits, available.keys)
    }
    companion object {
        private val blobHashPattern = Regex("[0-9a-f]{64}")
        internal fun verifyReferences(commits: List<GraphCommit>, available: Set<String>) {
            fun references(value: JsonElement) {
                when (value) {
                    is JsonObject -> { value["blob_hash"]?.jsonPrimitive?.content?.let { require(it in available) { "Missing graph blob" } }; value.values.forEach(::references) }
                    is JsonArray -> value.forEach(::references)
                    else -> Unit
                }
            }
            commits.forEach { c -> c.operations.forEach { references(it.payload) } }
        }
        fun empty() = GraphState(GraphBundle(UUID.randomUUID().toString()))
        fun digest(bytes: ByteArray): String {
            val alphabet = "0123456789abcdef"
            return buildString(64) { MessageDigest.getInstance("SHA-256").digest(bytes).forEach { byte ->
                val value = byte.toInt() and 255
                append(alphabet[value ushr 4]); append(alphabet[value and 15])
            } }
        }
        fun namespacedId(namespace: String, name: String): String {
            val uuid = UUID.fromString(namespace)
            val buffer = java.nio.ByteBuffer.allocate(16).putLong(uuid.mostSignificantBits).putLong(uuid.leastSignificantBits).array()
            val bytes = MessageDigest.getInstance("SHA-1").digest(buffer + name.toByteArray(Charsets.UTF_8)).copyOf(16)
            bytes[6] = ((bytes[6].toInt() and 0x0f) or 0x50).toByte(); bytes[8] = ((bytes[8].toInt() and 0x3f) or 0x80).toByte()
            val result = java.nio.ByteBuffer.wrap(bytes)
            return UUID(result.long, result.long).toString()
        }
    }
    fun text(id: String, key: String) = (graph.value(id, key) as? JsonPrimitive)?.contentOrNull.orEmpty()
    private fun legacyPhones(uid: String) = (membersByPerson[uid] ?: listOf(uid)).any { member ->
        (graph.value(member, "card_metadata") as? JsonObject)?.get("legacy_unverified") == JsonPrimitive(true) || graph.value(member, "legacy_unverified") == JsonPrimitive(true)
    }
    private fun visiblePoint(uid: String, point: String): Boolean {
        val hint = text(point, "compat_table") == "identifiers" || graph.value(point, "matching_hint") == JsonPrimitive(true)
        return !hint || (legacyPhones(uid) && text(point, "kind") in setOf("phone", "email"))
    }
    fun properties(id: String): JsonObject = JsonObject(graph.propertyNames(id).associateWith { graph.value(id, it)!! })
    private fun decisionsFor(uid: String): List<String> = incoming(uid).filter { (_, e) -> e.type == "targets" && graph.active(e.from!!) }.map { it.second.from!! }
    fun associated(uid: String): List<Pair<String, GraphEntity>> {
        val members = membersByPerson[uid] ?: listOf(uid)
        return members.flatMap { outgoing(it).filter { edge -> edge.second.type in VersionedGraph.attributions && edge.second.type != "participant" } + incoming(it).filter { edge -> edge.second.type == "participant" } }.distinctBy { it.first }.sortedWith(compareBy<Pair<String, GraphEntity>> { (graph.value(it.first, "card_order") as? JsonPrimitive)?.intOrNull ?: 1_000_000 }.thenBy { it.first })
    }
    fun selection(uid: String) = GraphSelection(uid, graph.heads, associated(uid).map { (id, e) ->
        val obj = if (e.type == "participant") e.from!! else e.to!!
        val label = when (graph.objects[obj]?.type) {
            "Name" -> text(obj, "display")
            "ContactPoint" -> "${text(obj, "kind")}: ${text(obj, "value")} ${text(obj, "label")}".trim()
            "Claim" -> "${text(obj, "predicate")}: ${text(obj, "value")}"
            "Note" -> text(obj, "body")
            "InteractionBatch" -> listOf("${text(obj, "count")} messages", text(obj, "channel"), text(obj, "thread").takeIf { it.isNotBlank() }?.let { "Thread: $it" }.orEmpty(), text(obj, "first_at"), text(obj, "last_at")).filter { it.isNotBlank() }.joinToString(" · ")
            "Interaction" -> {
                val conversation = outgoing(obj).firstOrNull { it.second.type == "in_conversation" }?.second?.to
                listOf(text(obj, "channel"), text(obj, "at").ifBlank { text(obj, "timestamp").ifBlank { text(obj, "date") } }, text(obj, "direction"), conversation?.let { "Thread: ${text(it, "external_key")}" }.orEmpty(), text(obj, "text").ifBlank { text(obj, "snippet") }).filter { it.isNotBlank() }.joinToString(" · ")
            }
            else -> properties(obj).toString()
        }
        GraphAssociation(id, e.type, label, obj)
    })
    fun commit(ops: List<GraphOperation>, blobs: Map<String, String> = emptyMap()): GraphState {
        if (ops.isEmpty()) return state
        val c = graph.commit(state.peer, ops, state.bundle.collection)
        val reduced = graph.appended(c)
        val bundle = state.bundle.copy(heads = listOf(c.id), commits = reduced.ordered, blobs = GraphBlobs.merge(state.bundle.blobs, blobs)).also { it.reducer = reduced }
        // This store already validated the immutable base. Only new bytes and
        // references need checking; never rehash every conversation on a card edit.
        verifyBlobs(blobs, listOf(c), bundle.blobs)
        bundle.blobsVerified = true
        return state.copy(bundle = bundle)
    }
    fun receive(bundle: GraphBundle): GraphState {
        require(bundle.collection == state.bundle.collection) { "This graph belongs to another collection. Back up this device before switching." }
        var merged = if (graph.commits.isEmpty()) bundle.reducer ?: graph else graph
        val pending = linkedMapOf<String, GraphCommit>()
        bundle.commits.forEach { c ->
            val known = merged.commits[c.id] ?: pending[c.id]
            require(known == null || known == c) { "Commit UUID reused for different content" }
            if (known == null) pending[c.id] = c
        }
        while (pending.isNotEmpty()) {
            val ready = pending.values.filter { c -> c.parents.all { it in merged.commits } }.sortedBy { it.id }
            require(ready.isNotEmpty()) { "Missing or cyclic graph parents" }
            ready.forEach { c -> merged = merged.received(c); pending.remove(c.id) }
        }
        require(bundle.heads.all { it in merged.commits }) { "Missing remote graph frontier" }
        val past = mutableSetOf<String>()
        val todo = java.util.ArrayDeque(bundle.heads)
        while (todo.isNotEmpty()) {
            val id = todo.removeLast()
            if (past.add(id)) todo.addAll(merged.commits.getValue(id).parents)
        }
        require(bundle.commits.all { it.id in past }) { "Invalid remote graph frontier" }
        val blobs = GraphBlobs.merge(state.bundle.blobs, bundle.blobs)
        verifyBlobs(if (bundle.blobsVerified) emptyMap() else bundle.blobs, bundle.commits, blobs)
        return state.copy(bundle = GraphBundle(bundle.collection, merged.heads, merged.ordered, blobs).also {
            it.reducer = merged; it.blobsVerified = true
        }, remoteHeads = bundle.heads)
    }
    /** Explicit first-pairing bootstrap only. Archive original bytes; never reuse a changed commit UUID. */
    fun rehome(collection: String): GraphState {
        require(state.remoteHeads.isEmpty()) { "An established graph cannot change collection." }
        require(UUID.fromString(collection).toString() == collection)
        if (collection == state.bundle.collection) return state
        val original = VersionedGraph.wire.encodeToString(GraphBundle.serializer(), state.bundle).toByteArray(Charsets.UTF_8)
        val hash = digest(original)
        val renamed = state.bundle.commits.map { c -> c.copy(id = namespacedId(collection, c.id), collection = collection, parents = c.parents.map { namespacedId(collection, it) }) }
        val rebased = state.copy(bundle = GraphBundle(collection, state.bundle.heads.map { namespacedId(collection, it) }, renamed, state.bundle.blobs))
        val archive = VersionedGraph.createObject("SourceRecord", buildJsonObject { put("system", "mypeople-standalone-graph"); put("original_collection", state.bundle.collection); put("original", buildJsonObject { put("blob_hash", hash) }) })
        return GraphStore(rebased).commit(listOf(archive), mapOf(hash to Base64.getEncoder().encodeToString(original)))
    }
    /** Frontier delta for a known peer; full file exports remain self-contained. */
    fun outbound(): GraphBundle {
        val known = mutableSetOf<String>()
        val todo = java.util.ArrayDeque(state.remoteHeads)
        while (todo.isNotEmpty()) {
            val id = todo.removeLast()
            require(id in graph.commits) { "Unknown acknowledged graph frontier" }
            if (known.add(id)) todo.addAll(graph.commits.getValue(id).parents)
        }
        val knownBlobs = mutableSetOf<String>()
        fun references(value: JsonElement) {
            when (value) {
                is JsonObject -> { value["blob_hash"]?.jsonPrimitive?.contentOrNull?.let(knownBlobs::add); value.values.forEach(::references) }
                is JsonArray -> value.forEach(::references)
                else -> Unit
            }
        }
        known.forEach { graph.commits.getValue(it).operations.forEach { op -> references(op.payload) } }
        return state.bundle.copy(commits = graph.ordered.filterNot { it.id in known }, blobs = GraphBlobs.filter(state.bundle.blobs) { it !in knownBlobs })
    }
    fun indexed(): GraphState {
        // Constructor validation established that every mapped UUID is a Person.
        if (state.localIds.size == graph.people.size) return state
        val ids = state.localIds.toMutableMap()
        var next = minOf(-1, (ids.values.minOrNull() ?: 0) - 1)
        graph.people.sorted().forEach { if (it !in ids) ids[it] = next-- }
        return state.copy(localIds = ids)
    }
    fun project(computeDuplicates: Boolean = true, derived: Records = Records(), previous: Records? = null, changedTargets: Set<String>? = null): Records {
        val hints = derived.people.values.flatMap { p -> (listOf(p.contact_uid) + p.contact_aliases).map { it to p } }.toMap()
        val ids = indexed().localIds
        val incremental = previous != null && changedTargets != null
        val roots = if (incremental) changedTargets!!.flatMap { target ->
            // Include inactive edges: removing an attribution must invalidate its
            // old owner too. Shared objects can invalidate more than one person.
            listOfNotNull(components.rootByPerson[target]) + graph.incoming(target).filter { it.second.type in VersionedGraph.attributions }.mapNotNull { components.rootByPerson[it.second.from] }
        }.toSet() else components.groups.keys
        val groups = roots.sorted().associateWith { components.groups.getValue(it) }
        val dirtyIds = roots.map { ids.getValue(it) }.toSet()
        val people = (if (incremental) previous!!.people.toPersistentHashMap() else persistentHashMapOf()).builder()
        val events = persistentHashMapOf<String, Event>().builder()
        val profiles = persistentHashMapOf<String, Profile>().builder()
        val moments = (if (incremental) previous!!.moments.toPersistentHashMap() else persistentHashMapOf()).builder()
        dirtyIds.forEach(people::remove)
        val personIds by lazy { components.rootByPerson.mapValues { (_, root) -> ids.getValue(root) } }
        groups.forEach { (uid, members) ->
            if (members.any { (graph.value(it, "is_me") as? JsonPrimitive)?.booleanOrNull == true }) return@forEach
            val edges = associated(uid)
            val decisions = members.flatMap { incoming(it) }.filter { (_, e) -> e.type == "targets" && graph.active(e.from!!) }.map { it.second.from!! }
            val entities = (members + edges.map { it.first } + edges.map { if (it.second.type == "participant") it.second.from!! else it.second.to!! } + decisions).distinct()
            val pid = ids.getValue(uid)
            fun objects(type: String) = edges.filter { it.second.type == type }.map { it.second.to!! }.filter { graph.active(it) }.distinct()
            val names = objects("has_name"); val claims = objects("subject_of"); val notes = objects("has_note")
            val primary = primaryName(uid)
            val name = primary?.let { text(it, "display") }.orEmpty().ifBlank { "Unnamed contact" }
            val ownerRegions = edges.filter { it.second.type == "has_preferences" }.mapNotNull { (_, e) -> text(e.to!!, "region").takeIf { it.isNotBlank() }?.let { e.from to it } }.toMap()
            val fields = edges.filter { it.second.type == "has_contact_point" && graph.active(it.second.to!!) && visiblePoint(uid, it.second.to!!) }.mapNotNull { (_, e) ->
                runCatching { json.decodeFromJsonElement<ContactField>(properties(e.to!!)).copy(object_id = e.to) }.getOrNull()?.let { field ->
                    if (members.size > 1 && field.kind == "phone" && field.region.isEmpty() && ownerRegions[e.from] != null) field.copy(region = ownerRegions.getValue(e.from)) else field
                }
            }.distinctBy { it.object_id }
            val preferences = objects("has_preferences").map(::properties).fold(JsonObject(emptyMap())) { a, b -> JsonObject(a + b) }
            fun decision(action: String): JsonElement? = decisions.lastOrNull { text(it, "action") == action }?.let { graph.value(it, "value") } ?: preferences[action]
            fun claim(key: String) = claims.firstOrNull { text(it, "predicate") == key }?.let { text(it, "value") }.orEmpty()
            val photoHash = objects("has_asset").firstNotNullOfOrNull { asset -> (graph.value(asset, "content") as? JsonObject)?.text("blob_hash")?.takeIf { it in state.bundle.blobs } }.orEmpty()
            val card = ContactCard(name, given = primary?.let { text(it, "given") }.orEmpty(), family = primary?.let { text(it, "family") }.orEmpty(), middle = primary?.let { text(it, "middle") }.orEmpty(), prefix = primary?.let { text(it, "prefix") }.orEmpty(), suffix = primary?.let { text(it, "suffix") }.orEmpty(), phonetic = primary?.let { text(it, "phonetic") }.orEmpty(), fields = fields, birthday = claim("birthday"), organization = claim("organization"), title = claim("title"), notes = notes.filter { text(it, "origin") in setOf("contact_card_notes", "legacy_card_notes") }.joinToString("\n\n") { text(it, "body") }, photo_hash = photoHash,
                favorite = (decision("favorite") as? JsonPrimitive)?.booleanOrNull ?: false, preferred_channel = (decision("preferred_channel") as? JsonPrimitive)?.contentOrNull.orEmpty(), region = (decision("region") as? JsonPrimitive)?.contentOrNull ?: "US", user_edited = members.any { (graph.value(it, "card_metadata") as? JsonObject)?.get("user_edited") == JsonPrimitive(true) }, legacy_unverified = legacyPhones(uid),
                originals = members.flatMap { ((graph.value(it, "originals") ?: (graph.value(it, "card_metadata") as? JsonObject)?.get("originals")) as? JsonArray).orEmpty().map { v -> v.jsonPrimitive.content } }.distinct(), source_records = members.flatMap { ((graph.value(it, "source_records") ?: (graph.value(it, "card_metadata") as? JsonObject)?.get("source_records")) as? JsonArray).orEmpty().map { v -> v.jsonPrimitive.content } }.distinct())
            val prefs = preferences
            val hint = members.firstNotNullOfOrNull { hints[it] }
            val interactions = edges.filter { it.second.type == "participant" && graph.active(it.second.from!!) }.map { it.second.from!! }.distinct()
            fun interactionTime(obj: String, end: Boolean) = if (graph.objects[obj]?.type == "InteractionBatch") text(obj, if (end) "last_at" else "first_at") else text(obj, "at").ifBlank { text(obj, "timestamp").ifBlank { text(obj, "date") } }
            fun interactionCount(obj: String) = if (graph.objects[obj]?.type == "InteractionBatch") (graph.value(obj, "count") as? JsonPrimitive)?.intOrNull ?: 0 else 1
            val firstContact = interactions.map { interactionTime(it, false) }.filter { it.isNotBlank() }.minOrNull()
            val lastContact = interactions.map { interactionTime(it, true) }.filter { it.isNotBlank() }.maxOrNull()
            val conflicts = mutableMapOf<String, List<ContactConflict>>()
            entities.forEach { entity ->
                (graph.propertyNames(entity) + "_lifecycle").filter { graph.conflicted(entity, it) }.forEach { property ->
                    conflicts["$entity/$property"] = graph.alternatives(entity, property).map { ContactConflict(it.operation, it.value) }
                }
                if (graph.deletionConflicts(entity).isNotEmpty()) {
                    conflicts["$entity/_lifecycle"] = graph.deletionConflicts(entity).map { alternative ->
                        val value = alternative.value.jsonObject
                        ContactConflict(alternative.operation, if (value.text("property") == "_lifecycle") value.getValue("value") else JsonPrimitive("active"))
                    }.distinctBy { it.value }
                }
            }
            components.contradictions.filter { contradiction -> graph.edges[contradiction]?.from in members }.forEach { contradiction ->
                conflicts["$contradiction/_lifecycle"] = listOf(ContactConflict("retract:$contradiction", JsonPrimitive("retracted")))
            }
            people[pid] = Person(name, uid, members.filterNot { it == uid }, card, photo = photoHash.ifEmpty { null }, trashed = members.none { graph.active(it) }, can_undo_merge = members.size > 1, contact_conflicts = conflicts,
                aliases = names.filterNot { it == primary }.map { text(it, "display") }.distinct(), identifiers = objects("has_contact_point").mapNotNull { obj ->
                    val kind = text(obj, "kind"); val value = text(obj, "value")
                    if (kind.isBlank() || kind == "google" || value.isBlank()) null else Identifier(kind, value)
                }.distinct(),
                category = prefs.text("category").ifBlank { hint?.category ?: "unknown" }, closeness = prefs["closeness"]?.jsonPrimitive?.doubleOrNull ?: hint?.closeness ?: 0.0, cadence_days = prefs["cadence_days"]?.jsonPrimitive?.doubleOrNull ?: hint?.cadence_days, muted = prefs["muted"]?.jsonPrimitive?.takeUnless { it == JsonNull }?.let { it.booleanOrNull ?: (it.intOrNull == 1) } ?: hint?.muted ?: false,
                trend = hint?.trend ?: "none", days_365 = hint?.days_365 ?: 0,
                channels = interactions.groupBy { text(it, "channel") }.map { ChannelCount(it.key, it.value.sumOf(::interactionCount)) }, first_contact = firstContact, last_contact = lastContact)
            (claims + notes).forEach memory@{ obj ->
                val p = properties(obj); val predicate = p.text("predicate")
                val reviews = incoming(obj).filter { (_, e) -> e.type == "targets" && graph.active(e.from!!) }.map { text(it.second.from!!, "action") }
                if (predicate != "public_profile" && (p.text("status") in setOf("rejected", "forgotten") || reviews.any { it in setOf("reject", "rejected", "forget", "forgotten") })) return@memory
                if (predicate == "public_profile") {
                    val statuses = incoming(obj).filter { (_, e) -> e.type == "targets" && graph.active(e.from!!) }.map { text(it.second.from!!, "action") }.filter { it in setOf("confirmed", "rejected", "suggested") }
                    profiles[obj] = Profile(pid, p.text("site"), p.text("url").ifBlank { p.text("value") }, p.text("title"), statuses.lastOrNull() ?: p.text("status").ifBlank { "suggested" }, p.text("assessment").ifBlank { "possible" }, p.text("reason"), p["confidence"]?.jsonPrimitive?.doubleOrNull ?: 0.0)
                } else {
                    val evidence = outgoing(obj).firstOrNull { it.second.type == "supported_by" }?.second?.to?.let { text(it, "quote") }
                    events[obj] = Event(pid, if (obj in notes) "note" else predicate.ifBlank { p.text("type") }, if (obj in notes) p.text("body").ifBlank { p.text("value") } else p.text("value"), p.text("date"), p["confidence"]?.jsonPrimitive?.doubleOrNull ?: 1.0, p.text("source").ifBlank { "manual" }, evidence ?: p.text("evidence").ifBlank { null }, p.text("said_at").ifBlank { null }, p.text("created_at"))
                }
            }
        }
        if (incremental) {
            // A shared memory object keeps the full projection's owner when that
            // owner's component did not change (full projection is root-ordered).
            events.putAll(previous!!.events.filterValues { it.person_id !in dirtyIds })
            profiles.putAll(previous.profiles.filterValues { it.person_id !in dirtyIds })
        }
        if (!incremental) graph.edgesOfType("about").forEach { (id, e) -> if (graph.active(id) && graph.objects[e.from]?.type == "Moment" && graph.active(e.from!!)) {
            val pid = personIds[e.to] ?: return@forEach; val p = properties(e.from)
            moments[e.from] = Moment(pid, p.text("kind"), p.text("reason"), p.text("context").ifBlank { null }, p["score"]?.jsonPrimitive?.doubleOrNull ?: 0.0, p.text("surfaced_on"), p.text("status").ifBlank { "new" })
        } }
        val records = Records(people.build(), events.build(), profiles.build(), moments.build())
        val distinct = graph.edgesOfType("distinct_person").filter { (id, _) -> graph.active(id) }.mapNotNull { (_, e) ->
            val a = personIds[e.from]; val b = personIds[e.to]
            if (a != null && b != null) setOf(a, b) else null
        }
        val oldIndex = if (incremental) previous!!.duplicateIndex else null
        val index = (oldIndex ?: GraphDuplicateIndex()).updated(records.people, if (oldIndex == null) records.people.keys else dirtyIds)
        val dupes = if (computeDuplicates || (incremental && index !== oldIndex)) index.groups(distinct) else previous?.dupes.orEmpty()
        return records.copy(dupes = dupes).also { it.duplicateIndex = index }
    }

    fun saveCard(uid: String, card: ContactCard, restore: Boolean = false): GraphState {
        val ops = mutableListOf<GraphOperation>(); val blobs = mutableMapOf<String, String>()
        if (uid !in graph.objects) ops += VersionedGraph.createObject("Person", target = uid)
        else if (restore) ops += graph.edit(uid, "_lifecycle", JsonPrimitive("active"))
        fun attach(type: String, edge: String, props: JsonObject) { val obj = VersionedGraph.createObject(type, props); ops += obj; ops += VersionedGraph.createEdge(edge, uid, obj.target) }
        val edges = if (uid in graph.objects) associated(uid) else emptyList()
        fun update(obj: String, key: String, value: JsonElement) {
            // An unrelated edit must not implicitly resolve a concurrent register conflict.
            val previous = graph.value(obj, key)
            val absentDefault = previous == null && (value == JsonPrimitive("") || value == JsonPrimitive(false) || value == JsonArray(emptyList()))
            if (!absentDefault && previous != value) ops += graph.edit(obj, key, value)
        }
        fun editable(type: String, predicate: (String) -> Boolean = { true }) = edges.filter { it.second.type == type && graph.active(it.second.to!!) && predicate(it.second.to!!) }
        val names = editable("has_name") { text(it, "label") != "alias" }
        val nameProps = buildJsonObject { put("display", card.name); put("given", card.given); put("family", card.family); put("middle", card.middle); put("prefix", card.prefix); put("suffix", card.suffix); put("phonetic", card.phonetic) }
        if (names.isEmpty()) attach("Name", "has_name", nameProps)
        else nameProps.forEach { (k, v) -> update(primaryName(uid) ?: names.first().second.to!!, k, v) }
        val points = editable("has_contact_point") { visiblePoint(uid, it) }
        val oldFields = points.mapNotNull { (edge, e) -> runCatching { edge to json.decodeFromJsonElement<ContactField>(properties(e.to!!)).copy(object_id = e.to) }.getOrNull() }
        val explicit = card.fields.map { it.object_id }.filter { it.isNotEmpty() }.toSet()
        require(explicit.all { id -> points.any { it.second.to == id } }) { "A contact point changed ownership. Reopen the contact; your draft was not applied." }
        fun sameField(a: ContactField, b: ContactField) = a.copy(object_id = "") == b.copy(object_id = "")
        oldFields.filter { (_, old) -> old.object_id !in explicit && card.fields.none { it.object_id.isEmpty() && sameField(it, old) } }.forEach { ops += graph.edit(it.first, "_lifecycle", JsonPrimitive("retracted")) }
        card.fields.forEach { field ->
            val props = JsonObject(VersionedGraph.wire.encodeToJsonElement(field.copy(object_id = "")).jsonObject + ("user_added" to JsonPrimitive(field.user_added)))
            if (field.object_id.isNotEmpty()) {
                props.forEach { (key, value) -> update(field.object_id, key, value) }
                if (!card.legacy_unverified && text(field.object_id, "compat_table") == "identifiers") {
                    update(field.object_id, "compat_table", JsonNull)
                    update(field.object_id, "matching_hint", JsonPrimitive(false))
                }
            } else if (oldFields.none { sameField(it.second, field) }) attach("ContactPoint", "has_contact_point", props)
        }
        val oldNotes = editable("has_note") { text(it, "origin") in setOf("contact_card_notes", "legacy_card_notes") }
        val combinedNotes = oldNotes.joinToString("\n\n") { text(it.second.to!!, "body") }
        if (combinedNotes != card.notes) {
            if (oldNotes.size == 1 && card.notes.isNotBlank()) update(oldNotes.single().second.to!!, "body", JsonPrimitive(card.notes))
            else {
                oldNotes.forEach { ops += graph.edit(it.first, "_lifecycle", JsonPrimitive("retracted")) }
                if (card.notes.isNotBlank()) attach("Note", "has_note", buildJsonObject { put("body", card.notes); put("origin", "contact_card_notes"); put("source", "manual") })
            }
        }
        mapOf("birthday" to card.birthday, "organization" to card.organization, "title" to card.title).forEach { (k, v) ->
            val old = editable("subject_of") { text(it, "predicate") == k }
            if (v.isBlank()) old.forEach { ops += graph.edit(it.first, "_lifecycle", JsonPrimitive("retracted")) }
            else if (old.isNotEmpty()) update(old.first().second.to!!, "value", JsonPrimitive(v))
            else attach("Claim", "subject_of", buildJsonObject { put("predicate", k); put("value", v); put("asserted_by", "contact_card"); put("source", "manual") })
        }
        val oldAssets = editable("has_asset")
        val oldPhotoHash = oldAssets.firstNotNullOfOrNull { (_, e) -> (graph.value(e.to!!, "content") as? JsonObject)?.text("blob_hash") }.orEmpty()
        require(card.photo_hash.isEmpty() || card.photo_hash == oldPhotoHash) { "Photo changed while editing. Reopen the contact; the draft was not applied." }
        val nextPhotoHash = if (card.photo.isNotEmpty()) digest(Base64.getDecoder().decode(card.photo)) else card.photo_hash
        if (oldPhotoHash != nextPhotoHash) {
            oldAssets.forEach { ops += graph.edit(it.first, "_lifecycle", JsonPrimitive("retracted")) }
            if (card.photo.isNotEmpty()) {
                val hash = digest(Base64.getDecoder().decode(card.photo)); blobs[hash] = card.photo
                attach("Asset", "has_asset", buildJsonObject { put("role", "contact_photo"); put("content", buildJsonObject { put("blob_hash", hash) }) })
            }
        }
        if (uid in graph.objects) {
            update(uid, "originals", json.encodeToJsonElement(card.originals)); update(uid, "source_records", json.encodeToJsonElement(card.source_records))
            val metadata = (graph.value(uid, "card_metadata") as? JsonObject).orEmpty()
            update(uid, "card_metadata", JsonObject(metadata + mapOf("originals" to json.encodeToJsonElement(card.originals), "source_records" to json.encodeToJsonElement(card.source_records), "user_edited" to JsonPrimitive(true), "legacy_unverified" to JsonPrimitive(card.legacy_unverified))))
        } else {
            // Initial person properties cannot be edited until its creation is in a commit; retain originals there.
            ops[0] = ops[0].copy(payload = buildJsonObject { put("type", "Person"); put("properties", buildJsonObject { put("originals", json.encodeToJsonElement(card.originals)); put("source_records", json.encodeToJsonElement(card.source_records)); put("card_metadata", buildJsonObject { put("originals", json.encodeToJsonElement(card.originals)); put("source_records", json.encodeToJsonElement(card.source_records)); put("user_edited", true); put("legacy_unverified", card.legacy_unverified) }) }) })
        }
        val settings = buildJsonObject { put("origin", "contact_card"); put("favorite", card.favorite); put("preferred_channel", card.preferred_channel); put("region", card.region) }
        val oldSettings = editable("has_preferences") { text(it, "origin") == "contact_card" }.lastOrNull()?.second?.to
        if (oldSettings == null) attach("RelationshipPreferences", "has_preferences", settings)
        else settings.forEach { (key, value) -> update(oldSettings, key, value) }
        // Foundation-era Decision settings are retained but explicitly superseded.
        decisionsFor(uid).filter { text(it, "action") in setOf("favorite", "preferred_channel", "region") }.forEach { decision ->
            val action = text(decision, "action")
            if (graph.value(decision, "value") != settings[action]) ops += graph.edit(decision, "_lifecycle", JsonPrimitive("retracted"))
        }
        return commit(ops, blobs)
    }

    fun mutate(kind: String, p: JsonObject, records: Records = project()): GraphState {
        val uid = records.people.values.firstOrNull { it.contact_uid == p.text("contact_uid") || p.text("contact_uid") in it.contact_aliases }?.contact_uid ?: records.people[p.int("person_id")]?.contact_uid
        val ops = mutableListOf<GraphOperation>()
        fun person() = requireNotNull(uid) { "This contact is no longer available" }
        fun attach(type: String, edge: String, props: JsonObject) { val obj = VersionedGraph.createObject(type, props); ops += obj; ops += VersionedGraph.createEdge(edge, person(), obj.target) }
        fun set(id: String, key: String, value: JsonElement) { ops += graph.edit(id, key, value) }
        when (kind) {
            "contact_save" -> return saveCard(p.text("contact_uid").ifBlank { uid ?: UUID.randomUUID().toString() }, json.decodeFromJsonElement(p.getValue("card")))
            "rename" -> return saveCard(person(), records.people.values.first { it.contact_uid == uid }.contactCard().copy(name = p.text("name")))
            "contact_trash", "contact_restore" -> {
                val members = graph.components().groups.values.first { person() in it }
                members.forEach { set(it, "_lifecycle", JsonPrimitive(if (kind == "contact_trash") "trashed" else "active")) }
            }
            "note" -> { require(p.text("text").isNotBlank()); attach("Note", "has_note", buildJsonObject { put("body", p.text("text").trim()); put("source", "manual"); put("created_at", java.time.Instant.now().toString()) }) }
            "event_add" -> attach("Claim", "subject_of", JsonObject(p.filterKeys { it !in setOf("person_id", "contact_uid") } + mapOf("predicate" to JsonPrimitive(p.text("type")), "source" to JsonPrimitive("manual"), "created_at" to JsonPrimitive(java.time.Instant.now().toString()))))
            "event_forget" -> {
                val selected = p.text("event_id").takeIf { it in graph.objects }?.let(::listOf) ?: records.events.filter { (_, e) -> e.person_id == records.people.entries.firstOrNull { it.value.contact_uid == uid }?.key && e.type == p.text("type") && e.value == p.text("value") && e.date == normalizeDate(p.text("date")) }.keys.toList()
                require(selected.isNotEmpty()) { "This fact changed. Reopen it." }; selected.forEach { set(it, "_lifecycle", JsonPrimitive("retracted")) }
            }
            "alias_add" -> attach("Name", "has_name", buildJsonObject { put("display", p.text("alias")); put("label", "alias") })
            "alias_remove" -> associated(person()).filter { it.second.type == "has_name" && text(it.second.to!!, "display").equals(p.text("alias"), true) }.forEach { set(it.first, "_lifecycle", JsonPrimitive("retracted")) }
            "relationship" -> {
                val prefs = associated(person()).filter { it.second.type == "has_preferences" && text(it.second.to!!, "origin") != "contact_card" }.map { it.second.to!! }.lastOrNull()
                if (prefs == null) attach("RelationshipPreferences", "has_preferences", JsonObject(p.filterKeys { it in setOf("category", "closeness", "cadence_days", "muted") }))
                else p.filterKeys { it in setOf("category", "closeness", "cadence_days", "muted") }.forEach { (k, v) -> set(prefs, k, v) }
            }
            "profile_status" -> {
                val obj = p.text("profile_id"); require(obj in graph.objects) { "Reopen this profile before reviewing" }
                graph.edges.filter { (id, e) -> e.type == "targets" && e.to == obj && graph.active(id) && graph.active(e.from!!) && text(e.from, "action") in setOf("confirmed", "suggested", "rejected") }.values.forEach { set(it.from!!, "_lifecycle", JsonPrimitive("retracted")) }
                val d = VersionedGraph.createObject("Decision", buildJsonObject { put("action", p.text("status")) }); ops += d; ops += VersionedGraph.createEdge("targets", d.target, obj)
            }
            "moment_status" -> set(p.text("key"), "status", JsonPrimitive(p.text("status")))
            "merge", "distinct" -> {
                val people = mergePeople(p, records).map { records.people.getValue(it).contact_uid }
                if (kind == "merge") {
                    val members = graph.components().groups.values.filter { group -> people.any { it in group } }.flatten().toSet()
                    graph.edges.filter { (id, e) -> e.type == "distinct_person" && graph.active(id) && e.from in members && e.to in members }.keys.forEach { set(it, "_lifecycle", JsonPrimitive("retracted")) }
                }
                val preferred = people.maxWith(compareBy<String> { target -> records.people.values.first { it.contact_uid == target }.channels.sumOf { it.count } }.thenBy { it })
                people.drop(1).forEach { ops += VersionedGraph.createEdge(if (kind == "merge") "same_person" else "distinct_person", people.first(), it, if (kind == "merge") buildJsonObject { put("preferred_person", preferred) } else JsonObject(emptyMap())) }
            }
            "merge_undo" -> {
                val members = graph.components().groups.values.first { person() in it }.toSet()
                graph.edges.filter { (id, e) -> e.type == "same_person" && graph.active(id) && e.from in members && e.to in members }.keys.forEach { set(it, "_lifecycle", JsonPrimitive("retracted")) }
                require(ops.isNotEmpty()) { "No active merge assertion remains" }
            }
            else -> throw EditRejected("This legacy request needs the Mac. It has not been discarded.")
        }
        return commit(ops)
    }
}
