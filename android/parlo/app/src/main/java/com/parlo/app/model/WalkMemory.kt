package com.parlo.app.model

/** What the tutor should remember from earlier walks in [language]. */
data class WalkMemory(
    val language: String,
    val focus: String = "",
    val reviewWords: List<String> = emptyList(),
    val goal: String = "",
    val episodes: List<String> = emptyList(),
    val recentConversation: List<String> = emptyList(),
    val nextStep: String = "",
    val returning: Boolean = false,
) {
    val isEmpty: Boolean get() = focus.isBlank() && reviewWords.isEmpty() && goal.isBlank() && episodes.isEmpty() && recentConversation.isEmpty() && !returning
}
