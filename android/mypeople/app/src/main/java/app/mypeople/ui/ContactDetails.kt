package app.mypeople.ui

import app.mypeople.ui.icons.Symbols

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import app.mypeople.AppGraph
import app.mypeople.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.booleanOrNull
import java.io.File

suspend fun shareContacts(context: Context, cards: List<ContactCard>) = withContext(Dispatchers.IO) {
    val directory = File(context.cacheDir, "transfers").apply { mkdirs() }
    val file = File(directory, "Contacts-${System.currentTimeMillis()}.vcf")
    val resolved = cards.map { card ->
        if (card.photo.isNotEmpty() || card.photo_hash.isEmpty()) card else card.copy(
            photo = java.util.Base64.getEncoder().encodeToString(File(context.filesDir, "memory/graph-blobs/${card.photo_hash}").readBytes()), photo_hash = "")
    }
    file.writeText(VCards.export(resolved))
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.transfers", file)
    withContext(Dispatchers.Main) { context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/x-vcard").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "Share contact details")) }
}

/** Calling, texting and emailing one card, refusing to guess a legacy number's country. */
private class Reach(private val context: Context, private val card: ContactCard, private val edit: () -> Unit) {
    fun requireCountry(field: ContactField): Boolean {
        if (card.canNormalizePhone(field)) return true
        Toast.makeText(context, "Verify the original number and country in Edit contact first. A legacy matching key may be missing its country code.", Toast.LENGTH_LONG).show()
        edit()
        return false
    }
    private fun region(f: ContactField) = f.region.ifEmpty { card.region }
    fun call(f: ContactField) { if (requireCountry(f)) openIntent(context, Intent.ACTION_DIAL, Uri.fromParts("tel", phoneCallTarget(f.value, region(f)) ?: f.value, null)) }
    fun text(f: ContactField) { if (requireCountry(f)) openIntent(context, Intent.ACTION_SENDTO, Uri.fromParts("smsto", phoneSmsTarget(f.value, region(f)) ?: f.value, null)) }
    fun email(f: ContactField) = openIntent(context, Intent.ACTION_SENDTO, Uri.fromParts("mailto", f.value, null))
    fun map(f: ContactField) = openIntent(context, Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=${Uri.encode(f.value)}"))
}

private fun ContactCard.first(kind: String) = fields.filter { it.kind == kind }.sortedByDescending { it.preferred }.firstOrNull()

private data class ReachAction(val channel: String, val label: String, val icon: ImageVector, val filled: ImageVector, val run: () -> Unit)

/**
 * The connected row of ways to reach someone. Their preferred channel comes first and is the
 * widest, in their accent; actions they have no details for are hidden, never disabled.
 */
@Composable
fun ContactActions(person: Person, edit: () -> Unit) {
    val context = LocalContext.current
    val card = person.contactCard()
    val reach = remember(card) { Reach(context, card, edit) }
    val phone = card.first("phone"); val email = card.first("email")
    val actions = buildList {
        if (phone != null) { add(ReachAction("call", "Call", Symbols.Call, Symbols.CallFilled) { reach.call(phone) }); add(ReachAction("text", "Message", Symbols.Chat, Symbols.ChatFilled) { reach.text(phone) }) }
        if (email != null) add(ReachAction("email", "Email", Symbols.Mail, Symbols.MailFilled) { reach.email(email) })
    }.sortedByDescending { it.channel == card.preferred_channel }
    if (actions.isEmpty()) return
    val palette = LocalPersonPalette.current
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(KinSpace.half)) {
        actions.forEachIndexed { index, action ->
            val primary = index == 0
            val source = remember { MutableInteractionSource() }
            val pressed by source.collectIsPressedAsState()
            // Pressed buttons round their inner corners and widen while neighbours yield.
            val inner by animateDpAsState(if (pressed) KinRadius.md else KinRadius.sm, KinMotion.spatialFast(), label = "corner")
            val grow by animateFloatAsState(if (pressed) 1.1f else 1f, KinMotion.spatialFast(), label = "width")
            val start = if (index == 0) KinSize.actionButton / 2 else inner
            val end = if (index == actions.lastIndex) KinSize.actionButton / 2 else inner
            Surface(
                onClick = action.run, interactionSource = source,
                modifier = Modifier.weight((if (primary) 1.4f else 1f) * grow).heightIn(min = KinSize.actionButton),
                shape = RoundedCornerShape(topStart = start, bottomStart = start, topEnd = end, bottomEnd = end),
                color = if (primary) palette?.accent ?: MaterialTheme.colorScheme.primary else palette?.container ?: MaterialTheme.colorScheme.secondaryContainer,
                contentColor = if (primary) palette?.onAccent ?: MaterialTheme.colorScheme.onPrimary else palette?.onContainer ?: MaterialTheme.colorScheme.onSecondaryContainer,
            ) {
                Column(Modifier.padding(vertical = KinSpace.s2), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(KinSpace.s1, Alignment.CenterVertically)) {
                    Icon(if (primary) action.filled else action.icon, null)
                    Text(action.label, style = MaterialTheme.typography.labelMedium, maxLines = 1)
                }
            }
        }
    }
}

private val KindOrder = listOf("phone", "email", "address", "website")

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun InfoRow(icon: ImageVector, value: String, label: String, shape: androidx.compose.ui.graphics.Shape, onClick: (() -> Unit)?, trailing: Pair<String, ImageVector>? = null, onTrailing: () -> Unit = {}) {
    val context = LocalContext.current
    var menu by remember { mutableStateOf(false) }
    fun copy() { (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Contact detail", value)); Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show() }
    Surface(Modifier.fillMaxWidth(), shape = shape, color = journalSurfaceColor()) {
        Box {
            Row(Modifier.fillMaxWidth().combinedClickable(onClickLabel = label, onLongClickLabel = "Copy or share", onClick = { onClick?.invoke() ?: copy() }, onLongClick = { menu = true }).heightIn(min = KinSize.rowTwoLine).padding(start = KinSpace.s4, end = if (trailing != null) KinSpace.s1 else KinSpace.s4, top = KinSpace.s3, bottom = KinSpace.s3), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KinSpace.s4)) {
                Icon(icon, null, tint = LocalPersonPalette.current?.accent ?: MaterialTheme.colorScheme.primary)
                Column(Modifier.weight(1f)) {
                    Text(value, style = MaterialTheme.typography.bodyLarge)
                    if (label.isNotEmpty()) Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (trailing != null) IconButton(onClick = onTrailing) { Icon(trailing.second, trailing.first, tint = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text("Copy") }, leadingIcon = { Icon(Symbols.ContentCopy, null) }, onClick = { menu = false; copy() })
                DropdownMenuItem(text = { Text("Share") }, leadingIcon = { Icon(Symbols.Share, null) }, onClick = { menu = false; context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, value), "Share detail")) })
            }
        }
    }
}

@Composable
fun ContactDetails(person: Person, id: Int, graph: AppGraph, edit: () -> Unit) {
    val context = LocalContext.current; val scope = rememberCoroutineScope()
    val card = person.contactCard()
    val reach = remember(card) { Reach(context, card, edit) }
    var trash by remember { mutableStateOf(false) }
    var undo by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(KinSpace.s3)) {
        Section("Contact info")
        if (person.mergeDecisionConflicts().isNotEmpty()) MergeDecisionPrompt(person, graph)
        val detailConflicts = person.contact_conflicts.filter { (field, choices) -> !isMergeDecisionConflict(field, choices) }
        if (detailConflicts.isNotEmpty()) {
            Surface(shape = RoundedCornerShape(KinRadius.xl), color = MaterialTheme.colorScheme.errorContainer) {
                Column(Modifier.fillMaxWidth().padding(KinSpace.s5), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Two versions, safely kept", style = MaterialTheme.typography.titleMedium)
                    Text("These details changed independently on different devices. Choose a version to share; neither edit has been lost.", style = MaterialTheme.typography.bodySmall)
                    detailConflicts.forEach { (field, choices) ->
                        Text(conflictFieldTitle(field, person), style = MaterialTheme.typography.labelLarge)
                        choices.forEach { choice ->
                            val value = when (field) {
                                "photo" -> "Photo · ${choice.change.take(8)}"
                                "_trashed" -> if ((choice.value as? JsonPrimitive)?.booleanOrNull == true) "In trash" else "Active contact"
                                else -> ((choice.value as? JsonPrimitive)?.contentOrNull ?: choice.value.toString()).ifEmpty { "(empty)" }.take(160)
                            }
                            OutlinedButton(onClick = { scope.launch {
                                try { graph.store.resolveContact(person.contact_uid, field, choice.change) }
                                catch (e: Exception) { Toast.makeText(context, graph.editError(e), Toast.LENGTH_LONG).show() }
                            } }, modifier = Modifier.fillMaxWidth()) { Text("Keep $value") }
                        }
                    }
                }
            }
        }
        if (person.card == null || card.legacy_unverified) Text("Legacy matching numbers may lack country codes. Re-import your original contacts before relying on these for international calls.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        // Phone, email, address, links, then work, dates and notes.
        val rows = buildList<@Composable (androidx.compose.ui.graphics.Shape) -> Unit> {
            card.fields.sortedWith(compareBy<ContactField> { KindOrder.indexOf(it.kind).let { i -> if (i < 0) KindOrder.size else i } }.thenByDescending { it.preferred }).forEach { f ->
                val label = listOf(f.label.ifEmpty { f.kind.replaceFirstChar { it.uppercase() } }, if (f.preferred) "Default" else "").filter { it.isNotEmpty() }.joinToString(" · ")
                when (f.kind) {
                    "phone" -> add { shape -> InfoRow(Symbols.Call, formatPhone(f.value), label, shape, onClick = { reach.call(f) }, trailing = "Message" to Symbols.Chat, onTrailing = { reach.text(f) }) }
                    "email" -> add { shape -> InfoRow(Symbols.Mail, f.value, label, shape, onClick = { reach.email(f) }) }
                    "address" -> add { shape -> InfoRow(Symbols.Home, f.value, label, shape, onClick = null, trailing = "Directions" to Symbols.Directions, onTrailing = { reach.map(f) }) }
                    "website" -> add { shape -> InfoRow(Symbols.Link, f.value, label, shape, onClick = { openLink(context, f.value) }) }
                    else -> add { shape -> InfoRow(Symbols.Notes, f.value, label, shape, onClick = null) }
                }
            }
            if (card.organization.isNotBlank() || card.title.isNotBlank()) add { shape -> InfoRow(Symbols.Group, listOf(card.title, card.organization).filter { it.isNotBlank() }.joinToString(" · "), "Work", shape, onClick = null) }
            if (card.birthday.isNotBlank()) add { shape -> InfoRow(Symbols.Cake, formatDate(card.birthday), "Birthday", shape, onClick = null) }
            if (card.notes.isNotBlank()) add { shape -> InfoRow(Symbols.Notes, card.notes, "Your contact notes", shape, onClick = null) }
        }
        if (rows.isEmpty()) Text("No details yet. Add a number or email in Edit contact.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        else Column(verticalArrangement = Arrangement.spacedBy(KinSpace.half)) { rows.forEachIndexed { index, row -> row(segmentShape(index, rows.size)) } }
        if (!person.trashed) DuplicatePhoneAction(person, id, graph)
        if (person.trashed) MetaLabel("In trash · kept until you restore it")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
            TextButton(onClick = { scope.launch { runCatching { shareContacts(context, listOf(card)) }.onFailure { Toast.makeText(context, "Could not share ${person.name}", Toast.LENGTH_SHORT).show() } } }) { Text("Share vCard") }
            if (person.can_undo_merge) TextButton(onClick = { undo = true }) { Text("Undo last merge") }
            if (person.trashed) TextButton(onClick = { graph.edit("contact_restore", buildJsonObject { put("person_id", id) }) }) { Text("Restore") }
            else TextButton(onClick = { trash = true }) { Text("Move to trash", color = MaterialTheme.colorScheme.error) }
        }
    }
    if (trash) AlertDialog(onDismissRequest = { trash = false }, title = { Text("Move ${person.name} to trash?") }, text = { Text("Hidden from your address book and removed from the MyPeople Android account. Other accounts aren't changed. You can restore them from People → Trash.") }, confirmButton = { TextButton(onClick = { graph.edit("contact_trash", buildJsonObject { put("person_id", id) }); trash = false }) { Text("Move to trash") } }, dismissButton = { TextButton(onClick = { trash = false }) { Text("Cancel") } })
    if (undo) AlertDialog(onDismissRequest = { undo = false }, title = { Text("Undo last merge?") }, text = { Text("Your Mac restores the separate records only if they haven't changed since merging. Otherwise it refuses rather than overwrite newer edits.") }, confirmButton = { TextButton(onClick = { graph.edit("merge_undo", buildJsonObject { put("person_id", id) }); undo = false }) { Text("Queue undo") } }, dismissButton = { TextButton(onClick = { undo = false }) { Text("Cancel") } })
}
