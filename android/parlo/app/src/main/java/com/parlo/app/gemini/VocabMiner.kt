package com.parlo.app.gemini

import com.parlo.app.model.Level
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

@Serializable
data class MinedWord(
    val word: String,
    val translation: String = "",
    val example: String = "",
    val reason: String = "",
)

/** Post-walk review: the words to keep, one thing to work on, and the tutor's suggested next walk. */
data class WalkReview(
    val words: List<MinedWord> = emptyList(),
    val focus: String = "",
    val nextWalkTitle: String = "",
    val nextWalkPrompt: String = "",
)

/**
 * Post-walk pass: sends the finished transcript to a text model (`generateContent`, JSON mode) and asks
 * for the words the learner did not know. Pure network + parsing; persistence lives in VocabCapture.
 */
class VocabMiner(
    private val client: OkHttpClient,
    private val baseUrl: String = GeminiApi.MODELS_URL,
    private val models: List<String> = DEFAULT_MODELS,
) {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /**
     * @param transcript (speaker label, text) pairs in order; speakers are "user" / "tutor".
     * @param knownWords words already in the vocab list for this language, excluded from results.
     */
    fun mine(
        apiKey: String,
        language: String,
        level: Level,
        transcript: List<Pair<String, String>>,
        knownWords: List<String>,
        maxWords: Int = 6,
    ): List<MinedWord> = review(apiKey, language, level, transcript, knownWords, maxWords).words

    fun review(
        apiKey: String,
        language: String,
        level: Level,
        transcript: List<Pair<String, String>>,
        knownWords: List<String>,
        maxWords: Int = 6,
    ): WalkReview {
        if (transcript.none { it.first.equals("user", true) }) return WalkReview()
        val body = requestBody(language, level, transcript, knownWords, maxWords).toString()
        var lastError: Exception? = null
        for (model in models) {
            val url = "$baseUrl/$model:generateContent?key=$apiKey"
            val resp = client.newCall(Request.Builder().url(url).post(body.toRequestBody(JSON_MEDIA)).build()).execute()
            val text = resp.body?.string().orEmpty()
            when {
                resp.isSuccessful -> return parseReview(text, knownWords, maxWords)
                resp.code == 404 -> { lastError = IllegalStateException(GeminiApi.describeHttpError(404, text)); continue }
                else -> throw IllegalStateException(GeminiApi.describeHttpError(resp.code, text))
            }
        }
        throw lastError ?: IllegalStateException("No text model available")
    }

    internal fun requestBody(
        language: String,
        level: Level,
        transcript: List<Pair<String, String>>,
        knownWords: List<String>,
        maxWords: Int,
    ): JsonObject {
        val lines = transcript.joinToString("\n") { (who, text) -> "${who.uppercase()}: $text" }
        val known = if (knownWords.isEmpty()) "none" else knownWords.joinToString(", ")
        val prompt = """
You are reviewing a transcript of a spoken $language practice conversation between a learner (USER) and a tutor (TUTOR). The learner is at ${level.label} level.

Find the $language words and short phrases the learner most likely did NOT know or could not produce. Strong signals: the learner asked what something means or how to say something, the tutor translated or explained a word, the tutor corrected the learner, the learner answered in English or stalled after the tutor used a word, or the tutor introduced a new useful expression.

Rules:
- Return at most $maxWords items, most useful first. Fewer is fine; zero is fine if nothing stands out.
- Skip proper names, numbers, filler words, and anything below the learner's level that they used correctly themselves.
- Only include items the learner personally struggled with or was explicitly taught. Never include a word just because the tutor said it, and skip greetings and stock phrases such as thanks, done, or nice to meet you.
- Each item is a single word or a short collocation of at most three words, never a full sentence.
- If the learner said something in English, only include the $language word they were missing, not a translation of their whole sentence.
- Skip these words the learner already has saved: $known
- "word" is in $language (dictionary form), "translation" is short English, "example" is the actual sentence from the transcript (or a very short natural one), "reason" is one of: asked_meaning, asked_how_to_say, corrected, struggled, introduced.

Also return:
- "focus": one short English sentence naming the single most useful thing for the learner to work on next time, based only on what actually happened in this transcript (for example a mistake they repeated). Empty if nothing stands out.
- "next_walk": a suggestion for the next walk that builds on this one, in English: "title" (at most six words, e.g. "Ordering tapas at a bar") and "prompt" (one sentence telling the tutor which topic or role-play to run and what to practise).

Transcript:
$lines
        """.trimIndent()

        return buildJsonObject {
            putJsonArray("contents") {
                add(buildJsonObject {
                    put("role", "user")
                    putJsonArray("parts") { add(buildJsonObject { put("text", prompt) }) }
                })
            }
            putJsonObject("generationConfig") {
                put("temperature", 0.2)
                put("responseMimeType", "application/json")
                putJsonObject("responseSchema") {
                    put("type", "OBJECT")
                    putJsonObject("properties") {
                        putJsonObject("words") {
                            put("type", "ARRAY")
                            putJsonObject("items") {
                                put("type", "OBJECT")
                                putJsonObject("properties") {
                                    putJsonObject("word") { put("type", "STRING") }
                                    putJsonObject("translation") { put("type", "STRING") }
                                    putJsonObject("example") { put("type", "STRING") }
                                    putJsonObject("reason") { put("type", "STRING") }
                                }
                                putJsonArray("required") { add(kotlinx.serialization.json.JsonPrimitive("word")); add(kotlinx.serialization.json.JsonPrimitive("translation")) }
                            }
                        }
                        putJsonObject("focus") { put("type", "STRING") }
                        putJsonObject("next_walk") {
                            put("type", "OBJECT")
                            putJsonObject("properties") {
                                putJsonObject("title") { put("type", "STRING") }
                                putJsonObject("prompt") { put("type", "STRING") }
                            }
                        }
                    }
                    putJsonArray("required") { add(kotlinx.serialization.json.JsonPrimitive("words")) }
                }
            }
        }
    }

    internal fun parse(responseBody: String, knownWords: List<String>, maxWords: Int): List<MinedWord> =
        parseReview(responseBody, knownWords, maxWords).words

    /** Accepts the review object, or a bare word array from older responses. */
    internal fun parseReview(responseBody: String, knownWords: List<String>, maxWords: Int): WalkReview {
        val root = json.parseToJsonElement(responseBody).jsonObject
        val text = root["candidates"]?.jsonArray?.firstOrNull()?.jsonObject
            ?.get("content")?.jsonObject?.get("parts")?.jsonArray
            ?.mapNotNull { it.jsonObject["text"]?.jsonPrimitive?.content }
            ?.joinToString("")
            ?.trim()
            .orEmpty()
        if (text.isEmpty()) return WalkReview()
        val element = runCatching { json.parseToJsonElement(stripFences(text)) }.getOrElse { return WalkReview() }
        val obj = element as? JsonObject
        val array: JsonArray = (if (obj != null) obj["words"] as? JsonArray else element as? JsonArray) ?: JsonArray(emptyList())
        val next = obj?.get("next_walk") as? JsonObject
        return WalkReview(
            words = words(array, knownWords, maxWords),
            focus = obj.text("focus"),
            nextWalkTitle = next.text("title"),
            nextWalkPrompt = next.text("prompt"),
        )
    }

    private fun JsonObject?.text(key: String): String =
        runCatching { this?.get(key)?.jsonPrimitive?.content }.getOrNull()?.trim().orEmpty()

    private fun words(array: JsonArray, knownWords: List<String>, maxWords: Int): List<MinedWord> {
        val known = knownWords.map { it.trim().lowercase() }.toSet()
        return array.mapNotNull { runCatching { json.decodeFromJsonElement(MinedWord.serializer(), it) }.getOrNull() }
            .map { it.copy(word = it.word.trim(), translation = it.translation.trim(), example = it.example.trim(), reason = it.reason.trim()) }
            .filter { it.word.isNotBlank() && it.word.lowercase() !in known }
            .distinctBy { it.word.lowercase() }
            .take(maxWords)
    }

    private fun stripFences(s: String): String =
        s.removePrefix("```json").removePrefix("```").removeSuffix("```").trim()

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
        val DEFAULT_MODELS = listOf("gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest")
    }
}
