package com.parlo.app.data

import androidx.room.withTransaction
import com.parlo.app.data.db.LearnerProfileEntity
import com.parlo.app.data.db.LearningEpisodeEntity
import com.parlo.app.data.db.ParloDatabase
import com.parlo.app.data.db.SessionEntity
import com.parlo.app.data.db.TurnEntity
import com.parlo.app.data.db.VocabEntity
import com.parlo.app.model.SessionConfig
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromStream
import kotlinx.serialization.json.encodeToStream
import java.io.DataInputStream
import java.io.InputStream
import java.io.OutputStream
import java.security.SecureRandom
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import javax.crypto.Cipher
import javax.crypto.CipherInputStream
import javax.crypto.CipherOutputStream
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

@Serializable
private data class LearningArchive(
    val format: Int = 1,
    val config: SessionConfig,
    val languages: List<SessionConfig>,
    val sessions: List<SessionEntity>,
    val turns: List<TurnEntity>,
    val vocab: List<VocabEntity>,
    val profiles: List<LearnerProfileEntity>,
    val episodes: List<LearningEpisodeEntity>,
)

/** Password-encrypted logical backup. No API key, Android keystore or model resumption handle. */
@OptIn(ExperimentalSerializationApi::class)
class LearningBackup(
    private val db: ParloDatabase,
    private val settings: SettingsRepository,
    private val maintenance: Mutex,
    private val gate: LearningDataGate = LearningDataGate(),
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    suspend fun export(output: OutputStream, password: CharArray) {
        var acquired = false
        try {
            gate.beginArchive(); acquired = true
            require(password.size >= 12) { "Use a backup password of at least 12 characters" }
            maintenance.withLock {
                val config = settings.currentConfig().copy(onboarding = false)
                val languages = settings.languageConfigs.first()
                val archive = db.withTransaction {
                    val dao = db.archiveDao()
                    LearningArchive(config = config, languages = languages, sessions = dao.sessions(),
                        turns = dao.turns(), vocab = dao.vocab(), profiles = dao.profiles(), episodes = dao.episodes())
                }
                val random = SecureRandom()
                val salt = ByteArray(16).also(random::nextBytes)
                val iv = ByteArray(12).also(random::nextBytes)
                output.write(MAGIC); output.write(salt); output.write(iv)
                CipherOutputStream(output, cipher(Cipher.ENCRYPT_MODE, password, salt, iv)).use { encrypted ->
                    GZIPOutputStream(encrypted).use { compressed ->
                        json.encodeToStream(archive, LimitedOutput(compressed))
                    }
                }
            }
        } finally { if (acquired) gate.endArchive(); password.fill('\u0000') }
    }

    /** Authenticate and validate the entire archive BEFORE touching data. Import replaces all learning data. */
    suspend fun restore(input: InputStream, password: CharArray) {
        var acquired = false
        try {
            gate.beginArchive(); acquired = true
            val header = DataInputStream(LimitedInput(input, MAX_BYTES + 1024 * 1024))
            val magic = ByteArray(MAGIC.size).also(header::readFully)
            require(magic.contentEquals(MAGIC)) { "Not a supported Parlo backup" }
            val salt = ByteArray(16).also(header::readFully)
            val iv = ByteArray(12).also(header::readFully)
            val archive = CipherInputStream(header, cipher(Cipher.DECRYPT_MODE, password, salt, iv)).use { decrypted ->
                val compressed = GZIPInputStream(decrypted)
                try {
                    val limited = LimitedInput(compressed)
                    val result = json.decodeFromStream<LearningArchive>(limited)
                    check(limited.read() == -1) { "Unexpected backup content" }
                    // Force GCM tag verification even if the JSON/GZIP reader stopped before ciphertext EOF.
                    val buffer = ByteArray(4096)
                    while (decrypted.read(buffer) != -1) { /* authenticate remaining ciphertext */ }
                    result
                } finally { compressed.close() }
            }
            require(archive.format == 1) { "This backup needs a newer version of Parlo" }
            require(archive.sessions.all { it.id > 0 } && archive.turns.all { it.id > 0 }) { "Invalid backup IDs" }
            maintenance.withLock {
                db.withTransaction {
                    val dao = db.archiveDao()
                    dao.clearSessions() // Cascades turns and derived memory.
                    dao.clearVocab(); dao.clearProfiles()
                    dao.insertSessions(archive.sessions)
                    dao.insertTurns(archive.turns)
                    dao.insertVocab(archive.vocab)
                    dao.insertProfiles(archive.profiles)
                    dao.insertEpisodes(archive.episodes)
                }
                settings.replaceLanguageConfigs(archive.config, archive.languages)
            }
        } finally { if (acquired) gate.endArchive(); password.fill('\u0000') }
    }

    private fun cipher(mode: Int, password: CharArray, salt: ByteArray, iv: ByteArray): Cipher {
        val spec = PBEKeySpec(password, salt, 210_000, 256)
        val key = try { SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded }
            finally { spec.clearPassword() }
        return try {
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
                updateAAD(MAGIC)
            }
        } finally { key.fill(0) }
    }

    private class LimitedInput(private val source: InputStream, private val maximum: Long = MAX_BYTES) : InputStream() {
        private var count = 0L
        override fun read(): Int = source.read().also { if (it != -1) consume(1) }
        override fun close() = source.close()
        override fun read(b: ByteArray, off: Int, len: Int): Int = source.read(b, off, len).also { if (it > 0) consume(it) }
        private fun consume(n: Int) { count += n; check(count <= maximum) { "Backup exceeds the 32 MB safety limit" } }
    }

    private class LimitedOutput(private val target: OutputStream) : OutputStream() {
        private var count = 0L
        override fun write(b: Int) { consume(1); target.write(b) }
        override fun write(b: ByteArray, off: Int, len: Int) { consume(len); target.write(b, off, len) }
        private fun consume(n: Int) { count += n; check(count <= MAX_BYTES) { "Backup exceeds the 32 MB safety limit" } }
    }

    companion object {
        private val MAGIC = "PARLO01".toByteArray(Charsets.US_ASCII)
        private const val MAX_BYTES = 32 * 1024 * 1024L
    }
}
