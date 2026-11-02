package com.parlo.app.ui

import android.annotation.SuppressLint
import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.parlo.app.ParloApp
import com.parlo.app.audio.AudioPlayer
import com.parlo.app.data.db.LearningEpisodeEntity
import com.parlo.app.data.db.SessionEntity
import com.parlo.app.data.db.VocabEntity
import com.parlo.app.model.LanguageCombo
import com.parlo.app.model.Level
import com.parlo.app.model.LiveSessionState
import com.parlo.app.model.SessionConfig
import com.parlo.app.service.LiveSessionService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class MainUiState(
    val live: LiveSessionState = LiveSessionState(),
    /** Settings shown in the pickers. Mirrors live.config while a session is active. */
    val config: SessionConfig = SessionConfig(),
    val recentCombos: List<LanguageCombo> = emptyList(),
    val hasApiKey: Boolean = false,
    val models: List<String> = emptyList(),
    val modelsLoading: Boolean = false,
    val modelsError: String? = null,
    val serviceBound: Boolean = false,
    /** Auto-captured words waiting in the Vocab "Suggested" tray. */
    val suggestedVocab: Int = 0,
    val dynamicColor: Boolean = false,
    val voicePreview: VoicePreview = VoicePreview(),
    /** Most recent finished walk, shown as the post-walk recap and next-walk suggestion. */
    val lastWalk: LastWalk? = null,
    /** False until the first walk has finished; drives the welcome screen and voice onboarding. */
    val hasWalked: Boolean = true,
    val maskedKey: String = "",
    val languages: List<SessionConfig> = emptyList(),
    val goal: String = "",
    val learningEpisodes: List<LearningEpisodeEntity> = emptyList(),
    val walkCount: Int = 0,
    val lastPractisedAt: Long? = null,
) {
    /** True once a walk can actually start: a key is saved and a voice model is known. */
    val ready: Boolean get() = hasApiKey && !keyRejected && (config.model.isNotBlank() || models.isNotEmpty())

    private val keyRejected: Boolean get() = modelsError?.contains("API key", ignoreCase = true) == true

    val setup: SetupStatus
        get() = when {
            !hasApiKey -> SetupStatus.NO_KEY
            modelsLoading && models.isEmpty() -> SetupStatus.CHECKING
            keyRejected -> SetupStatus.BAD_KEY
            ready -> SetupStatus.READY
            modelsError != null -> SetupStatus.OFFLINE
            else -> SetupStatus.NO_MODEL
        }
}

/** Real numbers only: the walk's length and the words saved from it. */
data class LastWalk(
    val sessionId: Long,
    val language: String,
    val dialect: String,
    val level: String,
    val durationMs: Long,
    val words: List<VocabEntity>,
    val focus: String,
    val nextWalkTitle: String,
    val nextWalkPrompt: String,
    val reviewing: Boolean,
    val interrupted: Boolean = false,
) {
    val lengthLabel: String get() = walkLengthLabel(durationMs)
}

internal fun walkLengthLabel(durationMs: Long): String {
    val minutes = durationMs / 60_000
    return if (minutes < 1) "Under a minute" else "$minutes min"
}

internal fun lastWalkOf(sessions: List<SessionEntity>, vocab: List<VocabEntity>, mining: Set<Long>): LastWalk? {
    val s = sessions.filter { it.endedAt != null }.maxByOrNull { it.startedAt } ?: return null
    return LastWalk(
        sessionId = s.id,
        language = s.language,
        dialect = s.dialect,
        level = s.level,
        durationMs = s.durationMs,
        words = vocab.filter { it.sessionId == s.id && !it.isSuggested }.sortedBy { it.savedAt },
        focus = s.focus.orEmpty(),
        nextWalkTitle = s.nextWalkTitle.orEmpty(),
        nextWalkPrompt = s.nextWalkPrompt.orEmpty(),
        reviewing = s.id in mining,
        interrupted = s.interrupted,
    )
}

enum class SetupStatus { NO_KEY, CHECKING, BAD_KEY, OFFLINE, NO_MODEL, READY }

private data class WalkHistory(
    val sessions: List<SessionEntity>,
    val words: List<VocabEntity>,
    val mining: Set<Long>,
    val languages: List<com.parlo.app.data.db.LanguageSession>,
)

/** Which voice sample is being fetched or played from Settings, if any. */
data class VoicePreview(val loading: String? = null, val playing: String? = null, val error: String? = null)

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val container = ParloApp.container(app)
    private val settings = container.settings
    private val models = container.models
    private val vocab = container.vocab
    private val sampler = container.voiceSampler
    private val preview = MutableStateFlow(VoicePreview())
    private var previewJob: Job? = null
    private var configWrite: Job? = null

    private fun queueConfig(block: suspend () -> Unit) {
        val previous = configWrite
        configWrite = viewModelScope.launch { previous?.join(); block() }
    }
    private val previewPlayer = AudioPlayer(viewModelScope, onSpeakingChanged = { speaking ->
        if (!speaking) preview.update { it.copy(playing = null) }
    })

    // Bound service reference; cleared in onServiceDisconnected.
    @SuppressLint("StaticFieldLeak")
    private var service: LiveSessionService? = null
    private var serviceStateJob: Job? = null
    private val liveState = MutableStateFlow(LiveSessionState())
    private val bound = MutableStateFlow(false)

    val uiState: StateFlow<MainUiState> = combine(
        liveState, settings.config, settings.recentCombos, settings.apiKey, bound,
    ) { live, persisted, combos, key, isBound ->
        MainUiState(
            live = live,
            config = if (live.isActive) live.config else persisted,
            recentCombos = combos,
            hasApiKey = key.isNotBlank(),
            serviceBound = isBound,
        )
    }.combine(models.models) { s, m -> s.copy(models = m) }
        .combine(models.loading) { s, l -> s.copy(modelsLoading = l) }
        .combine(models.error) { s, e -> s.copy(modelsError = e) }
        .combine(vocab.observeAll()) { s, words -> s.copy(suggestedVocab = words.count { it.isSuggested }) }
        .combine(settings.dynamicColor) { s, d -> s.copy(dynamicColor = d) }
        .combine(preview) { s, p -> s.copy(voicePreview = p) }
        .combine(combine(container.sessions.observeSessions(), vocab.observeAll(), container.vocabCapture.mining,
            container.db.sessionDao().observeLanguageSessions(), ::WalkHistory)) { s, history ->
            val participating = history.languages.filter { it.language.equals(s.config.language, true) }.map { it.sessionId }.toSet()
            val withLearnerTurns = history.languages.map { it.sessionId }.toSet()
            val languageWalks = history.sessions.filter { it.id in participating || (it.id !in withLearnerTurns && it.language.equals(s.config.language, true)) }
                .map { walk ->
                    // The final language's review must never become another language's lesson.
                    if (walk.language.equals(s.config.language, true)) walk else walk.copy(
                        language = s.config.language, dialect = s.config.dialect, level = s.config.level.name,
                        focus = null, nextWalkTitle = null, nextWalkPrompt = null)
                }
            s.copy(lastWalk = lastWalkOf(languageWalks, history.words.filter { it.language.equals(s.config.language, true) }, history.mining),
                hasWalked = history.sessions.isNotEmpty(), walkCount = languageWalks.count { it.endedAt != null && !it.interrupted },
                lastPractisedAt = languageWalks.maxOfOrNull { it.startedAt })
        }
        .combine(settings.languageConfigs) { s, languages -> s.copy(languages = languages) }
        .combine(container.learning.profiles) { s, profiles ->
            s.copy(goal = profiles.firstOrNull { it.language.equals(s.config.language, true) }?.goal.orEmpty())
        }
        .combine(settings.config.map { it.language }.distinctUntilChanged().flatMapLatest(container.learning::episodes)) { s, episodes ->
            s.copy(learningEpisodes = episodes.filter { it.language.equals(s.config.language, true) })
        }
        .combine(settings.apiKey) { s, k -> s.copy(maskedKey = com.parlo.app.ui.onboarding.maskKey(k)) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, MainUiState())

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            val svc = (binder as LiveSessionService.LocalBinder).service
            service = svc
            bound.value = true
            serviceStateJob?.cancel()
            serviceStateJob = viewModelScope.launch { svc.state.collect { liveState.value = it } }
        }

        override fun onServiceDisconnected(name: ComponentName) {
            service = null
            bound.value = false
            serviceStateJob?.cancel()
        }
    }

    init {
        viewModelScope.launch {
            models.loadCached()
            settings.apiKey.collect { key -> if (key.isNotBlank()) models.refresh(key) }
        }
    }

    fun bind(context: Context) {
        context.bindService(LiveSessionService.bindIntent(context), connection, Context.BIND_AUTO_CREATE)
    }

    fun unbind(context: Context) {
        if (bound.value) runCatching { context.unbindService(connection) }
        bound.value = false
        serviceStateJob?.cancel()
    }

    fun startSession(context: Context) {
        // One start path, including when the service hasn't bound yet. Read settings in the service
        // after queued edits, and carry the transient onboarding flag explicitly in the intent.
        viewModelScope.launch {
            configWrite?.join()
            ContextCompat.startForegroundService(context, LiveSessionService.startIntent(context, onboarding = !uiState.value.hasWalked))
        }
    }

    fun endSession(skipRecap: Boolean) = service?.endSession(skipRecap)

    fun toggleMute() = service?.toggleMute()

    fun repeatSlowly() = service?.requestRepeatSlowly()

    fun englishHelp() = service?.requestEnglishHelp()

    /** Point the next walk at the tutor's suggestion from [LastWalk]. */
    fun useSuggestedWalk() {
        val w = uiState.value.lastWalk ?: return
        if (w.nextWalkPrompt.isBlank()) return
        updateConfig {
            val sameLanguage = it.language.equals(w.language, true)
            it.copy(
                language = w.language,
                dialect = if (sameLanguage) it.dialect else w.dialect,
                level = if (sameLanguage) it.level else Level.parse(w.level),
                topic = w.nextWalkPrompt,
                topicTitle = w.nextWalkTitle,
                followPlan = true,
            )
        }
    }

    fun dropWord(word: VocabEntity) {
        viewModelScope.launch { vocab.delete(word) }
    }

    fun restoreWord(word: VocabEntity) {
        viewModelScope.launch { vocab.restore(listOf(word)) }
    }

    fun dismissError() = service?.dismissError()

    fun updateConfig(transform: (SessionConfig) -> SessionConfig) {
        val svc = service
        if (svc != null && svc.state.value.isActive) {
            svc.applyConfig(transform(svc.state.value.config))
        } else {
            queueConfig { settings.updateConfig(transform) }
        }
    }

    fun selectCombo(combo: LanguageCombo) = selectLanguageConfig(combo.language, combo.dialect, combo.level)

    fun selectLanguage(language: String, dialect: String? = null) = selectLanguageConfig(language, dialect)

    private fun selectLanguageConfig(language: String, dialect: String?, level: Level? = null) {
        val svc = service
        if (svc != null && svc.state.value.isActive) svc.selectLanguage(language, dialect, level)
        else queueConfig { settings.selectLanguage(language, dialect, level) }
    }

    fun setGoal(goal: String) {
        val language = uiState.value.config.language
        viewModelScope.launch { container.learning.setGoal(language, goal) }
    }

    fun forgetSessionMemory(id: Long) {
        viewModelScope.launch { container.learning.forgetSession(id) }
    }

    fun setApiKey(key: String) {
        settings.setApiKey(key)
        if (key.isNotBlank()) com.parlo.app.data.LearningWorker.enqueue(getApplication())
    }

    fun refreshModels() {
        viewModelScope.launch { models.refresh(settings.apiKey.value) }
    }

    fun setDynamicColor(enabled: Boolean) {
        viewModelScope.launch { settings.setDynamicColor(enabled) }
    }

    /** Plays a short greeting in [voice] via Gemini TTS; tapping the voice already playing stops it. */
    fun previewVoice(voice: String) {
        val key = settings.apiKey.value
        if (key.isBlank() || uiState.value.live.isActive) return
        val cfg = uiState.value.config
        val wasActive = preview.value.playing == voice || preview.value.loading == voice
        stopPreview()
        if (wasActive) return
        preview.value = VoicePreview(loading = voice)
        previewJob = viewModelScope.launch {
            val pcm = runCatching { withContext(Dispatchers.IO) { sampler.sample(key, voice, cfg.language, cfg.dialect) } }
                .getOrElse { e ->
                    preview.value = VoicePreview(error = e.message ?: "Couldn't fetch a sample")
                    return@launch
                }
            previewPlayer.start()
            preview.value = VoicePreview(playing = voice)
            for (off in pcm.indices step PREVIEW_CHUNK) {
                previewPlayer.enqueue(pcm.copyOfRange(off, minOf(off + PREVIEW_CHUNK, pcm.size)))
            }
        }
    }

    fun stopPreview() {
        previewJob?.cancel(); previewJob = null
        previewPlayer.stop()
        preview.value = VoicePreview()
    }

    override fun onCleared() {
        stopPreview()
        serviceStateJob?.cancel()
        super.onCleared()
    }

    companion object {
        private const val PREVIEW_CHUNK = 4096

        fun factory(app: Application) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = MainViewModel(app) as T
        }
    }
}
