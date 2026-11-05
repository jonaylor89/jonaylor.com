package app.mypeople.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.mypeople.data.PeopleSection
import app.mypeople.data.fastScrollSection
import kotlin.math.abs
import kotlin.math.ceil

/** Arrow with an end-stop, rather than a dropdown chevron. */
@Composable
fun EdgeJumpIcon(toBottom: Boolean) {
    val color = LocalContentColor.current
    Canvas(Modifier.size(24.dp).semantics { contentDescription = if (toBottom) "Jump to bottom" else "Jump to top" }) {
        val stroke = 2.dp.toPx()
        rotate(if (toBottom) 0f else 180f) {
            drawLine(color, Offset(size.width * .5f, size.height * .12f), Offset(size.width * .5f, size.height * .65f), stroke)
            drawLine(color, Offset(size.width * .28f, size.height * .43f), Offset(size.width * .5f, size.height * .65f), stroke)
            drawLine(color, Offset(size.width * .72f, size.height * .43f), Offset(size.width * .5f, size.height * .65f), stroke)
            drawLine(color, Offset(size.width * .22f, size.height * .85f), Offset(size.width * .78f, size.height * .85f), stroke)
        }
    }
}

/** Consume once, even when Navigation saves/restores a screen's scroll position. */
@Composable
fun OnScrollToTopRequest(request: Long, scroll: suspend () -> Unit) {
    var consumed by rememberSaveable { mutableLongStateOf(0) }
    val currentScroll by rememberUpdatedState(scroll)
    LaunchedEffect(request) {
        if (request != 0L && request != consumed) {
            consumed = request
            currentScroll()
        }
    }
}

/** A touch-target-wide gesture surface with a narrow letter pill inside it. */
@Composable
fun PeopleFastScroll(
    sections: List<PeopleSection>,
    selected: Char?,
    onJump: (PeopleSection) -> Unit,
    onPreview: (Char?) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (sections.isEmpty()) return
    val haptic = LocalHapticFeedback.current
    val jump by rememberUpdatedState(onJump)
    val preview by rememberUpdatedState(onPreview)
    val selectedIndex = sections.indexOfFirst { it.letter == selected }.coerceAtLeast(0)
    BoxWithConstraints(modifier.width(48.dp).padding(vertical = 8.dp)) {
        val fontScale = LocalDensity.current.fontScale
        val cellHeight = maxHeight / sections.size
        // Leave room for large system text. The full alphabet remains scrubbable;
        // the letter chooser exposes every section as an ordinary 48dp button.
        val stride = ceil((16f * fontScale / cellHeight.value.coerceAtLeast(1f))).toInt().coerceAtLeast(1)
        Box(
            Modifier.fillMaxSize().testTag("people-fast-scroll")
                .semantics {
                    contentDescription = "Fast scroll contacts"
                    stateDescription = "Section ${sections[selectedIndex].letter}"
                    progressBarRangeInfo = ProgressBarRangeInfo(selectedIndex.toFloat(), 0f..(sections.size - 1).coerceAtLeast(1).toFloat(), (sections.size - 2).coerceAtLeast(0))
                    setProgress { value ->
                        if (!value.isFinite()) false else {
                            jump(sections[value.toInt().coerceIn(sections.indices)]); true
                        }
                    }
                }
                .onKeyEvent { event ->
                    if (event.type != KeyEventType.KeyDown) false else {
                        val index = when (event.key) {
                            Key.DirectionUp -> (selectedIndex - 1).coerceAtLeast(0)
                            Key.DirectionDown -> (selectedIndex + 1).coerceAtMost(sections.lastIndex)
                            Key.MoveHome -> 0
                            Key.MoveEnd -> sections.lastIndex
                            else -> return@onKeyEvent false
                        }
                        jump(sections[index]); true
                    }
                }.focusable()
                .pointerInput(sections) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        down.consume()
                        var lastIndex: Int? = null
                        fun select(y: Float) {
                            val index = fastScrollSection(y, size.height.toFloat(), sections.size) ?: return
                            if (index != lastIndex) {
                                lastIndex = index
                                preview(sections[index].letter)
                                jump(sections[index])
                                haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                            }
                        }
                        try {
                            select(down.position.y)
                            do {
                                val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                                change.consume()
                                if (change.pressed) select(change.position.y)
                            } while (change.pressed)
                        } finally { preview(null) }
                    }
                },
        ) {
            Box(Modifier.align(Alignment.Center).width(24.dp).fillMaxHeight().background(MaterialTheme.colorScheme.surfaceContainer, CircleShape))
            Column(Modifier.fillMaxSize().clearAndSetSemantics { }) {
                sections.forEachIndexed { index, section ->
                    val active = section.letter == selected
                    val showLetter = index == 0 || index == sections.lastIndex || (index % stride == 0 && (stride == 1 || abs(index - selectedIndex) >= stride)) || active
                    Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                        if (showLetter) Text(section.letter.toString(), Modifier.wrapContentSize(unbounded = true), style = MaterialTheme.typography.labelSmall, fontSize = 11.sp, lineHeight = 12.sp, fontWeight = if (active) FontWeight.Bold else FontWeight.SemiBold, color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                        else Box(Modifier.size(2.dp).background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .5f), CircleShape))
                    }
                }
            }
        }
    }
}

@Composable
fun PeopleLetterChooser(sections: List<PeopleSection>, jump: (PeopleSection) -> Unit, close: () -> Unit) {
    AlertDialog(onDismissRequest = close, title = { Text("Jump to a letter") }, text = {
        androidx.compose.foundation.lazy.grid.LazyVerticalGrid(
            columns = androidx.compose.foundation.lazy.grid.GridCells.Adaptive((48.dp * LocalDensity.current.fontScale).coerceAtLeast(56.dp)),
            modifier = Modifier.fillMaxWidth().heightIn(max = 400.dp).testTag("people-letter-grid"),
        ) {
            items(sections.size, key = { sections[it].letter.toString() }) { index ->
                val section = sections[index]
                TextButton(onClick = { jump(section); close() }, modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Jump to ${section.letter}, ${section.count} contacts" }) { Text(section.letter.toString(), style = MaterialTheme.typography.titleMedium) }
            }
        }
    }, confirmButton = { TextButton(onClick = close) { Text("Close") } })
}
