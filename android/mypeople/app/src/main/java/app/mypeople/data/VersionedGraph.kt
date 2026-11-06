package app.mypeople.data

import java.time.OffsetDateTime
import java.util.PriorityQueue
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** Validated, immutable graph authority shared by storage, editors and transport. */
@Serializable
data class GraphOperation(
    val id: String,
    val kind: String,
    val target: String,
    val payload: JsonObject,
    val replaces: List<String>,
)

@Serializable
data class GraphCommit(
    val id: String,
    val collection: String,
    val peer: String,
    val recorded_at: String,
    val version: Int,
    val parents: List<String>,
    val operations: List<GraphOperation>,
)

data class GraphEntity(val type: String, val from: String? = null, val to: String? = null)
data class GraphAlternative(val operation: String, val value: JsonElement)
data class GraphSplit(val person: String, val operations: List<GraphOperation>, val review: List<String>)
data class GraphComponents(val groups: Map<String, List<String>>, val contradictions: List<String>)

class VersionedGraph private constructor(input: List<GraphCommit>, base: VersionedGraph?) {
    constructor(input: List<GraphCommit> = emptyList()) : this(input, null)
    companion object {
        val wire = Json { encodeDefaults = true; ignoreUnknownKeys = false }
        val objectTypes = setOf("Person", "Name", "ContactPoint", "Note", "Claim", "SourceRecord", "Evidence", "Interaction", "InteractionBatch", "Conversation", "Asset", "Relationship", "RelationshipPreferences", "Decision", "ProcessingRun", "Moment")
        private val person = setOf("Person")
        val edgeTypes: Map<String, Pair<Set<String>?, Set<String>?>> = mapOf(
            "has_name" to (person to setOf("Name")),
            "has_contact_point" to (person to setOf("ContactPoint")),
            "has_note" to (person to setOf("Note")),
            "subject_of" to (person to setOf("Claim")),
            "has_asset" to (person to setOf("Asset")),
            "has_preferences" to (person to setOf("RelationshipPreferences")),
            "same_person" to (person to person), "distinct_person" to (person to person),
            "participant" to (setOf("Interaction", "InteractionBatch", "Relationship") to person),
            "in_conversation" to (setOf("Interaction", "InteractionBatch") to setOf("Conversation")),
            "drawn_from" to (setOf("Evidence") to setOf("SourceRecord", "Interaction", "InteractionBatch", "Note")),
            "supported_by" to (setOf("Claim") to setOf("Evidence")),
            "contradicted_by" to (setOf("Claim") to setOf("Evidence")),
            "originated_from" to (null to setOf("SourceRecord")),
            "generated_by" to (null to setOf("ProcessingRun")),
            "targets" to (setOf("Decision") to null),
            "about" to (setOf("Moment") to setOf("Person", "Claim")),
        )
        val attributions = setOf("has_name", "has_contact_point", "has_note", "subject_of", "has_asset", "has_preferences", "participant")
        private fun id() = UUID.randomUUID().toString()
        private fun uuid(value: String) { require(UUID.fromString(value).toString() == value) { "Expected a canonical UUID" } }
        private fun string(value: JsonElement?): String {
            require(value is JsonPrimitive && value.isString) { "Expected a string" }
            return value.content
        }
        private fun validateJson(value: JsonElement, depth: Int = 0) {
            require(depth <= 100) { "JSON nesting exceeds supported depth" }
            when (value) {
                is JsonObject -> value.values.forEach { validateJson(it, depth + 1) }
                is JsonArray -> value.forEach { validateJson(it, depth + 1) }
                is JsonPrimitive -> if (!value.isString && value != JsonNull && value.booleanOrNull == null) {
                    require(value.content.matches(Regex("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")) && value.doubleOrNull?.isFinite() == true) { "Expected finite JSON values" }
                }
            }
        }
        private fun properties(value: JsonElement?): JsonObject {
            require(value is JsonObject && value.keys.all { it.isNotEmpty() && !it.startsWith('_') }) { "Invalid properties" }
            return value
        }
        fun createObject(type: String, properties: JsonObject = JsonObject(emptyMap()), target: String = id()) = GraphOperation(id(), "create_object", target, buildJsonObject { put("type", type); put("properties", properties) }, emptyList())
        fun createEdge(type: String, from: String, to: String, properties: JsonObject = JsonObject(emptyMap())) = GraphOperation(id(), "create_edge", id(), buildJsonObject { put("type", type); put("from", from); put("to", to); put("properties", properties) }, emptyList())
    }

    val commits: Map<String, GraphCommit>
    val ordered: List<GraphCommit>
    val heads: List<String>
    val collection: String?
    private val mutableObjects = mutableMapOf<String, GraphEntity>()
    private val mutableEdges = mutableMapOf<String, GraphEntity>()
    val objects: Map<String, GraphEntity> = java.util.Collections.unmodifiableMap(mutableObjects)
    val edges: Map<String, GraphEntity> = java.util.Collections.unmodifiableMap(mutableEdges)
    private val versions = mutableMapOf<Pair<String, String>, MutableMap<String, JsonElement>>()
    private val propertyIndex = mutableMapOf<String, MutableSet<String>>()
    private val operations = mutableMapOf<String, GraphOperation>()
    private val origins = mutableMapOf<String, String>()
    private val creation = mutableMapOf<String, String>()

    init {
        if (base != null) {
            // Local writes descend from the complete current frontier. Share the
            // immutable history/JSON values and copy only touched register maps.
            val c = input.single()
            listOf(c.id, c.collection, c.peer).forEach(::uuid)
            require(c.id !in base.commits && c.version == 1 && c.operations.isNotEmpty())
            require(c.parents == base.heads && (base.collection == null || c.collection == base.collection))
            OffsetDateTime.parse(c.recorded_at)
            c.operations.forEach { validateJson(it.payload, 3) }
            require(base.commits.size < 100_000 && base.operations.size.toLong() + c.operations.size <= 1_000_000)
            commits = base.commits + (c.id to c)
            ordered = base.ordered + c
            heads = listOf(c.id)
            collection = c.collection
            mutableObjects.putAll(base.mutableObjects); mutableEdges.putAll(base.mutableEdges)
            versions.putAll(base.versions); propertyIndex.putAll(base.propertyIndex)
            operations.putAll(base.operations); origins.putAll(base.origins); creation.putAll(base.creation)
            c.operations.map { it.target }.distinct().forEach { target ->
                propertyIndex[target] = base.propertyIndex[target].orEmpty().toMutableSet()
            }
            c.operations.forEach { op ->
                val property = when (op.kind) {
                    "set_property" -> (op.payload["property"] as? JsonPrimitive)?.content
                    "set_lifecycle" -> "_lifecycle"
                    else -> null
                }
                if (property != null) versions[op.target to property] = base.versions[op.target to property].orEmpty().toMutableMap()
            }
            c.operations.forEach { apply(c.id, it) }
        } else {
        val index = mutableMapOf<String, GraphCommit>()
        input.forEach { c ->
            // Validate payload trees in place. Encoding a bootstrap commit into a
            // second JsonElement tree can exhaust a phone heap before reduction.
            c.operations.forEach { validateJson(it.payload, 3) }
            listOf(c.id, c.collection, c.peer).forEach(::uuid)
            require(c.version == 1) { "Unsupported graph version" }
            OffsetDateTime.parse(c.recorded_at)
            require(c.parents.size <= 100_000 && c.parents.distinct().size == c.parents.size) { "Invalid commit parents" }
            c.parents.forEach(::uuid)
            require(c.operations.isNotEmpty()) { "A commit needs operations" }
            require(index[c.id] == null || index[c.id] == c) { "Commit UUID reused for different content" }
            index[c.id] = c
        }
        require(index.size <= 100_000 && index.values.sumOf { it.operations.size.toLong() } <= 1_000_000) { "Graph exceeds supported history size" }
        require(index.values.map { it.collection }.distinct().size <= 1) { "Cannot join different collections" }
        commits = index.toMap()
        collection = index.values.firstOrNull()?.collection
        val children = mutableMapOf<String, MutableList<String>>()
        val pending = index.mapValues { it.value.parents.size }.toMutableMap()
        index.values.forEach { c -> c.parents.forEach { parent ->
            require(parent in index) { "Missing commit parent" }
            children.getOrPut(parent) { mutableListOf() }.add(c.id)
        } }
        val ready = PriorityQueue<String>()
        pending.filterValues { it == 0 }.keys.forEach(ready::add)
        val sorted = mutableListOf<GraphCommit>()
        while (ready.isNotEmpty()) {
            val key = ready.remove()
            sorted.add(index.getValue(key))
            children[key].orEmpty().forEach { child ->
                pending[child] = pending.getValue(child) - 1
                if (pending[child] == 0) ready.add(child)
            }
        }
        require(sorted.size == index.size) { "Cyclic commit history" }
        ordered = sorted
        heads = (index.keys - children.keys).sorted()
        ordered.forEach { c -> c.operations.forEach { apply(c.id, it) } }
        }
    }

    fun appended(commit: GraphCommit): VersionedGraph = VersionedGraph(listOf(commit), this)

    fun observed(origin: String, commit: String): Boolean {
        if (origin == commit) return true
        val todo = java.util.ArrayDeque(commits.getValue(commit).parents)
        val seen = mutableSetOf<String>()
        while (todo.isNotEmpty()) {
            val key = todo.removeLast()
            if (key == origin) return true
            if (seen.add(key)) todo.addAll(commits.getValue(key).parents)
        }
        return false
    }

    private fun requireEntity(target: String, commit: String) {
        require(creation[target]?.let { observed(it, commit) } == true) { "Operation references an unobserved entity" }
    }

    private fun apply(commit: String, op: GraphOperation) {
        uuid(op.id); uuid(op.target); op.replaces.forEach(::uuid)
        require(op.id !in operations) { "Operation UUID reused" }
        require(op.replaces.distinct().size == op.replaces.size) { "Duplicate replacement" }
        val p = op.payload
        val values: Map<String, JsonElement>
        when (op.kind) {
            "create_object", "create_edge" -> {
                require(op.target !in creation && op.replaces.isEmpty()) { "Entity identity cannot be recreated" }
                val objectCreation = op.kind == "create_object"
                require(p.keys == if (objectCreation) setOf("type", "properties") else setOf("type", "from", "to", "properties")) { "Invalid entity creation" }
                val type = string(p["type"])
                val props = properties(p["properties"])
                if (objectCreation) {
                    require(type in objectTypes) { "Unknown object type" }
                    mutableObjects[op.target] = GraphEntity(type)
                } else {
                    val allowed = requireNotNull(edgeTypes[type]) { "Unknown edge type" }
                    val from = string(p["from"]); val to = string(p["to"])
                    listOf(from, to).forEach { uuid(it); requireEntity(it, commit) }
                    require((allowed.first == null || mutableObjects[from]?.type in allowed.first!!) && (allowed.second == null || mutableObjects[to]?.type in allowed.second!!)) { "Invalid edge endpoint type" }
                    require(type !in setOf("same_person", "distinct_person") || from != to) { "Identity assertions need two people" }
                    mutableEdges[op.target] = GraphEntity(type, from, to)
                }
                creation[op.target] = commit
                values = props + ("_lifecycle" to JsonPrimitive("active"))
            }
            "set_property", "set_lifecycle" -> {
                requireEntity(op.target, commit)
                val prop: String
                if (op.kind == "set_property") {
                    require(p.keys == setOf("property", "value")) { "Invalid property edit" }
                    prop = string(p["property"])
                    properties(JsonObject(mapOf(prop to p.getValue("value"))))
                } else {
                    require(p.keys == setOf("value") && string(p["value"]) in setOf("active", "trashed", "retracted")) { "Invalid lifecycle" }
                    prop = "_lifecycle"
                }
                op.replaces.forEach { old ->
                    val earlier = operations[old]
                    require(earlier != null && observed(origins.getValue(old), commit)) { "Edit replaces an unobserved version" }
                    val matches = when (earlier.kind) {
                        "create_object", "create_edge" -> prop == "_lifecycle" || prop in earlier.payload.getValue("properties").jsonObject
                        "set_lifecycle" -> prop == "_lifecycle"
                        "set_property" -> string(earlier.payload["property"]) == prop
                        else -> false
                    }
                    require(earlier.target == op.target && matches) { "Replacement targets another property" }
                    versions[op.target to prop]?.remove(old)
                }
                values = mapOf(prop to p.getValue("value"))
            }
            else -> error("Unknown operation kind")
        }
        operations[op.id] = op; origins[op.id] = commit
        values.forEach { (prop, value) ->
            versions.getOrPut(op.target to prop) { mutableMapOf() }[op.id] = value
            propertyIndex.getOrPut(op.target) { mutableSetOf() }.add(prop)
        }
    }

    fun propertyNames(target: String): Set<String> = propertyIndex[target].orEmpty() - "_lifecycle"
    fun alternatives(target: String, property: String) = versions[target to property].orEmpty().toSortedMap().map { (id, value) -> GraphAlternative(id, value) }
    fun value(target: String, property: String): JsonElement? {
        val register = versions[target to property] ?: return null
        if (register.size == 1) return register.values.first()
        return register.keys.maxOrNull()?.let(register::get)
    }
    fun conflicted(target: String, property: String): Boolean {
        val register = versions[target to property] ?: return false
        return register.size > 1 && register.values.distinct().size > 1
    }
    fun deletionConflicts(target: String): List<GraphAlternative> {
        val conflicts = mutableMapOf<String, JsonElement>()
        versions[target to "_lifecycle"].orEmpty().forEach { (lifecycle, state) ->
            if (state != JsonPrimitive("active")) {
                val deletion = origins.getValue(lifecycle)
                versions.filterKeys { it.first == target && it.second != "_lifecycle" }.forEach { (key, alternatives) ->
                    alternatives.forEach { (operation, value) ->
                        val edit = origins.getValue(operation)
                        if (!observed(deletion, edit) && !observed(edit, deletion)) {
                            conflicts[lifecycle] = buildJsonObject { put("property", "_lifecycle"); put("value", state) }
                            conflicts[operation] = buildJsonObject { put("property", key.second); put("value", value) }
                        }
                    }
                }
            }
        }
        return conflicts.toSortedMap().map { (id, value) -> GraphAlternative(id, value) }
    }
    fun active(target: String) = !conflicted(target, "_lifecycle") && value(target, "_lifecycle") == JsonPrimitive("active")
    fun edit(target: String, property: String, value: JsonElement, replaces: List<String>? = null): GraphOperation {
        require(target in creation) { "Unknown entity" }
        val lifecycle = property == "_lifecycle"
        return GraphOperation(id(), if (lifecycle) "set_lifecycle" else "set_property", target, buildJsonObject { if (!lifecycle) put("property", property); put("value", value) }, replaces ?: versions[target to property].orEmpty().keys.sorted())
    }
    fun commit(peer: String, operations: List<GraphOperation>, collection: String? = this.collection): GraphCommit = GraphCommit(id(), collection ?: id(), peer, OffsetDateTime.now(java.time.ZoneOffset.UTC).toString(), 1, heads, operations)

    fun components(): GraphComponents {
        val roots = mutableObjects.filterValues { it.type == "Person" }.keys.associateWith { it }.toMutableMap()
        fun root(start: String): String {
            var key = start
            while (roots.getValue(key) != key) { roots[key] = roots.getValue(roots.getValue(key)); key = roots.getValue(key) }
            return key
        }
        mutableEdges.toSortedMap().forEach { (id, edge) -> if (edge.type == "same_person" && active(id)) {
            val a = root(edge.from!!); val b = root(edge.to!!)
            roots[maxOf(a, b)] = minOf(a, b)
        } }
        val groups = roots.keys.sorted().groupBy(::root)
        val contradictions = mutableEdges.toSortedMap().filter { (id, e) -> e.type == "distinct_person" && active(id) && root(e.from!!) == root(e.to!!) }.keys.toList()
        return GraphComponents(groups, contradictions)
    }

    fun split(person: String, name: String, attributions: List<String>): GraphSplit {
        require(mutableObjects[person]?.type == "Person" && active(person)) { "Choose an active person" }
        require(name.isNotBlank()) { "The new person needs a name" }
        require(attributions.isNotEmpty() && attributions.distinct().size == attributions.size) { "Select distinct attribution edges to move" }
        val members = components().groups.values.first { person in it }.toSet()
        val associated = mutableEdges.filter { (id, e) -> e.type in Companion.attributions && active(id) && (if (e.type == "participant") e.to in members else e.from in members) }
        require(attributions.all { it in associated }) { "Selection is not an active attribution of this person" }
        val unverified = attributions.any { id ->
            val e = associated.getValue(id)
            val metadata = e.from?.let { value(it, "card_metadata") as? JsonObject }
            e.type == "has_contact_point" && (value(e.to!!, "kind") as? JsonPrimitive)?.content == "phone" &&
                (metadata?.get("legacy_unverified") == JsonPrimitive(true) || (value(e.to, "compat_table") as? JsonPrimitive)?.content == "identifiers" || value(e.to, "matching_hint") == JsonPrimitive(true))
        }
        val newPerson = createObject("Person", buildJsonObject { if (unverified) put("card_metadata", buildJsonObject { put("legacy_unverified", true) }) })
        val newName = createObject("Name", buildJsonObject { put("display", name.trim()) })
        val ops = mutableListOf(newPerson, newName, createEdge("has_name", newPerson.target, newName.target, buildJsonObject { put("preferred", true) }), createEdge("distinct_person", person, newPerson.target))
        attributions.forEach { id ->
            val edge = associated.getValue(id)
            val keys = versions.keys.filter { it.first == id }
            require(keys.none { conflicted(id, it.second) }) { "Resolve attribution conflicts before moving it" }
            val properties = JsonObject(keys.filter { it.second != "_lifecycle" }.associate { it.second to value(id, it.second)!! } + if (edge.type == "has_name") mapOf("preferred" to JsonPrimitive(false)) else emptyMap())
            ops.add(edit(id, "_lifecycle", JsonPrimitive("retracted")))
            ops.add(createEdge(edge.type, if (edge.type != "participant") newPerson.target else edge.from!!, if (edge.type == "participant") newPerson.target else edge.to!!, properties))
        }
        return GraphSplit(newPerson.target, ops, (associated.keys - attributions.toSet()).sorted())
    }
}
