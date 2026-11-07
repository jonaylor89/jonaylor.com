package app.mypeople

import android.app.Application
import app.mypeople.data.*
import coil3.ImageLoader
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.serialization.json.*
import java.io.File

class MyPeopleApp : Application() {
    lateinit var graph: AppGraph
        private set
    override fun onCreate() {
        super.onCreate()
        val maintenance = applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0 && File(cacheDir,"index-maintenance").isFile
        graph = AppGraph(this,startMemoryImmediately = !maintenance)
    }
}

class AppGraph(context: Application, startMemoryImmediately: Boolean = true) {
    val incoming = kotlinx.coroutines.flow.MutableStateFlow<android.content.Intent?>(null)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val settings = Settings(context)
    private val debug = context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0
    private fun timing(tag: String, stage: String, start: Long) { if (debug) android.util.Log.i(tag,"$stage=${(System.nanoTime()-start)/1000000}ms") }
    val store = Store(File(context.filesDir, "memory"),
        saveTiming = { stage, ms -> if (debug) android.util.Log.i("MyPeopleSave","$stage=${ms}ms") },
        startupTiming = { stage, ms -> if (debug) android.util.Log.i("MyPeopleStartup","$stage=${ms}ms") })
    val imports = MemoryImports(store)
    val offline = OfflineFiles(context, store, imports, settings)
    val bluetooth = BluetoothMemory(context, offline)
    val backups = Backups(context, this)
    val deviceContacts = DeviceContacts(context, this)
    val imageLoader = ImageLoader.Builder(context)
        .build()
    private val messages = Channel<String>(Channel.BUFFERED)
    val feedback = messages.receiveAsFlow()
    private val contactsRequests = Channel<Unit>(Channel.CONFLATED)
    init {
        scope.launch {
            for (request in contactsRequests) {
                delay(500)
                while (contactsRequests.tryReceive().isSuccess) { /* coalesce provider callbacks */ }
                try { deviceContacts.reconcile() }
                catch (_: Exception) { messages.send("Android copies could not be updated. MyPeople contacts are safe; check Settings and retry.") }
            }
        }
        scope.launch {
            deviceContacts.statusFlow.collect { status -> if (status.startsWith("Conflicts")) messages.send("Offline contact conflicts need review in MyPeople. Android copies were left untouched.") }
        }
        scope.launch {
            var previous: Records? = null
            store.state.collect { state ->
                if (state.ready && state.records != previous) {
                    previous = state.records
                    reconcileContacts()
                }
            }
        }
        if (startMemoryImmediately) openMemory()
    }
    fun openMemory() {
        scope.launch {
            try { store.initialize() }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { store.error("Couldn't open the local cache. It has not been overwritten.") }
        }
    }
    /** The application-owned job finishes its durable save even if the edited row disappears. */
    suspend fun submitEdit(kind: String, payload: JsonObject) = scope.async {
        val start=System.nanoTime()
        store.initialize()
        if (kind == "merge") {
            val ids = mergePeople(payload, store.state.value.records)
            if (!store.state.value.replicatedContacts && ids.any { it < 0 }) throw EditRejected("Sync once with the updated CLI to upgrade legacy contacts before merging them.")
            val provider=System.nanoTime()
            if (settings.contactsEnabled) deviceContacts.prepareMerge(ids)
            timing("MyPeopleEdit","merge_provider",provider)
            mergePeople(payload, store.state.value.records) // reconciliation can change the view
        }
        val person = store.state.value.records.people[payload.int("person_id")]
        val addressed = if (payload.text("contact_uid").isEmpty() && person?.contact_uid?.isNotEmpty() == true) JsonObject(payload + ("contact_uid" to JsonPrimitive(person.contact_uid))) else payload
        val durable=System.nanoTime()
        store.enqueue(kind, addressed)
        timing("MyPeopleEdit","durable",durable)
        timing("MyPeopleEdit",if (kind in opKinds) kind else "unsupported",start)
        if (kind == "merge") messages.send(if (store.state.value.replicatedContacts) "Contacts merged on this phone." else "Merge saved on this phone. Sync with your Mac to finish.")
    }.await()

    fun edit(kind: String, payload: JsonObject) {
        scope.launch {
            try { submitEdit(kind, payload) }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { messages.send(editError(e)) }
        }
    }
    fun editError(error: Exception): String = when (error) {
        is IllegalArgumentException -> error.message ?: "This edit could not be saved."
        is SecurityException -> "Contacts permission was revoked. Check Android contacts integration in Settings and try again."
        else -> "Couldn't save this edit. Your saved contacts were kept. Please try again."
    }
    fun reconcileContacts() {
        contactsRequests.trySend(Unit)
    }
    suspend fun retryFailed(clientId: String) {
        store.retryFailed(clientId)
    }
    suspend fun resolveMergeDecision(person: Person, keepMerged: Boolean, cleanPhones: Boolean): Int = scope.async {
        val removed = store.resolveMergeDecision(person, keepMerged, cleanPhones)
        messages.trySend(if (keepMerged) "Merge confirmed." + if (removed > 0) " Removed $removed duplicate phone fields." else "" else "Separate contact records restored. No facts or history were deleted.")
        removed
    }.await()
    suspend fun cleanDuplicatePhones(id: Int, person: Person): Int = scope.async {
        val removed = store.cleanDuplicatePhoneFields(id, person)
        messages.trySend("Removed $removed duplicate phone fields. Original details remain in history.")
        removed
    }.await()
    suspend fun saveContact(card: ContactCard, id: Int? = null, contactUid: String? = null, expectedPerson: Person? = null): Int {
        val start=System.nanoTime()
        return store.saveContact(card, id, contactUid, expectedPerson = expectedPerson).also { timing("MyPeopleEdit","contact_save",start) }
    }
}
