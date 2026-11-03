package com.parlo.app.model

import kotlinx.serialization.Serializable

/** A global coaching preference, independent of language level and correction frequency. */
@Serializable
enum class Encouragement(val label: String, val description: String, val instruction: String, val example: String) {
    MATTER_OF_FACT(
        "Matter-of-fact", "Straight to the point. No praise or pep talks.",
        "Give concise, factual feedback and move straight to the next useful step. Do not add praise, motivational language, pep talks or celebratory reactions. Remain patient and respectful.",
        "Use the past tense here. Now tell me where you went.",
    ),
    LOW_KEY(
        "Low-key", "Rare, specific acknowledgement. Mostly get on with practice.",
        "Avoid routine praise. Occasionally acknowledge a specific, meaningful improvement in a few words, then continue. Do not reward every answer or repetition with encouragement.",
        "That past tense was accurate. What happened next?",
    ),
    BALANCED(
        "Balanced", "Occasional encouragement for meaningful progress.",
        "Offer occasional, brief encouragement tied to observed progress or effort, not after every answer. Keep factual feedback and forward momentum more prominent than praise.",
        "You used that without a prompt. Try it in a different situation.",
    ),
    WARM(
        "Warm", "More reassurance, while keeping the conversation moving.",
        "Use warm, brief and specific encouragement fairly often, especially after genuine progress or a difficult attempt. Keep it proportionate and move on to useful practice in the same reply.",
        "That is becoming more natural. Now ask a follow-up question.",
    ),
    VERY_ENCOURAGING(
        "Very encouraging", "Frequent support and reassurance, still adult-to-adult.",
        "Be upbeat and offer frequent, specific reassurance when the learner is struggling and encouragement for evidenced progress. Never let encouragement replace useful feedback or the next activity.",
        "You are getting more comfortable with that pattern. Let's use it in a new context.",
    );

    companion object {
        fun parseOrNull(value: String?): Encouragement? = entries.firstOrNull {
            it.name.equals(value?.trim(), true) || it.label.equals(value?.trim(), true)
        }
        fun parse(value: String?): Encouragement = parseOrNull(value) ?: LOW_KEY
    }
}
