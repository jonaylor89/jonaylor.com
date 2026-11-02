package com.parlo.app.data

import android.app.Application
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.parlo.app.data.db.ParloDatabase
import com.parlo.app.model.SessionConfig
import com.parlo.app.model.Speaker
import com.parlo.app.uiaudit.KeystoreRunner
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

@RunWith(KeystoreRunner::class)
@Config(sdk = [34], application = Application::class)
class LearningBackupTest {
    private lateinit var db: ParloDatabase
    private lateinit var settings: SettingsRepository
    private lateinit var backup: LearningBackup
    private val password = "a long backup passphrase"

    @Before fun setup() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Application>()
        db = Room.inMemoryDatabaseBuilder(context, ParloDatabase::class.java).allowMainThreadQueries().build()
        settings = SettingsRepository(context)
        settings.saveConfig(SessionConfig(language = "German", followPlan = false))
        backup = LearningBackup(db, settings, Mutex())
    }
    @After fun close() { db.close() }

    private suspend fun seed(): Long {
        val sessions = SessionRepository(db.sessionDao())
        val id = sessions.startSession(SessionConfig(language = "German"), 1000)
        sessions.addTurn(id, Speaker.USER, "Meine private Geschichte", 1001, "German")
        LearningRepository(db).setGoal("German", "Work in Berlin")
        return id
    }
    private suspend fun export(): ByteArray {
        val output = ByteArrayOutputStream()
        backup.export(output, password.toCharArray())
        return output.toByteArray()
    }

    @Test fun `encrypted round trip preserves history goals and language choices but never replaces the API key`() = runBlocking {
        val id = seed()
        settings.setApiKey("original-device-key")
        val bytes = export()
        assertFalse(String(bytes, Charsets.ISO_8859_1).contains("Meine private Geschichte"))
        assertFalse(bytes.contentEquals(export())) // Fresh salt and IV every time.
        db.archiveDao().clearSessions()
        db.archiveDao().clearProfiles()
        settings.saveConfig(SessionConfig(language = "Hungarian"))
        settings.setApiKey("new-device-key")
        val secret = password.toCharArray()
        backup.restore(ByteArrayInputStream(bytes), secret)
        assertTrue(secret.all { it == '\u0000' })
        assertEquals("Meine private Geschichte", db.sessionDao().getTurns(id).single().text)
        assertEquals("Work in Berlin", LearningRepository(db).memory("German").goal)
        assertEquals("German", settings.currentConfig().language)
        assertFalse(settings.currentConfig().followPlan)
        assertEquals("new-device-key", settings.apiKey.value)
    }

    @Test fun `wrong password truncated and tampered archives never clear existing learning data`() = runBlocking {
        val id = seed()
        val bytes = export()
        val tampered = bytes.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        for ((data, pass) in listOf(bytes to "wrong password", tampered to password, bytes.copyOf(bytes.size - 8) to password)) {
            try { backup.restore(ByteArrayInputStream(data), pass.toCharArray()); fail("Must authenticate first") }
            catch (_: Exception) { }
            assertEquals("Meine private Geschichte", db.sessionDao().getTurns(id).single().text)
            assertEquals("German", settings.currentConfig().language)
        }
    }
}
