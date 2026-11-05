package app.mypeople.ui

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.ContactsContract as C
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import app.mypeople.AppGraph
import app.mypeople.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private fun seedFrom(intent: Intent): ContactCard {
    fun text(key: String) = intent.getStringExtra(key).orEmpty().take(10000)
    val fields = mutableListOf<ContactField>()
    listOf(C.Intents.Insert.PHONE to "phone", C.Intents.Insert.SECONDARY_PHONE to "phone", C.Intents.Insert.TERTIARY_PHONE to "phone", C.Intents.Insert.EMAIL to "email", C.Intents.Insert.SECONDARY_EMAIL to "email", C.Intents.Insert.TERTIARY_EMAIL to "email", C.Intents.Insert.POSTAL to "address").forEach { (key, kind) ->
        text(key).takeIf { it.isNotBlank() }?.let { fields.add(ContactField(kind, it)) }
    }
    return ContactCard(name = text(C.Intents.Insert.NAME), fields = fields, notes = text(C.Intents.Insert.NOTES), organization = text(C.Intents.Insert.COMPANY), title = text(C.Intents.Insert.JOB_TITLE))
}

class ContactLaunchState : ViewModel() {
    val seed = mutableStateOf<ContactCard?>(null)
    val editing = mutableStateOf<Int?>(null)
    val chooseExisting = mutableStateOf(false)
    val picking = mutableStateOf(false)
    val returnResult = mutableStateOf(false)
    val pickMime = mutableStateOf<String?>(null)
    val imported = mutableStateOf<List<ContactCard>?>(null)
    val ambiguous = mutableStateOf<Pair<List<Int>, Boolean>?>(null)
    val error = mutableStateOf<String?>(null)
}

/** All incoming data is staged for review. An external Intent never silently writes contacts. */
@Composable
fun ContactLaunchHandler(graph: AppGraph, openPerson: (Int) -> Unit) {
    val incoming by graph.incoming.collectAsStateWithLifecycle()
    val state by graph.store.state.collectAsStateWithLifecycle()
    val context = LocalContext.current; val activity = context as? Activity; val scope = rememberCoroutineScope()
    val model: ContactLaunchState = viewModel()
    var seed by model.seed; var editing by model.editing
    var chooseExisting by model.chooseExisting; var picking by model.picking
    var returnResult by model.returnResult
    var pickMime by model.pickMime; var imported by model.imported
    var ambiguous by model.ambiguous; var error by model.error
    LaunchedEffect(incoming, state.ready) {
        val intent = incoming ?: return@LaunchedEffect
        if (!state.ready) return@LaunchedEffect
        returnResult = activity?.callingActivity != null && intent.action != Intent.ACTION_VIEW
        try {
            when {
                intent.action == Intent.ACTION_PICK -> {
                    require(graph.settings.contactsEnabled && graph.deviceContacts.permitted()) { "Enable Android contacts integration in Settings before returning a contact to another app." }
                    pickMime = intent.type; picking = true
                }
                intent.type in setOf("text/x-vcard", "text/vcard") -> {
                    @Suppress("DEPRECATION") val uri = intent.data ?: intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                    require(uri?.scheme == "content") { "Choose a vCard through Android's file picker." }
                    imported = withContext(Dispatchers.IO) { requireNotNull(context.contentResolver.openInputStream(uri)).use { VCards.parse(Transfer.readLimited(it, 16 * 1024 * 1024).toString(Charsets.UTF_8)) } }
                }
                intent.action in setOf(Intent.ACTION_INSERT, Intent.ACTION_INSERT_OR_EDIT) -> { seed = seedFrom(intent); editing = null; chooseExisting = intent.action == Intent.ACTION_INSERT_OR_EDIT }
                intent.action in setOf(Intent.ACTION_VIEW, Intent.ACTION_EDIT) -> {
                    val uri = requireNotNull(intent.data)
                    require(graph.deviceContacts.permitted()) { "Allow Contacts access in MyPeople Settings to open system contact links." }
                    val uids = withContext(Dispatchers.IO) { graph.deviceContacts.uidsFor(uri) }
                    val entries = state.records.people.entries.filter { it.value.contact_uid in uids || it.value.contact_aliases.any { alias -> alias in uids } }
                    if (entries.size > 1) { ambiguous = entries.map { it.key } to (intent.action == Intent.ACTION_EDIT); return@LaunchedEffect }
                    val entry = entries.singleOrNull()
                    require(entry != null) { "This contact belongs to another account. Import it in Settings first; it has not been changed." }
                    if (intent.action == Intent.ACTION_VIEW) openPerson(entry.key) else { editing = entry.key; seed = entry.value.contactCard() }
                }
            }
        } catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (e: Exception) { error = e.message ?: "Could not open this contact." }
        finally { if (graph.incoming.value === intent) graph.incoming.value = null }
    }
    if (picking || chooseExisting) Dialog(onDismissRequest = { picking = false; chooseExisting = false; seed = null }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        MyPeopleTheme {
            Surface {
                Column {
                    Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                        TextButton(onClick = { picking = false; chooseExisting = false; seed = null }) { Text("Cancel") }
                        if (chooseExisting) TextButton(onClick = { chooseExisting = false }) { Text("Create new instead") }
                    }
                    PeopleScreen(state.records, graph) { id ->
                        if (chooseExisting) {
                            val person = state.records.people.getValue(id)
                            seed = fillContact(person.contactCard(), seed!!.copy(name = person.name)); editing = id; chooseExisting = false
                        } else scope.launch {
                            try {
                                graph.deviceContacts.reconcile()
                                val uri = withContext(Dispatchers.IO) { graph.deviceContacts.lookup(state.records.people.getValue(id).contact_uid, pickMime) }
                                require(uri != null) { "This contact has no requested field, or could not be published to Android." }
                                activity?.setResult(Activity.RESULT_OK, Intent().setDataAndType(uri, context.contentResolver.getType(uri)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                                picking = false; activity?.finish()
                            } catch (e: Exception) { error = e.message }
                        }
                    }
                }
            }
        }
    }
    if (!chooseExisting) seed?.let { initial -> ContactEditor(graph, editing, initial, close = { seed = null; editing = null }, saved = { id ->
        if (returnResult && graph.settings.contactsEnabled) scope.launch {
            try {
                graph.deviceContacts.reconcile()
                val uid = graph.store.state.value.records.people.getValue(id).contact_uid
                val uri = withContext(Dispatchers.IO) { graph.deviceContacts.lookup(uid) }
                require(uri != null) { "Contact saved, but Android could not return its URI. Open it in People." }
                activity?.setResult(Activity.RESULT_OK, Intent().setData(uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                activity?.finish()
            } catch (e: Exception) { openPerson(id); error = e.message }
        } else openPerson(id)
    }) }
    imported?.let { ImportContactsReview(it, graph) { imported = null } }
    ambiguous?.let { (ids, edit) -> AlertDialog(onDismissRequest = { ambiguous = null }, title = { Text("Which person?") }, text = {
        Column { Text("Android grouped several MyPeople contacts. They have not been merged here."); ids.forEach { id -> TextButton(onClick = {
            ambiguous = null
            if (edit) { editing = id; seed = state.records.people.getValue(id).contactCard() } else openPerson(id)
        }) { Text(state.records.people[id]?.name.orEmpty()) } } }
    }, confirmButton = { TextButton(onClick = { ambiguous = null }) { Text("Cancel") } }) }
    error?.let { message -> AlertDialog(onDismissRequest = { error = null }, title = { Text("Contact action unavailable") }, text = { Text(message) }, confirmButton = { TextButton(onClick = { error = null }) { Text("Close") } }) }
}
