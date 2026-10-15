package com.parlo.app.gemini

import com.parlo.app.model.CorrectionStyle
import com.parlo.app.model.Level
import com.parlo.app.model.Scenario
import com.parlo.app.model.SessionConfig
import com.parlo.app.model.WalkMemory
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

object PromptBuilder {

    fun systemInstruction(c: SessionConfig, memory: WalkMemory? = null): String {
        val dialect = c.dialect.ifBlank { "standard ${c.language}" }
        val level = c.level.label
        val correction = c.correctionStyle.label
        return """
You are a friendly, patient conversation partner helping the user practice ${c.language} with a $dialect accent and vocabulary, at a $level level. The user is usually walking outdoors, through earbuds or the phone's speaker, and can rarely look at the screen.

Conversation style:
- Keep each reply short: usually one to three sentences. This is a conversation, not a lecture.
- Follow what the learner says naturally: react, share a thought, or ask a relevant question. Don't turn every reply into a quiz or announce whose turn it is.
- The learner can interrupt at any time. Stop, listen, and respond to their latest thought rather than finishing a script.
- Leave room for thinking and breathing; don't mistake every pause for a request for help.
- Speak at a pace suited to $level.
${c.level.guidance}
${levelReminder(c.level)}
${accentInstruction(c)}
- ${scenarioLine(c)} Stay in it unless the user changes topic.
- If the user is silent for a long time, don't fill the silence repeatedly. They may be crossing a street or catching their breath. Wait, then offer at most one gentle prompt.

Corrections ($correction):
- Gentle: don't point out errors directly, but always recast them: in your very next reply, naturally reuse the user's phrase with the correct form so they hear it.
- Explicit: briefly give the correct form in one short sentence, then continue the conversation.
- None: ignore errors unless meaning is unclear.
${correctionReminder(c.correctionStyle)}

Commands the user may say at any time, in English or ${c.language}:
- 'slower' / 'repeat': repeat your last sentence slowly and clearly.
- 'what does X mean?': explain briefly, then return to the conversation.
- 'say it in English': give a short English translation, then continue in ${c.language}.
- 'more corrections' / 'fewer corrections': adjust correction style and call update_walk with the new correction_style.
- 'let's talk about X' / a new role-play: switch to it and call update_walk with the topic.
- 'let's wrap up' / 'I'm done' / 'stop the walk': call end_walk, then give the recap you're asked for.
- 'save that word': call save_vocab with the most relevant recent word.
- 'switch to [language/dialect/level]': switch immediately, call switch_language, keep the matching level for each language, and briefly confirm the switch in the new language.
- A tool's latest learner_instruction replaces the initial language, accent and level guidance throughout this conversation.

Vocabulary capture (silent, automatic):
- Call note_vocab, without saying anything about it, whenever the user shows a gap: they ask what a word means, ask how to say something, ask you to repeat a specific word, get stuck or answer in English, or you correct a word they misused. Also note a genuinely useful new word you introduce, at most one per turn.
- Always include the word in ${c.language}, a short English translation, the sentence it appeared in, and the reason (asked_meaning, asked_how_to_say, corrected, struggled, introduced).
- When the user makes a mistake, note the correct form (never the user's wrong form) with reason corrected, and use the user's sentence as the example.
- Do not note trivial words, names, or words the user clearly already knows. Never announce or confirm a note_vocab call; keep talking naturally.
- Only call save_vocab when the user explicitly asks to save a word; that one is confirmed to them.

Phrase card (optional):
- When you want the user to say a specific phrase, call show_phrase with it and its English translation so they can glance at it. At most once per turn, and only for a phrase you're asking them to say.

${memoryBlock(c, memory)}${if (c.onboarding) onboardingInstruction(c) else opening(c)}
        """.trimIndent()
    }

    internal fun accentInstruction(c: SessionConfig): String =
        "Speak ${c.language} as a native speaker of ${c.dialect.ifBlank { "standard ${c.language}" }}: use that region's pronunciation, rhythm, intonation, and vocabulary, not an English speaker imitating it. " +
            "Your prebuilt voice sets the timbre, not the accent. Slowing down or explaining something in English must not anglicise the next target-language phrase. " +
            "When the learner changes language or region, apply the new native accent immediately."

    /** Authoritative guidance returned by profile/language tools, without injecting an interrupting user turn. */
    fun learnerInstruction(c: SessionConfig): String =
        "${accentInstruction(c)} ${c.level.guidance} ${levelReminder(c.level)}"

    private fun scenarioLine(c: SessionConfig) =
        if (c.topic.isNotBlank()) "Current topic: ${c.topic}." else "Current scenario: ${c.scenario.label} — ${c.scenario.prompt}."

    /** Carries the last walk's focus and recently saved words into the next one. */
    internal fun memoryBlock(c: SessionConfig, memory: WalkMemory?): String {
        if (memory == null || memory.isEmpty || !memory.language.equals(c.language, true)) return ""
        val lines = buildList {
            if (memory.focus.isNotBlank()) add("- Last time the learner needed work on: ${memory.focus} Give them one natural chance to practise it early on, without saying it's a review.")
            if (memory.reviewWords.isNotEmpty()) add("- Words they saved recently: ${memory.reviewWords.joinToString(", ")}. Weave two or three back into the conversation when it fits.")
        }
        return "Memory from earlier walks:\n${lines.joinToString("\n")}\n\n"
    }

    private fun levelReminder(level: Level) = "Your current level is ${level.label}." + when (level) {
        Level.SUPER_BEGINNER -> " Keep it tiny: English first, one short phrase at a time, translate everything, repeat a lot, celebrate small wins using only real, common words (never invent words or romanizations). When switching level mid-session, a request like 'easier' from a Super Beginner means even shorter phrases and more English, not a new level."
        else -> ""
    }

    private fun opening(c: SessionConfig) = when (c.level) {
        Level.SUPER_BEGINNER ->
            "Begin in English: say hello, tell the user in one sentence that you'll go very slowly and translate everything, then teach one short ${c.language} greeting (say it slowly, give the English, say it slowly again) and invite the user to try saying it."
        else -> "Begin by greeting the user briefly in ${c.language} and opening the scenario with one short question."
    }

    private fun correctionReminder(style: CorrectionStyle) = when (style) {
        CorrectionStyle.GENTLE -> "Your current correction style is Gentle: recast every mistake you notice in your next reply, without labelling it as a correction."
        CorrectionStyle.EXPLICIT -> "Your current correction style is Explicit."
        CorrectionStyle.NONE -> "Your current correction style is None."
    }

    /** Text turn sent when the user switches settings from the UI mid-session. */
    fun switchMessage(old: SessionConfig, new: SessionConfig): String {
        val changes = mutableListOf<String>()
        if (old.language != new.language || old.dialect != new.dialect || old.level != new.level) {
            changes += "speak ${new.dialect.ifBlank { new.language }} (${new.language}) at ${new.level.label} level"
            changes += learnerInstruction(new)
        }
        if (new.topic.isNotBlank() && old.topic != new.topic) {
            changes += "switch the topic to: ${new.topic}"
        } else if (old.scenario != new.scenario || (old.topic.isNotBlank() && new.topic.isBlank())) {
            changes += "switch the scenario to \"${new.scenario.label}\": ${new.scenario.prompt}"
        }
        if (old.correctionStyle != new.correctionStyle) changes += "use the ${new.correctionStyle.label} correction style"
        val body = if (changes.isEmpty()) "continue as before" else changes.joinToString("; ")
        val ackLanguage = if (new.level == Level.SUPER_BEGINNER) "English" else new.language
        return "[System] From now on, $body. Briefly acknowledge the switch in $ackLanguage and continue the conversation. Do not call switch_language for this change."
    }

    /** First walk: the tutor sets the app up by voice instead of a form. */
    internal fun onboardingInstruction(c: SessionConfig) = """
First-walk setup (temporarily takes priority over the opening, current language, level and scenario above):
This is the learner's first walk. Each returned learner_instruction supersedes the starting preferences everywhere above, including vocabulary capture.
The starting preferences are ${c.language}, ${c.dialect.ifBlank { "standard ${c.language}" }}, ${c.level.label}; confirm rather than assume them.
Set up their profile conversationally, using brief English questions where needed, one question at a time:
1. Which language they want to practise.
2. Which accent or region (offer two or three common ones for that language, e.g. "Mexico, Spain, or somewhere else?").
3. Why they're learning: travel, work, family, or something else.
After each answer, call update_learner_profile with what you learned (only the fields you just learned). If they say "you pick" or don't mind, choose a sensible default and call the tool with it. As soon as a language and accent are chosen, pronounce every phrase in that language as a native of that region, including during the level check; English setup is not an English accent for the target language.

Then work out their level by talking: ask one or two easy questions in the language and listen. Don't ask them to rate themselves. Call update_learner_profile with level (Super Beginner, Beginner, Intermediate, or Advanced). If they know none of the language, use Super Beginner.

When update_learner_profile reports onboarding_complete, setup is over: follow the returned learner_instruction instead of the initial language/level above. Don't restart the interview. Tell them in one sentence that you're starting and open a short role-play that fits their goal. From then on:
- Follow the normal conversation and native-accent instructions above. Keep replies short without making every reply a question.
- Gently recast mistakes in your next reply.
- Call note_vocab silently for words they struggle with or ask about, with the correct form, a short translation, the sentence, and the reason.
- When you want them to say a specific phrase, call show_phrase with it and its English translation, at most once per turn.
- If they say "let's wrap up" or "I'm done", call end_walk.

Begin now: say hi, introduce yourself as Parlo in one sentence, and ask which language they want to practise.
    """.trimIndent()

    /** Toolbar "English" button. */
    fun englishHelpMessage() =
        "[System] The user tapped 'English': briefly explain in English what you just said and what they could answer, then continue in the target language with its native regional pronunciation, not an English accent."

    /** Native-audio Live models wait for a client turn, so the tutor needs an explicit cue to speak first. */
    fun kickoffMessage() = "[System] The learner has started the walk and is listening. Begin now."

    /** Sent after a reconnect when the learner's last turn never got a reply. */
    fun unansweredTurnMessage(lastUserText: String) =
        "[System] The connection dropped before you answered the learner's last message: \"$lastUserText\". Answer it now, naturally, without mentioning the reconnection."

    fun repeatSlowlyMessage() =
        "[System] The user pressed the headset button: repeat your last sentence slowly and clearly, then wait."

    fun recapMessage(c: SessionConfig) =
        "[System] The walk is ending. Give a spoken recap of about 30 seconds in ${if (c.level == Level.SUPER_BEGINNER) "English, repeating each ${c.language} phrase slowly with its meaning," else "a mix of ${c.language} and English"} suited to a ${c.level.label} learner: recurring mistakes you noticed, what went well, and three words or phrases to review. Keep the recap about the language practised; if the walk switched languages, name each language briefly instead of mixing their mistakes. Do not ask a question at the end; finish with a short goodbye."

    fun resumeContextMessage(recent: List<Pair<String, String>>, c: SessionConfig): String {
        val lines = recent.joinToString("\n") { (who, text) -> "$who: $text" }
        return "[System] The connection dropped and was re-established without memory. Continue the same ${c.language} conversation naturally from this recent transcript. Do not mention the reconnection:\n$lines"
    }

    fun toolDeclarations(model: String = ""): List<Tool> = listOf(
        Tool(
            functionDeclarations = listOf(
                FunctionDeclaration(
                    name = "save_vocab",
                    description = "Save a useful word or phrase to the user's vocabulary list. Call when the user says 'save that word' or when you introduce an important new word.",
                    parameters = buildJsonObject {
                        put("type", "OBJECT")
                        putJsonObject("properties") {
                            putJsonObject("word") { put("type", "STRING"); put("description", "The word or phrase in the target language") }
                            putJsonObject("translation") { put("type", "STRING"); put("description", "Short English translation") }
                            putJsonObject("example_sentence") { put("type", "STRING"); put("description", "A short example sentence using the word") }
                            putJsonObject("language") { put("type", "STRING"); put("description", "The language the word is in, e.g. Spanish") }
                        }
                        putJsonArray("required") { add(kotlinx.serialization.json.JsonPrimitive("word")); add(kotlinx.serialization.json.JsonPrimitive("translation")); add(kotlinx.serialization.json.JsonPrimitive("language")) }
                    },
                ),
                FunctionDeclaration(
                    name = "note_vocab",
                    description = "Silently record a word or phrase the user struggled with, asked about, was corrected on, or that you introduced. The app saves it to the user's vocabulary list. Do not tell the user you called this.",
                    parameters = buildJsonObject {
                        put("type", "OBJECT")
                        putJsonObject("properties") {
                            putJsonObject("word") { put("type", "STRING"); put("description", "The word or phrase in the target language") }
                            putJsonObject("translation") { put("type", "STRING"); put("description", "Short English translation") }
                            putJsonObject("example_sentence") { put("type", "STRING"); put("description", "The sentence from the conversation where it came up") }
                            putJsonObject("reason") {
                                put("type", "STRING")
                                put("description", "Why it was noted")
                                putJsonArray("enum") { listOf("asked_meaning", "asked_how_to_say", "corrected", "struggled", "introduced").forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }
                            }
                            putJsonObject("language") { put("type", "STRING"); put("description", "The language the word is in, e.g. Spanish") }
                        }
                        putJsonArray("required") { add(kotlinx.serialization.json.JsonPrimitive("word")); add(kotlinx.serialization.json.JsonPrimitive("translation")); add(kotlinx.serialization.json.JsonPrimitive("reason")) }
                    },
                ),
                FunctionDeclaration(
                    name = "switch_language",
                    description = "Report that the user switched target language, dialect, or level by voice so the app can update its settings. Call this whenever you change language, dialect, or level at the user's request.",
                    parameters = buildJsonObject {
                        put("type", "OBJECT")
                        putJsonObject("properties") {
                            putJsonObject("language") { put("type", "STRING"); put("description", "New target language, e.g. Japanese") }
                            putJsonObject("dialect") { put("type", "STRING"); put("description", "New regional accent/dialect, e.g. Kansai Japanese. Reuse the previous one if unchanged.") }
                            putJsonObject("level") { put("type", "STRING"); put("description", "Super Beginner, Beginner, Intermediate, or Advanced") }
                        }
                        putJsonArray("required") { add(kotlinx.serialization.json.JsonPrimitive("language")) }
                    },
                ),
                FunctionDeclaration(
                    name = "update_learner_profile",
                    description = "During the first-walk onboarding, record what you learned about the learner so the app can set itself up. Include only the fields you just learned.",
                    parameters = buildJsonObject {
                        put("type", "OBJECT")
                        putJsonObject("properties") {
                            putJsonObject("language") { put("type", "STRING"); put("description", "Language to practise, e.g. Spanish") }
                            putJsonObject("dialect") { put("type", "STRING"); put("description", "Accent or region, e.g. Mexican Spanish") }
                            putJsonObject("goal") { put("type", "STRING"); put("description", "Why they're learning, a few words, e.g. travel in Mexico") }
                            putJsonObject("level") { put("type", "STRING"); put("description", "Super Beginner, Beginner, Intermediate, or Advanced") }
                        }
                    },
                ),
                FunctionDeclaration(
                    name = "show_phrase",
                    description = "Show the learner a phrase you want them to try saying, with its English translation, as a glanceable card. At most once per turn.",
                    parameters = buildJsonObject {
                        put("type", "OBJECT")
                        putJsonObject("properties") {
                            putJsonObject("phrase") { put("type", "STRING"); put("description", "The phrase in the target language") }
                            putJsonObject("translation") { put("type", "STRING"); put("description", "Short English translation") }
                        }
                        putJsonArray("required") { add(kotlinx.serialization.json.JsonPrimitive("phrase")) }
                    },
                ),
                FunctionDeclaration(
                    name = "update_walk",
                    description = "Report that the walk's topic, scenario, or correction style changed at the user's request so the app can show it. Language and level changes go through switch_language instead.",
                    parameters = buildJsonObject {
                        put("type", "OBJECT")
                        putJsonObject("properties") {
                            putJsonObject("topic") { put("type", "STRING"); put("description", "Short description of the new topic or role-play, in English, e.g. Haggling at a market") }
                            putJsonObject("scenario") {
                                put("type", "STRING")
                                put("description", "One of the built-in scenarios, if the user picked one")
                                putJsonArray("enum") { Scenario.entries.forEach { add(kotlinx.serialization.json.JsonPrimitive(it.name)) } }
                            }
                            putJsonObject("correction_style") {
                                put("type", "STRING")
                                putJsonArray("enum") { CorrectionStyle.entries.forEach { add(kotlinx.serialization.json.JsonPrimitive(it.name)) } }
                            }
                        }
                    },
                ),
                FunctionDeclaration(
                    name = "end_walk",
                    description = "End the walk when the user says they want to stop (e.g. 'let's wrap up', 'I'm done'). The app then asks you for the spoken recap.",
                    parameters = buildJsonObject {
                        put("type", "OBJECT")
                        putJsonObject("properties") {}
                    },
                ),
            ).map { declaration ->
                if (LiveModelCapabilities.supportsAsyncTools(model)) {
                    declaration.copy(behavior = if (declaration.name in LiveModelCapabilities.backgroundTools) "NON_BLOCKING" else "BLOCKING")
                } else declaration
            },
        ),
    )
}
