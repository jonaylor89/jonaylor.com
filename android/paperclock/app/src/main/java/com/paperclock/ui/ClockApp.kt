package com.paperclock.ui

import android.media.MediaPlayer
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.paperclock.R
import com.paperclock.data.AlarmEntity
import com.paperclock.data.AlarmWithGoalRow
import com.paperclock.data.GoalEntity
import com.paperclock.data.SoundCatalog
import com.paperclock.ui.theme.Bone
import com.paperclock.ui.theme.Charcoal
import com.paperclock.ui.theme.Gold
import com.paperclock.ui.theme.Ink
import com.paperclock.ui.theme.Slate
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Calendar
import kotlin.math.abs

private enum class Destination { HOME, GOALS, WIZARD, EDITOR, SETTINGS }
private val dayNames = listOf(
    Calendar.MONDAY to "Mon", Calendar.TUESDAY to "Tue", Calendar.WEDNESDAY to "Wed",
    Calendar.THURSDAY to "Thu", Calendar.FRIDAY to "Fri", Calendar.SATURDAY to "Sat", Calendar.SUNDAY to "Sun"
)
private val dateFormat = DateTimeFormatter.ofPattern("MMM d, yyyy")
private val MaterialSymbolsRounded = FontFamily(Font(R.font.material_symbols_rounded))

@Composable
private fun MaterialSymbol(symbol: String, tint: Color, size: TextUnit) {
    val glyph = when (symbol) {
        "add" -> "\uE145"
        "more_horiz" -> "\uE5D3"
        "settings" -> "\uE8B8"
        else -> error("Unknown Material Symbol: $symbol")
    }
    Text(glyph, color = tint, fontFamily = MaterialSymbolsRounded, fontSize = size, lineHeight = size)
}

@Composable
fun ClockApp(vm: ClockViewModel, openExactSettings: () -> Unit, openNewAlarm: Boolean = false, openGoals: Boolean = false) {
    val state by vm.state.collectAsState()
    var destination by remember { mutableStateOf(if (openNewAlarm) Destination.EDITOR else if (openGoals) Destination.GOALS else Destination.HOME) }
    var editing by remember { mutableStateOf<AlarmEntity?>(null) }
    var alarmToDelete by remember { mutableStateOf<AlarmEntity?>(null) }
    var goalToDelete by remember { mutableStateOf<GoalEntity?>(null) }
    var homeMessage by remember { mutableStateOf<String?>(null) }
    var goalsMessage by remember { mutableStateOf<String?>(null) }

    BackHandler(enabled = destination != Destination.HOME) {
        destination = when (destination) {
            Destination.GOALS, Destination.SETTINGS, Destination.EDITOR -> Destination.HOME
            Destination.WIZARD -> Destination.GOALS
            Destination.HOME -> Destination.HOME
        }
    }

    AnimatedContent(
        targetState = destination,
        transitionSpec = {
            (fadeIn(tween(180)) + slideInHorizontally(tween(240)) { it / 12 }) togetherWith
                (fadeOut(tween(120)) + slideOutHorizontally(tween(180)) { -it / 16 })
        },
        label = "paper-clock-screen"
    ) { screen ->
        when (screen) {
        Destination.HOME -> HomeScreen(
            state = state,
            exactAllowed = vm.canScheduleExact(),
            onGoals = { destination = Destination.GOALS },
            onSettings = { destination = Destination.SETTINGS },
            onAdd = { editing = null; destination = Destination.EDITOR },
            onEdit = { editing = it; destination = Destination.EDITOR },
            onDelete = { alarmToDelete = it },
            onToggle = vm::toggle,
            openExactSettings = openExactSettings,
            confirmation = homeMessage,
            onConfirmationShown = { homeMessage = null }
        )
        Destination.GOALS -> GoalsScreen(
            goals = state.goals,
            alarms = state.alarms,
            onBack = { destination = Destination.HOME },
            onAdd = { destination = Destination.WIZARD },
            onDelete = { goalToDelete = it },
            confirmation = goalsMessage,
            onConfirmationShown = { goalsMessage = null }
        )
        Destination.WIZARD -> GoalWizard(
            onCancel = { destination = Destination.GOALS },
            onSave = { goal, alarm -> vm.saveGoal(goal, alarm); goalsMessage = "Goal created"; destination = Destination.GOALS }
        )
        Destination.EDITOR -> AlarmEditor(
            existing = editing,
            goals = state.goals,
            onBack = { destination = Destination.HOME },
            onSave = { alarm ->
                vm.saveAlarm(alarm)
                homeMessage = when {
                    !alarm.enabled -> "Alarm saved"
                    vm.canScheduleExact() -> "Alarm set for ${formatTime(alarm)}"
                    else -> "Alarm saved. Allow exact alarms to ring on time."
                }
                destination = Destination.HOME
            }
        )
        Destination.SETTINGS -> SettingsScreen(
            exactAllowed = vm.canScheduleExact(),
            onBack = { destination = Destination.HOME },
            openExactSettings = openExactSettings
        )
        }
    }

    alarmToDelete?.let { alarm ->
        ConfirmDeleteDialog(
            title = "Delete alarm?",
            body = "${formatTime(alarm)} will be removed.",
            onDismiss = { alarmToDelete = null },
            onConfirm = { vm.deleteAlarm(alarm); alarmToDelete = null }
        )
    }
    goalToDelete?.let { goal ->
        ConfirmDeleteDialog(
            title = "Delete goal?",
            body = "This removes ${goal.title} and unlinks its alarms.",
            onDismiss = { goalToDelete = null },
            onConfirm = { vm.deleteGoal(goal); goalToDelete = null }
        )
    }
}

@Composable
private fun HomeScreen(
    state: ClockUiState,
    exactAllowed: Boolean,
    onGoals: () -> Unit,
    onSettings: () -> Unit,
    onAdd: () -> Unit,
    onEdit: (AlarmEntity) -> Unit,
    onDelete: (AlarmEntity) -> Unit,
    onToggle: (AlarmEntity) -> Unit,
    openExactSettings: () -> Unit,
    confirmation: String?,
    onConfirmationShown: () -> Unit
) {
    val next = state.alarms.filter { it.alarm.enabled }.minByOrNull { millisUntil(it.alarm) }
    val snackbarHostState = remember { SnackbarHostState() }
    LaunchedEffect(confirmation) {
        confirmation?.let {
            snackbarHostState.showSnackbar(it)
            onConfirmationShown()
        }
    }
    Scaffold(
        containerColor = Ink,
        topBar = { HomeTopBar(onGoals, onSettings) },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                text = { Text("ADD ALARM", fontWeight = FontWeight.Black, letterSpacing = .5.sp) },
                icon = { MaterialSymbol("add", Ink, 22.sp) },
                onClick = onAdd,
                modifier = Modifier.semantics { contentDescription = "Add alarm" },
                shape = RoundedCornerShape(16.dp),
                containerColor = Gold,
                contentColor = Ink
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            item { Spacer(Modifier.height(6.dp)) }
            if (!exactAllowed) item { ExactAlarmCard(openExactSettings) }
            item { NextAlarmPanel(next, onAdd) }
            item { AlarmListHeader(state.alarms.count { it.alarm.enabled }) }
            items(state.alarms, key = { it.alarm.id }) { row ->
                AlarmRow(row, onEdit, { onDelete(row.alarm) }, onToggle)
            }
            item { Spacer(Modifier.height(88.dp)) }
        }
    }
}

@Composable
private fun HomeTopBar(onGoals: () -> Unit, onSettings: () -> Unit) {
    Surface(color = Ink) {
        Row(
            Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 20.dp, vertical = 16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(46.dp).clip(RoundedCornerShape(15.dp)).background(Charcoal)
                        .border(1.dp, Gold.copy(alpha = .45f), RoundedCornerShape(15.dp))
                ) {
                    Image(
                        painter = painterResource(R.drawable.brand_mark),
                        contentDescription = "Paper Clock",
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize()
                    )
                }
                Column(Modifier.padding(start = 10.dp)) {
                    Text("PAPER", style = MaterialTheme.typography.titleMedium, color = Gold, letterSpacing = 1.sp)
                    Text("CLOCK", style = MaterialTheme.typography.titleLarge, color = Bone, letterSpacing = .5.sp)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onGoals) { Text("GOALS", style = MaterialTheme.typography.titleMedium, color = Gold, letterSpacing = .7.sp) }
                IconButton(onClick = onSettings, modifier = Modifier.padding(start = 2.dp).semantics { contentDescription = "Open settings" }) { MaterialSymbol("settings", Bone.copy(alpha = .78f), 27.sp) }
            }
        }
    }
}

@Composable
private fun ExactAlarmCard(open: () -> Unit) {
    Surface(color = Charcoal, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("SYSTEM CHECK", style = MaterialTheme.typography.labelMedium, color = Gold, letterSpacing = .7.sp)
                Text("Allow exact alarms", style = MaterialTheme.typography.titleMedium, color = Bone, modifier = Modifier.padding(top = 3.dp))
                Text("Android needs permission to ring at the time you set.", style = MaterialTheme.typography.bodySmall, color = Bone.copy(alpha = .68f), modifier = Modifier.padding(top = 2.dp))
            }
            TextButton(onClick = open) { Text("ALLOW", color = Gold, fontWeight = FontWeight.Black) }
        }
    }
}

@Composable
private fun NextAlarmPanel(next: AlarmWithGoalRow?, onAdd: () -> Unit) {
    val panelShape = RoundedCornerShape(26.dp)
    BoxWithConstraints(
        Modifier.fillMaxWidth().height(if (next == null) 196.dp else 244.dp).clip(panelShape)
            .background(Brush.linearGradient(listOf(Charcoal, Slate, Ink)))
            .border(1.dp, Gold.copy(alpha = .48f), panelShape)
    ) {
        val timeSize = if (maxWidth < 350.dp) 64.sp else 76.sp
        Box(Modifier.align(Alignment.TopEnd).size(172.dp).clip(CircleShape).background(Gold.copy(alpha = .12f)))
        Box(Modifier.align(Alignment.TopEnd).padding(25.dp).size(100.dp).border(2.dp, Gold.copy(alpha = .55f), CircleShape))
        PaperGrain(Modifier.fillMaxSize(), Bone.copy(alpha = .045f))
        Column(Modifier.align(Alignment.CenterStart).padding(horizontal = 26.dp, vertical = 20.dp)) {
            Text("NEXT ALARM", style = MaterialTheme.typography.labelLarge, color = Gold, letterSpacing = 1.sp)
            if (next == null) {
                Text("NO ALARM", style = MaterialTheme.typography.headlineLarge.copy(fontSize = 42.sp), modifier = Modifier.padding(top = 22.dp))
                TextButton(onClick = onAdd, modifier = Modifier.padding(top = 4.dp)) { Text("SET ONE NOW", color = Gold, fontWeight = FontWeight.Black) }
            } else {
                Text(
                    formatTime(next.alarm),
                    style = MaterialTheme.typography.displayLarge.copy(fontSize = timeSize, letterSpacing = (-3).sp),
                    color = Bone,
                    modifier = Modifier.padding(top = 4.dp)
                )
                Text(
                    (next.goal?.title ?: next.alarm.label.ifBlank { "Alarm" }).uppercase(),
                    style = MaterialTheme.typography.titleMedium,
                    color = Gold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(nextAlarmDetail(next.alarm), style = MaterialTheme.typography.bodyMedium, color = Bone.copy(alpha = .72f), modifier = Modifier.padding(top = 8.dp))
            }
        }
    }
}

@Composable
private fun PaperGrain(modifier: Modifier = Modifier, color: Color) {
    Canvas(modifier) {
        repeat(230) { index ->
            val x = ((index * 71) % 997) / 997f * size.width
            val y = ((index * 113) % 991) / 991f * size.height
            val radius = ((index % 3) + 1) * .22.dp.toPx()
            drawCircle(color = color, radius = radius, center = Offset(x, y))
        }
    }
}

@Composable
private fun AlarmListHeader(activeCount: Int) {
    Row(Modifier.fillMaxWidth().padding(top = 12.dp), verticalAlignment = Alignment.Bottom) {
        Text("ALARMS", style = MaterialTheme.typography.headlineMedium, color = Gold, letterSpacing = .6.sp)
        Text(
            "  /  $activeCount ACTIVE",
            style = MaterialTheme.typography.labelMedium,
            color = Bone.copy(alpha = .62f),
            modifier = Modifier.padding(bottom = 3.dp)
        )
    }
    HorizontalDivider(color = Gold.copy(alpha = .34f), modifier = Modifier.padding(top = 6.dp))
}

@Composable
private fun AlarmRow(
    row: AlarmWithGoalRow,
    onEdit: (AlarmEntity) -> Unit,
    onDelete: () -> Unit,
    onToggle: (AlarmEntity) -> Unit
) {
    val alarm = row.alarm
    var menuExpanded by remember { mutableStateOf(false) }
    val foreground by animateColorAsState(if (alarm.enabled) Bone else Bone.copy(alpha = .62f), animationSpec = tween(180), label = "alarm-foreground")
    val surfaceColor by animateColorAsState(if (alarm.enabled) Charcoal else Charcoal.copy(alpha = .72f), animationSpec = tween(180), label = "alarm-surface")
    val elevation by animateDpAsState(if (alarm.enabled) 2.dp else 0.dp, animationSpec = tween(180), label = "alarm-elevation")
    Surface(
        color = surfaceColor,
        shape = RoundedCornerShape(20.dp),
        shadowElevation = elevation,
        modifier = Modifier.fillMaxWidth().clickable { onEdit(alarm) }
    ) {
        BoxWithConstraints {
            val compact = maxWidth < 350.dp
            Row(
            Modifier.fillMaxWidth().height(128.dp).padding(horizontal = 18.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                formatTime(alarm),
                modifier = Modifier.width(if (compact) 108.dp else 132.dp),
                style = MaterialTheme.typography.headlineLarge.copy(fontSize = if (compact) 32.sp else 38.sp, letterSpacing = (-1.5).sp),
                color = foreground,
                maxLines = 1
            )
            Column(Modifier.weight(1f)) {
                Text(alarm.label.ifBlank { "ALARM" }.uppercase(), style = MaterialTheme.typography.titleMedium, color = foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    repeatText(alarm.repeatDays),
                    style = MaterialTheme.typography.labelMedium,
                    color = Gold.copy(alpha = if (alarm.enabled) 1f else .65f),
                    modifier = Modifier.padding(top = 4.dp)
                )
                row.goal?.let { Text("GOAL · ${it.title.uppercase()}", style = MaterialTheme.typography.labelMedium, color = Bone.copy(alpha = .72f), maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            Column(horizontalAlignment = Alignment.End) {
                Switch(checked = alarm.enabled, onCheckedChange = { onToggle(alarm) })
                Box {
                    IconButton(onClick = { menuExpanded = true }, modifier = Modifier.height(32.dp).semantics { contentDescription = "Alarm options" }) { MaterialSymbol("more_horiz", foreground, 22.sp) }
                    DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                        DropdownMenuItem(
                            text = { Text("Delete alarm", color = MaterialTheme.colorScheme.error) },
                            onClick = { menuExpanded = false; onDelete() }
                        )
                    }
                }
            }
        }
        }
    }
}

@Composable
private fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        modifier = modifier,
        style = MaterialTheme.typography.titleMedium,
        color = Gold,
        letterSpacing = .8.sp
    )
}

@Composable
private fun GoalsScreen(
    goals: List<GoalEntity>,
    alarms: List<AlarmWithGoalRow>,
    onBack: () -> Unit,
    onAdd: () -> Unit,
    onDelete: (GoalEntity) -> Unit,
    confirmation: String?,
    onConfirmationShown: () -> Unit
) {
    val snackbarHostState = remember { SnackbarHostState() }
    LaunchedEffect(confirmation) {
        confirmation?.let {
            snackbarHostState.showSnackbar(it)
            onConfirmationShown()
        }
    }
    Scaffold(
        containerColor = Ink,
        topBar = { GoalsTopBar(onBack) },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        floatingActionButton = {
            if (goals.isNotEmpty()) {
                FloatingActionButton(onClick = onAdd, modifier = Modifier.semantics { contentDescription = "Create new goal" }, shape = RoundedCornerShape(12.dp), containerColor = Gold, contentColor = Ink) {
                    MaterialSymbol("add", Ink, 24.sp)
                }
            }
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            item { Spacer(Modifier.height(6.dp)) }
            item {
                Text("GOALS", style = MaterialTheme.typography.displayLarge.copy(fontSize = 56.sp), color = Bone, letterSpacing = (-1).sp)
                Text("THE REASON BEHIND THE RING.", style = MaterialTheme.typography.labelLarge, color = Gold, letterSpacing = .8.sp)
            }
            if (goals.isEmpty()) item { GoalEmptyPanel(onAdd) }
            items(goals, key = { it.id }) { goal ->
                GoalCard(goal, alarms.filter { it.alarm.goalId == goal.id }, onDelete)
            }
            item { Spacer(Modifier.height(88.dp)) }
        }
    }
}

@Composable
private fun GoalsTopBar(onBack: () -> Unit) {
    Surface(color = Ink) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("BACK", color = Gold, fontWeight = FontWeight.Bold) }
            Text("PAPER CLOCK", style = MaterialTheme.typography.titleMedium, color = Bone.copy(alpha = .7f), letterSpacing = .8.sp)
        }
    }
}

@Composable
private fun GoalEmptyPanel(onAdd: () -> Unit) {
    val shape = RoundedCornerShape(26.dp)
    Box(
        Modifier.fillMaxWidth().height(310.dp).clip(shape)
            .background(Brush.linearGradient(listOf(Charcoal, Slate, Ink)))
            .border(1.dp, Gold.copy(alpha = .48f), shape)
    ) {
        Box(Modifier.align(Alignment.BottomEnd).size(180.dp).clip(CircleShape).background(Gold.copy(alpha = .11f)))
        PaperGrain(Modifier.fillMaxSize(), Bone.copy(alpha = .045f))
        Column(Modifier.align(Alignment.CenterStart).padding(26.dp)) {
            Text("A REASON", style = MaterialTheme.typography.headlineLarge.copy(fontSize = 42.sp), color = Bone)
            Text("TO RISE.", style = MaterialTheme.typography.headlineLarge.copy(fontSize = 42.sp), color = Gold)
            Text("Give tomorrow a target, then build the morning around it.", style = MaterialTheme.typography.bodyLarge, color = Bone.copy(alpha = .72f), modifier = Modifier.padding(top = 16.dp))
            Button(
                onClick = onAdd,
                shape = RoundedCornerShape(4.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Gold, contentColor = Ink),
                modifier = Modifier.padding(top = 20.dp)
            ) { Text("CREATE A GOAL", fontWeight = FontWeight.Black, letterSpacing = .6.sp) }
        }
    }
}

@Composable
private fun GoalCard(goal: GoalEntity, alarms: List<AlarmWithGoalRow>, onDelete: (GoalEntity) -> Unit) {
    var menuExpanded by remember { mutableStateOf(false) }
    Surface(color = Charcoal, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(22.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                Text(goal.title.uppercase(), modifier = Modifier.weight(1f), style = MaterialTheme.typography.headlineMedium, color = Bone, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Box {
                    IconButton(onClick = { menuExpanded = true }, modifier = Modifier.semantics { contentDescription = "Goal options" }) { MaterialSymbol("more_horiz", Bone.copy(alpha = .66f), 22.sp) }
                    DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                        DropdownMenuItem(text = { Text("Delete goal", color = MaterialTheme.colorScheme.error) }, onClick = { menuExpanded = false; onDelete(goal) })
                    }
                }
            }
            Text(countdown(goal.targetDateEpochDay).uppercase(), style = MaterialTheme.typography.labelLarge, color = Gold, modifier = Modifier.padding(top = 10.dp))
            Text("TARGET · ${LocalDate.ofEpochDay(goal.targetDateEpochDay).format(dateFormat).uppercase()}", style = MaterialTheme.typography.labelMedium, color = Bone.copy(alpha = .62f), modifier = Modifier.padding(top = 3.dp))
            if (goal.description.isNotBlank()) Text(goal.description, style = MaterialTheme.typography.bodyMedium, color = Bone.copy(alpha = .8f), modifier = Modifier.padding(top = 16.dp))
            HorizontalDivider(color = Bone.copy(alpha = .16f), modifier = Modifier.padding(vertical = 16.dp))
            Text(if (alarms.isEmpty()) "NO LINKED ALARM" else "${alarms.size} LINKED ALARM${if (alarms.size == 1) "" else "S"}", style = MaterialTheme.typography.labelLarge, color = Gold)
            alarms.firstOrNull()?.let { Text(formatTime(it.alarm), style = MaterialTheme.typography.titleLarge, color = Bone, modifier = Modifier.padding(top = 4.dp)) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GoalWizard(onCancel: () -> Unit, onSave: (GoalEntity, AlarmEntity) -> Unit) {
    var step by remember { mutableIntStateOf(0) }
    var draft by remember { mutableStateOf(GoalDraft()) }
    var showDatePicker by remember { mutableStateOf(false) }
    var showTimePicker by remember { mutableStateOf(false) }
    var showSoundPicker by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = Ink,
        topBar = { GoalWizardTopBar(step, onCancel) },
        bottomBar = {
            BottomActionButton(
                label = if (step == 3) "Create goal" else "Next",
                enabled = step != 0 || draft.title.isNotBlank(),
                onClick = {
                    if (step < 3) step++ else if (draft.title.isNotBlank()) {
                        onSave(
                            GoalEntity(title = draft.title.trim(), description = draft.description.trim(), targetDateEpochDay = draft.date.toEpochDay()),
                            draft.alarm
                        )
                    }
                }
            )
        }
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(horizontal = 24.dp).verticalScroll(rememberScrollState())
        ) {
            LinearProgressIndicator(
                progress = { (step + 1) / 4f },
                color = Gold,
                trackColor = Charcoal,
                modifier = Modifier.fillMaxWidth().padding(top = 18.dp)
            )
            Text("0${step + 1}  /  04", style = MaterialTheme.typography.labelMedium, color = Gold, letterSpacing = 1.sp, modifier = Modifier.padding(top = 12.dp))
            Spacer(Modifier.height(24.dp))
            when (step) {
                0 -> {
                    WizardLead("Name the target", "A short, meaningful reason to get moving tomorrow.")
                    OutlinedTextField(
                        value = draft.title,
                        onValueChange = { draft = draft.copy(title = it) },
                        label = { Text("Goal title") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = draft.description,
                        onValueChange = { draft = draft.copy(description = it) },
                        label = { Text("Note (optional)") },
                        minLines = 3,
                        modifier = Modifier.fillMaxWidth().padding(top = 16.dp)
                    )
                }
                1 -> {
                    WizardLead("Choose the date", "Set the day you intend to reach this target.")
                    PickerCard("Target date", draft.date.format(dateFormat), "${daysFromToday(draft.date)} from today") { showDatePicker = true }
                }
                2 -> {
                    WizardLead("Set the alarm", "Choose when this goal's first alarm should ring.")
                    PickerCard("Alarm time", formatTime(draft.alarm), "Tap to choose a time") { showTimePicker = true }
                }
                3 -> {
                    WizardLead("Pick the sound", "This sound will wake you for this goal.")
                    PickerCard("Alarm sound", SoundCatalog.byKey(draft.alarm.soundKey).displayName, "Tap to listen and choose") { showSoundPicker = true }
                }
            }
            Spacer(Modifier.height(112.dp))
        }
    }

    if (showDatePicker) AppDatePicker(draft.date, onDismiss = { showDatePicker = false }) { date -> draft = draft.copy(date = date); showDatePicker = false }
    if (showTimePicker) AppTimePicker(draft.alarm.hour, draft.alarm.minute, onDismiss = { showTimePicker = false }) { hour, minute ->
        draft = draft.copy(alarm = draft.alarm.copy(hour = hour, minute = minute)); showTimePicker = false
    }
    if (showSoundPicker) SoundPickerSheet(draft.alarm.soundKey, { draft = draft.copy(alarm = draft.alarm.copy(soundKey = it)); showSoundPicker = false }, { showSoundPicker = false })
}

@Composable
private fun GoalWizardTopBar(step: Int, onCancel: () -> Unit) {
    Surface(color = Ink) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onCancel) { Text("CANCEL", color = Gold, fontWeight = FontWeight.Bold) }
            Text("GOAL BUILD · 0${step + 1}", style = MaterialTheme.typography.titleMedium, color = Bone, letterSpacing = .8.sp)
        }
    }
}

@Composable
private fun WizardLead(title: String, body: String) {
    BoxWithConstraints {
        val titleSize = if (maxWidth < 340.dp) 33.sp else 40.sp
        Column {
            Text(title.uppercase(), style = MaterialTheme.typography.headlineLarge.copy(fontSize = titleSize), color = Bone, letterSpacing = .2.sp)
            Text(body, style = MaterialTheme.typography.bodyLarge, color = Bone.copy(alpha = .72f), modifier = Modifier.padding(top = 8.dp, bottom = 28.dp))
        }
    }
}

@Composable
private fun PickerCard(label: String, value: String, support: String, onClick: () -> Unit) {
    Surface(
        color = Charcoal,
        shape = RoundedCornerShape(4.dp),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).border(1.dp, Bone.copy(alpha = .14f), RoundedCornerShape(4.dp))
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(label.uppercase(), style = MaterialTheme.typography.labelMedium, color = Gold, letterSpacing = .7.sp)
                Text(value, style = MaterialTheme.typography.titleLarge, color = Bone, modifier = Modifier.padding(top = 4.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(support, style = MaterialTheme.typography.bodySmall, color = Bone.copy(alpha = .68f), modifier = Modifier.padding(top = 2.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text("CHANGE", style = MaterialTheme.typography.labelMedium, color = Gold, modifier = Modifier.padding(start = 12.dp))
        }
    }
}

@Composable
private fun AlarmEditor(existing: AlarmEntity?, goals: List<GoalEntity>, onBack: () -> Unit, onSave: (AlarmEntity) -> Unit) {
    var draft by remember(existing) { mutableStateOf(existing ?: AlarmEntity(hour = 7, minute = 0, soundKey = SoundCatalog.sounds.first().key)) }
    var showTimePicker by remember { mutableStateOf(false) }
    var showGoalPicker by remember { mutableStateOf(false) }
    var showSoundPicker by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = Ink,
        topBar = { EditorTopBar(existing != null, onBack) },
        bottomBar = { BottomActionButton("SAVE ALARM", onClick = { onSave(draft) }) }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = 24.dp).verticalScroll(rememberScrollState())) {
            Text("ALARM TIME", style = MaterialTheme.typography.labelLarge, color = Gold, letterSpacing = 1.sp, modifier = Modifier.padding(top = 18.dp))
            Column(Modifier.fillMaxWidth().clickable { showTimePicker = true }.padding(top = 6.dp, bottom = 18.dp)) {
                Text(formatTime(draft), style = MaterialTheme.typography.displayLarge.copy(fontSize = 78.sp, letterSpacing = (-3.5).sp), color = Gold)
                Text("TAP THE TIME TO CHANGE", style = MaterialTheme.typography.labelMedium, color = Bone.copy(alpha = .6f), letterSpacing = .6.sp)
            }
            HorizontalDivider(color = Gold.copy(alpha = .42f))

            SectionLabel("Schedule", Modifier.padding(top = 28.dp, bottom = 8.dp))
            Text("REPEAT", style = MaterialTheme.typography.labelMedium, color = Bone.copy(alpha = .66f), modifier = Modifier.padding(top = 12.dp, bottom = 10.dp), letterSpacing = .7.sp)
            CompactWeekdaySelector(draft.repeatDays) { day -> draft = draft.copy(repeatDays = toggleDay(draft.repeatDays, day)) }
            HorizontalDivider(color = Bone.copy(alpha = .16f), modifier = Modifier.padding(top = 24.dp))

            SectionLabel("Purpose", Modifier.padding(top = 28.dp, bottom = 6.dp))
            MinimalLabelField(draft.label) { draft = draft.copy(label = it) }
            AlarmFormActionRow("LINKED GOAL", goals.firstOrNull { it.id == draft.goalId }?.title ?: "No linked goal", "Give this alarm a reason to ring") { showGoalPicker = true }

            SectionLabel("Wake method", Modifier.padding(top = 28.dp, bottom = 6.dp))
            AlarmFormActionRow("SOUND", SoundCatalog.byKey(draft.soundKey).displayName, "Preview and choose your wake-up sound") { showSoundPicker = true }
            AlarmFormSwitchRow("VIBRATE", "Use vibration when the alarm rings", draft.vibrate, Modifier.padding(bottom = 100.dp)) { draft = draft.copy(vibrate = it) }
        }
    }

    if (showTimePicker) AppTimePicker(draft.hour, draft.minute, onDismiss = { showTimePicker = false }) { hour, minute ->
        draft = draft.copy(hour = hour, minute = minute); showTimePicker = false
    }
    if (showGoalPicker) GoalPickerSheet(goals, draft.goalId, { draft = draft.copy(goalId = it); showGoalPicker = false }, { showGoalPicker = false })
    if (showSoundPicker) SoundPickerSheet(draft.soundKey, { draft = draft.copy(soundKey = it); showSoundPicker = false }, { showSoundPicker = false })
}

@Composable
private fun EditorTopBar(editing: Boolean, onBack: () -> Unit) {
    Surface(color = Ink) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("CANCEL", color = Gold, fontWeight = FontWeight.Bold) }
            Text(if (editing) "EDIT ALARM" else "NEW ALARM", style = MaterialTheme.typography.titleMedium, color = Bone, letterSpacing = .8.sp)
        }
    }
}

@Composable
private fun CompactWeekdaySelector(repeatDays: String, onToggle: (Int) -> Unit) {
    val selected = days(repeatDays)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        dayNames.forEach { (day, label) ->
            val isSelected = day in selected
            Surface(
                color = if (isSelected) Gold else Color.Transparent,
                shape = CircleShape,
                modifier = Modifier.weight(1f).height(40.dp).border(1.dp, if (isSelected) Gold else Bone.copy(alpha = .3f), CircleShape).clickable { onToggle(day) }
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(label.take(1), style = MaterialTheme.typography.titleMedium, color = if (isSelected) Ink else Bone.copy(alpha = .82f), fontWeight = FontWeight.Black)
                }
            }
        }
    }
}

@Composable
private fun MinimalLabelField(value: String, onValueChange: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
        Text("ALARM LABEL", style = MaterialTheme.typography.labelMedium, color = Bone.copy(alpha = .66f), letterSpacing = .7.sp)
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            textStyle = MaterialTheme.typography.titleLarge.copy(color = Bone),
            cursorBrush = SolidColor(Gold),
            modifier = Modifier.fillMaxWidth().padding(vertical = 9.dp),
            decorationBox = { field ->
                Box {
                    if (value.isEmpty()) Text("OPTIONAL · NAME THIS MOMENT", style = MaterialTheme.typography.titleMedium, color = Bone.copy(alpha = .35f))
                    field()
                }
            }
        )
        HorizontalDivider(color = Bone.copy(alpha = .16f))
    }
}

@Composable
private fun AlarmFormActionRow(label: String, value: String, support: String, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(top = 18.dp, bottom = 12.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.labelMedium, color = Gold, letterSpacing = .7.sp)
                Text(value, style = MaterialTheme.typography.titleLarge, color = Bone, modifier = Modifier.padding(top = 4.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(support, style = MaterialTheme.typography.bodySmall, color = Bone.copy(alpha = .6f), modifier = Modifier.padding(top = 2.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text("CHANGE", style = MaterialTheme.typography.labelMedium, color = Gold, letterSpacing = .6.sp, modifier = Modifier.padding(start = 16.dp))
        }
        HorizontalDivider(color = Bone.copy(alpha = .16f), modifier = Modifier.padding(top = 12.dp))
    }
}

@Composable
private fun AlarmFormSwitchRow(label: String, support: String, checked: Boolean, modifier: Modifier = Modifier, onCheckedChange: (Boolean) -> Unit) {
    Column(modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.labelMedium, color = Gold, letterSpacing = .7.sp)
                Text(support, style = MaterialTheme.typography.bodySmall, color = Bone.copy(alpha = .62f), modifier = Modifier.padding(top = 3.dp))
            }
            Switch(checked = checked, onCheckedChange = onCheckedChange)
        }
        HorizontalDivider(color = Bone.copy(alpha = .16f), modifier = Modifier.padding(top = 12.dp))
    }
}

@Composable
private fun BottomActionButton(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    Surface(color = Ink, tonalElevation = 0.dp) {
        Button(
            onClick = onClick,
            enabled = enabled,
            shape = RoundedCornerShape(18.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Gold, contentColor = Ink),
            modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 12.dp).height(60.dp)
        ) { Text(label, fontWeight = FontWeight.Black, letterSpacing = .8.sp) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GoalPickerSheet(goals: List<GoalEntity>, selected: Long?, select: (Long?) -> Unit, dismiss: () -> Unit) {
    ModalBottomSheet(
        onDismissRequest = dismiss,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = Charcoal,
        contentColor = Bone,
        dragHandle = { BottomSheetDefaults.DragHandle(color = Gold.copy(alpha = .62f)) }
    ) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
        Text("LINK A GOAL", style = MaterialTheme.typography.headlineMedium, color = Bone, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
        Text("Give this alarm a reason to ring.", style = MaterialTheme.typography.bodyMedium, color = Bone.copy(alpha = .68f), modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 14.dp))
        GoalChoiceRow("NO LINKED GOAL", "Keep this alarm independent.", selected == null) { select(null) }
        goals.forEach { goal ->
            GoalChoiceRow(goal.title.uppercase(), countdown(goal.targetDateEpochDay).uppercase(), selected == goal.id) { select(goal.id) }
        }
        Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun GoalChoiceRow(title: String, support: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        color = if (selected) Slate else Charcoal,
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).clickable(onClick = onClick)
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = if (selected) Gold else Bone, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(support, style = MaterialTheme.typography.bodySmall, color = Bone.copy(alpha = .65f), modifier = Modifier.padding(top = 2.dp))
            }
            RadioButton(selected = selected, onClick = onClick)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SoundPickerSheet(selected: String, select: (String) -> Unit, dismiss: () -> Unit) {
    val context = LocalContext.current
    var player by remember { mutableStateOf<MediaPlayer?>(null) }
    var playingKey by remember { mutableStateOf<String?>(null) }
    DisposableEffect(Unit) { onDispose { player?.release() } }

    ModalBottomSheet(
        onDismissRequest = dismiss,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = Charcoal,
        contentColor = Bone,
        dragHandle = { BottomSheetDefaults.DragHandle(color = Gold.copy(alpha = .62f)) }
    ) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
        Text("WAKE-UP SOUND", style = MaterialTheme.typography.headlineMedium, color = Bone, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
        Text("Preview a sound, then choose the one that gets you moving.", style = MaterialTheme.typography.bodyMedium, color = Bone.copy(alpha = .68f), modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 12.dp))
        SoundCatalog.sounds.forEachIndexed { index, sound ->
            val isSelected = selected == sound.key
            val isPlaying = playingKey == sound.key
            Surface(
                color = if (isSelected) Slate else Charcoal,
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 3.dp).clickable { select(sound.key) }
            ) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("${(index + 1).toString().padStart(2, '0')}", style = MaterialTheme.typography.labelMedium, color = Gold.copy(alpha = if (isSelected) 1f else .58f))
                    Text(sound.displayName, modifier = Modifier.weight(1f).padding(start = 12.dp), style = MaterialTheme.typography.titleMedium, color = if (isSelected) Gold else Bone, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    TextButton(onClick = {
                        if (isPlaying) {
                            player?.stop(); player?.release(); player = null; playingKey = null
                        } else {
                            player?.release()
                            playingKey = sound.key
                            player = MediaPlayer.create(context, sound.resourceId).apply {
                                setOnCompletionListener { player?.release(); player = null; playingKey = null }
                                start()
                            }
                        }
                    }) { Text(if (isPlaying) "STOP" else "PLAY", color = Gold, fontWeight = FontWeight.Bold) }
                    RadioButton(selected = isSelected, onClick = { select(sound.key) })
                }
            }
        }
        Spacer(Modifier.height(24.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppTimePicker(
    hour: Int,
    minute: Int,
    onDismiss: () -> Unit,
    onConfirm: (Int, Int) -> Unit
) {
    val state = rememberTimePickerState(initialHour = hour, initialMinute = minute, is24Hour = false)
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Charcoal,
        title = { Text("SET ALARM TIME", style = MaterialTheme.typography.titleLarge, color = Gold, letterSpacing = .7.sp) },
        confirmButton = {
            TextButton(onClick = { onConfirm(state.hour, state.minute) }) { Text("OK", color = Gold, fontWeight = FontWeight.Black) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("CANCEL", color = Bone, fontWeight = FontWeight.Bold) } },
        text = { TimePicker(state = state) }
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppDatePicker(date: LocalDate, onDismiss: () -> Unit, onConfirm: (LocalDate) -> Unit) {
    val state = rememberDatePickerState(initialSelectedDateMillis = date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                state.selectedDateMillis?.let { onConfirm(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) }
            }) { Text("OK") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    ) { DatePicker(state = state) }
}

@Composable
private fun SettingsScreen(exactAllowed: Boolean, onBack: () -> Unit, openExactSettings: () -> Unit) {
    Scaffold(containerColor = Ink, topBar = { SettingsTopBar(onBack) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = 20.dp)) {
            Text("SETTINGS", style = MaterialTheme.typography.displayLarge.copy(fontSize = 54.sp), color = Bone, modifier = Modifier.padding(top = 20.dp))
            Text("KEEP THE SYSTEM READY.", style = MaterialTheme.typography.labelLarge, color = Gold, letterSpacing = .8.sp)
            SectionLabel("Alarm access", Modifier.padding(top = 36.dp, bottom = 10.dp))
            Surface(color = Charcoal, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
                Row(Modifier.fillMaxWidth().padding(22.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("EXACT ALARMS", style = MaterialTheme.typography.titleMedium, color = Gold, letterSpacing = .7.sp)
                        Text(if (exactAllowed) "Allowed. Your alarms can ring precisely on time." else "Required for reliable alarm timing.", style = MaterialTheme.typography.bodyLarge, color = Bone.copy(alpha = .76f), modifier = Modifier.padding(top = 6.dp))
                    }
                    TextButton(onClick = openExactSettings) { Text(if (exactAllowed) "MANAGE" else "ALLOW", color = Gold, fontWeight = FontWeight.Black) }
                }
            }
            SectionLabel("About", Modifier.padding(top = 28.dp, bottom = 10.dp))
            Surface(color = Charcoal, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(22.dp)) {
                    Text("PAPER CLOCK", style = MaterialTheme.typography.titleMedium, color = Bone, letterSpacing = .7.sp)
                    Text("A private, offline alarm clock for meaningful mornings.", style = MaterialTheme.typography.bodyLarge, color = Bone.copy(alpha = .76f), modifier = Modifier.padding(top = 6.dp))
                }
            }
        }
    }
}

@Composable
private fun SettingsTopBar(onBack: () -> Unit) {
    Surface(color = Ink) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("BACK", color = Gold, fontWeight = FontWeight.Bold) }
            Text("PAPER CLOCK", style = MaterialTheme.typography.titleMedium, color = Bone.copy(alpha = .7f), letterSpacing = .8.sp)
        }
    }
}

@Composable
private fun ConfirmDeleteDialog(title: String, body: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Charcoal,
        title = { Text(title.uppercase(), style = MaterialTheme.typography.titleLarge, color = Gold) },
        text = { Text(body, color = Bone.copy(alpha = .78f)) },
        confirmButton = { TextButton(onClick = onConfirm) { Text("DELETE", color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Black) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("CANCEL", color = Bone, fontWeight = FontWeight.Bold) } }
    )
}

@Composable
fun AlarmRingingScreen(row: AlarmWithGoalRow?, onDismiss: () -> Unit) {
    val alarm = row?.alarm
    val goal = row?.goal
    Scaffold(containerColor = Ink, bottomBar = { BottomActionButton("DISMISS ALARM", onClick = onDismiss) }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).background(Ink)) {
            Box(Modifier.align(Alignment.TopEnd).padding(top = 48.dp).size(260.dp).clip(CircleShape).background(Gold.copy(alpha = .10f)))
            Box(Modifier.align(Alignment.TopEnd).padding(top = 92.dp, end = 44.dp).size(170.dp).border(2.dp, Gold.copy(alpha = .52f), CircleShape))
            Column(
                Modifier.fillMaxSize().padding(horizontal = 30.dp, vertical = 34.dp),
                verticalArrangement = Arrangement.SpaceBetween
            ) {
                Text("PAPER CLOCK  /  ALARM", style = MaterialTheme.typography.labelLarge, color = Gold, letterSpacing = 1.sp)
                Column {
                    Text(alarm?.let(::formatTime) ?: "ALARM", style = MaterialTheme.typography.displayLarge.copy(fontSize = 80.sp, letterSpacing = (-3).sp), color = Bone)
                    HorizontalDivider(color = Gold.copy(alpha = .42f), modifier = Modifier.padding(top = 18.dp, bottom = 20.dp))
                    Text((goal?.title ?: alarm?.label?.ifBlank { "TIME TO MOVE" } ?: "TIME TO MOVE").uppercase(), style = MaterialTheme.typography.headlineLarge.copy(fontSize = 38.sp), color = Gold)
                    Text(motivation(goal), style = MaterialTheme.typography.bodyLarge, color = Bone.copy(alpha = .8f), modifier = Modifier.padding(top = 16.dp))
                }
                Text("GET UP. MAKE THE NEXT HONEST MOVE.", style = MaterialTheme.typography.labelMedium, color = Bone.copy(alpha = .54f), letterSpacing = .7.sp)
            }
        }
    }
}

private fun motivation(goal: GoalEntity?): String {
    if (goal == null) return "Start with this moment."
    val lines = listOf(
        "Small actions make the target real.",
        "Get up. Your future self is waiting.",
        "Today is part of the work.",
        "Make the next honest move."
    )
    return lines[abs((LocalDate.now().toEpochDay() + goal.id).toInt()) % lines.size]
}

private fun formatTime(alarm: AlarmEntity) = formatTime(alarm.hour, alarm.minute)
private fun formatTime(hour: Int, minute: Int): String {
    val suffix = if (hour < 12) "AM" else "PM"
    val displayHour = hour % 12
    return "%d:%02d %s".format(if (displayHour == 0) 12 else displayHour, minute, suffix)
}

private fun nextAlarmDetail(alarm: AlarmEntity): String {
    val time = millisUntil(alarm)
    val hours = time / (60 * 60 * 1000)
    val minutes = (time / (60 * 1000)) % 60
    return if (hours == 0L) "In $minutes min · ${repeatText(alarm.repeatDays)}" else "In ${hours}h ${minutes}m · ${repeatText(alarm.repeatDays)}"
}

private fun days(text: String) = text.split(',').mapNotNull { it.toIntOrNull() }.toSet()
private fun toggleDay(text: String, day: Int): String = (days(text).let { if (day in it) it - day else it + day }).sorted().joinToString(",")
private fun repeatText(days: String): String {
    val selected = com.paperclock.ui.days(days)
    val weekdays = setOf(Calendar.MONDAY, Calendar.TUESDAY, Calendar.WEDNESDAY, Calendar.THURSDAY, Calendar.FRIDAY)
    return when {
        selected.isEmpty() -> "Once"
        selected == weekdays -> "Weekdays"
        selected.size == 7 -> "Every day"
        else -> dayNames.filter { it.first in selected }.joinToString(" · ") { it.second }
    }
}
private fun millisUntil(alarm: AlarmEntity): Long {
    val now = Calendar.getInstance()
    val calendar = now.clone() as Calendar
    calendar.set(Calendar.HOUR_OF_DAY, alarm.hour)
    calendar.set(Calendar.MINUTE, alarm.minute)
    calendar.set(Calendar.SECOND, 0)
    if (calendar.before(now)) calendar.add(Calendar.DAY_OF_YEAR, 1)
    return calendar.timeInMillis - now.timeInMillis
}
private fun countdown(epoch: Long): String {
    val days = ChronoUnit.DAYS.between(LocalDate.now(), LocalDate.ofEpochDay(epoch))
    return when {
        days > 0 -> "$days days remaining"
        days == 0L -> "Target day"
        else -> "${-days} days past target"
    }
}
private fun daysFromToday(date: LocalDate): String {
    val days = ChronoUnit.DAYS.between(LocalDate.now(), date)
    return when {
        days == 0L -> "Today"
        days == 1L -> "Tomorrow"
        days > 1L -> "$days days"
        else -> "${-days} days ago"
    }
}
