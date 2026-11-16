package app.mypeople.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import app.mypeople.AppGraph
import app.mypeople.data.*
import app.mypeople.ui.icons.Symbols
import coil3.compose.AsyncImage
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Local/offline picker. Selecting a tile previews it; only Save authors a preference. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PhotoChooser(person: Person, graph: AppGraph, dismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var choices by remember(person.contact_uid) { mutableStateOf<PhotoChoices?>(null) }
    var selected by remember(person.contact_uid) { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(person.contact_uid, attempt) {
        loading = true; error = null
        try {
            choices = graph.store.photoChoices(person.contact_uid)
            selected = choices?.preferred.orEmpty()
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { error = "Couldn’t load photos. Try again." }
        finally { loading = false }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) scope.launch {
            saving = true; error = null
            try {
                val bytes = withContext(Dispatchers.IO) {
                    requireNotNull(context.contentResolver.openInputStream(uri)).use { input ->
                        val output = java.io.ByteArrayOutputStream()
                        val buffer = ByteArray(8192)
                        val limit = 2 * 1024 * 1024
                        while (output.size() <= limit) {
                            val count = input.read(buffer, 0, minOf(buffer.size, limit + 1 - output.size()))
                            if (count < 0) break
                            output.write(buffer, 0, count)
                        }
                        output.toByteArray()
                    }
                }
                require(bytes.size <= 2 * 1024 * 1024) { "Choose a photo under 2 MiB." }
                val card = person.contactCard().copy(photo = Base64.getEncoder().encodeToString(bytes), photo_hash = "")
                card.validate()
                graph.saveContact(card, contactUid = person.contact_uid, expectedPerson = person)
                dismiss()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { error = e.message ?: "Couldn’t add that photo. Try another image." }
            finally { saving = false }
        }
    }
    ModalBottomSheet(onDismissRequest = { if (!saving) dismiss() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(.92f).padding(horizontal = KinSpace.s5).padding(bottom = KinSpace.s5), verticalArrangement = Arrangement.spacedBy(KinSpace.s3)) {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(KinSpace.s3)) {
            Text("Contact photo", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
            Text(person.name, style = MaterialTheme.typography.bodyLarge)
            Text("Your choice stays selected when new photos arrive. Photos are available offline after sync.", style = MaterialTheme.typography.bodyMedium)
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let { message ->
                Text(message, color = MaterialTheme.colorScheme.error, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                if (!saving) TextButton(onClick = { attempt++ }) { Text("Try again") }
            }
            choices?.let { options ->
                if (options.conflict) Text("Different photos were chosen on your devices. Choose a photo or Automatic to resolve this.", color = MaterialTheme.colorScheme.error)
                if (options.unavailablePreference) Text("Your preferred photo isn’t available for this contact. A temporary photo is shown; choose again to update your preference.")
                val preview = options.candidates.firstOrNull { it.id == selected.ifEmpty { options.automaticSelected } }
                val file by produceState<java.io.File?>(null, preview?.hash) {
                    value = withContext(Dispatchers.IO) { preview?.let { runCatching { graph.offline.photo(it.hash) }.getOrNull() } }
                }
                if (file != null) AsyncImage(model = file, imageLoader = graph.imageLoader, contentDescription = "Photo preview for ${person.name}", contentScale = ContentScale.Fit, modifier = Modifier.fillMaxWidth().height(160.dp))
                if (preview != null) {
                    Text(listOf(photoSourceLabel(preview.source),
                        if (preview.width > 0 && preview.height > 0) "${preview.width} × ${preview.height}" else "Resolution unknown",
                        preview.sourceUpdatedAt.take(10).ifEmpty { "Photo date unknown" }).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall)
                }
                val isAutomatic = selected.isEmpty()
                OutlinedCard(onClick = { selected = "" }, enabled = !saving, modifier = Modifier.fillMaxWidth().semantics { this.selected = isAutomatic }) {
                    Row(Modifier.padding(KinSpace.s3), verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = selected.isEmpty(), onClick = null)
                        Column(Modifier.padding(start = KinSpace.s3)) {
                            Text("Automatic", style = MaterialTheme.typography.titleMedium)
                            Text("Prefer a current, good-quality photo", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                val groups = options.candidates.groupBy { it.hash }.values.toList()
                if (groups.isEmpty()) Text("No photos yet. Add one from your device or import profile pictures on your Mac.")
                LazyVerticalGrid(columns = GridCells.Adaptive(112.dp), modifier = Modifier.fillMaxWidth().heightIn(max = 260.dp), horizontalArrangement = Arrangement.spacedBy(KinSpace.s3), verticalArrangement = Arrangement.spacedBy(KinSpace.s3)) {
                    items(groups, key = { it.first().hash }) { copies ->
                        val candidate = copies.firstOrNull { it.id == selected } ?: copies.first()
                        val chosen = copies.any { it.id == selected }
                        val sources = copies.map { photoSourceLabel(it.source) }.distinct().joinToString(" · ")
                        val image by produceState<java.io.File?>(null, candidate.hash) {
                            value = withContext(Dispatchers.IO) { runCatching { graph.offline.photo(candidate.hash) }.getOrNull() }
                        }
                        OutlinedCard(onClick = { selected = candidate.id }, enabled = !saving,
                            border = BorderStroke(if (chosen) 2.dp else 1.dp, if (chosen) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
                            modifier = Modifier.semantics { this.selected = chosen; contentDescription = "$sources photo${if (chosen) ", selected" else ""}" }) {
                            Box {
                                AsyncImage(model = image, imageLoader = graph.imageLoader, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().aspectRatio(1f))
                                if (chosen) Surface(modifier = Modifier.align(Alignment.TopEnd).padding(6.dp), shape = CircleShape, color = MaterialTheme.colorScheme.primary) {
                                    Icon(Symbols.Check, null, Modifier.padding(4.dp).size(18.dp))
                                }
                            }
                            Text(sources, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(8.dp))
                        }
                    }
                }
            }
            }
            choices?.let { options ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(KinSpace.s2), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, enabled = !saving, modifier = Modifier.weight(1f)) { Text("Add photo") }
                    TextButton(onClick = dismiss, enabled = !saving, modifier = Modifier.weight(1f)) { Text("Cancel") }
                    Button(enabled = !saving, modifier = Modifier.weight(1f), onClick = {
                        scope.launch {
                            saving = true; error = null
                            try { graph.choosePhoto(person.contact_uid, selected, options.observed); dismiss() }
                            catch (e: CancellationException) { throw e }
                            catch (_: Exception) { error = "Couldn’t save your choice. Reload and try again." }
                            finally { saving = false }
                        }
                    }) { Text(if (saving) "Saving…" else "Save") }
                }
            }
        }
    }
}
