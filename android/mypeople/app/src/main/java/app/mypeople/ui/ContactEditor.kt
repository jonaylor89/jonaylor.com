package app.mypeople.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.foundation.shape.RoundedCornerShape
import app.mypeople.ui.icons.Symbols
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import app.mypeople.AppGraph
import app.mypeople.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.launch

class ContactDraft : ViewModel() {
    var card by mutableStateOf<ContactCard?>(null)
    var original: Person? = null
    var error by mutableStateOf<String?>(null)
    var saving by mutableStateOf(false)
    var loadingPhoto by mutableStateOf(false)
    var description by mutableStateOf("")
}

/** A real offline address-book editor; no model or Mac required to save. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactEditor(graph: AppGraph, personId: Int? = null, initial: ContactCard = ContactCard("", region = captureRegion()), descriptionExtractor: ContactDescriptionExtractor? = null, close: () -> Unit, saved: (Int) -> Unit = {}) {
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
    var fullDetails by rememberSaveable { mutableStateOf(personId != null) }
    val canDescribe = personId == null && initial == ContactCard("", region = initial.region)
    var describing by rememberSaveable { mutableStateOf(canDescribe) }
    val extractor = remember(canDescribe, descriptionExtractor) { if (canDescribe) descriptionExtractor ?: NanoContactDescription(context) else null }
    var availability by remember { mutableStateOf<ContactDescriptionAvailability?>(null) }
    val descriptionEntry = describing && availability == ContactDescriptionAvailability.AVAILABLE && !fullDetails
    var extracting by remember { mutableStateOf(false) }
    var extractionJob by remember { mutableStateOf<Job?>(null) }
    DisposableEffect(extractor) { onDispose { extractor?.close() } }
    LaunchedEffect(extractor) {
        availability = null
        if (extractor != null) availability = try { withTimeout(5000) { extractor.availability() } }
        catch (_: TimeoutCancellationException) { ContactDescriptionAvailability.CHECK_TIMED_OUT }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { ContactDescriptionAvailability.CHECK_FAILED }
    }
    val focus = LocalFocusManager.current
    val scroll = rememberScrollState()
    LaunchedEffect(fullDetails, describing) { scroll.scrollTo(0) }
    LaunchedEffect(draft.error) { if (draft.error != null) scroll.animateScrollTo(0) }
    fun save() {
        if (draft.saving || draft.loadingPhoto) return
        draft.saving = true
        focus.clearFocus()
        scope.launch {
            try {
                val ready = card.copy(name = card.name.trim(), fields = card.fields.filter { it.value.isNotBlank() })
                ready.validate()
                val id = graph.saveContact(ready.withManualWebsites(draft.original?.contactCard()), personId, contactUid, expectedPerson = draft.original)
                saved(id); close()
            } catch (e: Exception) { draft.error = e.message ?: "Could not save. Your draft is still here." }
            finally { draft.saving = false }
        }
    }
    fun dismiss() { if (!draft.saving) { if (card != initial || draft.description.isNotBlank()) discard = true else close() } }
    fun update(next: ContactCard) { if (!draft.saving) { describing = false; draft.card = next; draft.error = null } }
    fun manually() {
        extractionJob?.cancel()
        extracting = false
        describing = false
        draft.error = null
        focus.clearFocus()
    }
    fun createDraft() {
        if (extracting || extractor == null || availability != ContactDescriptionAvailability.AVAILABLE || draft.description.isBlank()) return
        val source = draft.description
        extracting = true
        draft.error = null
        focus.clearFocus()
        extractionJob = scope.launch {
            try {
                val proposed = withTimeout(30000) { extractor.extract(source, card.region) }
                ensureActive()
                if (describing) { update(proposed); describing = false }
            } catch (_: TimeoutCancellationException) {
                draft.error = "On-device AI took too long. Your description is still here. Try again or add manually."
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) {
                draft.error = "Couldn’t extract reliable details. Include one person’s name and try again, or add manually. Your description is still here."
            } finally { extracting = false }
        }
    }
    val choosePhoto = rememberContactPhotoPicker(onPhoto = { encoded ->
        val next = draft.card!!.copy(photo = encoded, photo_hash = "")
        next.copy(name = next.name.ifBlank { "Photo preview" }).validate(); update(next)
    }, loading = { draft.loadingPhoto = it; if (it) draft.error = null }, error = { draft.error = it })
    Dialog(onDismissRequest = ::dismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false, dismissOnBackPress = !draft.saving)) {
        MyPeopleTheme {
            val dialogWindow = (LocalView.current.parent as? DialogWindowProvider)?.window
            val lightBars = MaterialTheme.colorScheme.surface.luminance() > .5f
            SideEffect {
                dialogWindow?.let { window ->
                    WindowCompat.getInsetsController(window, window.decorView).apply {
                        isAppearanceLightStatusBars = lightBars
                        isAppearanceLightNavigationBars = lightBars
                    }
                    window.isNavigationBarContrastEnforced = false
                }
            }
            Scaffold(modifier = Modifier.imePadding(), topBar = {
                CenterAlignedTopAppBar(title = { Text(when { personId == null && draft.description.isNotBlank() && !descriptionEntry -> "Review contact"; personId == null -> "New contact"; else -> "Edit contact" }, style = MaterialTheme.typography.titleMedium) }, navigationIcon = { IconButton(enabled = !draft.saving, onClick = ::dismiss) { Icon(Symbols.Close, "Cancel") } }, actions = {
                    if (personId != null) TextButton(enabled = !draft.saving && !draft.loadingPhoto && card.name.isNotBlank(), onClick = ::save) { Text(if (draft.saving) "Saving…" else "Save") }
                })
            }, bottomBar = {
                if (personId == null) Surface(color = MaterialTheme.colorScheme.surface) {
                    Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Button(enabled = !draft.saving && !draft.loadingPhoto && !extracting && (if (descriptionEntry) draft.description.isNotBlank() else card.name.isNotBlank()), onClick = {
                            when {
                                descriptionEntry -> createDraft()
                                else -> save()
                            }
                        }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp), shape = RoundedCornerShape(KinRadius.lgPlus)) {
                            if (draft.saving || draft.loadingPhoto || extracting) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                            else Icon(if (descriptionEntry) Symbols.Notes else Symbols.Check, null, Modifier.size(20.dp))
                            Spacer(Modifier.width(KinSpace.s2))
                            Text(when { draft.saving -> "Saving…"; draft.loadingPhoto -> "Adding photo…"; extracting -> "Creating draft…"; descriptionEntry -> "Create draft"; else -> "Save contact" }, style = MaterialTheme.typography.titleMedium)
                        }
                    }
                }
            }) { padding ->
                Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).verticalScroll(scroll).padding(if (fullDetails) 24.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(if (fullDetails) 14.dp else 8.dp)) {
                    draft.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive }) }
                    if (!fullDetails) {
                        if (descriptionEntry) {
                            ContactDescriptionEntry(draft.description, extracting, change = { draft.description = it.take(CONTACT_DESCRIPTION_LIMIT); draft.error = null }, manually = ::manually)
                        } else {
                            if (draft.description.isNotBlank()) ContactDescriptionSource(draft.description)
                            ContactCapture(card, !draft.saving && !draft.loadingPhoto, ::update,
                                more = { describing = false; focus.clearFocus(); fullDetails = true }, onInteraction = { describing = false },
                                onPhoto = choosePhoto,
                                portrait = if (card.photo.isNotEmpty() || card.photo_hash.isNotEmpty()) { { Avatar(Person(card.name, card = card), graph, 56.dp, AvatarShape.Cookie) } } else null)
                        }
                    } else {
                    if (personId == null) TextButton(enabled = !draft.saving, onClick = { focus.clearFocus(); fullDetails = false }) { Text("Back to essentials") }
                    Text("Details you maintain. Never overwritten by AI. Social profile links you add are confirmed for profile discovery and photo lookup.", style = MaterialTheme.typography.bodyMedium)
                    Avatar(Person(card.name, card = card), graph, 88.dp)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(enabled = !draft.saving && !draft.loadingPhoto, onClick = choosePhoto) { Text("Choose photo") }
                        if (card.photo.isNotEmpty() || card.photo_hash.isNotEmpty()) TextButton(onClick = { update(card.copy(photo = "", photo_hash = "")) }) { Text("Use automatic photo") }
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
                    OutlinedTextField(card.notes, { update(card.copy(notes = it)) }, label = { Text("Contact notes") }, minLines = 3, modifier = Modifier.fillMaxWidth())
                    Choice("Preferred way to reach out", card.preferred_channel.ifEmpty { "ask" }, listOf("ask", "call", "text", "email")) { update(card.copy(preferred_channel = if (it == "ask") "" else it)) }
                    Row { Checkbox(card.favorite, { update(card.copy(favorite = it)) }); Text("Pin to favorites", Modifier.padding(top = 12.dp)) }
                    if (initial.originals.isNotEmpty()) Text("Original vCard properties are retained for lossless recovery and export.", style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(24.dp))
                    }
                }
            }
            if (discard) AlertDialog(onDismissRequest = { discard = false }, title = { Text("Discard unsaved changes?") }, confirmButton = { TextButton(onClick = close) { Text("Discard") } }, dismissButton = { TextButton(onClick = { discard = false }) { Text("Keep editing") } })
        }
    }
}
