package com.parlo.app.service

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import androidx.media.session.MediaButtonReceiver
import com.parlo.app.BuildConfig
import com.parlo.app.MainActivity
import com.parlo.app.ParloApp
import com.parlo.app.R
import com.parlo.app.audio.AudioPlayer
import com.parlo.app.audio.AudioRouteManager
import com.parlo.app.audio.Earcons
import com.parlo.app.audio.MicrophoneStreamer
import com.parlo.app.gemini.GeminiLiveClient
import com.parlo.app.gemini.LiveEvent
import com.parlo.app.gemini.LiveToolDispatcher
import com.parlo.app.gemini.LiveSetup
import com.parlo.app.gemini.PromptBuilder
import com.parlo.app.gemini.Setup
import com.parlo.app.gemini.ToolHandler
import com.parlo.app.model.AudioState
import com.parlo.app.model.ConnectionState
import com.parlo.app.model.LanguageCatalog
import com.parlo.app.model.LanguageCombo
import com.parlo.app.model.LearnerProfile
import com.parlo.app.model.LiveSessionState
import com.parlo.app.model.SessionConfig
import com.parlo.app.model.WalkMemory
import com.parlo.app.model.SessionError
import com.parlo.app.model.Speaker
import com.parlo.app.model.TranscriptTurn
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.atomic.AtomicLong

/**
 * Foreground service that owns the whole walk session: Gemini socket, mic, speaker, focus, routing,
 * MediaSession (headset buttons), notification, transcript persistence and the end-of-session recap.
 */
class LiveSessionService : LifecycleService() {

    inner class LocalBinder : Binder() {
        val service: LiveSessionService get() = this@LiveSessionService
    }

    private val binder = LocalBinder()

    private val _state = MutableStateFlow(LiveSessionState())
    val state: StateFlow<LiveSessionState> = _state

    private lateinit var container: com.parlo.app.AppContainer
    private lateinit var client: GeminiLiveClient
    private lateinit var player: AudioPlayer
    private lateinit var mic: MicrophoneStreamer
    private lateinit var route: AudioRouteManager
    private lateinit var earcons: Earcons
    private lateinit var toolHandler: ToolHandler
    private lateinit var toolDispatcher: LiveToolDispatcher
    /** Resolved model for this connection, separate from the persisted optional override. */
    private var liveModel = ""
    private var mediaSession: MediaSessionCompat? = null
    private var connectivity: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private var dbSessionId: Long? = null
    /** Ordered application-scope writes survive service teardown; connecting waits for session creation. */
    private var pendingWrite: Job? = null
    private var committedTurns = 0
    private var dataLease: Long? = null
    private val configMutex = Mutex()
    private var persistenceFailed = false

    private fun persist(block: suspend () -> Unit) {
        val previous = pendingWrite
        pendingWrite = container.appScope.launch {
            previous?.join()
            try { block() }
            catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (e: Exception) {
                Log.e(TAG, "Could not persist walk; stopping rather than silently losing history", e)
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main.immediate) {
                    if (!persistenceFailed) {
                        persistenceFailed = true
                        container.learningDataGate.endSession(dataLease)
                        dataLease = null
                        fail(SessionError.Unknown("Could not save this walk. Check free storage before trying again."))
                    }
                }
            }
        }
    }
    private var startupJob: Job? = null
    private var eventsJob: Job? = null
    private var recapJob: Job? = null
    private var walkMemory: WalkMemory? = null
    private var hadReadyOnce = false
    private var pendingResumeContext = false
    private var awaitingRecapTurnComplete = false
    private var recapText = StringBuilder()
    private var tutorSpeaking = false
    private var micLevel = 0f
    private var focusPaused = false
    private val turnIds = AtomicLong(1)
    private val userBuffer = StringBuilder()
    private val tutorBuffer = StringBuilder()

    override fun onCreate() {
        super.onCreate()
        container = ParloApp.container(this)
        client = GeminiLiveClient(container.okHttp, lifecycleScope)
        earcons = Earcons(lifecycleScope)
        player = AudioPlayer(lifecycleScope, onSpeakingChanged = { speaking -> tutorSpeaking = speaking; refreshAudioState() })
        mic = MicrophoneStreamer(
            scope = lifecycleScope,
            onChunk = { bytes, len -> client.sendAudio(bytes, len) },
            onLevel = { lvl -> if ((lvl > 0.06f) != (micLevel > 0.06f)) { micLevel = lvl; refreshAudioState() } else micLevel = lvl },
        )
        route = AudioRouteManager(this, ::onFocusChange)
        toolHandler = ToolHandler(
            vocab = container.vocab,
            currentLanguage = { _state.value.config.language },
            currentDialect = { _state.value.config.dialect },
            currentLevel = { _state.value.config.level },
            sessionId = { dbSessionId },
            onVocabSaved = { word ->
                earcons.play(Earcons.Cue.VOCAB_SAVED)
                appendTurn(Speaker.SYSTEM, "Saved \"$word\" to vocab")
                _state.update { it.copy(caughtWords = it.caughtWords + word) }
            },
            onLanguageSwitched = ::onVoiceLanguageSwitch,
            onVocabNoted = { word ->
                appendTurn(Speaker.SYSTEM, "Saved \"$word\" to vocab")
                _state.update { it.copy(caughtWords = it.caughtWords + word) }
            },
            onProfileUpdated = ::onProfileUpdate,
            currentConfig = { _state.value.config },
            recallHistory = { query -> pendingWrite?.join(); container.learning.search(_state.value.config.language, query) },
            languageDefaults = { language -> container.settings.forLanguage(language) ?: SessionConfig(language = language, dialect = LanguageCatalog.defaultDialectFor(language), level = com.parlo.app.model.Level.SUPER_BEGINNER) },
            languageMemory = { PromptBuilder.memoryBlock(_state.value.config, walkMemory) },
            onShowPhrase = { phrase -> _state.update { it.copy(phrase = phrase) } },
            onWalkUpdated = ::onVoiceWalkUpdate,
            onEndWalk = { lifecycleScope.launch { delay(END_WALK_DELAY_MS); endSession(skipRecap = false) } },
        )
        toolDispatcher = LiveToolDispatcher(
            scope = lifecycleScope,
            model = { liveModel },
            handle = toolHandler::handle,
            respond = { response -> client.sendToolResponses(listOf(response)) },
        )
        setupMediaSession()
        registerNetworkCallback()
        lifecycleScope.launch { _state.collect { container.liveWalk.value = it } }
    }

    override fun onBind(intent: Intent): IBinder {
        super.onBind(intent)
        return binder
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        when (intent?.action) {
            ACTION_START -> {
                // Started with startForegroundService (widget/notification): promote before any early failure.
                if (!_state.value.isActive) goForeground()
                lifecycleScope.launch {
                    try {
                        container.recovery.await()
                        if (container.models.defaultModel() == null) container.models.loadCached()
                        startSession(container.settings.currentConfig().copy(onboarding = intent.getBooleanExtra(EXTRA_ONBOARDING, false)))
                    } catch (e: kotlinx.coroutines.CancellationException) { throw e }
                    catch (e: Exception) { fail(SessionError.Unknown(e.message ?: "Could not recover learning history")) }
                }
            }
            ACTION_TOGGLE_MUTE -> toggleMute()
            ACTION_END -> endSession(skipRecap = false)
            ACTION_END_NOW -> endSession(skipRecap = true)
            Intent.ACTION_MEDIA_BUTTON -> MediaButtonReceiver.handleIntent(mediaSession, intent)
        }
        return START_NOT_STICKY
    }

    // ------------------------------------------------------------------ public API

    fun startSession(config: SessionConfig) {
        if (_state.value.isActive) return
        val previousStartup = startupJob
        if (previousStartup?.isActive == true) {
            // An immediate restart after ending during setup must not make the old setup's
            // CONNECTING guard match a new walk and open a stale socket.
            lifecycleScope.launch {
                previousStartup.join()
                pendingWrite?.join()
                if (!_state.value.isActive) startSession(config)
            }
            return
        }
        val apiKey = container.settings.apiKey.value
        if (apiKey.isBlank()) { fail(SessionError.MissingApiKey); return }
        val model = config.model.ifBlank { container.models.defaultModel().orEmpty() }
        if (model.isBlank()) { fail(SessionError.NoLiveModel); return }
        dataLease = container.learningDataGate.beginSession()
        if (dataLease == null) {
            fail(SessionError.Unknown("Wait for the backup or restore to finish before starting a walk"))
            return
        }
        liveModel = model
        val effective = config
        committedTurns = 0
        toolDispatcher.clear()

        hadReadyOnce = false
        pendingResumeContext = false
        userBuffer.clear(); tutorBuffer.clear(); recapText.clear()
        _state.value = LiveSessionState(
            connection = ConnectionState.CONNECTING,
            audio = AudioState.IDLE,
            config = effective,
            sessionStartMs = System.currentTimeMillis(),
            statusText = "Connecting…",
            profile = if (effective.onboarding) LearnerProfile() else null,
        )
        goForeground()
        route.begin()
        player.start()
        mediaSession?.isActive = true
        setPlaybackState(PlaybackStateCompat.STATE_PLAYING)
        eventsJob?.cancel()
        eventsJob = lifecycleScope.launch { client.events.collect(::onLiveEvent) }
        walkMemory = null
        val priorWrites = pendingWrite
        startupJob = lifecycleScope.launch {
            try {
                container.recovery.await()
                priorWrites?.join()
                if (_state.value.connection != ConnectionState.CONNECTING) return@launch
                persistenceFailed = false
                walkMemory = container.learning.memory(effective.language)
                if (_state.value.connection != ConnectionState.CONNECTING) return@launch
                val prepared = effective.copy(onboarding = walkMemory?.returning != true)
                _state.update { it.copy(config = prepared, profile = if (prepared.onboarding) LearnerProfile() else null) }
                container.settings.saveConfig(prepared)
                dbSessionId = container.sessions.startSession(prepared, _state.value.sessionStartMs)
                // An end tap during DB setup must not open a new socket or leave an empty session.
                if (_state.value.connection == ConnectionState.CONNECTING) client.start(apiKey) { buildSetup(_state.value.config) }
                else { container.sessions.cleanupEmpty(); dbSessionId = null }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.e(TAG, "Could not prepare durable session", e)
                fail(SessionError.Unknown(e.message ?: "Could not load learning history"))
            }
        }
    }

    fun toggleMute() = setMuted(!_state.value.muted)

    fun setMuted(muted: Boolean) {
        if (!_state.value.isActive) return
        mic.setMuted(muted)
        if (muted) client.endAudioStream()
        _state.update { it.copy(muted = muted) }
        earcons.play(if (muted) Earcons.Cue.MUTED else Earcons.Cue.UNMUTED)
        refreshAudioState()
        updateNotification()
    }

    /** Apply new settings mid-session. Live-switchable fields go over the wire as a text turn; voice/model reconnect. */
    fun applyConfig(new: SessionConfig) {
        lifecycleScope.launch { configMutex.withLock { applyConfigDurably(new) } }
    }

    private suspend fun applyConfigDurably(new: SessionConfig) {
        val old = _state.value.config
        if (new == old) return
        flushBuffers()
        container.settings.saveConfig(new)
        val merged = container.settings.currentConfig().copy(onboarding = new.onboarding)
        if (!old.language.equals(merged.language, true)) {
            walkMemory = container.learning.memory(merged.language, dbSessionId ?: 0)
        }
        _state.update { it.copy(config = merged) }
        if (!_state.value.isActive) return
        val model = merged.model.ifBlank { container.models.defaultModel() ?: liveModel }
        val needsReconnect = merged.voice != old.voice || model != liveModel
        if (needsReconnect) {
            liveModel = model
            toolDispatcher.clear()
            _state.update { it.copy(connection = ConnectionState.RECONNECTING, statusText = "Applying voice/model…") }
            earcons.play(Earcons.Cue.RECONNECTING)
            player.flush()
            client.reconnectWithNewSetup { buildSetup(_state.value.config) }
        } else if (client.isReady) {
            player.flush()
            client.sendText(PromptBuilder.switchMessage(old, merged) + "\n" + PromptBuilder.memoryBlock(merged, walkMemory))
            appendTurn(Speaker.SYSTEM, "Switched to ${merged.dialect.ifBlank { merged.language }} · ${merged.level.label}")
        }
        updateNotification()
    }

    fun selectLanguage(language: String, dialect: String? = null, level: com.parlo.app.model.Level? = null) {
        lifecycleScope.launch {
            configMutex.withLock {
                container.settings.selectLanguage(language, dialect, level)
                applyConfigDurably(container.settings.currentConfig().copy(onboarding = false))
            }
        }
    }

    fun requestEnglishHelp() {
        if (!client.isReady) return
        player.flush()
        client.sendText(PromptBuilder.englishHelpMessage())
    }

    fun requestRepeatSlowly() {
        if (!client.isReady) return
        player.flush()
        client.sendText(PromptBuilder.repeatSlowlyMessage())
    }

    fun endSession(skipRecap: Boolean) {
        val s = _state.value
        if (!s.isActive) { stopSelf(); return }
        if (s.connection == ConnectionState.ENDING) {
            if (skipRecap) finishSession()
            return
        }
        if (skipRecap || !client.isReady) { finishSession(); return }
        _state.update { it.copy(connection = ConnectionState.ENDING, recapInProgress = true, statusText = "Recap…") }
        mic.setMuted(true)
        recapText.clear()
        awaitingRecapTurnComplete = true
        player.flush()
        client.sendText(PromptBuilder.recapMessage(s.config))
        appendTurn(Speaker.SYSTEM, "Requesting end-of-walk recap")
        updateNotification()
        recapJob = lifecycleScope.launch {
            withTimeoutOrNull(RECAP_TIMEOUT_MS) {
                while (awaitingRecapTurnComplete) delay(100)
                while (player.isSpeaking) delay(100)
            }
            finishSession()
        }
    }

    fun dismissError() {
        _state.update { it.copy(error = null, connection = ConnectionState.IDLE, statusText = "") }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // ------------------------------------------------------------------ lifecycle

    private fun finishSession() {
        recapJob?.cancel(); recapJob = null
        val recap = recapText.toString().trim()
        flushBuffers()
        val config = _state.value.config
        val id = dbSessionId
        val endedAt = System.currentTimeMillis()
        toolDispatcher.clear()
        client.close()
        mic.stop()
        player.stop()
        route.end()
        earcons.play(Earcons.Cue.SESSION_ENDED)
        setPlaybackState(PlaybackStateCompat.STATE_STOPPED)
        mediaSession?.isActive = false
        eventsJob?.cancel(); eventsJob = null
        _state.update {
            it.copy(connection = ConnectionState.IDLE, audio = AudioState.IDLE, muted = false, recapInProgress = false, statusText = "")
        }
        dbSessionId = null
        val lease = dataLease
        val setup = startupJob
        dataLease = null
        persist {
            try {
                setup?.join()
                if (id != null) {
                    container.sessions.finishSession(id, endedAt, recap.ifBlank { null }, config)
                    com.parlo.app.data.LearningWorker.enqueue(applicationContext, id)
                }
            } finally { container.learningDataGate.endSession(lease) }
        }
        lifecycleScope.launch {
            pendingWrite?.join()
            delay(700)
            if (!_state.value.isActive) {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
    }

    private fun fail(error: SessionError) {
        Log.w(TAG, "session failed: ${error.message}")
        earcons.play(Earcons.Cue.ERROR)
        toolDispatcher.clear()
        client.close()
        mic.stop()
        player.stop()
        route.end()
        setPlaybackState(PlaybackStateCompat.STATE_ERROR)
        mediaSession?.isActive = false
        eventsJob?.cancel(); eventsJob = null
        flushBuffers()
        val id = dbSessionId
        val config = _state.value.config
        _state.update { it.copy(connection = ConnectionState.ERROR, audio = AudioState.IDLE, error = error, recapInProgress = false, statusText = error.title) }
        dbSessionId = null
        val lease = dataLease
        val setup = startupJob
        dataLease = null
        persist {
            try {
                setup?.join()
                if (id != null) {
                    container.sessions.finishSession(id, System.currentTimeMillis(), null, config)
                    com.parlo.app.data.LearningWorker.enqueue(applicationContext, id)
                }
                container.sessions.cleanupEmpty()
            } finally { container.learningDataGate.endSession(lease) }
        }
        if (isForeground) updateNotification()
    }

    override fun onDestroy() {
        toolDispatcher.clear()
        flushBuffers()
        val interruptedId = dbSessionId
        val lease = dataLease
        val setup = startupJob
        dataLease = null
        persist {
            try {
                setup?.join()
                if (interruptedId != null) {
                    container.db.sessionDao().recoverInterrupted(interruptedId)
                    com.parlo.app.data.LearningWorker.enqueue(applicationContext, interruptedId)
                }
            } finally { container.learningDataGate.endSession(lease) }
        }
        if (_state.value.isActive) {
            client.close(); mic.stop(); player.stop(); route.end()
            _state.update { it.copy(connection = ConnectionState.IDLE, audio = AudioState.IDLE, muted = false) }
        }
        container.liveWalk.value = _state.value
        networkCallback?.let { runCatching { connectivity?.unregisterNetworkCallback(it) } }
        mediaSession?.release()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ Gemini events

    private suspend fun onLiveEvent(e: LiveEvent) {
        when (e) {
            is LiveEvent.Ready -> {
                val wasReconnect = hadReadyOnce
                hadReadyOnce = true
                _state.update { it.copy(connection = if (it.connection == ConnectionState.ENDING) it.connection else ConnectionState.CONNECTED, error = null, statusText = "") }
                if (!mic.isRunning) mic.start()
                mic.setMuted(_state.value.muted || _state.value.recapInProgress)
                if (wasReconnect) {
                    earcons.play(Earcons.Cue.RECONNECTED)
                    if (pendingResumeContext || !e.resumed) {
                        pendingResumeContext = false
                        sendResumeContext()
                    }
                    flushBuffers()
                    val last = _state.value.transcript.lastOrNull { it.speaker != Speaker.SYSTEM }
                    if (last?.speaker == Speaker.USER && !_state.value.recapInProgress) {
                        client.sendText(PromptBuilder.unansweredTurnMessage(last.text))
                    }
                } else {
                    earcons.play(Earcons.Cue.SESSION_STARTED)
                    client.sendText(PromptBuilder.kickoffMessage())
                }
                refreshAudioState(); updateNotification()
            }
            is LiveEvent.Audio -> player.enqueue(e.pcm)
            is LiveEvent.InputTranscript -> {
                if (tutorBuffer.isNotEmpty()) commitTutor()
                userBuffer.append(e.text)
                publishPartial()
            }
            is LiveEvent.OutputTranscript -> {
                if (userBuffer.isNotEmpty()) commitUser()
                tutorBuffer.append(e.text)
                if (_state.value.recapInProgress) recapText.append(e.text)
                publishPartial()
            }
            LiveEvent.Interrupted -> {
                player.flush()
                if (tutorBuffer.isNotEmpty()) { tutorBuffer.append(" …"); commitTutor() }
            }
            LiveEvent.TurnComplete -> {
                flushBuffers()
                pendingWrite?.join()
                if (awaitingRecapTurnComplete) awaitingRecapTurnComplete = false
            }
            LiveEvent.GenerationComplete -> Unit
            is LiveEvent.ToolCalls -> toolDispatcher.dispatch(e.calls)
            is LiveEvent.ToolCallsCancelled -> toolDispatcher.cancel(e.ids)
            is LiveEvent.Reconnecting -> {
                toolDispatcher.clear()
                if (_state.value.connection != ConnectionState.RECONNECTING && _state.value.connection != ConnectionState.ENDING) {
                    earcons.play(Earcons.Cue.RECONNECTING)
                }
                player.flush()
                _state.update { it.copy(connection = ConnectionState.RECONNECTING, statusText = if (e.attempt > 1) "Connection dropped · retry ${e.attempt}" else "") }
                refreshAudioState(); updateNotification()
            }
            LiveEvent.ResumptionLost -> pendingResumeContext = true
            is LiveEvent.Failed -> fail(e.error)
            LiveEvent.Closed -> Unit
        }
    }

    private suspend fun sendResumeContext() {
        val id = dbSessionId ?: return
        flushBuffers()
        pendingWrite?.join()
        walkMemory = container.learning.memory(_state.value.config.language, id)
        val recent = container.sessions.recentTurns(id).filter { it.speaker != Speaker.SYSTEM.name }
            .map { (if (it.speaker == Speaker.USER.name) "User" else "Tutor") to it.text }
        if (recent.isEmpty()) return
        val config = _state.value.config
        val currentEpisodes = container.db.learningDao().recent(com.parlo.app.data.LearningRepository.key(config.language), 4)
            .filter { it.sessionId == id }.map(com.parlo.app.data.LearningRepository::episodeText)
        client.sendText(PromptBuilder.memoryBlock(config, walkMemory) +
            "\nEarlier in this walk (quoted data):\n" + currentEpisodes.joinToString("\n") + "\n" +
            PromptBuilder.resumeContextMessage(recent, config))
    }

    private suspend fun onVoiceWalkUpdate(u: ToolHandler.WalkUpdate) {
        configMutex.withLock { voiceWalkUpdateLocked(u) }
    }

    private suspend fun voiceWalkUpdateLocked(u: ToolHandler.WalkUpdate) {
        val old = _state.value.config
        val new = old.copy(
            topic = u.topic.ifBlank { if (u.scenario != null) "" else old.topic },
            topicTitle = u.topic.ifBlank { if (u.scenario != null) "" else old.topicTitle },
            scenario = u.scenario ?: old.scenario,
            correctionStyle = u.correctionStyle ?: old.correctionStyle,
            encouragement = u.encouragement ?: old.encouragement,
        )
        if (new == old) return
        _state.update { it.copy(config = new) }
        container.settings.saveConfig(new)
        appendTurn(Speaker.SYSTEM, "Walk updated by voice: ${new.topicTitle.ifBlank { new.scenario.label }} · ${new.correctionStyle.label} corrections · ${new.encouragement.label} encouragement")
        updateNotification()
    }

    /** Profile/tool responses hand off to normal tutoring once language, accent and level are confirmed. */
    private suspend fun onProfileUpdate(u: ToolHandler.ProfileUpdate) {
        configMutex.withLock { profileUpdateLocked(u) }
    }

    private suspend fun profileUpdateLocked(u: ToolHandler.ProfileUpdate) {
        flushBuffers()
        val (new, profile) = applyProfileUpdate(_state.value.config, _state.value.profile ?: LearnerProfile(), u)
        _state.update { it.copy(config = new, profile = profile) }
        container.settings.saveConfig(new)
        if (u.goal.isNotBlank()) container.learning.setGoal(new.language, u.goal)
        if (walkMemory?.language?.equals(new.language, true) != true) walkMemory = container.learning.memory(new.language, dbSessionId ?: 0)
        updateNotification()
    }

    private suspend fun onVoiceLanguageSwitch(combo: LanguageCombo) {
        configMutex.withLock { voiceLanguageSwitchLocked(combo) }
    }

    private suspend fun voiceLanguageSwitchLocked(combo: LanguageCombo) {
        val old = _state.value.config
        flushBuffers()
        container.settings.selectLanguage(combo.language, combo.dialect, combo.level)
        val new = container.settings.currentConfig().copy(onboarding = false)
        if (new == old) return
        _state.update { it.copy(config = new) }
        pendingWrite?.join()
        walkMemory = container.learning.memory(new.language, dbSessionId ?: 0)
        appendTurn(Speaker.SYSTEM, "Switched by voice to ${combo.label}")
        updateNotification()
    }

    // ------------------------------------------------------------------ transcript

    private fun publishPartial() {
        _state.update { s ->
            val finals = s.transcript.filter { it.isFinal }
            val partials = buildList {
                if (userBuffer.isNotEmpty()) add(TranscriptTurn(-1, Speaker.USER, userBuffer.toString(), System.currentTimeMillis(), isFinal = false))
                if (tutorBuffer.isNotEmpty()) add(TranscriptTurn(-2, Speaker.TUTOR, tutorBuffer.toString(), System.currentTimeMillis(), isFinal = false))
            }
            s.copy(transcript = finals + partials)
        }
    }

    private fun commitUser() { val t = userBuffer.toString(); userBuffer.clear(); appendTurn(Speaker.USER, t) }
    private fun commitTutor() { val t = collapseRepeat(tutorBuffer.toString()); tutorBuffer.clear(); appendTurn(Speaker.TUTOR, t) }
    private fun flushBuffers() { if (userBuffer.isNotEmpty()) commitUser(); if (tutorBuffer.isNotEmpty()) commitTutor(); publishPartial() }

    private fun appendTurn(speaker: Speaker, text: String) {
        val clean = text.trim()
        if (clean.isEmpty()) return
        val now = System.currentTimeMillis()
        val turn = TranscriptTurn(turnIds.getAndIncrement(), speaker, clean, now)
        _state.update { s -> s.copy(transcript = s.transcript.filter { it.isFinal } + turn) }
        publishPartial()
        val id = dbSessionId ?: return
        val language = _state.value.config.language
        if (speaker != Speaker.SYSTEM) committedTurns++
        val checkpoint = speaker != Speaker.SYSTEM && committedTurns % 12 == 0
        persist {
            container.sessions.addTurn(id, speaker, clean, now, language)
            if (checkpoint) com.parlo.app.data.LearningWorker.enqueue(applicationContext, id)
        }
    }

    // ------------------------------------------------------------------ audio state / focus

    private fun refreshAudioState() {
        _state.update { s ->
            val audio = when {
                s.connection == ConnectionState.RECONNECTING || s.connection == ConnectionState.CONNECTING -> AudioState.RECONNECTING
                s.connection == ConnectionState.IDLE || s.connection == ConnectionState.ERROR -> AudioState.IDLE
                tutorSpeaking -> AudioState.SPEAKING
                s.muted -> AudioState.MUTED
                micLevel > 0.06f -> AudioState.LISTENING
                else -> AudioState.IDLE
            }
            if (audio == s.audio) s else s.copy(audio = audio)
        }
    }

    private fun onFocusChange(focus: AudioRouteManager.FocusState) {
        when (focus) {
            AudioRouteManager.FocusState.GAINED -> {
                if (focusPaused) {
                    focusPaused = false
                    mic.setPaused(false); player.setPaused(false)
                    _state.update { it.copy(statusText = "") }
                }
            }
            AudioRouteManager.FocusState.LOST_TRANSIENT, AudioRouteManager.FocusState.LOST -> {
                focusPaused = true
                mic.setPaused(true); player.setPaused(true)
                client.endAudioStream()
                _state.update { it.copy(statusText = "Paused (audio focus lost)") }
                if (focus == AudioRouteManager.FocusState.LOST) {
                    lifecycleScope.launch {
                        delay(3000)
                        if (focusPaused && _state.value.isActive) { route.end(); route.begin() }
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------ media session (headset buttons)

    private fun setupMediaSession() {
        val mbrIntent = Intent(Intent.ACTION_MEDIA_BUTTON).setClass(this, MediaButtonReceiver::class.java)
        val mbrPending = PendingIntent.getBroadcast(this, 0, mbrIntent, PendingIntent.FLAG_IMMUTABLE)
        mediaSession = MediaSessionCompat(this, "ParloSession", null, mbrPending).apply {
            setCallback(object : MediaSessionCompat.Callback() {
                // Single tap on most headsets -> play/pause; the compat default handler turns a double tap into onSkipToNext.
                override fun onPlay() = toggleMute()
                override fun onPause() = toggleMute()
                override fun onSkipToNext() = requestRepeatSlowly()
                override fun onSkipToPrevious() = requestRepeatSlowly()
                override fun onStop() = endSession(skipRecap = false)
            })
            setPlaybackState(playbackState(PlaybackStateCompat.STATE_STOPPED))
        }
    }

    private fun playbackState(state: Int) = PlaybackStateCompat.Builder()
        .setActions(
            PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or PlaybackStateCompat.ACTION_PLAY_PAUSE or
                PlaybackStateCompat.ACTION_SKIP_TO_NEXT or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or PlaybackStateCompat.ACTION_STOP,
        )
        .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f)
        .build()

    private fun setPlaybackState(state: Int) { mediaSession?.setPlaybackState(playbackState(state)) }

    // ------------------------------------------------------------------ connectivity

    private fun registerNetworkCallback() {
        connectivity = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (_state.value.isActive) client.nudgeReconnect()
            }
        }
        networkCallback = cb
        runCatching {
            connectivity?.registerNetworkCallback(
                NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(),
                cb,
            )
        }
    }

    // ------------------------------------------------------------------ notification

    private var isForeground = false

    private fun goForeground() {
        val n = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
        isForeground = true
    }

    private fun updateNotification() {
        if (!isForeground) return
        getSystemService(android.app.NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
    }

    private fun buildNotification(): Notification {
        val s = _state.value
        val c = s.config
        val title = "${c.dialect.ifBlank { c.language }} · ${c.level.label}"
        val text = when {
            s.error != null -> s.error.title
            s.statusText.isNotBlank() -> s.statusText
            s.muted -> "Muted"
            else -> "Listening"
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        fun action(action: String, req: Int) = PendingIntent.getService(
            this, req, Intent(this, LiveSessionService::class.java).setAction(action),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, ParloApp.CHANNEL_SESSION)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(0, getString(if (s.muted) R.string.action_unmute else R.string.action_mute), action(ACTION_TOGGLE_MUTE, 1))
            .addAction(0, getString(R.string.action_end), action(ACTION_END, 2))
            .build()
    }

    // ------------------------------------------------------------------ setup

    private fun buildSetup(c: SessionConfig): Setup = LiveSetup.build(c, liveModel, walkMemory)

    companion object {
        private const val TAG = "LiveSessionService"
        const val NOTIFICATION_ID = 1001
        const val ACTION_START = BuildConfig.APPLICATION_ID + ".action.START"
        const val ACTION_TOGGLE_MUTE = BuildConfig.APPLICATION_ID + ".action.TOGGLE_MUTE"
        const val ACTION_END = BuildConfig.APPLICATION_ID + ".action.END"
        const val ACTION_END_NOW = BuildConfig.APPLICATION_ID + ".action.END_NOW"
        private const val RECAP_TIMEOUT_MS = 75_000L
        private const val END_WALK_DELAY_MS = 300L

        private const val EXTRA_ONBOARDING = "onboarding"

        fun startIntent(context: Context, onboarding: Boolean = false) = Intent(context, LiveSessionService::class.java)
            .setAction(ACTION_START).putExtra(EXTRA_ONBOARDING, onboarding)
        fun bindIntent(context: Context) = Intent(context, LiveSessionService::class.java)
    }
}

/** A default dialect is useful for config, but isn't a confirmed onboarding answer. */
internal fun applyProfileUpdate(
    old: SessionConfig,
    previous: LearnerProfile,
    update: ToolHandler.ProfileUpdate,
): Pair<SessionConfig, LearnerProfile> {
    val language = update.language.ifBlank { old.language }
    val languageChanged = update.language.isNotBlank() && !language.equals(previous.language, true)
    val dialect = update.dialect.ifBlank {
        if (!language.equals(old.language, true)) LanguageCatalog.defaultDialectFor(language) else old.dialect
    }
    val profile = previous.copy(
        language = update.language.ifBlank { previous.language },
        dialect = update.dialect.ifBlank { if (languageChanged) "" else previous.dialect },
        goal = update.goal.ifBlank { previous.goal },
        level = update.level?.label ?: if (languageChanged) "" else previous.level,
    )
    val done = profile.language.isNotBlank() && profile.dialect.isNotBlank() && profile.level.isNotBlank()
    return old.copy(
        language = language,
        dialect = dialect,
        level = update.level ?: old.level,
        onboarding = old.onboarding && !done,
    ) to profile
}

/** Gemini sometimes re-emits a whole output transcription around a tool call; keep one copy. */
internal fun collapseRepeat(text: String): String {
    val t = text.trim()
    if (t.length < 2 || t.length % 2 != 0) return text
    val half = t.length / 2
    return if (t.substring(0, half).trim() == t.substring(half).trim()) t.substring(0, half).trim() else text
}
