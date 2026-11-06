package app.mypeople.ui

import app.mypeople.ui.icons.*

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.sp
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.mypeople.AppGraph
import app.mypeople.data.Person
import java.util.Base64
import coil3.compose.AsyncImage

/** The settings entry point: the "account avatar" at the trailing end of each screen's top. */
@Composable
fun AccountButton(onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.testTag("nav-settings")) {
        Box(Modifier.size(32.dp).background(MaterialTheme.colorScheme.secondaryContainer, CircleShape), contentAlignment = Alignment.Center) {
            Icon(Symbols.Person, "Settings", Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSecondaryContainer)
        }
    }
}

@Composable
fun Heading(title: String, subtitle: String, onAccount: (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(start = KinSpace.s4, end = KinSpace.s2, top = KinSpace.s4, bottom = KinSpace.s3), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f).padding(top = KinSpace.s1), verticalArrangement = Arrangement.spacedBy(KinSpace.s1)) {
            Text(title, Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineMedium)
            Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (onAccount != null) AccountButton(onAccount)
    }
}

@Composable
fun Section(title: String) {
    Text(title, Modifier.fillMaxWidth().padding(top = KinSpace.s6, bottom = KinSpace.s2).semantics { heading() }, style = MaterialTheme.typography.titleLarge)
}

/** An alphabet section label: an expressive letter and a quiet count. */
@Composable
fun SectionHeader(label: String, count: String? = null, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().padding(start = KinSpace.s4, end = KinSpace.s4, top = KinSpace.s5, bottom = KinSpace.s2).semantics(mergeDescendants = true) { heading() }, verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(KinSpace.s3)) {
        Text(label, style = KinType.indexLetter, color = MaterialTheme.colorScheme.secondary)
        if (count != null) Text(count, Modifier.padding(bottom = 3.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Segmented list cards: large outer corners, small inner corners, hairline seams. */
fun segmentShape(index: Int, count: Int): Shape = RoundedCornerShape(
    topStart = if (index == 0) KinRadius.xl else KinRadius.sm, topEnd = if (index == 0) KinRadius.xl else KinRadius.sm,
    bottomStart = if (index == count - 1) KinRadius.xl else KinRadius.sm, bottomEnd = if (index == count - 1) KinRadius.xl else KinRadius.sm,
)

/** A connected button group used as tabs; the selection is a secondary-container fill. */
@Composable
fun JournalTabs(selected: Int, labels: List<String>, onSelect: (Int) -> Unit) {
    val scrollable = LocalDensity.current.fontScale > 1.3f
    val scroll = rememberScrollState()
    Row(Modifier.padding(horizontal = KinSpace.s4).fillMaxWidth()
        .then(if (scrollable) Modifier.horizontalScroll(scroll) else Modifier).selectableGroup(), horizontalArrangement = Arrangement.spacedBy(KinSpace.half)) {
        labels.forEachIndexed { index, label ->
            val requester = remember { BringIntoViewRequester() }
            LaunchedEffect(selected, scrollable) { if (scrollable && selected == index) requester.bringIntoView() }
            val on = selected == index
            val color by animateColorAsState(if (on) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainer, KinMotion.effects(), label = "tab")
            val shape = RoundedCornerShape(
                topStartPercent = if (index == 0 || on) 50 else 15, bottomStartPercent = if (index == 0 || on) 50 else 15,
                topEndPercent = if (index == labels.lastIndex || on) 50 else 15, bottomEndPercent = if (index == labels.lastIndex || on) 50 else 15,
            )
            Box(Modifier.then(if (scrollable) Modifier.widthIn(min = 96.dp) else Modifier.weight(1f)).bringIntoViewRequester(requester).clip(shape).background(color).selectable(on, role = Role.Tab, onClick = { onSelect(index) }).heightIn(min = KinSize.touchTarget).padding(horizontal = if (scrollable) KinSpace.s5 else KinSpace.s2, vertical = KinSpace.s3), contentAlignment = Alignment.Center) {
                Text(label, softWrap = false, style = MaterialTheme.typography.labelLarge, color = if (on) MaterialTheme.colorScheme.onSecondaryContainer else MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
fun JournalCard(modifier: Modifier = Modifier, shape: Shape = RoundedCornerShape(KinRadius.xl), content: @Composable ColumnScope.() -> Unit) {
    Card(modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = journalSurfaceColor()), shape = shape, content = content)
}

@Composable
fun EmptyState(title: String, detail: String, actionLabel: String? = null, onAction: () -> Unit = {}) {
    Column(Modifier.fillMaxWidth().padding(KinSpace.s4).clip(RoundedCornerShape(KinRadius.xl)).background(MaterialTheme.colorScheme.surfaceContainerLow).padding(KinSpace.s6), verticalArrangement = Arrangement.spacedBy(KinSpace.s3)) {
        Surface(shape = CircleShape, color = MaterialTheme.colorScheme.secondaryContainer) {
            Icon(Icons.Outlined.Spa, null, Modifier.padding(KinSpace.s4).size(24.dp), tint = MaterialTheme.colorScheme.onSecondaryContainer)
        }
        Text(title, style = MaterialTheme.typography.headlineSmall)
        Text(detail, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (actionLabel != null) FilledTonalButton(onClick = onAction) { Text(actionLabel) }
    }
}

/**
 * A label chip. [date] is for birthdays and anniversaries: the only place tertiary appears,
 * so it always means "a date that matters".
 */
@Composable
fun MetaLabel(text: String, date: Boolean = false) {
    val colors = MaterialTheme.colorScheme
    Surface(
        color = if (date) colors.tertiaryContainer else colors.surface.copy(alpha = 0f),
        contentColor = if (date) colors.onTertiaryContainer else colors.onSurfaceVariant,
        shape = RoundedCornerShape(KinRadius.sm),
        border = if (date) null else BorderStroke(1.dp, colors.outline),
    ) {
        Row(Modifier.heightIn(min = 32.dp).padding(start = if (date) KinSpace.s2 else KinSpace.s4, end = KinSpace.s4), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
            if (date) Icon(Symbols.Cake, null, Modifier.size(18.dp))
            Text(text, style = MaterialTheme.typography.labelLarge)
        }
    }
}

enum class AvatarShape { Circle, Cookie, Soft }

/** Favorites wear the cookie; a business (named only by its company) a soft square. */
fun Person.avatarShape(): AvatarShape = when {
    card?.favorite == true -> AvatarShape.Cookie
    card?.organization?.isNotBlank() == true && card.organization.trim() == name.trim() -> AvatarShape.Soft
    else -> AvatarShape.Circle
}

fun Person.paletteSeed(): String = contact_uid.ifEmpty { name }

fun initials(name: String): String = name.split(" ").filter { it.isNotEmpty() && it.first().isLetterOrDigit() }.take(2).map { it.first().uppercaseChar() }.joinToString("")

@Composable
fun Avatar(person: Person, graph: AppGraph, size: Dp = KinSize.avatarSm, shape: AvatarShape = person.avatarShape()) {
    val palette = personPalette(person.paletteSeed())
    // Starring someone morphs their circle into a cookie.
    val cookie by animateFloatAsState(if (shape == AvatarShape.Cookie) 1f else 0f, KinMotion.spatialFast(), label = "avatar-shape")
    val clip = when {
        shape == AvatarShape.Soft -> RoundedCornerShape(size * .3f)
        cookie > 0f -> cookieShape(cookie)
        else -> CircleShape
    }
    // Avatars are fixed-size, so their monograms don't follow the font scale.
    val fontScale = LocalDensity.current.fontScale
    val letterSize = (if (size >= KinSize.avatarXl) 56f else size.value * .42f) / fontScale
    val monogram = (if (size >= KinSize.avatarXl) KinType.monogramLarge else KinType.monogram).copy(fontSize = letterSize.sp, lineHeight = letterSize.sp)
    val fallback: @Composable () -> Unit = {
        Box(Modifier.fillMaxSize().background(palette.container), contentAlignment = Alignment.Center) {
            val letters = initials(person.name)
            if (letters.isEmpty()) Icon(Symbols.Person, null, Modifier.size(size * .5f), tint = palette.onContainer)
            else Text(letters, style = monogram, color = palette.onContainer, maxLines = 1)
        }
    }
    Box(Modifier.size(size).clip(clip)) {
        val manual = remember(person.card?.photo) { person.card?.photo?.takeIf { it.isNotEmpty() }?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() } }
        // The monogram stays underneath; a plain AsyncImage avoids a subcomposition per row.
        fallback()
        val hash = person.card?.photo_hash?.ifEmpty { null } ?: person.photo
        val model = remember(manual, hash) { manual ?: hash?.let { val file = graph.offline.photo(it); file.takeIf { it.exists() } } }
        if (model != null) AsyncImage(model = model, imageLoader = graph.imageLoader, contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
    }
}

/** One person in a list card: avatar, name, a supporting line and an optional trailing action. */
@Composable
fun PersonRow(person: Person, graph: AppGraph, detail: String?, modifier: Modifier = Modifier, trailing: (@Composable () -> Unit)? = null, onClick: () -> Unit) {
    Row(modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = KinSize.rowTwoLine).padding(start = KinSpace.s4, end = if (trailing != null) KinSpace.s1 else KinSpace.s4, top = KinSpace.s2, bottom = KinSpace.s2), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KinSpace.s4)) {
        Avatar(person, graph)
        Column(Modifier.weight(1f)) {
            Text(person.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!detail.isNullOrBlank()) Text(detail, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        trailing?.invoke()
    }
}

/** The search bar is the screen's title on compact widths; it never scrolls away. */
@Composable
fun KinSearchBar(query: String, onQuery: (String) -> Unit, scrolled: Boolean, modifier: Modifier = Modifier, onAccount: (() -> Unit)? = null) {
    Surface(modifier.fillMaxWidth().heightIn(min = KinSize.searchBar), shape = RoundedCornerShape(KinRadius.xl), color = MaterialTheme.colorScheme.surfaceContainerHigh, shadowElevation = if (scrolled) KinElevation.level1 else 0.dp) {
        Row(Modifier.padding(start = KinSpace.s4, end = KinSpace.s1), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KinSpace.s4)) {
            Icon(Symbols.Search, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                BasicTextField(
                    query, onQuery, singleLine = true,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    modifier = Modifier.fillMaxWidth().padding(vertical = KinSpace.s4).semantics { contentDescription = "Search people" },
                    decorationBox = { field ->
                        if (query.isEmpty()) Text("Search contacts", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        field()
                    },
                )
            }
            if (query.isNotEmpty()) IconButton(onClick = { onQuery("") }) { Icon(Symbols.Close, "Clear search", tint = MaterialTheme.colorScheme.onSurfaceVariant) }
            else if (onAccount != null) AccountButton(onAccount)
        }
    }
}

/** The app's only FAB. Collapses to its icon while the list scrolls down. */
@Composable
fun KinFab(label: String, icon: ImageVector, expanded: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    Surface(
        onClick = onClick, enabled = enabled, modifier = Modifier.semantics { contentDescription = label }.alpha(if (enabled) 1f else .38f),
        shape = RoundedCornerShape(KinRadius.lg), color = MaterialTheme.colorScheme.primaryContainer, contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
        shadowElevation = KinElevation.level3,
    ) {
        Row(Modifier.heightIn(min = KinSize.fab).widthIn(min = KinSize.fab).padding(start = KinSpace.s4, end = if (expanded) KinSpace.s5 else KinSpace.s4), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null)
            AnimatedVisibility(expanded, enter = fadeIn(KinMotion.effects()) + expandHorizontally(KinMotion.spatialDefault()), exit = fadeOut(KinMotion.effects()) + shrinkHorizontally(KinMotion.spatialDefault())) {
                Text(label, Modifier.padding(start = KinSpace.s3), style = MaterialTheme.typography.labelLarge, maxLines = 1)
            }
        }
    }
}

fun openIntent(context: Context, action: String, uri: Uri) {
    try { context.startActivity(Intent(action, uri)) }
    catch (_: ActivityNotFoundException) { Toast.makeText(context, "No app is available for this action.", Toast.LENGTH_SHORT).show() }
    catch (_: SecurityException) { Toast.makeText(context, "This action isn't available on this device.", Toast.LENGTH_SHORT).show() }
}
fun openLink(context: Context, url: String) {
    val uri = Uri.parse(url)
    if (uri.scheme in listOf("https", "http")) openIntent(context, Intent.ACTION_VIEW, uri)
}
