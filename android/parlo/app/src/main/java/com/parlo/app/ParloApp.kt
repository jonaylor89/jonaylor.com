package com.parlo.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.room.withTransaction
import androidx.work.Configuration
import com.parlo.app.data.LearningBackup
import com.parlo.app.data.LearningDataGate
import com.parlo.app.data.LearningRepository
import com.parlo.app.data.LearningWorker
import com.parlo.app.data.LiveModelDiscovery
import com.parlo.app.data.ModelRepository
import com.parlo.app.data.SessionRepository
import com.parlo.app.data.SettingsRepository
import com.parlo.app.data.VocabCapture
import com.parlo.app.data.VocabRepository
import com.parlo.app.data.db.ParloDatabase
import com.parlo.app.gemini.MemoryAnalyzer
import com.parlo.app.gemini.VocabMiner
import com.parlo.app.model.CorrectionStyle
import com.parlo.app.model.Level
import com.parlo.app.gemini.VoiceSampler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import com.parlo.app.model.LiveSessionState
import com.parlo.app.widget.WidgetData
import com.parlo.app.widget.WidgetDataBuilder
import com.parlo.app.widget.WidgetUpdater
import okhttp3.OkHttpClient
import java.util.Locale
import java.util.concurrent.TimeUnit

/** Simple manual DI: one graph, lazily built, shared by Activity, ViewModel and Service. */
class AppContainer(context: Context) {
    val okHttp: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .build()
    val db: ParloDatabase = ParloDatabase.build(context)
    val settings = SettingsRepository(context)
    val sessions = SessionRepository(db.sessionDao())
    val vocab = VocabRepository(db.vocabDao())
    val learning = LearningRepository(db)
    val memoryAnalyzer = MemoryAnalyzer(okHttp.newBuilder().readTimeout(60, TimeUnit.SECONDS).build())
    val models = ModelRepository(settings, LiveModelDiscovery(okHttp))
    /** Application-scope state and ordered turn writes; durable analysis is owned by WorkManager. */
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val voiceSampler = VoiceSampler(okHttp.newBuilder().readTimeout(30, TimeUnit.SECONDS).build())
    val vocabCapture = VocabCapture(
        sessions, vocab, settings,
        VocabMiner(okHttp.newBuilder().readTimeout(60, TimeUnit.SECONDS).build()),
        appScope, learning.maintenance,
    )
    val learningDataGate = LearningDataGate()
    val learningBackup = LearningBackup(db, settings, learning.maintenance, learningDataGate)
    /** Runs once per process; workers and service startup await it so live walks aren't misclassified. */
    val recovery = appScope.async {
        db.withTransaction {
            sessions.cleanupEmpty()
            db.sessionDao().recoverInterrupted()
        }
        val defaults = settings.currentConfig()
        val previous = sessions.observeSessions().first().distinctBy { it.language.lowercase(Locale.ROOT) }
        settings.seedLanguages(previous.map { session ->
            defaults.copy(
                language = session.language, dialect = session.dialect,
                level = Level.parse(session.level),
                correctionStyle = CorrectionStyle.parse(session.correctionStyle),
                topic = "", topicTitle = "", followPlan = true,
            )
        })
    }

    /** Mirror of the walk service's state, so widgets can show a running walk. */
    val liveWalk = MutableStateFlow(LiveSessionState())
    val widgetData: StateFlow<WidgetData> = combine(
        combine(sessions.observeSessions(), vocab.observeAll(), ::Pair),
        liveWalk.map(WidgetDataBuilder::liveWalk).distinctUntilChanged().map { liveWalk.value },
        settings.config,
        combine(settings.apiKey, settings.cachedModels, settings.dynamicColor, ::Triple),
    ) { (s, v), live, cfg, (key, models, dynamic) ->
        WidgetDataBuilder.build(s, v, live, cfg.language, key.isNotBlank(), models.isNotEmpty() || cfg.model.isNotBlank(), dynamic)
    }.stateIn(appScope, SharingStarted.Eagerly, WidgetData())
}

class ParloApp : Application(), Configuration.Provider {
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().build()

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        createChannels()
        WidgetUpdater.start(this, container.widgetData, container.appScope)
        LearningWorker.enqueue(this)
    }

    private fun createChannels() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_SESSION,
                getString(R.string.notification_channel_session),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = getString(R.string.notification_channel_session_desc)
                setSound(null, null)
                enableVibration(false)
            },
        )
    }

    companion object {
        const val CHANNEL_SESSION = "walk_session"
        fun container(context: Context): AppContainer = (context.applicationContext as ParloApp).container
    }
}
