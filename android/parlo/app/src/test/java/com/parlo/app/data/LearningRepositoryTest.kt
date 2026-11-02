package com.parlo.app.data

import android.app.Application
import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.parlo.app.data.db.ParloDatabase
import com.parlo.app.data.db.TurnEntity
import com.parlo.app.gemini.MemoryAnalyzer
import com.parlo.app.model.SessionConfig
import com.parlo.app.model.Speaker
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class LearningRepositoryTest {
    private lateinit var db: ParloDatabase
    private lateinit var context: Context
    private lateinit var learning: LearningRepository
    private val name = "learning-${UUID.randomUUID()}.db"
    private val server = MockWebServer()
    private val analyzer get() = MemoryAnalyzer(OkHttpClient(), server.url("/models").toString().trimEnd('/'), listOf("test"))

    @Before fun setup() {
        context = ApplicationProvider.getApplicationContext()
        open()
        server.start()
    }

    private fun open() {
        db = Room.databaseBuilder(context, ParloDatabase::class.java, name).allowMainThreadQueries().build()
        learning = LearningRepository(db)
    }

    @After fun close() { db.close(); context.deleteDatabase(name); server.shutdown() }

    private suspend fun session(language: String = "German"): Long = SessionRepository(db.sessionDao())
        .startSession(SessionConfig(language = language), 1_700_000_000_000)

    private suspend fun turn(id: Long, text: String, language: String = "German", speaker: Speaker = Speaker.USER) =
        SessionRepository(db.sessionDao()).addTurn(id, speaker, text, 1_700_000_001_000, language)

    private fun analysis(summary: String = "We discussed a job interview.") = MockResponse().setBody(
        """{"candidates":[{"content":{"parts":[{"text":${JsonPrimitive("""{"summary":${JsonPrimitive(summary)},"demonstrated":"Asked a question independently.","practise":"Try a follow-up question later.","nextStep":"Continue the interview role-play."}""")}}]}}]}""",
    )

    @Test fun `history and preferences survive database reopening without a model connection`() = runBlocking {
        val id = session()
        turn(id, "Ich bereite mich auf ein Vorstellungsgespräch vor.")
        learning.setGoal("GERMAN", "Interview confidently")
        db.close()
        open()
        val memory = learning.memory("German")
        assertTrue(memory.returning)
        assertEquals("Interview confidently", memory.goal)
        assertTrue(memory.recentConversation.single().contains("Vorstellungsgespräch"))
        assertTrue(learning.search("German", "Vorstellungsgespräch").single().contains("session $id"))
        assertFalse(learning.memory("Hungarian").returning)
        assertEquals("", learning.memory("Hungarian").goal)
    }

    @Test fun `multilingual turns are consolidated independently with idempotent source cursors`() = runBlocking {
        val id = session("Spanish")
        turn(id, "Guten Morgen", "German")
        turn(id, "Jó reggelt", "Hungarian")
        assertEquals(setOf("German", "Hungarian"), db.sessionDao().observeLanguageSessions().first().map { it.language }.toSet())
        server.enqueue(analysis("German morning greeting."))
        server.enqueue(analysis("Hungarian morning greeting."))
        learning.consolidate(id, "key", analyzer)
        learning.consolidate(id, "key", analyzer)
        assertEquals(2, server.requestCount)
        val german = db.learningDao().recent("german", 10).single()
        val hungarian = db.learningDao().recent("hungarian", 10).single()
        assertEquals(german.fromTurnId, german.throughTurnId)
        assertTrue(hungarian.fromTurnId > german.throughTurnId)
        assertTrue(learning.search("German", "Guten").isNotEmpty())
        assertTrue(learning.search("Spanish", "Guten").isEmpty())
        assertFalse(learning.memory("German").episodes.single().contains("Hungarian"))
    }

    @Test fun `consolidation retries malformed output without losing original evidence`() = runBlocking {
        val id = session()
        turn(id, "Ich hätte gern einen Kaffee.")
        server.enqueue(MockResponse().setBody("""{"candidates":[]}"""))
        try { learning.consolidate(id, "key", analyzer); fail("Expected retryable failure") } catch (_: IllegalStateException) { }
        assertEquals(0L, db.learningDao().cursor(id, "german"))
        assertEquals(1, db.sessionDao().getTurns(id).size)
        server.enqueue(analysis())
        learning.consolidate(id, "key", analyzer)
        assertTrue(db.learningDao().cursor(id, "german") > 0)
        assertEquals(1, db.learningDao().recent("german", 10).size)
    }

    @Test fun `chunks have bounded original input and do not recursively summarise summaries`() = runBlocking {
        val id = session()
        repeat(25) { turn(id, "Original sentence $it") }
        server.enqueue(analysis("Checkpoint one"))
        server.enqueue(analysis("Checkpoint two"))
        learning.consolidate(id, "key", analyzer)
        val first = server.takeRequest().body.readUtf8()
        val second = server.takeRequest().body.readUtf8()
        assertTrue(first.contains("Original sentence 19"))
        assertFalse(first.contains("Original sentence 20"))
        assertTrue(second.contains("Original sentence 20"))
        assertFalse(second.contains("Checkpoint one"))
        assertEquals(2, db.learningDao().recent("german", 10).size)
    }

    @Test fun `forget wins against an in-flight analysis and suppresses retrieval and backfill`() = runBlocking {
        val id = session()
        turn(id, "My private interview story")
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                runBlocking { learning.forgetSession(id) }
                return analysis()
            }
        }
        learning.consolidate(id, "key", analyzer)
        assertTrue(db.learningDao().recent("german", 10).isEmpty())
        assertTrue(learning.search("German", "interview").isEmpty())
        assertTrue(learning.memory("German").recentConversation.isEmpty())
        assertTrue(db.sessionDao().pendingMemory(10).isEmpty())
        learning.consolidate(id, "key", analyzer)
        assertEquals(1, server.requestCount)
        assertEquals(1, db.sessionDao().getTurns(id).size) // Exclusion isn't transcript deletion.
    }

    @Test fun `deleting a conversation cascades its derived memories`() = runBlocking {
        val id = session()
        turn(id, "Ich gehe nach Hause")
        server.enqueue(analysis())
        learning.consolidate(id, "key", analyzer)
        assertEquals(1, db.learningDao().recent("german", 10).size)
        db.sessionDao().deleteSession(id)
        assertTrue(db.learningDao().recent("german", 10).isEmpty())
        assertTrue(db.sessionDao().getTurns(id).isEmpty())
    }

    @Test fun `search treats SQL wildcard characters literally and respects a fixed result budget`() = runBlocking {
        val id = session()
        turn(id, "The sign says 50% off")
        turn(id, "some unrelated text")
        assertTrue(learning.search("German", "50%").single().contains("50%"))
        assertTrue(learning.search("German", "__").isEmpty())
        repeat(10) { turn(id, "interview $it") }
        assertEquals(6, learning.search("German", "interview").size)
        assertTrue(learning.search("German", "x").isEmpty())
    }

    @Test fun `custom language backfill does not loop because SQLite lower only folds ASCII`() = runBlocking {
        val id = session("Íslenska")
        turn(id, "Góðan daginn", "Íslenska")
        assertEquals(listOf(id), db.sessionDao().pendingMemory(10))
        server.enqueue(analysis())
        learning.consolidate(id, "key", analyzer)
        // Unfinished session has no vocabulary-review job; its checkpoint should fully drain it.
        assertTrue(db.sessionDao().pendingMemory(10).isEmpty())
    }

    @Test fun `history excerpts include the actual match even at the end of a long turn`() = runBlocking {
        val id = session()
        turn(id, "Anfang ".repeat(500) + "Vorstellungsgespräch")
        val result = learning.search("German", "Vorstellungsgespräch").single()
        assertTrue(result.contains("Vorstellungsgespräch"))
        assertTrue(result.length < 1000)
    }

    @Test fun `process recovery closes an interrupted walk at its last evidence not the next launch time`() = runBlocking {
        val id = session()
        turn(id, "We were discussing my weekend")
        db.sessionDao().recoverInterrupted()
        val recovered = db.sessionDao().getSession(id)!!
        assertTrue(recovered.interrupted)
        assertEquals(1_700_000_001_000L, recovered.endedAt)
        assertEquals(1000L, recovered.durationMs)
        assertEquals(listOf(id), db.sessionDao().pendingMemory(10))
        assertTrue(learning.memory("German").returning)
        db.sessionDao().recoverInterrupted()
        assertEquals(recovered, db.sessionDao().getSession(id))
    }

    @Test fun `explicit retrieval ratings persist and only due words enter the tutor context`() = runBlocking {
        val id = session()
        val wordId = db.vocabDao().insert(com.parlo.app.data.db.VocabEntity(word = "Kaffee", translation = "coffee", exampleSentence = "", language = "German", savedAt = 1, sessionId = id))
        assertEquals(listOf("Kaffee"), learning.memory("German").reviewWords)
        val now = System.currentTimeMillis()
        learning.recordReview(wordId, true, now)
        assertTrue(learning.memory("German").reviewWords.isEmpty())
        db.close(); open()
        val saved = db.learningDao().vocabItem(wordId)!!
        assertEquals(now + com.parlo.app.model.RetrievalSchedule.DAY, saved.nextReviewAt)
        assertEquals(0, saved.reviewStage)
        learning.forgetSession(id)
        assertTrue(db.learningDao().dueWords("German", Long.MAX_VALUE, 6).isEmpty())
    }

    @Test fun `v3 migration preserves transcripts vocabulary and review then backfills memory`() = runBlocking {
        db.close()
        context.deleteDatabase(name)
        val resource = javaClass.getResource("/com.parlo.app.data.db.ParloDatabase/3.json")!!
        val schema = Json.parseToJsonElement(resource.readText()).jsonObject["database"]!!.jsonObject
        context.openOrCreateDatabase(name, Context.MODE_PRIVATE, null).use { old ->
            for (entity in schema["entities"]!!.jsonArray) {
                val e = entity.jsonObject
                val table = e["tableName"]!!.jsonPrimitive.content
                old.execSQL(e["createSql"]!!.jsonPrimitive.content.replace("\${TABLE_NAME}", table))
                for (index in e["indices"]!!.jsonArray) {
                    old.execSQL(index.jsonObject["createSql"]!!.jsonPrimitive.content.replace("\${TABLE_NAME}", table))
                }
            }
            for (query in schema["setupQueries"]!!.jsonArray) old.execSQL(query.jsonPrimitive.content)
            old.execSQL("INSERT INTO sessions (id, startedAt, endedAt, language, dialect, level, scenario, correctionStyle, durationMs, recap, focus) VALUES (1, 1000, 2000, 'German', 'Standard German', 'BEGINNER', 'FREE', 'GENTLE', 1000, 'Nice walk', 'Ask follow-up questions')")
            old.execSQL("INSERT INTO turns (id, sessionId, speaker, text, timestamp) VALUES (1, 1, 'USER', 'Ich möchte einen Kaffee', 1001)")
            old.execSQL("INSERT INTO vocab (id, word, translation, exampleSentence, language, savedAt, sessionId, source, status, reason) VALUES (1, 'Kaffee', 'coffee', '', 'German', 1001, 1, 'MANUAL', 'KEPT', '')")
            old.version = 3
        }
        open()
        assertEquals("Nice walk", db.sessionDao().getSession(1)!!.recap)
        assertTrue(db.sessionDao().getSession(1)!!.remember)
        assertEquals("", db.sessionDao().getTurns(1).single().language)
        assertEquals("Kaffee", db.vocabDao().find("German", "Kaffee")!!.word)
        assertEquals(listOf(1L), db.sessionDao().pendingMemory(10))
        server.enqueue(analysis())
        learning.consolidate(1, "key", analyzer)
        assertTrue(learning.memory("German").returning)
        assertEquals(1, db.learningDao().recent("german", 10).size)
    }
}
