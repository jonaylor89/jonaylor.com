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

/** One atomic JSON transaction contains the Mac's view, cursor AND outbox. No partial-page saves. */
class Store(private val directory: File, private val startupTiming: (String, Long) -> Unit = { _, _ -> }) {
    private val mutex = Mutex()
    private val journal = StoreJournal(directory)
    private val startupIndex = StartupIndex(directory)
    private var historySource: List<ContactChange>? = null
    private var history = ContactHistory()
    private var viewRecords: Records? = null
    private var viewPending: List<PendingOp>? = null
    private var viewReplica: ReplicaState? = null
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
    private fun current(): Records {
        if (viewRecords !== disk.records || viewPending !== disk.pending || viewReplica !== disk.replica) {
            val base = optimistic(disk.records, disk.pending)
            view = if (disk.replica.enabled) contactHistory().project(base, disk.replica.localIds) else base
            viewRecords = disk.records; viewPending = disk.pending; viewReplica = disk.replica
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
        mutable.value = StoreState(records = shown(), pending = disk.pending, failedEdits = disk.failedEdits, lastSync = disk.lastSync, lastError = disk.lastError, notices = disk.notices, ready = loaded, offlineSource = disk.offlineSource, offlineRevision = disk.offlineRevision, replicatedContacts = disk.replica.enabled)
    }
    private fun load() {
        if (loaded) return
        // A corrupt cache must not silently erase a durable outbox.
        val start = System.nanoTime()
        startupIndex.read()?.let { mutable.value = StoreState(records = it) }
        startupTiming("address_book", (System.nanoTime() - start) / 1_000_000)
        disk = journal.load()
        startupTiming("disk", (System.nanoTime() - start) / 1_000_000)
        journal.cachedRecords?.let {
            view = it; viewRecords = disk.records; viewPending = disk.pending; viewReplica = disk.replica
        }
        loaded = true
        val projectStart = System.nanoTime()
        publish()
        startupTiming("projection", (System.nanoTime() - projectStart) / 1_000_000)
        if (journal.cachedRecords == null) runCatching { journal.cacheView(disk, current()) }
        runCatching { startupIndex.save(current()) }
    }
    private fun save(next: DiskState) {
        journal.save(disk, next)
        disk = next
        publish()
        if (journal.checkpointWritten) runCatching { journal.cacheView(disk, current()) }
        runCatching { startupIndex.save(current()) }
    }
    private suspend fun <T> locked(block: () -> T): T = withContext(Dispatchers.IO) {
        mutex.withLock { load(); block() }
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
        val standalone = disk.offlineSource == null && disk.cursor == 0L && disk.records.people.isEmpty() && disk.pending.isEmpty()
        if (disk.replica.enabled || standalone) {
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
        require(disk.replica.enabled) { "Pair with an updated CLI first." }
        val choice = contactHistory().contact(uid)?.conflicts?.get(field)?.firstOrNull { it.change == changeId }
            ?: throw EditRejected("This conflict has changed. Reopen the contact.")
        saveChange(contactHistory().edit(uid, values = JsonObject(mapOf(field to choice.value))))
    }
    suspend fun retryFailed(clientId: String) = locked {
        val failed = requireNotNull(disk.failedEdits.firstOrNull { it.client_id == clientId }) { "This edit has already been recovered." }
        require(failed.kind == "relationship") { "Review this failed edit before recovering it." }
        val retry = failed.copy(client_id = UUID.randomUUID().toString(), sent = false, completed = false, created_at = Instant.now().toString())
        save(disk.copy(pending = disk.pending + retry, failedEdits = disk.failedEdits.filterNot { it.client_id == clientId }))
    }
    suspend fun dismissFailed(clientId: String) = locked { save(disk.copy(failedEdits = disk.failedEdits.filterNot { it.client_id == clientId })) }
    suspend fun snapshot(): DiskState = locked { disk }
    suspend fun restoreBackup(next: DiskState) = locked {
        require(disk.pending.isEmpty()) { "Back up and sync this phone's pending edits before restoring." }
        // A new device must retry acknowledgments, not assume the old device delivered them.
        save(next.copy(pending = next.pending.map { it.copy(sent = it.completed) }, lastError = null))
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
    suspend fun exportOffline(): TransferManifest = locked {
        val source = requireNotNull(disk.offlineSource) { "Import a memory file from your Mac first." }
        editsManifest(source, disk.offlineRevision, disk.pending, null, true).copy(publisher = disk.replica.publisher)
    }
    suspend fun bluetoothEdits(source: String, publisher: String? = null): TransferManifest = locked {
        UUID.fromString(source)
        val sameSource = disk.offlineSource == source
        require(publisher == null || disk.replica.publisher == null || publisher == disk.replica.publisher || disk.pending.all { it.portable }) { "Finish the queued profile and review decisions with the Mac they came from, then sync here." }
        require(sameSource || disk.pending.isEmpty() || standaloneQueue()) { "These queued edits belong to another database or sync method. Acknowledge them there before switching." }
        editsManifest(source, if (sameSource) disk.offlineRevision else 0, if (sameSource || standaloneQueue()) disk.pending else emptyList(), publisher, sameSource || standaloneQueue())
    }
    private fun editsManifest(source: String, revision: Long, ops: List<PendingOp>, publisher: String?, includeHistory: Boolean): TransferManifest {
        val h = contactHistory()
        val enabled = disk.replica.enabled && includeHistory
        val samePeer = publisher != null && publisher == disk.replica.publisher && includeHistory
        return TransferManifest(type = "edits", source = source, revision = revision, publisher = publisher, created_at = Instant.now().toString(), ops = ops,
            contact_version = 1, contact_heads = if (enabled) h.heads else emptyList(),
            contact_history = if (enabled) (if (samePeer) h.missing(disk.replica.remoteHeads) else h.changes) else emptyList(),
            record_hashes = if (samePeer) disk.replica.recordHashes else emptyMap())
    }
    suspend fun reset() = locked {
        require(disk.pending.isEmpty() || standaloneQueue()) { "Wait for pending edits before switching devices." }
        save(DiskState(pending = if (standaloneQueue()) disk.pending else emptyList(), replica = if (standaloneQueue()) disk.replica else ReplicaState(), nextLocalId = disk.nextLocalId, failedEdits = disk.failedEdits))
    }
}
