package app.mypeople.ui

import android.Manifest
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.mypeople.AppGraph
import app.mypeople.data.*
import kotlinx.serialization.json.decodeFromJsonElement
import app.mypeople.data.text
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

fun matchingContacts(card: ContactCard, records: Records): List<Int> {
    val emails = card.fields.filter { it.kind == "email" }.map { it.value.trim().lowercase() }.toSet()
    val phones = card.fields.filter { it.kind == "phone" }.mapNotNull { dialable(it.value, it.region.ifEmpty { card.region })?.substringBefore(";ext=") }.toSet()
    return records.people.filterValues { p ->
        !p.trashed && (p.name.equals(card.name, true) || p.contactFields().any { f ->
            (f.kind == "email" && f.value.lowercase().trim() in emails) || (f.kind == "phone" && dialable(f.value, f.region.ifEmpty { p.contactCard().region })?.substringBefore(";ext=") in phones)
        })
    }.keys.toList()
}
fun fillContact(existing: ContactCard, incoming: ContactCard): ContactCard = existing.copy(
    given = existing.given.ifBlank { incoming.given }, family = existing.family.ifBlank { incoming.family },
    middle = existing.middle.ifBlank { incoming.middle }, prefix = existing.prefix.ifBlank { incoming.prefix }, suffix = existing.suffix.ifBlank { incoming.suffix },
    phonetic = existing.phonetic.ifBlank { incoming.phonetic }, birthday = existing.birthday.ifBlank { incoming.birthday },
    organization = existing.organization.ifBlank { incoming.organization }, title = existing.title.ifBlank { incoming.title },
    notes = existing.notes.ifBlank { incoming.notes }, photo = existing.photo.ifBlank { incoming.photo },
    fields = ((if (existing.legacy_unverified && !incoming.legacy_unverified && incoming.fields.any { it.kind == "phone" }) existing.fields.filterNot { it.kind == "phone" } else existing.fields) + incoming.fields).distinctBy { Triple(it.kind, it.value, it.label) },
    originals = (existing.originals + incoming.originals).distinct(),
    source_records = (existing.source_records + incoming.source_records).distinct(),
    legacy_unverified = incoming.legacy_unverified || (existing.legacy_unverified && incoming.fields.none { it.kind == "phone" }),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ImportContactsReview(cards: List<ContactCard>, graph: AppGraph, close: () -> Unit) {
    val importState by graph.store.state.collectAsStateWithLifecycle()
    val records = importState.records
    val matches = remember(cards) { cards.map { matchingContacts(it, records) } }
    var selected by remember(cards) { mutableStateOf(cards.indices.filter { matches[it].isEmpty() }.toSet()) }
    var targets by remember(cards) { mutableStateOf(emptyMap<Int, Int>()) }
    var completed by remember(cards) { mutableStateOf(emptySet<Int>()) }
    var busy by remember { mutableStateOf(false) }; var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Dialog(onDismissRequest = { if (!busy) close() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        MyPeopleTheme {
            Scaffold(topBar = { TopAppBar(title = { Text("Review import · ${cards.size}") }, navigationIcon = { TextButton(enabled = !busy, onClick = close) { Text("Cancel") } }, actions = {
                TextButton(enabled = !busy && selected.isNotEmpty(), onClick = { scope.launch {
                    busy = true; error = null
                    try {
                        for (index in selected.sorted()) {
                            if (index in completed) continue
                            val target = targets[index]
                            val old = graph.store.state.value.records.people[target]
                            graph.saveContact(if (old == null) cards[index] else fillContact(old.contactCard(), cards[index]), target)
                            completed = completed + index
                        }
                        close()
                    } catch (e: Exception) { error = "${completed.size} saved; remaining contacts were not discarded. ${e.message.orEmpty()}" }
                    finally { busy = false }
                } }) { Text(if (busy) "Importing…" else "Import ${selected.size}") }
            }) }) { padding ->
                LazyColumn(Modifier.padding(padding), contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item { Text("Nothing is automatically merged. Matches start unchecked. Choose a target to fill blanks and add fields, or deliberately create a separate person. Originals are retained.") }
                    error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
                    itemsIndexed(cards) { index, card ->
                        JournalCard {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Row { Checkbox(index in selected || index in completed, enabled = !busy && index !in completed, onCheckedChange = { checked -> selected = if (checked) selected + index else selected - index }); Text(card.name, Modifier.padding(top = 12.dp), style = MaterialTheme.typography.titleMedium) }
                                card.fields.take(4).forEach { Text("${it.label.ifBlank { it.kind }}: ${it.value}", style = MaterialTheme.typography.bodySmall) }
                                if (index in completed) Text("Saved")
                                else {
                                    val options = listOf("Create separate contact") + matches[index].map { "Fill #$it · ${records.people[it]?.name}" }
                                    val current = targets[index]?.let { "Fill #$it · ${records.people[it]?.name}" } ?: options.first()
                                    Choice("Import as", current, options) { value ->
                                        val chosen = matches[index].firstOrNull { "Fill #$it · ${records.people[it]?.name}" == value }
                                        targets = if (chosen == null) targets - index else targets + (index to chosen)
                                        selected = selected + index
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun ContactsSettings(graph: AppGraph, state: StoreState, feedback: (String) -> Unit) {
    val context = LocalContext.current; val scope = rememberCoroutineScope()
    var enabled by remember { mutableStateOf(graph.settings.contactsEnabled) }
    var peopleFirst by remember { mutableStateOf(graph.settings.peopleFirst) }
    val providerStatus by graph.deviceContacts.statusFlow.collectAsStateWithLifecycle()
    var busy by remember { mutableStateOf(false) }; var status by remember { mutableStateOf(graph.deviceContacts.status) }
    LaunchedEffect(providerStatus) { status = providerStatus; enabled = graph.settings.contactsEnabled }
    var candidates by remember { mutableStateOf<List<ContactCard>?>(null) }
    var recovering by remember { mutableStateOf<PendingOp?>(null) }
    var report by remember { mutableStateOf(false) }; var consent by remember { mutableStateOf(false) }
    var permissionAction by remember { mutableStateOf("") }; var conflict by remember { mutableStateOf("") }
    var backupAction by remember { mutableStateOf("") }; var backupUri by remember { mutableStateOf<Uri?>(null) }
    // Secrets deliberately never saved in instance state.
    var passphrase by remember { mutableStateOf("") }; var backupError by remember { mutableStateOf<String?>(null) }
    fun runTask(block: suspend () -> Unit) { scope.launch { busy = true; try { block() } catch (e: Exception) { feedback(e.message ?: "Operation failed; saved contacts were kept.") } finally { busy = false } } }
    fun reconcile(prefer: String = "") = runTask { status = graph.deviceContacts.reconcile(prefer); enabled = graph.settings.contactsEnabled }
    fun enableIntegration() = runTask { withContext(Dispatchers.IO) { graph.deviceContacts.ensureAccount() }; graph.settings.contactsEnabled = true; enabled = true; status = graph.deviceContacts.reconcile() }
    fun importDevice() = runTask { candidates = graph.deviceContacts.importCandidates() }
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (permissionAction == "enable" && result.values.all { it }) { enableIntegration() }
        else if (permissionAction == "import" && result[Manifest.permission.READ_CONTACTS] == true) importDevice()
        else feedback("Contacts permission was not granted. Your address book is still available in MyPeople.")
    }
    val importFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> if (uri != null) runTask {
        candidates = withContext(Dispatchers.IO) { requireNotNull(context.contentResolver.openInputStream(uri)).use { VCards.parse(Transfer.readLimited(it, 16 * 1024 * 1024).toString(Charsets.UTF_8)) } }
    } }
    val createBackup = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        if (uri != null) runTask { try { graph.backups.export(uri, passphrase); feedback("Full phone backup saved. Keep its passphrase somewhere safe.") } finally { passphrase = ""; backupAction = "" } }
        else { passphrase = ""; backupAction = "" }
    }
    val restoreBackup = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> if (uri != null) { backupUri = uri; backupAction = "restore"; backupError = null; passphrase = "" } }
    JournalCard {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Your address book", style = MaterialTheme.typography.titleLarge)
            Row { Checkbox(peopleFirst, { peopleFirst = it; graph.settings.peopleFirst = it }); Text("Open to People on launch", Modifier.padding(top = 12.dp)) }
            OutlinedButton(enabled = !busy, onClick = { importFile.launch(arrayOf("text/x-vcard", "text/vcard", "application/octet-stream", "text/plain")) }) { Text("Import vCard · review first") }
            OutlinedButton(enabled = !busy, onClick = { permissionAction = "import"; permissions.launch(arrayOf(Manifest.permission.READ_CONTACTS)) }) { Text("Import existing Android contacts") }
            OutlinedButton(enabled = !busy, onClick = { runTask { shareContacts(context, state.records.people.values.filterNot { it.trashed }.map { it.contactCard() }) } }) { Text("Export address book as vCard") }
            TextButton(onClick = { report = true }) { Text("Migration safety report") }
            Text("vCard files are unencrypted and contain contact details. They do not contain MyPeople facts, evidence, or conversation history.", style = MaterialTheme.typography.bodySmall)
        }
    }
    JournalCard {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Android contacts integration", style = MaterialTheme.typography.titleLarge)
            Text("Keeps a separate MyPeople account for the dialer, messaging apps, and system pickers. Only verified contact details are copied—not facts, quotes, or relationship scores. Other accounts are never written to.")
            Row { Switch(enabled && graph.deviceContacts.permitted(), enabled = !busy, onCheckedChange = { value ->
                if (value) consent = true else { graph.settings.contactsEnabled = false; enabled = false; status = "Integration paused. Existing Android copies remain; remove the MyPeople account in Android Settings to remove them." }
            }); Text("Enable integration", Modifier.padding(start = 12.dp, top = 12.dp)) }
            Text(status, style = MaterialTheme.typography.bodySmall)
            if (enabled) {
                OutlinedButton(enabled = !busy, onClick = { reconcile() }) { Text("Reconcile Android contacts") }
                Text("Edits in other contact apps are imported. If both sides change, that contact is left untouched until you choose which version wins.", style = MaterialTheme.typography.bodySmall)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(enabled = !busy, onClick = { conflict = "mypeople" }) { Text("Keep MyPeople versions") }
                    TextButton(enabled = !busy, onClick = { conflict = "android" }) { Text("Keep Android versions") }
                }
            }
        }
    }
    JournalCard {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Backup & recovery", style = MaterialTheme.typography.titleLarge)
            Text("Encrypted full phone backup: contacts, photos, facts, trash, and unsynced edits. Server tokens and transfer passphrases are excluded. Reconnect to the same Mac/server after restoring.")
            OutlinedButton(enabled = !busy, onClick = { backupAction = "export"; passphrase = ""; backupError = null }) { Text("Create encrypted phone backup") }
            OutlinedButton(enabled = !busy && state.pending.isEmpty(), onClick = { restoreBackup.launch(arrayOf("*/*")) }) { Text("Restore encrypted phone backup") }
            if (state.pending.isNotEmpty()) Text("Sync pending edits before restoring. Exporting a backup is always available.", style = MaterialTheme.typography.bodySmall)
            Text("This is a phone backup, not a backup of your Mac’s message database. App uninstall still removes local data. Test recovery before deleting other contacts apps.", style = MaterialTheme.typography.bodySmall)
        }
    }
    if (state.failedEdits.isNotEmpty()) JournalCard {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Edits needing recovery", style = MaterialTheme.typography.titleLarge)
            Text("Failed payloads are kept in phone backups. Recovered edits use new operation IDs.")
            state.failedEdits.forEach { op ->
                Text(op.kind)
                if (op.kind == "relationship") {
                    val uid = op.payload.text("contact_uid")
                    val person = state.records.people.values.firstOrNull { it.contact_uid == uid || uid in it.contact_aliases } ?: state.records.people[op.payload.int("person_id")]
                    Text(person?.name ?: "Saved relationship edit", style = MaterialTheme.typography.titleMedium)
                    Text(op.payload.filterKeys { it !in setOf("person_id", "contact_uid") }.entries.joinToString(" · ") { "${it.key}: ${it.value}" }, style = MaterialTheme.typography.bodySmall)
                }
                if (op.kind == "contact_save") TextButton(enabled = !busy, onClick = { recovering = op }) { Text("Review & recover contact save") }
                if (op.kind == "relationship") TextButton(enabled = !busy, onClick = { runTask { graph.retryFailed(op.client_id); feedback("Relationship edit saved for retry. Sync with your updated Mac.") } }) { Text("Retry relationship edit") }
            }
        }
    }
    if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    recovering?.let { op ->
        val card = json.decodeFromJsonElement<ContactCard>(requireNotNull(op.payload["card"]))
        val uid = op.payload.text("contact_uid")
        val id = state.records.people.entries.firstOrNull { it.value.contact_uid == uid || uid in it.value.contact_aliases }?.key
        ContactEditor(graph, id, card, close = { recovering = null }, saved = { scope.launch { graph.store.dismissFailed(op.client_id) } })
    }
    candidates?.let { ImportContactsReview(it, graph) { candidates = null } }
    if (report) AlertDialog(onDismissRequest = { report = false }, title = { Text("Migration safety report") }, text = { Text(state.records.migrationReport().summary(), Modifier.verticalScroll(rememberScrollState())) }, confirmButton = { TextButton(onClick = { report = false }) { Text("Close") } })
    if (consent) AlertDialog(onDismissRequest = { consent = false }, title = { Text("Make contacts available to Android?") }, text = { Text("Apps with Contacts permission can read these details. Only the MyPeople account is managed. Existing Google/SIM/device contacts are not removed and may aggregate with the new copies. Import and review your original contacts first.") }, confirmButton = { TextButton(onClick = { consent = false; permissionAction = "enable"; permissions.launch(arrayOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)) }) { Text("Allow & enable") } }, dismissButton = { TextButton(onClick = { consent = false }) { Text("Cancel") } })
    if (conflict.isNotEmpty()) AlertDialog(onDismissRequest = { conflict = "" }, title = { Text("Resolve conflicting edits?") }, text = { Text("For contacts changed on both sides, keep the ${if (conflict == "android") "Android" else "MyPeople"} version. This may discard the other version's conflicting changes. Make a backup first.") }, confirmButton = { TextButton(onClick = { val preference = conflict; conflict = ""; reconcile(preference) }) { Text("Resolve conflicts") } }, dismissButton = { TextButton(onClick = { conflict = "" }) { Text("Cancel") } })
    if (backupAction.isNotEmpty()) AlertDialog(onDismissRequest = { if (!busy) { backupAction = ""; passphrase = "" } }, title = { Text(if (backupAction == "export") "Protect your backup" else "Restore this phone?") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(if (backupAction == "export") "Use a separate passphrase of at least 12 ASCII characters. Losing it means losing access to the backup." else "Replaces saved phone memory. Pending edits in the backup are restored and retried by UUID. Android integration is paused and server credentials must be entered again. Your current pending queue must be empty.")
            OutlinedTextField(passphrase, { passphrase = it; backupError = null }, label = { Text("Backup passphrase") }, visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
            backupError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = { TextButton(enabled = !busy && passphrase.length >= 12, onClick = {
        if (backupAction == "export") createBackup.launch("MyPeople-phone-${java.time.LocalDate.now()}.sherloq-backup")
        else scope.launch {
            busy = true
            try { graph.backups.restore(requireNotNull(backupUri), passphrase); enabled = false; backupAction = ""; passphrase = ""; feedback("Backup restored. Reconnect to the same Mac/server to sync.") }
            catch (e: Exception) { backupError = e.message ?: "Could not restore; saved contacts were kept." }
            finally { busy = false }
        }
    }) { Text(if (backupAction == "export") "Choose destination" else "Restore & replace") } }, dismissButton = { TextButton(enabled = !busy, onClick = { backupAction = ""; passphrase = "" }) { Text("Cancel") } })
}
