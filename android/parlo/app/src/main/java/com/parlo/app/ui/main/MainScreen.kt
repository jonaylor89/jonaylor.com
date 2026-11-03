package com.parlo.app.ui.main

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.MenuBook
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Forum
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Place
import androidx.compose.material.icons.rounded.Route
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FabPosition
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.parlo.app.R
import com.parlo.app.data.db.VocabEntity
import com.parlo.app.model.ConnectionState
import com.parlo.app.model.CorrectionStyle
import com.parlo.app.model.ErrorAction
import com.parlo.app.model.Level
import com.parlo.app.model.Scenario
import com.parlo.app.model.SessionConfig
import com.parlo.app.model.SessionError
import com.parlo.app.model.Speaker
import com.parlo.app.model.TranscriptTurn
import com.parlo.app.ui.LastWalk
import com.parlo.app.ui.MainViewModel
import com.parlo.app.ui.SetupStatus
import com.parlo.app.ui.components.LanguageMonogram
import com.parlo.app.ui.components.Overline
import com.parlo.app.ui.components.ParloSnackbarHost
import com.parlo.app.ui.components.StatusBanner
import com.parlo.app.ui.components.WalkFab
import com.parlo.app.ui.components.WalkFabState
import com.parlo.app.ui.components.nativeNameOf
import com.parlo.app.ui.onboarding.WelcomeScreen
import com.parlo.app.ui.settings.SettingsSheet
import com.parlo.app.ui.theme.Parlo
import com.parlo.app.ui.theme.ParloShape
import com.parlo.app.ui.theme.ParloSize
import com.parlo.app.ui.theme.ParloSpacing
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(
    viewModel: MainViewModel,
    onOpenVocab: () -> Unit,
    onOpenHistory: () -> Unit,
) {
    val ui by viewModel.uiState.collectAsStateWithLifecycle()
    val live = ui.live
    val cfg = ui.config
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var showSettings by remember { mutableStateOf(false) }
    var showConfig by remember { mutableStateOf(false) }
    var showLanguagePicker by remember { mutableStateOf(false) }
    var showJournal by remember { mutableStateOf(false) }
    var selectedWord by remember { mutableStateOf<VocabEntity?>(null) }
    var showPermissionRationale by remember { mutableStateOf(false) }

    val neededPermissions = remember {
        buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add(Manifest.permission.BLUETOOTH_CONNECT)
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (result[Manifest.permission.RECORD_AUDIO] == true) {
            viewModel.startSession(context)
        } else {
            scope.launch {
                val r = snackbar.showSnackbar("Parlo can't hear you without the microphone.", actionLabel = "Allow in Settings", duration = SnackbarDuration.Long)
                if (r == SnackbarResult.ActionPerformed) {
                    context.startActivity(
                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                }
            }
        }
    }

    fun launchPermissions() = permissionLauncher.launch(neededPermissions.toTypedArray())

    fun requestStart() {
        if (!ui.ready) { showSettings = true; return }
        val microphoneMissing = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
        if (microphoneMissing) showPermissionRationale = true else viewModel.startSession(context)
    }

    // Ending a walk is a single tap; the recap can be skipped from the snackbar instead of a hidden long-press.
    LaunchedEffect(live.connection) {
        if (live.connection == ConnectionState.ENDING) {
            val r = snackbar.showSnackbar("Walk ended · Writing your recap…", actionLabel = "Skip", duration = SnackbarDuration.Indefinite)
            if (r == SnackbarResult.ActionPerformed) viewModel.endSession(skipRecap = true)
        }
    }

    val firstRun = !ui.hasWalked && !live.isActive && live.error == null
    val lastWalk = ui.lastWalk
    fun startFromHome() {
        if (cfg.followPlan && lastWalk?.nextWalkTitle?.isNotBlank() == true && cfg.topicTitle.isBlank()) viewModel.useSuggestedWalk()
        requestStart()
    }
    Scaffold(
        snackbarHost = { ParloSnackbarHost(snackbar) },
        containerColor = if (live.isActive) Parlo.colors.walkGround else MaterialTheme.colorScheme.surface,
        bottomBar = {
            if (firstRun || live.isActive) return@Scaffold
            Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 2.dp) {
                Box(Modifier.navigationBarsPadding().padding(horizontal = ParloSpacing.space4, vertical = ParloSpacing.space2)) {
                    WalkFab(
                        state = if (ui.ready) WalkFabState.READY else WalkFabState.SETUP,
                        subLabel = if (ui.ready) walkFabSubLabel(cfg) else setupStep(ui.setup),
                        onClick = { if (ui.ready) startFromHome() else showSettings = true },
                        modifier = Modifier.fillMaxWidth().testTag("start_walk"),
                    )
                }
            }
        },
        topBar = {
            if (firstRun) return@Scaffold
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = if (live.isActive) Parlo.colors.walkGround else MaterialTheme.colorScheme.surface),
                title = { Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineMedium) },
                actions = {
                    IconButton(onClick = onOpenVocab) {
                        BadgedBox(badge = { if (ui.suggestedVocab > 0) Badge { Text(ui.suggestedVocab.toString()) } }) {
                            Icon(Icons.AutoMirrored.Rounded.MenuBook, "Vocabulary")
                        }
                    }
                    IconButton(onClick = onOpenHistory) { Icon(Icons.Rounded.History, "Session history") }
                    IconButton(onClick = { showSettings = true }) { Icon(Icons.Rounded.Settings, "Settings") }
                },
            )
        },
    ) { padding ->
        if (firstRun) {
            WelcomeScreen(
                status = ui.setup,
                maskedKey = ui.maskedKey,
                onPasteKey = viewModel::setApiKey,
                onStart = ::requestStart,
                modifier = Modifier.padding(padding),
                languageChoice = {
                    LanguageJourneyPicker(cfg, ui.languages, { viewModel.selectLanguage(it) }, { showLanguagePicker = true })
                },
                onRetry = viewModel::refreshModels,
                secondaryAction = {
                    TextButton(onClick = { showJournal = true }) { Text("Already learning with Parlo? Restore progress") }
                },
            )
            return@Scaffold
        }
        if (live.isActive) {
            WalkScreen(
                live = live,
                onToggleMute = viewModel::toggleMute,
                onSlower = viewModel::repeatSlowly,
                onEnglish = viewModel::englishHelp,
                onEnd = { viewModel.endSession(skipRecap = false) },
                modifier = Modifier.padding(padding).padding(horizontal = ParloSpacing.space4),
            )
            return@Scaffold
        }
        HomeContent(
            ui = ui,
            onSelectLanguage = { viewModel.selectLanguage(it) },
            onAddLanguage = { showLanguagePicker = true },
            onWalkSettings = { showConfig = true },
            onModeSelected = { guided -> viewModel.updateConfig {
                if (guided) it.copy(followPlan = true) else it.copy(topic = "", topicTitle = "", scenario = Scenario.FREE, followPlan = false)
            } },
            onWordSelected = { selectedWord = it },
            onOpenJourney = { showJournal = true },
            onOpenVocab = onOpenVocab,
            onOpenHistory = onOpenHistory,
            modifier = Modifier.padding(padding),
        ) {
            val error = live.error
            if (error != null) {
                ErrorCard(
                    error = error,
                    onAction = {
                        when (error.action) {
                            ErrorAction.UPDATE_KEY, ErrorAction.OPEN_SETTINGS -> showSettings = true
                            ErrorAction.REFRESH_MODELS -> { viewModel.refreshModels(); viewModel.dismissError() }
                            ErrorAction.RETRY, ErrorAction.START_AGAIN -> { viewModel.dismissError(); requestStart() }
                        }
                    },
                    onDismiss = viewModel::dismissError,
                )
            } else if (!live.isActive && !ui.ready) {
                SetupCard(status = ui.setup, onOpenSettings = { showSettings = true }, onRefresh = viewModel::refreshModels)
            }

        }
    }

    if (showPermissionRationale) {
        AlertDialog(
            onDismissRequest = { showPermissionRationale = false },
            title = { Text("Before we start") },
            text = {
                Text(
                    "Parlo needs your microphone to hear you. Bluetooth (for earbud buttons) and notifications (for lock-screen controls) are optional; without earbuds the tutor plays through the speaker.",
                )
            },
            confirmButton = {
                Button(onClick = { showPermissionRationale = false; launchPermissions() }) { Text("Continue") }
            },
            dismissButton = { TextButton(onClick = { showPermissionRationale = false }) { Text("Not now") } },
        )
    }
    selectedWord?.let { word ->
        VocabularyWordSheet(word = word, onDismiss = { selectedWord = null },
            onOpenVocab = { selectedWord = null; onOpenVocab() },
            onRemove = {
                selectedWord = null
                viewModel.dropWord(word)
                scope.launch {
                    val result = snackbar.showSnackbar("Removed “${word.word}”", actionLabel = "Undo", duration = SnackbarDuration.Short)
                    if (result == SnackbarResult.ActionPerformed) viewModel.restoreWord(word)
                }
            })
    }
    if (showJournal) {
        LearningJournalSheet(ui, viewModel::setGoal, viewModel::forgetSessionMemory,
            onHistory = { showJournal = false; onOpenHistory() }, onDismiss = { showJournal = false })
    }
    if (showSettings) {
        SettingsSheet(viewModel = viewModel, onDismiss = { showSettings = false })
    }
    if (showConfig) {
        WalkConfigSheet(
            viewModel = viewModel,
            onPickLanguage = { showLanguagePicker = true },
            onDismiss = { showConfig = false },
        )
    }
    if (showLanguagePicker) {
        LanguagePickerSheet(
            language = cfg.language,
            dialect = cfg.dialect,
            onSelect = { lang, dialect -> viewModel.selectLanguage(lang, dialect) },
            onDismiss = { showLanguagePicker = false },
        )
    }
}

/** Scrollable sheet with everything that shapes the walk. Nothing on the main screen changes height. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WalkConfigSheet(viewModel: MainViewModel, onPickLanguage: () -> Unit, onDismiss: () -> Unit) {
    val ui by viewModel.uiState.collectAsStateWithLifecycle()
    val cfg = ui.config
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState, containerColor = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(
            Modifier.padding(horizontal = ParloSpacing.space5).padding(bottom = ParloSpacing.space8).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text("Today's walk", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
                TextButton(onClick = onDismiss) { Text("Done") }
            }
            LanguageCard(language = cfg.language, dialect = cfg.dialect, onClick = onPickLanguage)
            if (cfg.topicTitle.isNotBlank()) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.weight(1f)) {
                        Text("Topic", style = MaterialTheme.typography.labelMedium)
                        Text(cfg.topicTitle, style = MaterialTheme.typography.bodyLarge)
                    }
                    TextButton(onClick = { viewModel.updateConfig { it.copy(topic = "", topicTitle = "") } }) { Text("Clear") }
                }
            }
            Text("Level", style = MaterialTheme.typography.labelMedium)
            SegmentedPicker(options = Level.entries, selected = cfg.level, label = { it.shortLabel }, onSelect = { l -> viewModel.updateConfig { it.copy(level = l) } })
            Text("${cfg.level.label} — ${cfg.level.description}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("Corrections", style = MaterialTheme.typography.labelMedium)
            SegmentedPicker(options = CorrectionStyle.entries, selected = cfg.correctionStyle, label = { it.label }, onSelect = { s -> viewModel.updateConfig { it.copy(correctionStyle = s) } })
            if (ui.recentCombos.size >= 2) {
                Text("Recent", style = MaterialTheme.typography.labelMedium)
                ChipRow(
                    options = ui.recentCombos,
                    selected = ui.recentCombos.firstOrNull { it == cfg.languageCombo },
                    label = { it.label },
                    onSelect = viewModel::selectCombo,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (ui.live.isActive) {
                Text("Changes apply to the current walk right away.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun SetupCard(status: SetupStatus, onOpenSettings: () -> Unit, onRefresh: () -> Unit) {
    val (title, body, action) = when (status) {
        SetupStatus.NO_KEY -> Triple("Connect Gemini to start", "Parlo talks through your own free Gemini key. It stays encrypted on this phone.", "Add key")
        SetupStatus.CHECKING -> Triple("Checking your key…", "Looking for voice models this key can use.", null)
        SetupStatus.BAD_KEY -> Triple("That key didn't work", "Check it was copied fully, or make a new one in AI Studio.", "Update key")
        SetupStatus.OFFLINE -> Triple("Couldn't reach Gemini", "Check your connection, then try again.", "Try again")
        SetupStatus.NO_MODEL -> Triple("Can't find a voice model", "Your key works, but no live voice models showed up. Try refreshing.", "Refresh")
        SetupStatus.READY -> return
    }
    Surface(Modifier.fillMaxWidth().testTag("setup_card"), shape = ParloShape.large, color = MaterialTheme.colorScheme.surfaceContainerHighest) {
        Row(Modifier.padding(start = ParloSpacing.space4, top = ParloSpacing.space3, bottom = ParloSpacing.space3, end = ParloSpacing.space2), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.Key, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(ParloSpacing.space3))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.width(8.dp))
            when {
                status == SetupStatus.CHECKING -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                action != null -> FilledTonalButton(onClick = if (status == SetupStatus.NO_MODEL || status == SetupStatus.OFFLINE) onRefresh else onOpenSettings) { Text(action) }
            }
        }
    }
}

/** Today's suggestion: the tutor's next walk (or today's settings) and quick tweaks. Starting is the FAB's job. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun NextWalkCard(
    cfg: SessionConfig,
    walk: LastWalk?,
    onTune: () -> Unit,
) {
    val suggested = cfg.followPlan && cfg.topicTitle.isBlank() && walk?.nextWalkTitle?.isNotBlank() == true && walk.language.equals(cfg.language, true)
    val title = when {
        cfg.topicTitle.isNotBlank() -> cfg.topicTitle
        suggested -> walk!!.nextWalkTitle
        cfg.followPlan && walk?.interrupted == true -> "Pick up where we paused"
        else -> cfg.scenario.label
    }
    val scheme = MaterialTheme.colorScheme
    Surface(shape = ParloShape.extraLarge, color = scheme.surfaceContainer, modifier = Modifier.fillMaxWidth().testTag("next_walk")) {
        Column(Modifier.padding(ParloSpacing.space5), verticalArrangement = Arrangement.spacedBy(ParloSpacing.space3)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Overline(
                    "Today's walk",
                    color = scheme.secondary, icon = Icons.Rounded.Route, modifier = Modifier.weight(1f),
                )
                FilledTonalIconButton(onClick = onTune, modifier = Modifier.size(ParloSize.targetMin)) { Icon(Icons.Rounded.Tune, "Walk settings") }
            }
            Text(title, style = MaterialTheme.typography.headlineSmall)
            if (suggested && walk!!.focus.isNotBlank()) {
                Text("Practise: ${walk.focus}", style = MaterialTheme.typography.bodyLarge, color = scheme.onSurfaceVariant)
            }

        }
    }
}

/** Post-walk reward + the tutor's next-walk suggestion. Only real numbers: length and words saved. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun LastWalkCard(walk: LastWalk, onWordSelected: (VocabEntity) -> Unit, onOpenVocab: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Surface(shape = ParloShape.large, color = scheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth().testTag("last_walk")) {
        Column(Modifier.padding(ParloSpacing.space4), verticalArrangement = Arrangement.spacedBy(ParloSpacing.space3)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(ParloSpacing.space3)) {
                LanguageMonogram(walk.language, size = 36.dp)
                Column {
                    Overline(if (walk.interrupted) "Interrupted · progress saved" else "Last walk", color = scheme.secondary)
                    Text("${walk.lengthLabel} · ${walk.language}", style = MaterialTheme.typography.titleLarge)
                }
            }
            if (walk.reviewing) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text("Picking out your words…", style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
            }
            if (walk.words.isNotEmpty()) {
                val n = walk.words.size
                Text("$n word${if (n == 1) "" else "s"} saved · tap to explore", style = MaterialTheme.typography.bodyMedium)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(ParloSpacing.space2)) {
                    walk.words.take(4).forEach { word ->
                        AssistChip(
                            onClick = { onWordSelected(word) },
                            label = { Text(word.word, style = Parlo.type.phraseGloss, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            modifier = Modifier.widthIn(max = 200.dp).testTag("saved_word_${word.id}"),
                        )
                    }
                }
                if (n > 4) TextButton(onClick = onOpenVocab) { Text("View all saved words") }
            }
        }
    }
}

@Composable
internal fun ReviewCard(count: Int, onReview: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Surface(onClick = onReview, shape = ParloShape.large, color = scheme.secondaryContainer, contentColor = scheme.onSecondaryContainer, modifier = Modifier.fillMaxWidth().testTag("review_card")) {
        Row(Modifier.padding(start = ParloSpacing.space4, top = ParloSpacing.space2, bottom = ParloSpacing.space2, end = ParloSpacing.space2), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.AutoAwesome, null)
            Spacer(Modifier.width(ParloSpacing.space3))
            Text(
                "$count new word${if (count == 1) "" else "s"} from your last walk",
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onReview, colors = ButtonDefaults.textButtonColors(contentColor = scheme.onSecondaryContainer)) { Text("Review") }
        }
    }
}

/** What happened + what to do, one primary action, raw detail behind "Details". */
@Composable
private fun ErrorCard(error: SessionError, onAction: () -> Unit, onDismiss: () -> Unit) {
    var showDetail by remember(error) { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    StatusBanner(error.title, error.body, icon = Icons.Rounded.ErrorOutline, error = true, modifier = Modifier.testTag("error_card")) {
        AnimatedVisibility(visible = showDetail && error.detail.isNotBlank()) {
            Text(error.detail, color = scheme.onErrorContainer, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = ParloSpacing.space2))
        }
        Row(horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(top = ParloSpacing.space1)) {
            val textColors = ButtonDefaults.textButtonColors(contentColor = scheme.onErrorContainer)
            if (error.detail.isNotBlank()) {
                TextButton(onClick = { showDetail = !showDetail }, colors = textColors) { Text(if (showDetail) "Hide details" else "Details") }
            }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onDismiss, colors = textColors) { Text("Dismiss") }
            Button(onClick = onAction, colors = ButtonDefaults.buttonColors(containerColor = scheme.error, contentColor = scheme.onError)) { Text(error.action.label) }
        }
    }
}

@Composable
fun Transcript(turns: List<TranscriptTurn>, modifier: Modifier = Modifier) {
    val listState = rememberLazyListState()
    LaunchedEffect(turns.size, turns.lastOrNull()?.text?.length) {
        if (turns.isNotEmpty()) listState.animateScrollToItem(turns.lastIndex)
    }
    if (turns.isEmpty()) {
        Box(modifier, contentAlignment = Alignment.Center) {
            Text(
                "Your conversation will appear here.\nTap Start and talk, with earbuds or out loud.",
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }
    LazyColumn(state = listState, modifier = modifier, contentPadding = PaddingValues(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        items(turns, key = { it.id }) { turn -> TurnBubble(turn) }
    }
}

/** Tutor left on surface-container-high, you right on primary-container; the 4dp corner points to the speaker. */
@Composable
fun TurnBubble(turn: TranscriptTurn) {
    val colors = Parlo.colors
    when (turn.speaker) {
        Speaker.SYSTEM -> Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Text(turn.text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
                modifier = Modifier.padding(vertical = ParloSpacing.space1))
        }
        else -> {
            val isUser = turn.speaker == Speaker.USER
            val bg = if (isUser) colors.bubbleLearner else colors.bubbleTutor
            val fg = if (isUser) colors.onBubbleLearner else colors.onBubbleTutor
            Row(Modifier.fillMaxWidth(), horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start) {
                Column(
                    Modifier.widthIn(max = 320.dp)
                        .clip(ParloShape.bubble(fromLearner = isUser))
                        .background(if (turn.isFinal) bg else bg.copy(alpha = 0.6f))
                        .padding(horizontal = ParloSpacing.space4, vertical = ParloSpacing.space3),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (!isUser) {
                            Icon(Icons.Rounded.GraphicEq, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.tertiary)
                            Spacer(Modifier.width(ParloSpacing.space1))
                        }
                        Text(if (isUser) "You" else "Parlo", style = MaterialTheme.typography.labelMedium, color = fg)
                    }
                    Text(turn.text, style = Parlo.type.phraseBody, color = fg)
                }
            }
        }
    }
}

/** "Português · Lisboa": the language in its own name, then the accent's place. */
internal fun walkFabSubLabel(cfg: SessionConfig): String {
    if (cfg.language.isBlank()) return "Choose a language"
    val accent = cfg.dialect.takeIf { it.isNotBlank() && !it.equals(cfg.language, true) }
    return listOfNotNull(nativeNameOf(cfg.language), accent).joinToString(" · ")
}

/** The single missing setup step, named on the Finish-setup FAB. */
internal fun setupStep(status: SetupStatus): String = when (status) {
    SetupStatus.NO_KEY -> "Add your Gemini key"
    SetupStatus.BAD_KEY -> "Replace your Gemini key"
    SetupStatus.CHECKING -> "Checking your key…"
    SetupStatus.OFFLINE -> "Reconnect to Gemini"
    SetupStatus.NO_MODEL -> "Find a Live model"
    SetupStatus.READY -> ""
}
