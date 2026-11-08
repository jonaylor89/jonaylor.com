package app.mypeople.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import app.mypeople.AppGraph
import app.mypeople.data.*
import kotlinx.coroutines.CancellationException

internal data class PhonePreviewUi(val source: Person, val preview: ContactPhonePreview? = null, val failed: Boolean = false)

/** Only this person's point provenance is read, off the UI thread through Store. */
@Composable
internal fun rememberContactPhonePreview(person: Person, graph: AppGraph): Pair<PhonePreviewUi, () -> Unit> {
    var attempt by remember(person.contact_uid) { mutableIntStateOf(0) }
    val loaded by produceState<PhonePreviewUi?>(null, person, attempt) {
        value = null
        try { value = PhonePreviewUi(person, graph.store.contactPhonePreview(person)) }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { value = PhonePreviewUi(person, failed = true) }
    }
    return (loaded?.takeIf { it.source == person } ?: PhonePreviewUi(person)) to { attempt++ }
}

@Composable
internal fun PhoneNumbersPreview(preview: ContactPhonePreview) {
    Column(verticalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
        Text("${preview.numbers.size} distinct ${if (preview.numbers.size == 1) "number" else "numbers"} · ${preview.entries} saved entries", style = MaterialTheme.typography.titleSmall)
        preview.numbers.forEach { number ->
            Column {
                Text(phoneDisplay(number.number), style = MaterialTheme.typography.bodyLarge)
                Text((number.labels + if (number.entries > 1) listOf("${number.entries} saved copies") else emptyList()).joinToString(" · "), style = MaterialTheme.typography.bodySmall)
            }
        }
        if (preview.importHints.isNotEmpty()) Text("${preview.importHints.size} unverified import hints are kept separately. No country codes are guessed.", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
internal fun EarlierSeparationPreview(preview: ContactPhonePreview) {
    if (preview.earlierSeparation.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
        Text("Earlier keep-separate decision", style = MaterialTheme.typography.titleSmall)
        preview.earlierSeparation.forEach { decision ->
            listOf(decision.left, decision.right).forEach { source ->
                Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainer) {
                    Column(Modifier.fillMaxWidth().padding(KinSpace.s3)) {
                        Text(source.name, style = MaterialTheme.typography.labelLarge)
                        if (source.numbers.isEmpty()) Text("No separate verified phone entry", style = MaterialTheme.typography.bodySmall)
                        source.numbers.forEach { Text(phoneDisplay(it), style = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
            Text("These source records were marked as different people. The contact above currently combines them.", style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
internal fun UnverifiedPhoneHints(preview: ContactPhonePreview) {
    if (preview.importHints.isEmpty()) return
    var expanded by remember { mutableStateOf(false) }
    Column {
        TextButton(onClick = { expanded = !expanded }) { Text("${if (expanded) "Hide" else "Show"} ${preview.importHints.size} unverified import hints") }
        if (expanded) {
            Text("These old matching hints are not verified phone numbers. They are retained for review, not offered as Call or Message actions. Removing repeated phone entries leaves them untouched.", style = MaterialTheme.typography.bodySmall)
            preview.importHints.forEach { Text(it.value, style = MaterialTheme.typography.bodyMedium) }
        }
    }
}
