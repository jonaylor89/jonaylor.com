package com.parlo.app.model

/** What the tutor should remember from earlier walks in [language]. */
data class WalkMemory(
    val language: String,
    val focus: String = "",
    val reviewWords: List<String> = emptyList(),
) {
    val isEmpty: Boolean get() = focus.isBlank() && reviewWords.isEmpty()
}
