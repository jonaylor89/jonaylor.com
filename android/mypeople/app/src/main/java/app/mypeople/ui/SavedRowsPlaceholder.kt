package app.mypeople.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** The real screen stays navigable during a first legacy-cache migration. No modal spinner,
 * fictional empty-state claims, or animation competing with disk loading on slower phones.
 */
@Composable
fun SavedRowsPlaceholder() {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp).semantics { contentDescription = "Reading saved contacts on this device" }, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        repeat(3) {
            Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Surface(Modifier.size(44.dp), shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainerHigh) { }
                Column(Modifier.weight(1f).padding(top = 5.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    Surface(Modifier.fillMaxWidth(.55f).height(13.dp), shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerHigh) { }
                    Surface(Modifier.fillMaxWidth(.8f).height(9.dp), shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerHigh) { }
                }
            }
        }
    }
}
