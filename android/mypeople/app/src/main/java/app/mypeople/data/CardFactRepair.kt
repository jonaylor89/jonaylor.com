package app.mypeople.data

import kotlinx.serialization.json.*

/** Identify only the old Android save-card bug's paired retractions, not ordinary forget,
 * rejection, split or reattribution decisions. Restoring an edge never edits its fact text. */
internal fun GraphStore.repairableCardFactAttributions(): List<String> {
    val scalarKeys = setOf("birthday", "organization", "title")
    val cardOrigins = setOf("contact_card", "legacy_contact_card")
    val commits = mutableMapOf<String, GraphCommit>()
    fun currentRetraction(edge: String): String? {
        val alternatives = graph.alternatives(edge, "_lifecycle")
        if (alternatives.size != 1 || alternatives.single().value != JsonPrimitive("retracted")) return null
        return alternatives.single().operation
    }
    val indexed = graph as? IndexedGraph
    val edges = if (indexed != null && indexed.sequence == indexed.database.latest)
        indexed.database.sql.query("SELECT id FROM entities WHERE type='subject_of' AND active=0").map { it[0]!! }.map { it to graph.edges.getValue(it) }
    else graph.edgesOfType("subject_of")
    val components = graph.components()
    val visibleRoots = components.groups.filterValues { members ->
        members.any { graph.active(it) } && members.none { graph.value(it, "is_me") == JsonPrimitive(true) }
    }.keys
    val candidates = edges.filter { (edge, entity) ->
        components.rootByPerson[entity.from] in visibleRoots &&
        !graph.active(edge) && graph.active(entity.to!!) && text(entity.to, "predicate") in scalarKeys &&
            text(entity.to, "asserted_by") !in cardOrigins && text(entity.to, "value").isNotBlank() &&
            text(entity.to, "status") !in setOf("rejected", "forgotten") &&
            graph.outgoing(entity.to).any { (id, source) -> source.type == "originated_from" && graph.active(id) && text(source.to!!, "table") == "events" } &&
            graph.incoming(entity.to).none { (id, target) -> target.type == "targets" && graph.active(id) && graph.active(target.from!!) && text(target.from, "action") in setOf("reject", "rejected", "forget", "forgotten") }
    }
    // Resolve only the few candidate operations to commits, never materialize the graph's log.
    fun retractionCommit(operation: String): GraphCommit? {
        if (indexed != null) {
            val commitId = indexed.database.scalar("SELECT c.id FROM operations o JOIN commits c ON c.seq=o.commit_seq WHERE o.id=?", listOf(operation)) ?: return null
            return commits.getOrPut(commitId) { graph.commits.getValue(commitId) }
        }
        return graph.ordered.firstOrNull { commit -> commit.operations.any { it.id == operation } }
    }
    return candidates.filter { (edge, entity) ->
        val operation = currentRetraction(edge) ?: return@filter false
        val commit = retractionCommit(operation) ?: return@filter false
        val predicate = text(entity.to!!, "predicate")
        commit.operations.any { op ->
            if (op.kind != "set_lifecycle" || op.payload["value"] != JsonPrimitive("retracted") || op.target == edge) false
            else {
                val companion = graph.edges[op.target]
                companion?.type == "subject_of" && companion.from == entity.from &&
                    text(companion.to!!, "predicate") == predicate && text(companion.to, "asserted_by") in cardOrigins
            }
        }
    }.map { it.first }.sorted()
}
