package app.mypeople.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.io.File
import java.time.Instant
import java.util.UUID

@Serializable
data class Notice(val id: String = UUID.randomUUID().toString(), val message: String)

@Serializable
data class DiskState(
    val records: Records = Records(),
    val cursor: Long = 0,
    val nextLocalId: Int = -1,
    val pending: List<PendingOp> = emptyList(),
    val failedEdits: List<PendingOp> = emptyList(),
    val lastSync: String? = null,
    val lastError: String? = null,
    val notices: List<Notice> = emptyList(),
    val offlineSource: String? = null,
    val offlineRevision: Long = 0,
    val journalSequence: Long = 0,
    val replica: ReplicaState = ReplicaState(),
    val graph: GraphState? = null,
)

data class StoreState(
    val records: Records = Records(),
    val pending: List<PendingOp> = emptyList(),
    val failedEdits: List<PendingOp> = emptyList(),
    val lastSync: String? = null,
    val lastError: String? = null,
    val notices: List<Notice> = emptyList(),
    val ready: Boolean = false,
    val offlineSource: String? = null,
    val offlineRevision: Long = 0,
    val replicatedContacts: Boolean = false,
)

/** Pure reducer shared by disk-backed sync and JVM tests. Foreign-device results aren't our edits. */
fun DiskState.receive(page: Changes): DiskState {
    val results = page.ops.associateBy { it.client_id }
    val failures = pending.mapNotNull { op -> results[op.client_id]?.takeIf { it.status == "failed" }?.let { Notice(message = it.message ?: "${op.kind} failed on your Mac.") } }
    val nextRecords = records.applyChanges(page.records)
    fun canonicalArrived(op: PendingOp, index: Int): Boolean {
        val uid = op.payload.text("contact_uid")
        val person = nextRecords.people.values.firstOrNull { it.contact_uid == uid || uid in it.contact_aliases } ?: return false
        if (uid != person.contact_uid && uid in person.contact_aliases) return true
        return pending.drop(index).filter { it.kind == "contact_save" && it.payload.text("contact_uid") == uid }.any {
            it.payload["card"]?.let { data -> json.decodeFromJsonElement<ContactCard>(data) }?.let { saved -> (saved.edit_id.isNotEmpty() && saved.edit_id == person.card?.edit_id) || saved.copy(edit_id = "") == person.card?.copy(edit_id = "") } == true
        }
    }
    return copy(
        records = nextRecords, cursor = page.cursor,
        pending = pending.mapIndexedNotNull { index, op ->
            val status = results[op.client_id]?.status
            when {
                status == "failed" -> null
                op.kind == "contact_save" && (status == "done" || op.completed) ->
                    if (canonicalArrived(op, index)) null else op.copy(sent = true, completed = true)
                status == "done" -> null
                status == "pending" -> op.copy(sent = true)
                else -> op
            }
        },
        failedEdits = failedEdits + pending.filter { results[it.client_id]?.status == "failed" },
        notices = notices + failures,
    )
}

/** Durable local graph plus retained upgrade outbox; atomic typed checkpoints and journal deltas. */
class Store(private val directory: File, private val saveTiming: (String, Long) -> Unit = { _, _ -> }, private val startupTiming: (String, Long) -> Unit = { _, _ -> }) {
    private inline fun <T> timedSave(stage: String, block: () -> T): T {
        val start = System.nanoTime()
        return block().also { saveTiming(stage, (System.nanoTime() - start) / 1_000_000) }
    }
    private val mutex = Mutex()
    private val journal = StoreJournal(directory,startupTiming)
    private val startupIndex = StartupIndex(directory)
    private var historySource: List<ContactChange>? = null
    private var history = ContactHistory()
    private var viewRecords: Records? = null
    private var viewPending: List<PendingOp>? = null
    private var viewReplica: ReplicaState? = null
    private var viewGraph: GraphState? = null
    private var view = Records()
    private var disk = DiskState()
    private var loaded = false
    private val mutable = MutableStateFlow(StoreState())
    val state: StateFlow<StoreState> = mutable.asStateFlow()

    private fun contactHistory(): ContactHistory {
        if (historySource !== disk.replica.changes) {
            history = ContactHistory(disk.replica.changes, startupTiming)
            historySource = disk.replica.changes
        }
        return history
    }
    private fun changedHintTargets(previous: Records?, next: Records): Set<String>? {
        if (previous === next) return emptySet()
        fun hintsOnly(records: Records) = records.events.isEmpty() && records.profiles.isEmpty() && records.moments.isEmpty() &&
            records.dupes.isEmpty() && records.contactChanges.isEmpty() && records.people.values.all { it.name.isEmpty() && it.card == null && it.identifiers.isEmpty() }
        if (previous == null || !hintsOnly(previous) || !hintsOnly(next)) return null
        return (previous.people.keys + next.people.keys).filter { previous.people[it] != next.people[it] }.flatMap { id ->
            listOfNotNull(previous.people[id], next.people[id]).flatMap { listOf(it.contact_uid) + it.contact_aliases }
        }.filter { it.isNotEmpty() }.toSet()
    }
    private fun current(): Records {
        if (viewRecords !== disk.records || viewPending !== disk.pending || viewReplica !== disk.replica || viewGraph !== disk.graph) {
            val base = optimistic(disk.records, disk.pending)
            view = disk.graph?.let { next ->
                val gs = GraphStore(next)
                val previous = viewGraph
                if (previous != null && previous.bundle.collection == next.bundle.collection &&
                    previous.bundle.heads == next.bundle.heads && previous.localIds == next.localIds &&
                    viewRecords === disk.records && viewPending === disk.pending) return@let view
                val oldIds = previous?.bundle?.commits.orEmpty().map { it.id }.toSet()
                val replaced = !next.bundle.commits.map { it.id }.toSet().containsAll(oldIds)
                val changed = previous == null || replaced || previous.bundle.collection != next.bundle.collection || next.bundle.commits.filterNot { it.id in oldIds }.any { commit ->
                    commit.operations.any { op ->
                        val kind = gs.graph.objects[op.target]?.type ?: gs.graph.edges[op.target]?.type
                        val bookkeeping = kind == "Person" && op.kind == "set_property" && op.payload.text("property") in setOf("card_metadata", "originals", "source_records")
                        !bookkeeping && kind in setOf("Person", "Name", "ContactPoint", "same_person", "distinct_person")
                    }
                }
                // Reuse only projections independent of a small card-shaped delta.
                // Merges/splits, evidence/reviews, non-card graph deltas and
                // changed derived inputs keep the full projection path.
                val edits = next.bundle.commits.filterNot { it.id in oldIds }.flatMap { it.operations }
                val cardTypes = setOf("Person", "Name", "ContactPoint", "Note", "Claim", "Asset", "RelationshipPreferences", "has_name", "has_contact_point", "has_note", "subject_of", "has_asset", "has_preferences", "same_person", "distinct_person", "Decision", "targets", "Moment", "about")
                val hintTargets = changedHintTargets(viewRecords, disk.records)
                val incremental = previous != null && !replaced && previous.bundle.collection == next.bundle.collection &&
                    previous.localIds.all { (uid, id) -> next.localIds[uid] == id } &&
                    hintTargets != null && viewPending === disk.pending &&
                    edits.all { (gs.graph.objects[it.target] ?: gs.graph.edges[it.target])?.type in cardTypes }
                val targets = if (incremental) edits.flatMap { op ->
                    val edge = gs.graph.edges[op.target]
                    listOfNotNull(op.target, edge?.from, edge?.to)
                }.toSet() + hintTargets!! else null
                val projected = gs.project(computeDuplicates = changed, derived = base, previous = view, changedTargets = targets)
                projected
            } ?: if (disk.replica.enabled) contactHistory().project(base, disk.replica.localIds) else base
            viewRecords = disk.records; viewPending = disk.pending; viewReplica = disk.replica; viewGraph = disk.graph
        }
        return view
    }
    private var dupesView: Records? = null
    private var dupesPending: List<PendingOp>? = null
    private var shownRecords = Records()
    /** The view plus duplicates involving contacts changed here since the last sync, listed first. */
    private fun shown(): Records {
        val view = current()
        if (view !== dupesView || disk.pending !== dupesPending) {
            val touched = disk.pending.filter(::changesIdentity).map { it.payload.text("contact_uid") }.toSet()
            val distinct = disk.pending.filter { it.kind == "distinct" }.map { it.payload.ids().toSet() }
            val local = if (touched.isEmpty()) emptyMap() else localDuplicates(view, touched, distinct)
            shownRecords = if (local.isEmpty()) view else view.copy(dupes = local + view.dupes)
            dupesView = view; dupesPending = disk.pending
        }
        return shownRecords
    }
    /** Created, renamed, given a new number or address, or restored here: worth a duplicate check.
     * A favorite or a note isn't, or every rejected pair would resurface after a small edit. */
    private fun changesIdentity(op: PendingOp): Boolean = when (op.kind) {
        "contact_save", "contact_restore", "rename" -> true
        "contact_change" -> {
            val p = op.payload
            val values = p["values"] as? JsonObject
            val adds = p["adds"] as? JsonObject
            // A new contact always carries its name; a merge's links already settle who is who.
            (p["links"] as? JsonArray).isNullOrEmpty() && (values?.containsKey("name") == true ||
                adds?.containsKey("fields") == true || (values?.get("_trashed") as? JsonPrimitive)?.booleanOrNull == false)
        }
        else -> false
    }
    private fun publish() {
        if (journal.indexed?.sql?.inTransaction == true) return // Never expose an uncommitted edit.
        mutable.value = StoreState(records = shown(), pending = disk.pending, failedEdits = disk.failedEdits, lastSync = disk.lastSync, lastError = disk.lastError, notices = disk.notices, ready = loaded, offlineSource = disk.offlineSource, offlineRevision = disk.offlineRevision, replicatedContacts = disk.graph != null || disk.replica.enabled)
    }
    private fun load() {
        if (loaded) return
        // A corrupt cache must not silently erase a durable outbox.
        val start = System.nanoTime()
        if (!journal.hasIndex) startupIndex.read()?.let { mutable.value = StoreState(records = it) }
        startupTiming("address_book", (System.nanoTime() - start) / 1_000_000)
        disk = journal.load()
        startupTiming("disk", (System.nanoTime() - start) / 1_000_000)
        // A cached screen projection is not a warm authority. Build/verify the
        // reducer and its indexes before enabling editing, not on the first Save.
        val graphStart = System.nanoTime()
        disk.graph?.let { state ->
            val gs = GraphStore(state, startupTiming)
            gs.graph.components().membersByPerson
            val blobs = GraphBlobs.persist(state.bundle.blobs, File(directory, "graph-blobs"))
            if (blobs !== state.bundle.blobs) disk = disk.copy(graph = state.copy(bundle = state.bundle.copy(blobs = blobs).also {
                it.reducer = gs.graph; it.blobsVerified = true
            }))
        }
        journal.cachedRecords?.let {
            if (disk.graph != null && it.duplicateIndex == null) it.duplicateIndex = GraphDuplicateIndex().updated(it.people, it.people.keys)
            view = it; viewRecords = disk.records; viewPending = disk.pending; viewReplica = disk.replica; viewGraph = disk.graph
        }
        startupTiming("graph_indexes", (System.nanoTime() - graphStart) / 1_000_000)
        loaded = true
        val projectStart = System.nanoTime()
        if (journal.indexed == null && IndexedGraphFiles.supported() && disk.graph != null) {
            disk = journal.createIndex(disk,shown())
            view = journal.cachedRecords!!; viewRecords=disk.records; viewPending=disk.pending; viewReplica=disk.replica; viewGraph=disk.graph
            dupesView=null
        }
        publish()
        startupTiming("projection", (System.nanoTime() - projectStart) / 1_000_000)
        if (journal.indexed == null) {
            if (journal.cachedRecords == null) runCatching { journal.cacheView(disk, current()) }
            runCatching { startupIndex.save(current()) }
        }
    }
    private fun save(next: DiskState) {
        val database = journal.indexed
        if (database != null && !database.sql.inTransaction) {
            database.transaction { save(next) }; publish(); return
        }
        val graph = next.graph?.let { state ->
            val blobs = GraphBlobs.persist(state.bundle.blobs, File(directory, "graph-blobs"))
            if (blobs === state.bundle.blobs) state else state.copy(bundle = state.bundle.copy(blobs = blobs).also {
                it.reducer = state.bundle.reducer; it.blobsVerified = state.bundle.blobsVerified
            })
        }
        val prepared = if (graph === next.graph) next else next.copy(graph = graph)
        if (database != null) {
            val previous=disk; disk=prepared
            val projected=timedSave("projection") { shown() }
            view=timedSave("indexed_transaction") { journal.saveIndexed(previous,prepared,projected) }
            val reduced=database.graph()
            val gs=prepared.graph!!
            disk=prepared.copy(graph=gs.copy(bundle=GraphBundle(gs.bundle.collection,reduced.heads,reduced.ordered,DatabaseBlobs(database,database.latest)).also { it.reducer=reduced; it.blobsVerified=true }))
            viewRecords=disk.records; viewPending=disk.pending; viewReplica=disk.replica; viewGraph=disk.graph; dupesView=null
            return
        }
        if (prepared.graph != null && IndexedGraphFiles.supported()) {
            disk=prepared
            disk=journal.createIndex(prepared,shown())
            view=journal.cachedRecords!!; viewRecords=disk.records; viewPending=disk.pending; viewReplica=disk.replica; viewGraph=disk.graph; dupesView=null
            publish(); return
        }
        timedSave("journal") { journal.save(disk, prepared) }
        disk = prepared
        timedSave("publish") { publish() }
        timedSave("checkpoint_cache") { if (journal.checkpointWritten) runCatching { journal.cacheView(disk, current()) } }
        timedSave("startup_index") { runCatching { startupIndex.save(current()) } }
    }
    private suspend fun <T> locked(block: () -> T): T = withContext(Dispatchers.IO) {
        mutex.withLock {
            load()
            val database=journal.indexed
            if (database == null) {
                val before=disk
                try { block() } catch (error: Throwable) {
                    disk=journal.indexed?.readState() ?: before
                    viewRecords=null; viewGraph=null; dupesView=null
                    throw error
                }
            } else {
                val before=disk
                try { database.transaction(block).also { publish() } }
                catch (error: Throwable) {
                    disk=before; view=database.readRecords("view"); viewRecords=disk.records; viewPending=disk.pending; viewReplica=disk.replica; viewGraph=disk.graph; dupesView=null
                    throw error
                }
            }
        }
    }
    suspend fun initialize() = locked { Unit }
    suspend fun cursor(): Long = locked { disk.cursor }
    suspend fun unsent(): List<PendingOp> = locked { disk.pending.filterNot { it.sent } }
    suspend fun enqueue(kind: String, payload: JsonObject, expectedPerson: Person? = null) = locked {
        if (expectedPerson != null) {
            val current = current().people.values.firstOrNull { it.contact_uid == expectedPerson.contact_uid }
            if (!sameContactVersion(current, expectedPerson)) throw EditRejected("Contact changed during Android reconciliation. Neither version was overwritten.")
        }
        require(kind in opKinds) { "Unsupported operation" }
        if (disk.graph != null) {
            saveGraph(GraphStore(disk.graph!!).mutate(kind, payload, current()))
            return@locked
        }
        if (disk.replica.enabled && kind in setOf("merge", "rename", "contact_trash", "contact_restore")) {
            val h = contactHistory()
            val person = current().people[payload.int("person_id")]
                ?: current().people.values.firstOrNull { it.contact_uid == payload.text("contact_uid") }
            if (kind == "merge") {
                val ids = mergePeople(payload, current())
                val participants = ids.map { current().people.getValue(it) }
                val target = participants.maxWith(compareBy<Person> { it.channels.sumOf { c -> c.count } }.thenBy { it.contact_uid })
                val combined = (listOf(target) + participants.filterNot { it === target }).map { it.contactCard() }.reduce(::mergeCards)
                // Resolve known scalar differences explicitly; lists retain original addition tags.
                val authored = participants.flatMap { h.contact(it.contact_uid)?.registers.orEmpty().keys }.toSet()
                val values = JsonObject(ContactHistory.scalarValues(combined).filterKeys { it in authored })
                val c = h.edit(target.contact_uid, links = participants.map { it.contact_uid }, values = values)
                saveChange(c)
            } else {
                requireNotNull(person) { "This contact is no longer available." }
                saveChange(if (kind == "rename") h.edit(person.contact_uid, values = buildJsonObject { put("name", payload.text("name")); put("user_edited", true) })
                    else h.edit(person.contact_uid, trashed = kind == "contact_trash"))
            }
            return@locked
        }
        if (disk.replica.enabled && kind == "merge_undo") throw EditRejected("Splitting replicated identities is not supported yet. Contact history has been retained.")
        save(disk.copy(pending = disk.pending + PendingOp(UUID.randomUUID().toString(), kind, payload, created_at = java.time.LocalDateTime.now().toString())))
    }
    suspend fun saveContact(card: ContactCard, id: Int? = null, contactUid: String? = null, expectedPerson: Person? = null, restore: Boolean = false): Int = locked {
        card.validate()
        val current = current()
        val entry = contactUid?.takeIf { it.isNotEmpty() }?.let { uid -> current.people.entries.firstOrNull { it.value.contact_uid == uid || uid in it.value.contact_aliases } }
        require(contactUid.isNullOrEmpty() || entry != null) { "This contact belongs to a different or older view. Reopen it from People; your draft is still here." }
        val target = entry?.key ?: id
        val person = entry?.value ?: current.people[id]
        if (expectedPerson != null && !sameContactVersion(person, expectedPerson)) throw EditRejected("Contact changed during Android reconciliation. Neither version was overwritten.")
        require(id == null || person != null) { "This contact changed while editing. Reopen it from People; your draft is still here." }
        require(target == null || target < 0 || person?.contact_uid?.isNotEmpty() == true) { "Sync with the updated Mac once to upgrade this contact before editing." }
        val localId = target ?: minOf(disk.nextLocalId, (current.people.keys.minOrNull() ?: 0).coerceAtMost(0) - 1)
        val uid = person?.contact_uid?.takeIf { it.isNotEmpty() } ?: newContactUid()
        val standalone = disk.offlineSource == null && disk.cursor == 0L && disk.records.people.isEmpty() && disk.pending.isEmpty() && !disk.replica.enabled
        if (disk.graph != null || standalone) {
            val gs = timedSave("graph_open") { GraphStore(disk.graph ?: GraphStore.empty()) }
            val next = timedSave("graph_edit") { gs.saveCard(uid, card.copy(user_edited = true), restore) }
            saveGraph(next)
            return@locked current().people.entries.first { uid == it.value.contact_uid || uid in it.value.contact_aliases }.key
        }
        if (disk.replica.enabled) {
            val c = contactHistory().edit(uid, card.copy(user_edited = true), trashed = if (restore) false else null)
            saveChange(c)
            return@locked current().people.entries.first { uid == it.value.contact_uid || uid in it.value.contact_aliases }.key
        }
        val clientId = UUID.randomUUID().toString()
        val payload = buildJsonObject {
            put("contact_uid", uid); put("local_id", localId)
            if (localId > 0) put("person_id", localId)
            put("card", json.encodeToJsonElement(card.copy(user_edited = true, edit_id = clientId)))
        }
        val op = PendingOp(clientId, "contact_save", payload, created_at = Instant.now().toString())
        val restoration = if (restore && person?.trashed == true) listOf(PendingOp(UUID.randomUUID().toString(), "contact_restore", buildJsonObject { put("person_id", localId); put("contact_uid", uid) }, created_at = op.created_at)) else emptyList()
        save(disk.copy(pending = disk.pending + restoration + op, nextLocalId = minOf(disk.nextLocalId, localId - 1)))
        localId
    }
    private fun saveGraph(next: GraphState) {
        val indexed = timedSave("graph_index") { GraphStore(next).indexed() }
        save(disk.copy(graph = indexed, nextLocalId = minOf(disk.nextLocalId, (indexed.localIds.values.minOrNull() ?: 0) - 1)))
    }
    /** A phone-only cleanup must not run the full card-save path or modify shared
     * contact-point metadata belonging to another identity. History remains append-only. */
    internal suspend fun contactPhonePreview(expected: Person): ContactPhonePreview {
        if (expected.contact_uid.isEmpty() || expected.contactFields().none { it.kind == "phone" && it.object_id.isNotEmpty() }) return expected.phonePreview()
        return locked {
            val person = current().people.values.firstOrNull { it.contact_uid == expected.contact_uid }
            if (!sameContactVersion(person, expected) || person == null) throw EditRejected("Contact changed; reopen its phone details.")
            disk.graph?.let { GraphStore(it).phonePreview(person) } ?: person.phonePreview()
        }
    }
    internal suspend fun cleanDuplicatePhoneFields(id: Int, expectedPerson: Person): Int = locked {
        val person = current().people[id]
        require(sameContactVersion(person, expectedPerson) && person != null && person.contact_aliases == expectedPerson.contact_aliases && person.contact_conflicts == expectedPerson.contact_conflicts && person.canCleanDuplicatePhones()) { "Contact changed or a detail needs a choice; preview again." }
        val gs = GraphStore(requireNotNull(disk.graph))
        val cleanup = gs.phonePreview(person).cleanup
        if (cleanup.removed == 0) return@locked 0
        val ops = gs.duplicatePhoneOperations(person, cleanup)
        saveGraph(gs.commit(ops))
        cleanup.removed
    }

    /** Explicit identity choice. Optional phone cleanup shares the same single commit:
     * a stale choice or shared metadata failure leaves both decisions unapplied. */
    internal suspend fun resolveMergeDecision(expected: Person, keepMerged: Boolean, cleanPhones: Boolean): Int = locked {
        val person = current().people.values.firstOrNull { it.contact_uid == expected.contact_uid }
        if (!sameContactVersion(person, expected) || person == null || person.contact_aliases != expected.contact_aliases || person.contact_conflicts != expected.contact_conflicts)
            throw EditRejected("This contact changed. Close this review and reopen it before choosing.")
        val conflicts = person.mergeDecisionConflicts()
        require(conflicts.isNotEmpty()) { "This merge decision has already been resolved." }
        val gs = GraphStore(requireNotNull(disk.graph))
        val components = gs.graph.components()
        val members = components.groups.values.first { person.contact_uid in it }.toSet()
        val separateEdges = conflicts.keys.map { it.substringBefore('/') }
        require(separateEdges.all { it in components.contradictions && gs.graph.edges[it]?.type == "distinct_person" }) { "This merge decision changed. Reopen the review." }
        val targets = if (keepMerged) separateEdges else gs.graph.edgesOfType("same_person").filter { (edge, entity) ->
            entity.from in members && entity.to in members && gs.graph.active(edge)
        }.map { it.first }
        require(targets.isNotEmpty())
        val ops = targets.map { gs.graph.edit(it, "_lifecycle", JsonPrimitive("retracted")) }.toMutableList()
        var removed = 0
        if (cleanPhones) {
            require(keepMerged && !person.trashed && conflicts.size == person.contact_conflicts.size) { "Resolve the other conflicting details before removing duplicate phone fields." }
            val cleanup = gs.phonePreview(person).cleanup
            ops += gs.duplicatePhoneOperations(person, cleanup)
            removed = cleanup.removed
        }
        saveGraph(gs.commit(ops))
        removed
    }

    /** Explicit maintenance only: restore proven misclassified fact edges in one normal
     * Store transaction. Never modifies fact text, cards, identities or prior operations. */
    internal suspend fun repairCardFactAttributions(expectedHeads: List<String>, edges: List<String>) = locked {
        val state = requireNotNull(disk.graph)
        require(state.bundle.heads == expectedHeads) { "The graph changed; preview again." }
        val gs = GraphStore(state)
        val repairable = gs.repairableCardFactAttributions().toSet()
        require(edges.isNotEmpty() && edges.distinct().size == edges.size && edges.all { it in repairable }) { "The repair no longer matches." }
        saveGraph(gs.commit(edges.map { gs.graph.edit(it, "_lifecycle", JsonPrimitive("active")) }))
    }
    suspend fun associations(uid: String): GraphSelection = locked {
        GraphStore(requireNotNull(disk.graph) { "Sync with the graph-enabled CLI first." }).selection(uid)
    }
    suspend fun split(selection: GraphSelection, name: String, edges: List<String>): Int = locked {
        val gs = GraphStore(requireNotNull(disk.graph))
        require(selection.heads == gs.graph.heads) { "This contact changed. Reopen split and review the associations again." }
        val split = gs.graph.split(selection.uid, name, edges)
        saveGraph(gs.commit(split.operations))
        disk.graph!!.localIds.getValue(split.person)
    }
    suspend fun resolveGraph(target: String, property: String, operation: String) = locked {
        val gs = GraphStore(requireNotNull(disk.graph))
        val choice = gs.graph.alternatives(target, property).firstOrNull { it.operation == operation }?.value
            ?: if (property == "_lifecycle") gs.graph.deletionConflicts(target).firstOrNull { it.operation == operation }?.let { JsonPrimitive("active") } else null
            ?: throw EditRejected("This conflict changed. Reopen it.")
        saveGraph(gs.commit(listOf(gs.graph.edit(target, property, requireNotNull(choice) { "This conflict changed. Reopen it." }))))
    }
    private fun replicaState(h: ContactHistory, state: ReplicaState = disk.replica): ReplicaState {
        var next = disk.nextLocalId
        val ids = state.localIds.toMutableMap()
        h.contacts.keys.forEach { uid -> if (uid !in ids) { ids[uid] = next; next-- } }
        return state.copy(enabled = true, changes = h.changes, localIds = if (ids == state.localIds) state.localIds else ids)
    }
    private fun saveChange(c: ContactChange) {
        val h = contactHistory().plus(listOf(c))
        val replica = replicaState(h)
        val op = PendingOp(c.id, "contact_change", json.encodeToJsonElement(c).jsonObject, created_at = Instant.now().toString())
        // Reuse the history just built; publishing would otherwise rebuild it from scratch.
        history = h; historySource = replica.changes
        save(disk.copy(replica = replica, pending = disk.pending + op, nextLocalId = minOf(disk.nextLocalId, (replica.localIds.values.minOrNull() ?: 0) - 1)))
    }
    suspend fun resolveContact(uid: String, field: String, changeId: String) = locked {
        if (disk.graph != null) {
            val gs = GraphStore(disk.graph!!)
            val conflict = current().people.values.firstOrNull { it.contact_uid == uid || uid in it.contact_aliases }?.contact_conflicts?.get(field)?.firstOrNull { it.change == changeId }
                ?: throw EditRejected("This conflict changed. Reopen it.")
            val target = field.substringBefore('/'); val property = field.substringAfter('/')
            saveGraph(gs.commit(listOf(gs.graph.edit(target, property, conflict.value))))
            return@locked
        }
        require(disk.replica.enabled) { "Pair with an updated CLI first." }
        val choice = contactHistory().contact(uid)?.conflicts?.get(field)?.firstOrNull { it.change == changeId }
            ?: throw EditRejected("This conflict has changed. Reopen the contact.")
        saveChange(contactHistory().edit(uid, values = JsonObject(mapOf(field to choice.value))))
    }
    suspend fun retryFailed(clientId: String) = locked {
        val failed = requireNotNull(disk.failedEdits.firstOrNull { it.client_id == clientId }) { "This edit has already been recovered." }
        require(failed.kind == "relationship") { "Review this failed edit before recovering it." }
        if (disk.graph != null) {
            val next = GraphStore(GraphStore(disk.graph!!).mutate(failed.kind, failed.payload, current())).indexed()
            save(disk.copy(graph = next, failedEdits = disk.failedEdits.filterNot { it.client_id == clientId }))
        } else {
            val retry = failed.copy(client_id = UUID.randomUUID().toString(), sent = false, completed = false, created_at = Instant.now().toString())
            save(disk.copy(pending = disk.pending + retry, failedEdits = disk.failedEdits.filterNot { it.client_id == clientId }))
        }
    }
    suspend fun dismissFailed(clientId: String) = locked { save(disk.copy(failedEdits = disk.failedEdits.filterNot { it.client_id == clientId })) }
    suspend fun snapshot(): DiskState = locked { disk }
    suspend fun restoreBackup(next: DiskState) = locked {
        require(disk.pending.isEmpty() && disk.graph == null) { "Back up this phone's graph and sync its edits before restoring. Reset only after saving that backup." }
        // A new device must retry acknowledgments, not assume the old device delivered them.
        next.graph?.let { GraphStore(it) }
        save(next.copy(graph = next.graph?.copy(peer = UUID.randomUUID().toString(), remoteHeads = emptyList()), pending = next.pending.map { it.copy(sent = it.completed) }, lastError = null))
    }
    suspend fun sent(ids: Set<String>) = locked {
        save(disk.copy(pending = disk.pending.map { if (it.client_id in ids) it.copy(sent = true) else it }))
    }
    suspend fun receive(page: Changes) = locked {
        var next = disk.receive(page)
        if (!page.more && next.records.contactChanges.isNotEmpty() && next.pending.none { it.kind in setOf("contact_save", "merge", "rename", "contact_trash", "contact_restore", "merge_undo") }) {
            val remote = ContactHistory(next.records.contactChanges.values.toList())
            val h = ContactHistory(next.replica.changes + remote.changes)
            val replica = replicaState(h, next.replica).copy(remoteHeads = remote.heads)
            next = next.copy(replica = replica, nextLocalId = minOf(next.nextLocalId, (replica.localIds.values.minOrNull() ?: 0) - 1))
        }
        save(next)
    }
    suspend fun succeeded() = locked { save(disk.copy(lastSync = Instant.now().toString(), lastError = null)) }
    suspend fun error(message: String) = withContext(Dispatchers.IO) {
        mutex.withLock {
            if (loaded) {
                val next = disk.copy(lastError = message)
                try { save(next) } catch (_: java.io.IOException) {
                    // Even a full disk must leave a visible error, not an uncaught coroutine failure.
                    disk = next
                    publish()
                }
            } else mutable.value = mutable.value.copy(lastError = message)
        }
    }
    suspend fun dismissNotice(id: String) = locked { save(disk.copy(notices = disk.notices.filterNot { it.id == id })) }
    private fun standaloneQueue(): Boolean {
        if (disk.offlineSource == null && disk.cursor == 0L && disk.records.people.isEmpty() && disk.replica.enabled && disk.pending.all { it.kind == "contact_change" }) return true
        val created = disk.pending.filter { it.kind == "contact_save" && (it.payload.int("local_id") ?: 0) < 0 }.map { it.payload.text("contact_uid") }.toSet()
        return disk.offlineSource == null && disk.cursor == 0L && disk.records.people.isEmpty() && disk.pending.all {
            it.kind !in setOf("merge", "distinct", "event_forget", "profile_status", "moment_status") && it.payload.text("contact_uid") in created
        }
    }
    suspend fun installOffline(snapshot: TransferManifest) = locked {
        Transfer.validate(snapshot)
        if (snapshot.graph != null) {
            installGraph(snapshot)
            return@locked
        }
        require(disk.graph == null) { "This memory lacks graph history. Update the CLI; local graph edits have been retained." }
        require(snapshot.type == "snapshot") { "Choose a memory file from your Mac, not an edits file." }
        val sameSource = disk.offlineSource == snapshot.source
        require(sameSource || disk.pending.isEmpty() || standaloneQueue()) { "Export and acknowledge pending edits before switching databases or sync methods." }
        val samePublisher = snapshot.publisher == disk.replica.publisher
        // Requests naming a row on one Mac can't go to another. Everything else names its contact.
        require(!sameSource || samePublisher || disk.replica.publisher == null || disk.pending.all { it.portable }) { "Finish the queued profile and review decisions with the Mac they came from, then sync here." }
        require(!sameSource || !samePublisher || snapshot.revision >= disk.offlineRevision) { "This memory file is older than the one already on your phone." }
        if (snapshot.contact_version == 0 && sameSource && snapshot.revision == disk.offlineRevision) return@locked
        val base = if (sameSource || standaloneQueue()) disk else DiskState(notices = disk.notices)
        require(snapshot.base_revision == null || (sameSource && samePublisher && snapshot.base_revision == base.offlineRevision)) { "Incremental memory needs its original base. Sync again from this phone." }
        require(!base.replica.enabled || snapshot.contact_version == 1) { "This CLI is too old for replicated contacts. Update it before syncing." }
        val acknowledged = base.copy(records = if (snapshot.base_revision == null) Records() else base.records).receive(Changes(0, false, snapshot.records, snapshot.results))
        var receivedHistory: ContactHistory? = null
        val replica = if (snapshot.contact_version == 1) {
            require(acknowledged.pending.none { it.kind in setOf("contact_save", "merge", "rename", "contact_trash", "contact_restore", "merge_undo") }) { "Finish syncing legacy contact edits before enabling replicated contacts." }
            val h = if (sameSource && snapshot.contact_history.isEmpty()) contactHistory()
                else ContactHistory((if (sameSource || standaloneQueue()) base.replica.changes else emptyList()) + snapshot.contact_history, startupTiming)
            require(if (snapshot.contact_history.isEmpty()) snapshot.contact_heads.all { it in h.byId }
                else h.past(snapshot.contact_heads).containsAll(snapshot.contact_history.map { it.id })) { "Invalid contact history frontier." }
            receivedHistory = h
            replicaState(h, base.replica).copy(remoteHeads = snapshot.contact_heads, recordHashes = snapshot.record_hashes, publisher = snapshot.publisher)
        } else base.replica
        receivedHistory?.let { history = it; historySource = replica.changes }
        save(acknowledged.copy(
            replica = replica, nextLocalId = minOf(acknowledged.nextLocalId, (replica.localIds.values.minOrNull() ?: 0) - 1),
            cursor = 0,
            offlineSource = snapshot.source, offlineRevision = snapshot.revision,
            lastSync = Instant.now().toString(), lastError = null,
        ))
    }
    /** Validate/merge/project/convert the legacy outbox before the single durable commit point. */
    private fun installGraph(snapshot: TransferManifest) {
        require(snapshot.type == "snapshot") { "Choose a memory snapshot, not edits." }
        val incoming = requireNotNull(snapshot.graph)
        val sameSource = disk.offlineSource == snapshot.source
        require(snapshot.publisher == disk.replica.publisher || disk.replica.publisher == null || disk.pending.all { it.portable }) { "Finish queued legacy review requests with their original publisher before switching. All edits have been retained." }
        require(sameSource || disk.offlineSource == null) { "This memory belongs to another database. Existing graph and queued edits have been retained." }
        require(!sameSource || snapshot.publisher != disk.replica.publisher || snapshot.revision >= disk.offlineRevision) { "This memory file is older than this device's view." }
        val oldView = current()
        // Keep only rebuildable relationship inference, not a second copy of cards/facts.
        val received = (if (snapshot.base_revision != null) disk.records else Records()).applyChanges(snapshot.records)
        val derivedCandidate = Records(people = received.people.mapValues { (_, p) -> Person("", contact_uid = p.contact_uid,
            contact_aliases = p.contact_aliases, category = p.category, closeness = p.closeness,
            cadence_days = p.cadence_days, trend = p.trend, days_365 = p.days_365, muted = p.muted) })
        val derived = if (derivedCandidate == disk.records) disk.records else derivedCandidate
        var local = disk.graph ?: GraphState(GraphBundle(incoming.collection))
        if (local.bundle.collection != incoming.collection) {
            require(disk.offlineSource == null) { "Cannot join different graph collections." }
            // File import is an explicit first join, just like confirmed QR pairing.
            journal.preserveGraphJoin(local.bundle.collection)
            local = GraphStore(local).rehome(incoming.collection)
        }
        var merged = GraphStore(local).receive(incoming)
        var gs = GraphStore(merged)
        // Existing native IDs need no adoption, object-table scan or quadratic
        // search through every displayed person. Only newly received people do.
        val unmapped = gs.graph.people.filter { it !in merged.localIds }.sorted()
        if (unmapped.isNotEmpty()) {
            val idMap = merged.localIds.toMutableMap()
            val used = idMap.values.toMutableSet()
            val oldByUid = oldView.people.entries.flatMap { (id, person) ->
                (listOf(person.contact_uid) + person.contact_aliases).filter { it.isNotEmpty() }.map { it to id }
            }.toMap()
            for (uid in unmapped) {
                val preferred = oldByUid[uid] ?: oldByUid[gs.text(uid, "legacy_contact_uid")] ?: gs.text(uid, "legacy_id").toIntOrNull()
                if (preferred != null && preferred !in used) { idMap[uid] = preferred; used += preferred }
            }
            merged = GraphStore(merged.copy(localIds = idMap)).indexed()
            gs = GraphStore(merged)
        }
        // Only the legacy outbox converter needs a complete adoption view.
        // Routine native sync must not project the entire book twice.
        val newView by lazy { gs.project() }
        fun resolve(oldUid: String, oldId: Int?): String? {
            val old = oldView.people[oldId] ?: oldView.people.values.firstOrNull { it.contact_uid == oldUid || oldUid in it.contact_aliases }
            return newView.people.values.firstOrNull { it.contact_uid == oldUid || oldUid in it.contact_aliases }?.contact_uid
                ?: gs.graph.people.firstOrNull { id ->
                    (oldUid.isNotEmpty() && gs.text(id, "legacy_contact_uid") == oldUid) || (old != null && gs.text(id, "legacy_id").toIntOrNull() == oldId)
                }?.let { found -> newView.people.values.firstOrNull { it.contact_uid == found || found in it.contact_aliases }?.contact_uid }
        }
        val results = snapshot.results.associateBy { it.client_id }
        val retained = mutableListOf<PendingOp>(); val failed = disk.failedEdits.toMutableList(); val notices = disk.notices.toMutableList()
        var migrated = 0
        disk.pending.forEach { op ->
            val receipt = results[op.client_id]
            if (receipt?.status == "done") return@forEach
            if (receipt?.status == "failed") { failed += op; notices += Notice(message = receipt.message ?: "A legacy edit needs review; its full payload was retained."); return@forEach }
            val p = op.payload.toMutableMap()
            val rowId = op.payload.int("person_id") ?: op.payload.int("local_id") ?: when (op.kind) {
                "profile_status" -> oldView.profiles[op.payload.text("profile_id")]?.person_id
                "moment_status" -> oldView.moments[op.payload.text("key")]?.person_id
                "event_forget" -> oldView.events[op.payload.text("event_id")]?.person_id
                else -> null
            }
            val uid = resolve(op.payload.text("contact_uid").ifBlank { oldView.people[rowId]?.contact_uid.orEmpty() }, rowId)
            if (op.kind == "event_forget") oldView.events[op.payload.text("event_id")]?.let { old ->
                p["type"] = JsonPrimitive(old.type); p["value"] = JsonPrimitive(old.value); p["date"] = JsonPrimitive(old.date)
            }
            if (uid != null) p["contact_uid"] = JsonPrimitive(uid)
            if (op.kind in setOf("merge", "distinct")) {
                val uids = op.payload.ids().mapNotNull { resolve(oldView.people[it]?.contact_uid.orEmpty(), it) }
                val ids = uids.mapNotNull { target -> GraphStore(merged).project().people.entries.firstOrNull { it.value.contact_uid == target || target in it.value.contact_aliases }?.key }
                if (ids.size == op.payload.ids().size) p["person_ids"] = JsonArray(ids.map(::JsonPrimitive))
                else { retained += op; return@forEach }
            }
            // Stable graph ids replace SQL ids for review items. Match the original displayed item exactly.
            if (op.kind == "profile_status") {
                val profile = oldView.profiles[op.payload.text("profile_id")]
                val target = GraphStore(merged).project().profiles.entries.firstOrNull { it.value.url == profile?.url && GraphStore(merged).project().people[it.value.person_id]?.contact_uid == uid }?.key
                if (target != null) p["profile_id"] = JsonPrimitive(target)
            }
            if (op.kind == "moment_status") {
                val moment = oldView.moments[op.payload.text("key")]
                val target = GraphStore(merged).project().moments.entries.firstOrNull { it.value.kind == moment?.kind && it.value.surfaced_on == moment.surfaced_on && it.value.reason == moment.reason }?.key
                if (target != null) p["key"] = JsonPrimitive(target)
            }
            val converted = runCatching {
                if (op.kind == "contact_change") {
                    val changed = oldView.people.values.firstOrNull { it.contact_uid == op.payload.text("contact_uid") || op.payload.text("contact_uid") in it.contact_aliases }
                        ?: throw EditRejected("Legacy contact history needs sync")
                    val target = uid ?: throw EditRejected("Legacy contact attribution needs sync")
                    var next = GraphStore(merged).saveCard(target, changed.contactCard(), !changed.trashed)
                    if (changed.trashed) next = GraphStore(next).mutate("contact_trash", buildJsonObject { put("contact_uid", target) })
                    val links = (op.payload["links"] as? JsonArray).orEmpty().map { it.jsonPrimitive.content }
                    val linked = links.map { resolve(it, null) ?: throw EditRejected("Legacy merge attribution needs sync") }.distinct()
                    if (linked.size > 1) next = GraphStore(next).commit(linked.drop(1).map { VersionedGraph.createEdge("same_person", linked.first(), it) })
                    next
                } else GraphStore(merged).mutate(op.kind, JsonObject(p))
            }
            converted.onSuccess { merged = it; migrated++ }.onFailure { retained += op.copy(sent = false) }
        }
        if (disk.graph == null && (disk.replica.changes.isNotEmpty() || disk.pending.isNotEmpty() || disk.failedEdits.isNotEmpty())) {
            // Retain the complete old causal ledger/outbox inside the authority,
            // using its interned binary representation rather than expanding
            // shared parent arrays into enormous JSON in every future backup.
            val blobDirectory = File(directory, "graph-blobs").apply { mkdirs() }
            val temporary = File.createTempFile(".legacy-", ".tmp", blobDirectory)
            try {
                val legacy = disk.copy(records = Records(), graph = null)
                java.io.FileOutputStream(temporary).use { out ->
                    StoreCheckpoint.write(legacy, out, formatVersion = 7); out.fd.sync()
                }
                val hash = temporary.inputStream().use(GraphBlobs::verifiedHash)
                temporary.inputStream().use { GraphBlobs.put(blobDirectory, hash, it) }
                GraphBlobs.syncDirectory(blobDirectory)
                val original = VersionedGraph.createObject("SourceRecord", buildJsonObject {
                    put("system", "mypeople-android-pre-graph"); put("format", "checkpoint-v7")
                    put("original", buildJsonObject { put("blob_hash", hash) })
                })
                merged = GraphStore(merged).commit(listOf(original), GraphBlobs.files(blobDirectory, listOf(hash)))
            } finally { temporary.delete() }
        }
        merged = GraphStore(merged).indexed()
        if (migrated > 0) notices += Notice(message = "$migrated queued legacy edits were committed into local graph history.")
        if (retained.isNotEmpty()) notices += Notice(message = "${retained.size} legacy requests remain queued for the Mac; nothing was discarded.")
        val pending = if (retained == disk.pending) disk.pending else retained
        val replica = ReplicaState(publisher = snapshot.publisher).let { if (it == disk.replica) disk.replica else it }
        save(disk.copy(graph = merged, pending = pending, failedEdits = failed, notices = notices, records = derived,
            offlineSource = snapshot.source, offlineRevision = snapshot.revision, cursor = 0,
            replica = replica, lastSync = Instant.now().toString(), lastError = null))
    }
    suspend fun exportOffline(): TransferManifest = locked {
        val source = requireNotNull(disk.offlineSource) { "Import a memory file from your Mac first." }
        editsManifest(source, disk.offlineRevision, disk.pending, null, true).copy(publisher = disk.replica.publisher)
    }
    suspend fun bluetoothEdits(source: String, publisher: String? = null, graphCollection: String? = null): TransferManifest = locked {
        UUID.fromString(source)
        graphCollection?.let { target ->
            require(UUID.fromString(target).toString() == target)
            disk.graph?.let { existing ->
                if (existing.bundle.collection != target) {
                    require(disk.offlineSource == null && existing.remoteHeads.isEmpty()) { "This phone already belongs to another graph collection. Its history has been retained." }
                    journal.preserveGraphJoin(existing.bundle.collection)
                    val joined = GraphStore(GraphStore(existing).rehome(target)).indexed()
                    save(disk.copy(graph = joined, offlineSource = source, offlineRevision = 0, replica = disk.replica.copy(publisher = publisher)))
                }
            }
        }
        val sameSource = disk.offlineSource == source
        require(publisher == null || disk.replica.publisher == null || publisher == disk.replica.publisher || disk.pending.all { it.portable }) { "Finish the queued profile and review decisions with the Mac they came from, then sync here." }
        require(sameSource || disk.pending.isEmpty() || standaloneQueue()) { "These queued edits belong to another database or sync method. Acknowledge them there before switching." }
        editsManifest(source, if (sameSource) disk.offlineRevision else 0, if (sameSource || standaloneQueue()) disk.pending else emptyList(), publisher, sameSource || standaloneQueue())
    }
    private fun editsManifest(source: String, revision: Long, ops: List<PendingOp>, publisher: String?, includeHistory: Boolean): TransferManifest {
        disk.graph?.let { gs ->
            require(includeHistory) { "Sync this collection before switching databases; graph edits have been retained." }
            return TransferManifest(type = "edits", source = source, revision = revision, publisher = publisher, created_at = Instant.now().toString(), ops = ops,
                graph = if (publisher != null && publisher == disk.replica.publisher) GraphStore(gs).outbound() else gs.bundle)
        }
        val h = contactHistory()
        val enabled = disk.replica.enabled && includeHistory
        val samePeer = publisher != null && publisher == disk.replica.publisher && includeHistory
        return TransferManifest(type = "edits", source = source, revision = revision, publisher = publisher, created_at = Instant.now().toString(), ops = ops,
            contact_version = 1, contact_heads = if (enabled) h.heads else emptyList(),
            contact_history = if (enabled) (if (samePeer) h.missing(disk.replica.remoteHeads) else h.changes) else emptyList(),
            record_hashes = if (samePeer) disk.replica.recordHashes else emptyMap())
    }
    suspend fun reset() = locked {
        require(disk.graph == null) { "Graph history is durable. Export a backup before switching; reset cannot discard local commits." }
        require(disk.pending.isEmpty() || standaloneQueue()) { "Wait for pending edits before switching devices." }
        save(DiskState(pending = if (standaloneQueue()) disk.pending else emptyList(), replica = if (standaloneQueue()) disk.replica else ReplicaState(), nextLocalId = disk.nextLocalId, failedEdits = disk.failedEdits))
    }
}
