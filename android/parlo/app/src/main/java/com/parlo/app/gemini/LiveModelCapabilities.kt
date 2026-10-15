package com.parlo.app.gemini

/** Only opt into optional wire features for model families known to support them. */
object LiveModelCapabilities {
    val backgroundTools = setOf("note_vocab", "show_phrase", "update_walk")

    fun supportsAsyncTools(model: String): Boolean {
        val name = model.removePrefix("models/").lowercase()
        // 3.1 Live is sequential-only. Unknown families retain the compatible blocking protocol.
        return ("2.5" in name && "native-audio" in name && "thinking" !in name) ||
            (name.startsWith("gemini-3.8-live") && "thinking" !in name)
    }
}
