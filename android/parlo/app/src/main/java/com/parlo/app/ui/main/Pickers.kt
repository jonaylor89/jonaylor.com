package com.parlo.app.ui.main

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import com.parlo.app.ui.theme.ParloMotion
import com.parlo.app.ui.theme.ParloShape
import com.parlo.app.ui.theme.ParloSize
import com.parlo.app.ui.theme.ParloSpacing
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Dropdown of suggestions that also accepts free text. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComboBox(
    label: String,
    value: String,
    suggestions: List<String>,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { if (enabled) expanded = it }, modifier = modifier) {
        OutlinedTextField(
            value = value,
            onValueChange = { onValueChange(it) },
            label = { Text(label) },
            singleLine = true,
            enabled = enabled,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryEditable),
        )
        val filtered = suggestions.filter { it.contains(value, ignoreCase = true) || value.isBlank() }
        if (filtered.isNotEmpty()) {
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                filtered.forEach { s ->
                    DropdownMenuItem(
                        text = { Text(s) },
                        trailingIcon = { if (s == value) Icon(Icons.Filled.Check, null) },
                        onClick = { onValueChange(s); expanded = false },
                    )
                }
            }
        }
    }
}

/** Level and correction style: connected segments, the selected one on Sunpath (secondary) with a check. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> SegmentedPicker(
    options: List<T>,
    selected: T,
    label: (T) -> String,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    SingleChoiceSegmentedButtonRow(modifier = modifier.fillMaxWidth()) {
        options.forEachIndexed { i, opt ->
            SegmentedButton(
                selected = opt == selected,
                onClick = { onSelect(opt) },
                shape = SegmentedButtonDefaults.itemShape(index = i, count = options.size),
                colors = SegmentedButtonDefaults.colors(
                    activeContainerColor = scheme.secondary,
                    activeContentColor = scheme.onSecondary,
                    activeBorderColor = scheme.secondary,
                    inactiveContainerColor = scheme.surfaceContainerHighest,
                    inactiveBorderColor = scheme.outline,
                ),
                modifier = Modifier.heightIn(min = ParloSize.targetMin),
            ) { Text(label(opt), maxLines = 1, style = MaterialTheme.typography.labelLarge) }
        }
    }
}

/**
 * A two-to-four-way toggle drawn as an M3 Expressive connected button group: full outer corners,
 * tighter inner ones, a hairline gap, and the selection morphing to a full pill.
 */
@Composable
fun <T> ConnectedChoice(
    options: List<T>,
    selected: T,
    label: (T) -> String,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    icon: ((T) -> ImageVector)? = null,
) {
    val scheme = MaterialTheme.colorScheme
    Row(modifier.fillMaxWidth().selectableGroup(), horizontalArrangement = Arrangement.spacedBy(ParloSpacing.hair)) {
        options.forEachIndexed { i, opt ->
            val isSelected = opt == selected
            val bg by animateColorAsState(if (isSelected) scheme.secondary else scheme.surfaceContainerHighest, ParloMotion.effects(), label = "choice")
            Surface(
                shape = ParloShape.connected(i, options.size, isSelected),
                color = bg,
                contentColor = if (isSelected) scheme.onSecondary else scheme.onSurface,
                modifier = Modifier.weight(1f).heightIn(min = ParloSize.targetMin)
                    .selectable(selected = isSelected, onClick = { onSelect(opt) }, role = Role.RadioButton),
            ) {
                Row(Modifier.padding(horizontal = ParloSpacing.space3), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    val glyph = if (isSelected) Icons.Rounded.Check else icon?.invoke(opt)
                    if (glyph != null) {
                        Icon(glyph, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(ParloSpacing.space2))
                    }
                    Text(label(opt), style = MaterialTheme.typography.labelLarge, maxLines = 1)
                }
            }
        }
    }
}

/** Quick-switch and accent chips: selected on secondary-container with a leading check; wraps, never scrolls. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun <T> ChipRow(
    options: List<T>,
    selected: T?,
    label: (T) -> String,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    FlowRow(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(ParloSpacing.space2)) {
        options.forEach { opt ->
            val isSelected = opt == selected
            FilterChip(
                selected = isSelected,
                onClick = { onSelect(opt) },
                label = { Text(label(opt)) },
                leadingIcon = if (isSelected) ({ Icon(Icons.Rounded.Check, null, Modifier.size(FilterChipDefaults.IconSize)) }) else null,
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = scheme.secondaryContainer,
                    selectedLabelColor = scheme.onSecondaryContainer,
                    selectedLeadingIconColor = scheme.onSecondaryContainer,
                ),
            )
        }
    }
}
