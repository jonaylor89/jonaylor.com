package app.mypeople.data

import android.content.Context
import android.content.pm.PackageManager
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateContentRequest
import kotlinx.coroutines.withTimeout

/** Uses only an already-installed AICore model. Never call download() or warmup() here. */
class NanoContactDescription(context: Context) : ContactDescriptionExtractor {
    private val packages = context.applicationContext.packageManager
    private val client = lazy { Generation.getClient() }

    override suspend fun availability(): ContactDescriptionAvailability = withTimeout(5000) {
        // The SDK queries this same package. Missing AICore is different from an unavailable model.
        val service = try { packages.getApplicationInfo("com.google.android.aicore", 0) }
        catch (_: PackageManager.NameNotFoundException) { return@withTimeout ContactDescriptionAvailability.AICORE_MISSING }
        if (!service.enabled) return@withTimeout ContactDescriptionAvailability.AICORE_DISABLED
        when (client.value.checkStatus()) {
            FeatureStatus.AVAILABLE -> ContactDescriptionAvailability.AVAILABLE
            FeatureStatus.DOWNLOADABLE, FeatureStatus.DOWNLOADING -> ContactDescriptionAvailability.NOT_INSTALLED
            else -> ContactDescriptionAvailability.UNAVAILABLE
        }
    }

    override suspend fun extract(description: String, region: String): ContactCard = withTimeout(30000) {
        check(availability() == ContactDescriptionAvailability.AVAILABLE) { "On-device AI isn’t ready. Add this contact manually; no model will be downloaded." }
        val response = client.value.generateContent(generateContentRequest(TextPart(contactDescriptionPrompt(description))) {
            temperature = 0f
            candidateCount = 1
            maxOutputTokens = 768
        })
        val text = response.candidates.firstOrNull()?.text ?: error("No draft was returned. Try again or add manually.")
        parseContactDescription(description, text, region)
    }

    override fun close() {
        if (client.isInitialized()) client.value.close()
    }
}
