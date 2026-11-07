package app.mypeople.data

import android.app.Instrumentation
import android.content.Context
import android.os.Bundle
import android.os.PowerManager
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable
private data class PhoneCleanupEdit(val id: Int, val before: Person, val after: ContactCard, val removed: Int)
@Serializable
private data class PhoneCleanupPlan(val token: String, val collection: String, val heads: List<String>, val edits: List<PhoneCleanupEdit>)

/** Explicit user-authorized maintenance of the existing graph, never a fixture/test runner.
 * Preview first; apply requires its token and exact frontier, and verifies a complete encrypted
 * recovery backup before using normal Store saves. No contact payloads leave app-private files. */
class PhoneDuplicateMaintenance : Instrumentation() {
    private var options = Bundle()
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); options = arguments ?: Bundle(); start() }
    override fun onStart() {
        val context = targetContext
        val output = Bundle()
        val lock = (context.getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MyPeople:phone-cleanup")
        try {
            require(File(context.cacheDir, "index-maintenance").isFile) { "Stop the app and prepare maintenance first" }
            lock.acquire(30 * 60 * 1000L)
            runBlocking {
                val store = Store(File(context.filesDir, "memory")); store.initialize()
                val state = store.snapshot()
                val native = requireNotNull(state.graph) { "Native graph history is required" }
                val planFile = File(context.cacheDir, "phone-cleanup-plan.json")
                when (options.getString("op")) {
                    "preview" -> {
                        val graph = GraphStore(native).graph
                        val edits = mutableListOf<PhoneCleanupEdit>()
                        var conflicts = 0; var shared = 0; var scanned = 0
                        for ((id, person) in store.state.value.records.people) {
                            if (person.trashed) continue
                            scanned++
                            if (person.contact_conflicts.isNotEmpty()) { conflicts++; continue }
                            val card = person.contactCard()
                            val cleanup = card.withoutDuplicatePhones()
                            if (cleanup.removed == 0) continue
                            // A contact-point object's metadata can be owned by multiple people.
                            // Never change another person's labels/defaults as a side effect.
                            val members = (person.contact_aliases + person.contact_uid).toSet()
                            val changesSharedPoint = cleanup.card.fields.any { field ->
                                field.object_id.isNotEmpty() && card.fields.firstOrNull { it.object_id == field.object_id } != field &&
                                    graph.incoming(field.object_id).any { (edge, entity) -> entity.type == "has_contact_point" && entity.from !in members && graph.active(edge) }
                            }
                            if (changesSharedPoint) { shared++; continue }
                            edits += PhoneCleanupEdit(id, person, cleanup.card, cleanup.removed)
                        }
                        val plan = PhoneCleanupPlan(UUID.randomUUID().toString(), native.bundle.collection, native.bundle.heads, edits)
                        durable(planFile, json.encodeToString(plan))
                        output.putString("stream", "PHONE CLEANUP PREVIEW scanned=$scanned contacts=${edits.size} extraFields=${edits.sumOf { it.removed }} offlineConflictsSkipped=$conflicts sharedMetadataSkipped=$shared plan=${plan.token}")
                    }
                    "apply" -> {
                        val plan = json.decodeFromString<PhoneCleanupPlan>(planFile.readText())
                        require(options.getString("confirm") == plan.token) { "Explicit preview token required" }
                        require(native.bundle.collection == plan.collection && native.bundle.heads == plan.heads) { "The graph changed; preview again" }
                        require(plan.edits.all { edit ->
                            val current = store.state.value.records.people[edit.id]
                            current == edit.before && !edit.before.trashed && edit.before.contact_conflicts.isEmpty() &&
                                edit.before.contactCard().withoutDuplicatePhones().let { it.card == edit.after && it.removed == edit.removed }
                        }) { "The preview no longer matches; nothing was changed" }
                        if (plan.edits.isEmpty()) {
                            output.putString("stream", "PHONE CLEANUP APPLIED contacts=0 extraFields=0")
                        } else {
                            val recovery = verifiedMaintenanceRecovery(context, state, "phone-cleanup", json.encodeToString(plan))
                            var changed = 0; var removed = 0
                            for (edit in plan.edits) {
                                require(store.cleanDuplicatePhoneFields(edit.id, edit.before) == edit.removed)
                                changed++; removed += edit.removed
                                durable(File(recovery, "progress.txt"), "contacts=$changed extraFields=$removed\n")
                            }
                            // A fresh Store must observe the durable result, not only our in-process view.
                            val reopened = Store(File(context.filesDir, "memory")); reopened.initialize()
                            require(plan.edits.all { edit -> reopened.state.value.records.people[edit.id]?.contactCard()?.fields?.sortedBy { it.object_id } == edit.after.fields.sortedBy { it.object_id } }) { "Restart verification failed; recovery retained" }
                            val remaining = reopened.state.value.records.people.values.filterNot { it.trashed }.sumOf { it.contactCard().withoutDuplicatePhones().removed }
                            output.putString("stream", "PHONE CLEANUP APPLIED contacts=$changed extraFields=$removed remainingRemovableFields=$remaining recovery=${recovery.name}")
                        }
                    }
                    else -> error("Choose preview or apply")
                }
            }
            finish(0, output)
        } catch (error: Throwable) {
            // Exceptions can contain contact content. Print only their class, not their message.
            output.putString("stream", "Phone cleanup stopped: ${error.javaClass.simpleName}; saved data, preview and recovery files retained.")
            finish(1, output)
        } finally { if (lock.isHeld) lock.release() }
    }

    private fun durable(file: File, text: String) {
        FileOutputStream(file).use { it.write(text.toByteArray()); it.fd.sync() }
    }
}
