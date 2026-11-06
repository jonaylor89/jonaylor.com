package app.mypeople.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
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
import java.util.Base64

class ContactDraft : ViewModel() {
    var card by mutableStateOf<ContactCard?>(null)
    var original: Person? = null
    var error by mutableStateOf<String?>(null)
    var saving by mutableStateOf(false)
}

/** A real offline address-book editor; no model or Mac required to save. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactEditor(graph: AppGraph, personId: Int? = null, initial: ContactCard = ContactCard(""), close: () -> Unit, saved: (Int) -> Unit = {}) {
    val editorState by graph.store.state.collectAsStateWithLifecycle()
    val contactUid = rememberSaveable(personId) { editorState.records.people[personId]?.contact_uid.orEmpty() }
    val draftKey = rememberSaveable { java.util.UUID.randomUUID().toString() }
    val draft: ContactDraft = viewModel(key = "contact-$draftKey")
    if (draft.card == null) { draft.card = initial; draft.original = editorState.records.people[personId] }
    val card = draft.card!!
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var discard by remember { mutableStateOf(false) }
    var showNameFields by rememberSaveable { mutableStateOf(false) }
    fun dismiss() { if (!draft.saving) { if (card != initial) discard = true else close() } }
    fun update(next: ContactCard) { draft.card = next; draft.error = null }
    val photo = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) scope.launch {
            try {
                val encoded = withContext(Dispatchers.IO) {
                    val data = requireNotNull(context.contentResolver.openInputStream(uri)).use { Transfer.readLimited(it, 2 * 1024 * 1024) }
                    Base64.getEncoder().encodeToString(data)
                }
                val next = draft.card!!.copy(photo = encoded, photo_hash = ""); next.validate(); update(next)
            } catch (_: Exception) { draft.error = "Choose a JPEG or PNG smaller than 2 MiB." }
        }
    }
    Dialog(onDismissRequest = ::dismiss, properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnBackPress = !draft.saving)) {
        MyPeopleTheme {
            Scaffold(topBar = {
                TopAppBar(title = { Text(if (personId == null) "New contact" else "Edit contact") }, navigationIcon = { TextButton(enabled = !draft.saving, onClick = ::dismiss) { Text("Cancel") } }, actions = {
                    TextButton(enabled = !draft.saving && card.name.isNotBlank(), onClick = {
                        scope.launch {
                            draft.saving = true
                            try { card.validate(); val id = graph.saveContact(card.withManualWebsites(draft.original?.contactCard()), personId, contactUid, expectedPerson = draft.original); saved(id); close() }
                            catch (e: Exception) { draft.error = e.message ?: "Could not save. Your draft is still here." }
                            finally { draft.saving = false }
                        }
                    }) { Text(if (draft.saving) "Saving…" else "Save") }
                })
            }) { padding ->
                Column(Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Text("Details you maintain. Never overwritten by AI. Social profile links you add are confirmed for profile discovery and photo lookup.", style = MaterialTheme.typography.bodyMedium)
                    draft.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    Avatar(Person(card.name, card = card), graph, 88.dp)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(enabled = !draft.saving, onClick = { photo.launch(arrayOf("image/jpeg", "image/png")) }) { Text("Choose photo") }
                        if (card.photo.isNotEmpty() || card.photo_hash.isNotEmpty()) TextButton(onClick = { update(card.copy(photo = "", photo_hash = "")) }) { Text("Remove photo") }
                    }
                    OutlinedTextField(card.name, { update(card.copy(name = it)) }, label = { Text("Display name") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    TextButton(onClick = { showNameFields = !showNameFields }) { Text(if (showNameFields) "Hide name details" else "More name fields") }
                    if (showNameFields) {
                        OutlinedTextField(card.given, { update(card.copy(given = it)) }, label = { Text("Given name") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                        OutlinedTextField(card.family, { update(card.copy(family = it)) }, label = { Text("Family name") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                        OutlinedTextField(card.middle, { update(card.copy(middle = it)) }, label = { Text("Middle name") }, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(card.prefix, { update(card.copy(prefix = it)) }, label = { Text("Name prefix") }, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(card.suffix, { update(card.copy(suffix = it)) }, label = { Text("Name suffix") }, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(card.phonetic, { update(card.copy(phonetic = it)) }, label = { Text("Phonetic name") }, modifier = Modifier.fillMaxWidth())
                    }
                    Section("Contact details")
                    if (initial.legacy_unverified) Row {
                        Checkbox(!card.legacy_unverified, { update(card.copy(legacy_unverified = !it)) })
                        Text("I checked the original numbers and country codes. These details are ready for Android.", Modifier.padding(top = 12.dp))
                    }
                    OutlinedTextField(card.region, { update(card.copy(region = it.uppercase().take(2))) }, label = { Text("Country for local numbers (US, DE, GB…)") }, supportingText = { Text("International +country numbers are safest. Originals and extensions are retained.") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    card.fields.forEachIndexed { index, field ->
                        JournalCard {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Text(field.kind.replaceFirstChar(Char::uppercase), style = MaterialTheme.typography.titleMedium)
                                fun change(f: ContactField) { update(card.copy(fields = card.fields.toMutableList().also { it[index] = f })) }
                                OutlinedTextField(field.value, { change(field.copy(value = it, structured = if (field.kind == "address") "" else field.structured)) }, label = { Text("Value") }, keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = when (field.kind) { "phone" -> androidx.compose.ui.text.input.KeyboardType.Phone; "email" -> androidx.compose.ui.text.input.KeyboardType.Email; "website" -> androidx.compose.ui.text.input.KeyboardType.Uri; else -> androidx.compose.ui.text.input.KeyboardType.Text }), modifier = Modifier.fillMaxWidth(), minLines = if (field.kind == "address") 2 else 1)
                                OutlinedTextField(field.label, { change(field.copy(label = it)) }, label = { Text("Label (Mobile, Work, Home…)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                                if (field.kind == "phone") OutlinedTextField(field.region, { change(field.copy(region = it.uppercase().take(2))) }, label = { Text("Country override (optional)") }, supportingText = { Text("Blank uses ${card.region}. Prefer +country numbers when possible.") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                                if (field.kind == "phone" && field.value.isNotBlank() && dialable(field.value, field.region.ifEmpty { card.region }) == null) Text("Check this number or its country code. It will be saved unchanged.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                                Row {
                                    Checkbox(field.preferred, { checked -> update(card.copy(fields = card.fields.mapIndexed { i, f -> if (i == index) f.copy(preferred = checked) else if (f.kind == field.kind && checked) f.copy(preferred = false) else f })) })
                                    Text("Preferred ${field.kind}", Modifier.padding(top = 12.dp))
                                }
                                TextButton(onClick = { update(card.copy(fields = card.fields.filterIndexed { i, _ -> i != index })) }) { Text("Remove field") }
                            }
                        }
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf("phone", "email", "address", "website", "im", "anniversary").forEach { kind -> OutlinedButton(onClick = { update(card.copy(fields = card.fields + ContactField(kind, ""))) }) { Text("+ $kind") } }
                    }
                    OutlinedTextField(card.birthday, { update(card.copy(birthday = it)) }, label = { Text("Birthday (YYYY-MM-DD or --MM-DD)") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(card.organization, { update(card.copy(organization = it)) }, label = { Text("Organization") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(card.title, { update(card.copy(title = it)) }, label = { Text("Job title") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(card.notes, { update(card.copy(notes = it)) }, label = { Text("Contact notes (no AI processing)") }, minLines = 3, modifier = Modifier.fillMaxWidth())
                    Choice("Preferred way to reach out", card.preferred_channel.ifEmpty { "ask" }, listOf("ask", "call", "text", "email")) { update(card.copy(preferred_channel = if (it == "ask") "" else it)) }
                    Row { Checkbox(card.favorite, { update(card.copy(favorite = it)) }); Text("Pin to favorites", Modifier.padding(top = 12.dp)) }
                    if (initial.originals.isNotEmpty()) Text("Original vCard properties are retained for lossless recovery and export.", style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(24.dp))
                }
            }
            if (discard) AlertDialog(onDismissRequest = { discard = false }, title = { Text("Discard unsaved changes?") }, confirmButton = { TextButton(onClick = close) { Text("Discard") } }, dismissButton = { TextButton(onClick = { discard = false }) { Text("Keep editing") } })
        }
    }
}
