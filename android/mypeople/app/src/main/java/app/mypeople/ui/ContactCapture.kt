package app.mypeople.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import app.mypeople.ui.icons.Tune
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.mypeople.data.ContactCard
import app.mypeople.data.ContactField
import app.mypeople.data.dialable
import app.mypeople.ui.icons.Symbols
import com.google.i18n.phonenumbers.PhoneNumberUtil
import java.util.Locale

/** One living contact card. Optional details unfold in place, regardless of who fills it in. */
@Composable
internal fun ContactCapture(card: ContactCard, enabled: Boolean, update: (ContactCard) -> Unit, more: () -> Unit, onInteraction: () -> Unit = {}, onPhoto: (() -> Unit)? = null, portrait: (@Composable () -> Unit)? = null) {
    val colors = MaterialTheme.colorScheme
    val largeText = LocalDensity.current.fontScale > 1.3f
    val separateCountry = largeText || LocalConfiguration.current.screenWidthDp < 360
    val fieldModifier = Modifier.fillMaxWidth().onFocusChanged { if (it.isFocused) onInteraction() }
    var workExpanded by rememberSaveable { mutableStateOf(card.organization.isNotEmpty() || card.title.isNotEmpty()) }
    var noteExpanded by rememberSaveable { mutableStateOf(card.notes.isNotEmpty()) }
    var linkExpanded by rememberSaveable { mutableStateOf(card.fields.any { it.kind == "website" }) }
    var country by rememberSaveable { mutableStateOf(false) }

    Surface(shape = RoundedCornerShape(KinRadius.xl), color = colors.primaryContainer) {
        Row(Modifier.fillMaxWidth().padding(KinSpace.s3), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
            if (!largeText) {
                val mark: @Composable () -> Unit = {
                    Surface(Modifier.size(56.dp), shape = cookieShape(), color = colors.primary, contentColor = colors.onPrimary) {
                        if (portrait != null) portrait()
                        else Box(contentAlignment = Alignment.Center) {
                            val letters = initials(card.name)
                            if (letters.isEmpty()) Icon(Symbols.Person, null, Modifier.size(28.dp))
                            else Text(letters, style = MaterialTheme.typography.headlineSmall, maxLines = 1)
                        }
                    }
                }
                if (onPhoto != null) IconButton(onClick = { onInteraction(); onPhoto() }, enabled = enabled,
                    modifier = Modifier.size(64.dp).semantics { contentDescription = if (card.photo.isEmpty() && card.photo_hash.isEmpty()) "Add photo" else "Change photo" }) {
                    Box(Modifier.size(56.dp)) {
                        mark()
                        Surface(Modifier.size(20.dp).align(Alignment.BottomEnd), shape = CircleShape, color = colors.surface, contentColor = colors.primary) {
                            Icon(Symbols.Edit, null, Modifier.padding(3.dp))
                        }
                    }
                } else mark()
            }
                TextField(card.name, { update(card.copy(name = it)) }, enabled = enabled,
                    label = { Text("Name (required)") }, singleLine = true, textStyle = MaterialTheme.typography.headlineSmall,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Next),
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = colors.primaryContainer, unfocusedContainerColor = colors.primaryContainer, disabledContainerColor = colors.primaryContainer,
                        focusedTextColor = colors.onPrimaryContainer, unfocusedTextColor = colors.onPrimaryContainer,
                        focusedLabelColor = colors.onPrimaryContainer, unfocusedLabelColor = colors.onPrimaryContainer,
                        focusedIndicatorColor = colors.primary, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent,
                    ), modifier = fieldModifier.weight(1f))
        }
    }

    Column(Modifier.fillMaxWidth().padding(top = KinSpace.s3), verticalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
        Text("STAY IN TOUCH", Modifier.padding(start = KinSpace.s1), style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
        Surface(shape = RoundedCornerShape(KinRadius.xl), color = colors.surfaceContainerLow) {
            Column {
                listOf("phone" to "Phone number", "email" to "Email").forEachIndexed { channelIndex, (kind, label) ->
                    val index = card.fields.indexOfFirst { it.kind == kind }
                    val field = card.fields.getOrNull(index) ?: ContactField(kind, "")
                    val region = field.region.ifEmpty { card.region }
                    val countryButton: @Composable () -> Unit = {
                        TextButton(enabled = enabled, onClick = { onInteraction(); country = true },
                            modifier = Modifier.padding(end = KinSpace.s2).semantics { contentDescription = "Country for local numbers: ${countryName(region)}. Change country" }) {
                            Text("$region ▾", style = MaterialTheme.typography.labelLarge)
                        }
                    }
                    CaptureField(field.value, { value ->
                        val fields = card.fields.toMutableList()
                        if (index < 0) { if (value.isNotBlank()) fields.add(field.copy(value = value)) }
                        else fields[index] = field.copy(value = value)
                        update(card.copy(fields = fields))
                    }, "$label (optional)", enabled, fieldModifier,
                        icon = if (kind == "phone") Symbols.Call else Symbols.Mail,
                        keyboardType = if (kind == "phone") KeyboardType.Phone else KeyboardType.Email,
                        imeAction = if (kind == "email") ImeAction.Done else ImeAction.Next,
                        trailing = if (kind == "phone" && !separateCountry) countryButton else null)
                    if (kind == "phone" && separateCountry) countryButton()
                    if (kind == "phone" && field.value.isNotBlank() && dialable(field.value, region) == null) {
                        Text("Check the number or country. We’ll keep what you enter.", Modifier.padding(horizontal = KinSpace.s4, vertical = KinSpace.s2), color = colors.error, style = MaterialTheme.typography.bodySmall)
                    }
                    if (channelIndex == 0) HorizontalDivider(Modifier.padding(start = 56.dp, end = KinSpace.s4), color = colors.outlineVariant.copy(alpha = .5f))
                }
            }
        }
    }

    Column(Modifier.fillMaxWidth().padding(top = KinSpace.s3), verticalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
        Text("MAKE IT PERSONAL", Modifier.padding(start = KinSpace.s1), style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
            CaptureChip("Link", Symbols.Link, linkExpanded, enabled) { onInteraction(); linkExpanded = !linkExpanded }
            CaptureChip("Work", Symbols.Group, workExpanded, enabled) { onInteraction(); workExpanded = !workExpanded }
            CaptureChip("Note", Symbols.Notes, noteExpanded, enabled) { onInteraction(); noteExpanded = !noteExpanded }
        }
    }
    CaptureExpansion(linkExpanded) {
        val index = card.fields.indexOfFirst { it.kind == "website" }
        val field = card.fields.getOrNull(index) ?: ContactField("website", "")
        CaptureGroup {
            CaptureField(field.value, { value ->
                val fields = card.fields.toMutableList()
                if (index < 0) { if (value.isNotBlank()) fields.add(field.copy(value = value)) }
                else fields[index] = field.copy(value = value)
                update(card.copy(fields = fields))
            }, "Profile or website link (optional)", enabled, fieldModifier, icon = Symbols.Link, keyboardType = KeyboardType.Uri)
        }
        Text("Profile links can be used for profile discovery and photo lookup.", style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
    }
    CaptureExpansion(workExpanded) {
        CaptureGroup {
            CaptureField(card.organization, { update(card.copy(organization = it)) }, "Company or organization", enabled, fieldModifier)
            HorizontalDivider(Modifier.padding(horizontal = KinSpace.s4), color = colors.outlineVariant.copy(alpha = .5f))
            CaptureField(card.title, { update(card.copy(title = it)) }, "Role", enabled, fieldModifier)
        }
    }
    CaptureExpansion(noteExpanded) {
        CaptureGroup {
            CaptureField(card.notes, { update(card.copy(notes = it)) }, "Where we met / what to remember", enabled, fieldModifier, icon = Symbols.Notes, singleLine = false)
        }
        Text("Contact notes · included in exports and sync, not processed by background AI.", style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
    }
    TextButton(enabled = enabled, onClick = more, modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = KinSpace.s4, vertical = KinSpace.s3)) {
        Icon(Icons.Outlined.Tune, null, Modifier.size(18.dp))
        Text("More details", Modifier.padding(start = KinSpace.s2).weight(1f), style = MaterialTheme.typography.labelLarge)
        if (!separateCountry) Text("Birthday, photo & more", style = MaterialTheme.typography.bodySmall)
    }
    if (card.fields.any { it.kind !in setOf("phone", "email", "website") } || listOf("phone", "email", "website").any { kind -> card.fields.count { it.kind == kind } > 1 } || ((card.photo.isNotEmpty() || card.photo_hash.isNotEmpty()) && (portrait == null || largeText)) || card.birthday.isNotEmpty()) {
        Text("Additional details are included. Open More details to review them.", style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
    }
    if (country) {
        val phoneIndex = card.fields.indexOfFirst { it.kind == "phone" }
        val phone = card.fields.getOrNull(phoneIndex)
        ContactCountryChooser(phone?.region?.ifEmpty { card.region } ?: card.region, select = { region ->
            if (phone != null && phone.region.isNotEmpty()) update(card.copy(fields = card.fields.toMutableList().also { it[phoneIndex] = phone.copy(region = region) }))
            else update(card.copy(region = region))
            country = false
        }, close = { country = false })
    }
}

@Composable
private fun CaptureChip(label: String, icon: ImageVector, selected: Boolean, enabled: Boolean, click: () -> Unit) {
    FilterChip(selected = selected, enabled = enabled, onClick = click, label = { Text(label) },
        leadingIcon = { Icon(if (selected) Symbols.Check else icon, null, Modifier.size(18.dp)) }, shape = RoundedCornerShape(KinRadius.lg),
        border = FilterChipDefaults.filterChipBorder(enabled, selected, borderColor = MaterialTheme.colorScheme.outlineVariant),
        colors = FilterChipDefaults.filterChipColors(selectedContainerColor = MaterialTheme.colorScheme.secondaryContainer))
}

@Composable
private fun CaptureExpansion(visible: Boolean, content: @Composable ColumnScope.() -> Unit) {
    AnimatedVisibility(visible, enter = fadeIn(KinMotion.effects()) + expandVertically(KinMotion.spatialDefault()), exit = fadeOut(KinMotion.effects()) + shrinkVertically(KinMotion.spatialDefault())) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(KinSpace.s2), content = content)
    }
}

@Composable
private fun CaptureGroup(content: @Composable ColumnScope.() -> Unit) {
    Surface(shape = RoundedCornerShape(KinRadius.xl), color = MaterialTheme.colorScheme.surfaceContainerLow) { Column(content = content) }
}

@Composable
private fun CaptureField(value: String, change: (String) -> Unit, label: String, enabled: Boolean, modifier: Modifier, icon: ImageVector? = null, keyboardType: KeyboardType = KeyboardType.Text, imeAction: ImeAction = ImeAction.Next, singleLine: Boolean = true, trailing: (@Composable () -> Unit)? = null) {
    val colors = MaterialTheme.colorScheme
    val focus = LocalFocusManager.current
    TextField(value, change, enabled = enabled, label = { Text(label) }, singleLine = singleLine, minLines = if (singleLine) 1 else 3,
        leadingIcon = icon?.let { { Icon(it, null, tint = colors.onSurfaceVariant) } }, trailingIcon = trailing,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType, capitalization = if (keyboardType == KeyboardType.Text) KeyboardCapitalization.Sentences else KeyboardCapitalization.None, imeAction = imeAction),
        keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
        colors = TextFieldDefaults.colors(focusedContainerColor = colors.surfaceContainerLow, unfocusedContainerColor = colors.surfaceContainerLow, disabledContainerColor = colors.surfaceContainerLow,
            focusedIndicatorColor = colors.primary, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent),
        modifier = modifier.heightIn(min = 64.dp))
}

internal fun countryName(region: String): String = runCatching { Locale.Builder().setRegion(region).build().getDisplayCountry(Locale.getDefault()).ifBlank { region } }.getOrDefault(region)
internal fun captureRegion(): String = Locale.getDefault().country.takeIf { it in PhoneNumberUtil.getInstance().supportedRegions } ?: "US"

@Composable
private fun ContactCountryChooser(selected: String, select: (String) -> Unit, close: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val countries = remember { PhoneNumberUtil.getInstance().supportedRegions.map { it to countryName(it) }.sortedBy { it.second } }
    AlertDialog(onDismissRequest = close, title = { Text("Country for local numbers") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
            Text("Numbers starting with + already include their country code.")
            OutlinedTextField(query, { query = it }, label = { Text("Search countries") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            LazyColumn(Modifier.heightIn(max = 320.dp)) {
                items(countries.filter { it.first.contains(query, true) || it.second.contains(query, true) }, key = { it.first }) { (code, name) ->
                    TextButton(onClick = { select(code) }, modifier = Modifier.fillMaxWidth()) { Text("${if (code == selected) "✓ " else ""}$name ($code)", Modifier.fillMaxWidth()) }
                }
            }
        }
    }, confirmButton = { TextButton(onClick = close) { Text("Cancel") } })
}
