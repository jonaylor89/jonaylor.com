package com.parlo.app.model

data class TryPhrase(val phrase: String, val translation: String = "")

/** What the tutor has learned about the learner during the onboarding walk; blank means not asked yet. */
data class LearnerProfile(
    val language: String = "",
    val dialect: String = "",
    val goal: String = "",
    val level: String = "",
)
