package com.parlo.app.data

import com.parlo.app.model.LanguageCatalog
import com.parlo.app.model.Level
import com.parlo.app.model.Scenario
import com.parlo.app.model.SessionConfig

/** Restore a language's own teaching settings, preserving global voice/model and explicit changes. */
internal fun languageConfig(previous: SessionConfig, requested: SessionConfig, saved: List<SessionConfig>): SessionConfig {
    if (previous.language.equals(requested.language, true)) return requested
    val target = saved.firstOrNull { it.language.equals(requested.language, true) }
    return requested.copy(
        dialect = if (requested.dialect == previous.dialect) target?.dialect ?: LanguageCatalog.defaultDialectFor(requested.language) else requested.dialect,
        level = if (requested.level == previous.level) target?.level ?: Level.SUPER_BEGINNER else requested.level,
        correctionStyle = if (requested.correctionStyle == previous.correctionStyle) target?.correctionStyle ?: requested.correctionStyle else requested.correctionStyle,
        scenario = if (requested.scenario == previous.scenario) target?.scenario ?: Scenario.FREE else requested.scenario,
        topic = if (requested.topic == previous.topic) target?.topic.orEmpty() else requested.topic,
        topicTitle = if (requested.topicTitle == previous.topicTitle) target?.topicTitle.orEmpty() else requested.topicTitle,
        followPlan = target?.followPlan ?: true,
    )
}
