package com.parlo.app.gemini

import com.parlo.app.model.SessionConfig
import com.parlo.app.model.WalkMemory

/** The resolved connection model must never be written back as the user's override. */
object LiveSetup {
    fun build(config: SessionConfig, resolvedModel: String, memory: WalkMemory? = null): Setup = Setup(
        model = if (resolvedModel.startsWith("models/")) resolvedModel else "models/$resolvedModel",
        generationConfig = GenerationConfig(
            speechConfig = SpeechConfig(VoiceConfig(PrebuiltVoiceConfig(config.voice))),
        ),
        systemInstruction = Content(parts = listOf(Part(text = PromptBuilder.systemInstruction(config, memory)))),
        tools = PromptBuilder.toolDeclarations(resolvedModel),
    )
}
