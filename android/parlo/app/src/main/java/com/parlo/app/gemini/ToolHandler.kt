package com.parlo.app.gemini

import com.parlo.app.data.VocabCapture
import com.parlo.app.data.VocabRepository
import com.parlo.app.data.db.VocabSource
import com.parlo.app.model.CorrectionStyle
import com.parlo.app.model.LanguageCatalog
import com.parlo.app.model.LanguageCombo
import com.parlo.app.model.Level
import com.parlo.app.model.Scenario
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** Executes the Live tools (vocab, language switch, walk updates, end of walk) locally and produces the `toolResponse` payloads. */
class ToolHandler(
    private val vocab: VocabRepository,
    private val currentLanguage: () -> String,
    private val currentDialect: () -> String,
    private val currentLevel: () -> Level,
    private val sessionId: () -> Long?,
    private val onVocabSaved: suspend (word: String) -> Unit,
    private val onLanguageSwitched: suspend (LanguageCombo) -> Unit,
    private val onVocabNoted: suspend (word: String) -> Unit = {},
    private val onWalkUpdated: suspend (WalkUpdate) -> Unit = {},
    private val onEndWalk: suspend () -> Unit = {},
) {
    /** Fields the tutor changed by voice; null / blank means unchanged. */
    data class WalkUpdate(val topic: String = "", val scenario: Scenario? = null, val correctionStyle: CorrectionStyle? = null)

    suspend fun handle(call: FunctionCall): FunctionResponse {
        val args = call.args ?: JsonObject(emptyMap())
        val response: JsonObject = when (call.name) {
            "save_vocab" -> saveVocab(args)
            "note_vocab" -> noteVocab(args)
            "switch_language" -> switchLanguage(args)
            "update_walk" -> updateWalk(args)
            "end_walk" -> endWalk()
            else -> buildJsonObject { put("error", "unknown function ${call.name}") }
        }
        return FunctionResponse(id = call.id, name = call.name, response = response)
    }

    private suspend fun saveVocab(args: JsonObject): JsonObject {
        val word = args.str("word")
        if (word.isBlank()) return buildJsonObject { put("error", "word is required") }
        val id = vocab.save(
            word = word,
            translation = args.str("translation"),
            example = args.str("example_sentence"),
            language = args.str("language").ifBlank { currentLanguage() },
            sessionId = sessionId(),
        )
        onVocabSaved(word)
        return buildJsonObject { put("result", "saved"); put("id", id) }
    }

    /** Silent capture: saved to the list (droppable from the recap), no earcon, and the model is told not to mention it. */
    private suspend fun noteVocab(args: JsonObject): JsonObject {
        val word = args.str("word")
        if (word.isBlank()) return buildJsonObject { put("error", "word is required") }
        val id = vocab.capture(
            word = word,
            translation = args.str("translation"),
            example = args.str("example_sentence"),
            language = args.str("language").ifBlank { currentLanguage() },
            sessionId = sessionId(),
            source = VocabSource.TUTOR,
            reason = VocabCapture.reasonLabel(args.str("reason")),
        )
        if (id != null) onVocabNoted(word)
        return buildJsonObject {
            put("result", if (id != null) "noted" else "already_known")
            put("note", "Do not mention this to the user; continue the conversation.")
        }
    }

    private suspend fun switchLanguage(args: JsonObject): JsonObject {
        val language = LanguageCatalog.canonicalName(args.str("language").ifBlank { currentLanguage() })
        val dialectArg = args.str("dialect")
        val dialect = when {
            dialectArg.isNotBlank() -> LanguageCatalog.canonicalDialect(language, dialectArg)
            language.equals(currentLanguage(), true) -> currentDialect()
            else -> LanguageCatalog.defaultDialectFor(language)
        }
        val levelArg = args.str("level")
        val level = if (levelArg.isBlank()) currentLevel() else Level.parse(levelArg)
        val combo = LanguageCombo(language, dialect, level)
        onLanguageSwitched(combo)
        return buildJsonObject {
            put("result", "ok")
            put("language", language); put("dialect", dialect); put("level", level.label)
        }
    }

    private suspend fun updateWalk(args: JsonObject): JsonObject {
        val update = WalkUpdate(
            topic = args.str("topic"),
            scenario = args.str("scenario").takeIf { it.isNotBlank() }?.let { s -> Scenario.entries.firstOrNull { it.name.equals(s, true) } },
            correctionStyle = args.str("correction_style").takeIf { it.isNotBlank() }?.let { s -> CorrectionStyle.entries.firstOrNull { it.name.equals(s, true) } },
        )
        if (update == WalkUpdate()) return buildJsonObject { put("error", "nothing to update") }
        onWalkUpdated(update)
        return buildJsonObject { put("result", "ok") }
    }

    private suspend fun endWalk(): JsonObject {
        onEndWalk()
        return buildJsonObject {
            put("result", "ending")
            put("note", "The app will ask you for the recap next; don't say goodbye yet.")
        }
    }

    private fun JsonObject.str(key: String): String =
        runCatching { this[key]?.jsonPrimitive?.content }.getOrNull()?.trim().orEmpty()
}
