package app.mypeople.data

import kotlinx.serialization.json.*
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.OutputStream
import java.security.DigestOutputStream
import java.security.MessageDigest

/** Local-only, versioned typed checkpoint. Avoids JSON lexing/reflection/object trees at startup.
 * The transfer/backup formats remain JSON. Every field, including receipts and arbitrary JSON
 * payloads, round-trips here. A bad/newer checkpoint is an error, never a fallback to old data.
 */
internal object StoreCheckpoint {
    private val magic = "SHRQDB01".toByteArray(Charsets.US_ASCII)
    private const val MAX_BYTES = 256 * 1024 * 1024
    private const val MAX_ITEMS = 100_000
    private fun hash(bytes: ByteArray, size: Int = bytes.size) = MessageDigest.getInstance("SHA-256").run { update(bytes, 0, size); digest() }

    data class Snapshot(val state: DiskState, val view: Records?)
    private const val PROJECTION_VERSION = 2

    fun encode(state: DiskState, view: Records? = null, formatVersion: Int = 7): ByteArray {
        val bytes = ByteArrayOutputStream()
        write(state, bytes, view, formatVersion)
        return bytes.toByteArray()
    }

    /** Checkpoints stream directly to the fsynced temp file; no full-size buffer copies. */
    fun write(state: DiskState, output: OutputStream, view: Records? = null, formatVersion: Int = 7) {
        require(formatVersion in 1..7 && (formatVersion != 1 || view == null))
        require(formatVersion >= 5 || state.graph == null) { "Graph state requires checkpoint version 5." }
        val digest = MessageDigest.getInstance("SHA-256")
        val stream = DigestOutputStream(output, digest)
        val w = Writer(DataOutputStream(stream), formatVersion)
        w.out.write(magic); w.out.writeInt(formatVersion)
        w.records(state.records)
        w.out.writeLong(state.cursor); w.out.writeInt(state.nextLocalId)
        w.list(state.pending, w::op); w.list(state.failedEdits, w::op)
        w.nullString(state.lastSync); w.nullString(state.lastError)
        w.list(state.notices) { w.string(it.id); w.string(it.message) }
        w.nullString(state.offlineSource); w.out.writeLong(state.offlineRevision); w.out.writeLong(state.journalSequence)
        val r = state.replica
        w.out.writeBoolean(r.enabled); w.list(r.changes, w::change); w.strings(r.remoteHeads)
        w.map(r.localIds, w::string, w.out::writeInt); w.map(r.recordHashes, w::string, w::string); w.nullString(r.publisher)
        if (formatVersion >= 7) w.graph(state.graph)
        else if (formatVersion >= 5) w.element(json.encodeToJsonElement(state.graph))
        if (formatVersion >= 2) {
            w.out.writeBoolean(view != null)
            if (view != null) { w.out.writeInt(PROJECTION_VERSION); w.records(view) }
        }
        w.out.flush()
        require(w.out.size() <= MAX_BYTES - 32) { "Local checkpoint exceeds supported size." }
        stream.on(false)
        output.write(digest.digest())
        output.flush()
    }

    fun decode(bytes: ByteArray): DiskState = snapshot(bytes).state

    fun snapshot(bytes: ByteArray): Snapshot {
        require(bytes.size in (magic.size + 4 + 32)..MAX_BYTES) { "Invalid local checkpoint size." }
        require(hash(bytes, bytes.size - 32).contentEquals(bytes.copyOfRange(bytes.size - 32, bytes.size))) { "Damaged local checkpoint." }
        val input = DataInputStream(ByteArrayInputStream(bytes, 0, bytes.size - 32))
        val actual = ByteArray(magic.size); input.readFully(actual)
        require(actual.contentEquals(magic)) { "Unsupported local checkpoint." }
        val version = input.readInt()
        require(version in 1..7) { "Unsupported local checkpoint version." }
        val r = Reader(input, version)
        val records = r.records()
        val cursor = input.readLong(); val nextLocalId = input.readInt()
        val pending = r.list(r::op); val failed = r.list(r::op)
        val lastSync = r.nullString(); val lastError = r.nullString()
        val notices = r.list { Notice(r.string(), r.string()) }
        val source = r.nullString(); val revision = input.readLong(); val sequence = input.readLong()
        val replica = ReplicaState(input.readBoolean(), r.list(r::change), r.strings(), r.map(r::string, input::readInt), r.map(r::string, r::string), r.nullString())
        val graph = if (version >= 7) r.graph() else if (version >= 5) r.element().let { if (it == JsonNull) null else json.decodeFromJsonElement<GraphState>(it) } else null
        val view = if (version >= 2 && input.readBoolean()) {
            val projectionVersion = input.readInt()
            r.records().takeIf { projectionVersion == PROJECTION_VERSION }
        } else null
        require(input.available() == 0) { "Unexpected data in local checkpoint." }
        return Snapshot(DiskState(records, cursor, nextLocalId, pending, failed, lastSync, lastError, notices, source, revision, sequence, replica, graph), view)
    }

    private class Writer(val out: DataOutputStream, val version: Int) {
        private val stringLists = mutableMapOf<List<String>, Int>()
        fun string(value: String) {
            val bytes = value.toByteArray(Charsets.UTF_8)
            require(bytes.size <= 32 * 1024 * 1024 && out.size().toLong() + bytes.size < MAX_BYTES - 32) { "Local checkpoint exceeds supported size." }
            out.writeInt(bytes.size); out.write(bytes)
        }
        fun nullString(value: String?) { out.writeBoolean(value != null); if (value != null) string(value) }
        fun <T> list(items: List<T>, write: (T) -> Unit) { require(items.size <= MAX_ITEMS); out.writeInt(items.size); items.forEach(write) }
        fun strings(items: List<String>) {
            if (version < 3) { list(items, ::string); return }
            val existing = stringLists[items]
            if (existing != null) { out.writeInt(-existing - 1); return }
            require(stringLists.size < 1_000_000)
            stringLists[items] = stringLists.size
            list(items, ::string)
        }
        fun <K,V> map(items: Map<K,V>, key: (K) -> Unit, value: (V) -> Unit) { require(items.size <= MAX_ITEMS); out.writeInt(items.size); items.forEach { (k,v) -> key(k); value(v) } }
        fun element(value: JsonElement) {
            when (value) {
                JsonNull -> out.writeByte(0)
                is JsonPrimitive -> when {
                    value.isString -> { out.writeByte(1); string(value.content) }
                    value.booleanOrNull == false -> out.writeByte(2)
                    value.booleanOrNull == true -> out.writeByte(3)
                    else -> { out.writeByte(4); string(value.content) }
                }
                is JsonArray -> { out.writeByte(5); list(value, ::element) }
                is JsonObject -> { out.writeByte(6); map(value, ::string, ::element) }
            }
        }
        fun graph(state: GraphState?) {
            out.writeBoolean(state != null)
            if (state == null) return
            val b = state.bundle
            string(b.collection); strings(b.heads)
            list(b.commits) { c ->
                string(c.id); string(c.collection); string(c.peer); string(c.recorded_at)
                out.writeInt(c.version); strings(c.parents)
                require(c.operations.size <= 1_000_000)
                out.writeInt(c.operations.size)
                c.operations.forEach { op -> string(op.id); string(op.kind); string(op.target); element(op.payload); strings(op.replaces) }
            }
            map(b.blobs, ::string, ::string)
            string(state.peer); map(state.localIds, ::string, out::writeInt); strings(state.remoteHeads)
        }
        fun field(f: ContactField) {
            require(version >= 4 || !f.user_added) { "Manual link provenance requires checkpoint version 4." }
            require(version >= 6 || f.object_id.isEmpty()) { "Stable contact point identity requires checkpoint version 6." }
            string(f.kind); string(f.value); string(f.label); out.writeBoolean(f.preferred); string(f.structured); string(f.region)
            if (version >= 4) out.writeBoolean(f.user_added)
            if (version >= 6) string(f.object_id)
        }
        fun card(c: ContactCard) {
            strings(listOf(c.name, c.given, c.family, c.middle, c.prefix, c.suffix, c.phonetic))
            list(c.fields, ::field)
            strings(listOf(c.birthday, c.organization, c.title, c.notes, c.photo))
            out.writeBoolean(c.favorite); string(c.preferred_channel); string(c.region)
            strings(c.originals); strings(c.source_records); out.writeBoolean(c.user_edited); string(c.edit_id); out.writeBoolean(c.legacy_unverified)
        }
        fun person(p: Person) {
            string(p.name); string(p.contact_uid); strings(p.contact_aliases)
            out.writeBoolean(p.card != null); p.card?.let(::card)
            out.writeBoolean(p.trashed); out.writeBoolean(p.can_undo_merge)
            map(p.contact_conflicts, ::string) { list(it) { c -> string(c.change); element(c.value) } }
            strings(p.aliases); list(p.identifiers) { string(it.kind); string(it.value) }; nullString(p.photo)
            string(p.category); out.writeDouble(p.closeness)
            out.writeBoolean(p.cadence_days != null); p.cadence_days?.let(out::writeDouble)
            string(p.trend); out.writeInt(p.days_365); out.writeBoolean(p.muted)
            list(p.channels) { string(it.channel); out.writeInt(it.count) }; nullString(p.first_contact); nullString(p.last_contact)
        }
        fun event(e: Event) { out.writeInt(e.person_id); string(e.type); string(e.value); string(e.date); out.writeDouble(e.confidence); string(e.source); nullString(e.evidence); nullString(e.said_at); string(e.created_at) }
        fun profile(p: Profile) { out.writeInt(p.person_id); string(p.site); string(p.url); string(p.title); string(p.status); string(p.assessment); string(p.reason); out.writeDouble(p.confidence) }
        fun moment(m: Moment) { out.writeInt(m.person_id); string(m.kind); string(m.reason); nullString(m.context); out.writeDouble(m.score); string(m.surfaced_on); string(m.status) }
        fun change(c: ContactChange) {
            string(c.id); strings(c.parents); string(c.contact_uid); element(c.values)
            map(c.adds, ::string) { list(it, ::element) }; map(c.removes, ::string, ::strings); strings(c.links); map(c.replaces, ::string, ::strings)
        }
        fun op(o: PendingOp) { string(o.client_id); string(o.kind); element(o.payload); out.writeBoolean(o.sent); string(o.created_at); out.writeBoolean(o.completed) }
        fun records(r: Records) {
            map(r.people, out::writeInt, ::person); map(r.events, ::string, ::event); map(r.profiles, ::string, ::profile); map(r.moments, ::string, ::moment)
            map(r.dupes, ::string) { list(it.person_ids, out::writeInt); strings(it.clues) }; map(r.contactChanges, ::string, ::change)
        }
    }

    private class Reader(val input: DataInputStream, val version: Int) {
        private val stringLists = mutableListOf<List<String>>()
        fun count(): Int = input.readInt().also { require(it in 0..MAX_ITEMS && it <= input.available()) { "Invalid checkpoint collection size." } }
        fun string(): String {
            val size = input.readInt()
            require(size in 0..(32 * 1024 * 1024) && size <= input.available()) { "Invalid checkpoint string." }
            val bytes = ByteArray(size); input.readFully(bytes); return bytes.toString(Charsets.UTF_8)
        }
        fun nullString(): String? = if (input.readBoolean()) string() else null
        fun <T> list(read: () -> T): List<T> = List(count()) { read() }
        fun strings(): List<String> {
            if (version < 3) return list(::string)
            val size = input.readInt()
            if (size < 0) {
                val index = -size.toLong() - 1
                require(index in 0 until stringLists.size.toLong()) { "Invalid shared checkpoint string list." }
                return stringLists[index.toInt()]
            }
            require(size in 0..MAX_ITEMS && size <= input.available() && stringLists.size < 1_000_000) { "Invalid checkpoint string list." }
            return List(size) { string() }.also(stringLists::add)
        }
        fun <K,V> map(key: () -> K, value: () -> V): Map<K,V> {
            val size = count(); val result = LinkedHashMap<K,V>(size)
            repeat(size) { require(result.put(key(), value()) == null) { "Duplicate checkpoint key." } }
            return result
        }
        fun element(depth: Int = 0): JsonElement {
            require(depth < 64) { "Checkpoint JSON nesting is too deep." }
            return when (input.readUnsignedByte()) {
                0 -> JsonNull; 1 -> JsonPrimitive(string()); 2 -> JsonPrimitive(false); 3 -> JsonPrimitive(true)
                4 -> json.parseToJsonElement(string()).also { require(it is JsonPrimitive && !it.isString && it != JsonNull && it.booleanOrNull == null) { "Invalid checkpoint number." } }
                5 -> JsonArray(list { element(depth + 1) }); 6 -> JsonObject(map(::string) { element(depth + 1) })
                else -> throw IllegalArgumentException("Unknown checkpoint JSON type.")
            }
        }
        fun field() = ContactField(string(), string(), string(), input.readBoolean(), string(), string(), if (version >= 4) input.readBoolean() else false, if (version >= 6) string() else "")
        fun card(): ContactCard {
            val names = strings().also { require(it.size == 7) }
            val fields = list(::field); val text = strings().also { require(it.size == 5) }
            return ContactCard(names[0], names[1], names[2], names[3], names[4], names[5], names[6], fields,
                text[0], text[1], text[2], text[3], text[4], input.readBoolean(), string(), string(), strings(), strings(), input.readBoolean(), string(), input.readBoolean())
        }
        fun person(): Person {
            val name = string(); val uid = string(); val aliases = strings(); val card = if (input.readBoolean()) card() else null
            return Person(name, uid, aliases, card, input.readBoolean(), input.readBoolean(), map(::string) { list { ContactConflict(string(), element()) } }, strings(),
                list { Identifier(string(), string()) }, nullString(), string(), input.readDouble(), if (input.readBoolean()) input.readDouble() else null,
                string(), input.readInt(), input.readBoolean(), list { ChannelCount(string(), input.readInt()) }, nullString(), nullString())
        }
        fun event() = Event(input.readInt(), string(), string(), string(), input.readDouble(), string(), nullString(), nullString(), string())
        fun profile() = Profile(input.readInt(), string(), string(), string(), string(), string(), string(), input.readDouble())
        fun moment() = Moment(input.readInt(), string(), string(), nullString(), input.readDouble(), string(), string())
        fun graph(): GraphState? {
            if (!input.readBoolean()) return null
            val collection = string(); val heads = strings()
            val commits = list {
                val id = string(); val book = string(); val peer = string(); val at = string()
                val v = input.readInt(); val parents = strings()
                val count = input.readInt()
                require(count in 0..1_000_000) { "Invalid graph operation count" }
                val operations = List(count) { GraphOperation(string(), string(), string(), element().jsonObject, strings()) }
                GraphCommit(id, book, peer, at, v, parents, operations)
            }
            val blobs = map(::string, ::string)
            return GraphState(GraphBundle(collection, heads, commits, blobs), string(), map(::string, input::readInt), strings())
        }
        fun change() = ContactChange(string(), strings(), string(), element().jsonObject, map(::string) { list { element() } }, map(::string, ::strings), strings(), map(::string, ::strings))
        fun op() = PendingOp(string(), string(), element().jsonObject, input.readBoolean(), string(), input.readBoolean())
        fun records() = Records(map(input::readInt, ::person), map(::string, ::event), map(::string, ::profile), map(::string, ::moment), map(::string) { Dupes(list(input::readInt), strings()) }, map(::string, ::change))
    }
}
