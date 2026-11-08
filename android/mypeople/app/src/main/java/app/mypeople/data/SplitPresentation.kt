package app.mypeople.data

import java.net.URI
import kotlinx.serialization.json.*

/** Presentation only: never changes attribution or invents a public handle from an import key. */
internal data class SplitPresentation(val label: String, val detail: String = "", val url: String? = null)

internal fun splitPresentation(type: String, properties: JsonObject, sourceRecords: List<String> = emptyList()): SplitPresentation? {
    fun text(key: String) = (properties[key] as? JsonPrimitive)?.contentOrNull.orEmpty().trim()
    fun web(value: String): String? = runCatching {
        URI(value).takeIf { it.scheme in setOf("https", "http") && !it.host.isNullOrBlank() && it.userInfo == null }?.toASCIIString()
    }.getOrNull()
    if (type == "Claim" && text("predicate") == "public_profile") {
        val url = web(text("url")) ?: web(text("value"))
        return SplitPresentation(
            listOf(text("site").ifBlank { "Social profile" }, text("url").ifBlank { text("value") }).filter { it.isNotBlank() }.joinToString(" · "),
            listOf(text("status").takeIf { it.isNotBlank() }?.let { "Review: $it" }.orEmpty(), text("reason")).filter { it.isNotBlank() }.joinToString("\n"), url,
        )
    }
    if (type != "ContactPoint") return null
    val kind = text("kind")
    val value = text("value")
    val handle = value.removePrefix("@")
    val validHandle = handle.matches(Regex("[A-Za-z0-9_.-]+"))
    val explicit = web(value)
    val url = explicit ?: when {
        kind == "instagram" && validHandle -> "https://www.instagram.com/$handle/"
        kind == "linkedin" && validHandle -> "https://www.linkedin.com/in/$handle/"
        kind == "snapchat" && validHandle -> "https://www.snapchat.com/add/$handle"
        kind in setOf("x", "twitter") && value.matches(Regex("[0-9]+")) -> "https://x.com/i/user/$value"
        kind in setOf("x", "twitter") && validHandle -> "https://x.com/$handle"
        kind == "telegram" && value.startsWith("@") && validHandle -> "https://t.me/$handle"
        kind == "google" && value.matches(Regex("people/[A-Za-z0-9_-]+")) -> "https://contacts.google.com/person/${value.removePrefix("people/")}"
        else -> null
    }
    val title = when (kind) {
        "telegram-contact", "telegram-context" -> "Telegram imported contact"
        "telegram" -> "Telegram account"
        "google" -> "Google contact"
        "instagram" -> "Instagram"
        "linkedin" -> "LinkedIn"
        "snapchat" -> "Snapchat"
        "x", "twitter" -> "X / Twitter"
        else -> kind
    }
    val explanation = when (kind) {
        "telegram-contact", "telegram-context" -> "Address-book import key, not a Telegram username. It cannot be opened as a profile."
        "telegram" -> if (url == null) "Numeric Telegram account ID, not a public username." else "Telegram profile"
        "google" -> "Google Contacts record · may require the Google account that imported it."
        else -> ""
    }
    val googleRecord = if (kind == "google") sourceRecords.asSequence().mapNotNull {
        runCatching { Json.parseToJsonElement(it) as? JsonObject }.getOrNull()
    }.firstOrNull { (it["resourceName"] as? JsonPrimitive)?.contentOrNull == value } else null
    fun googleValues(key: String, vararg fields: String): List<String> = (googleRecord?.get(key) as? JsonArray).orEmpty().mapNotNull { record ->
        (record as? JsonObject)?.let { entry -> fields.firstNotNullOfOrNull { field -> (entry[field] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() } } }
    }
    val importedDetails = listOf(
        googleValues("names", "displayName", "unstructuredName").joinToString(" · "),
        googleValues("phoneNumbers", "canonicalForm", "value").joinToString(" · "),
        googleValues("emailAddresses", "value").joinToString(" · "),
        googleValues("organizations", "name").joinToString(" · "),
    ).filter { it.isNotBlank() }
    val opaque = kind in setOf("telegram-contact", "telegram-context", "google")
    val detail = (importedDetails + listOf(
        explanation,
        "Import key: $value".takeIf { opaque }.orEmpty(),
        text("source").takeIf { it.isNotBlank() }?.let { "Source: $it" }.orEmpty(),
        text("label").takeIf { it.isNotBlank() }?.let { "Label: $it" }.orEmpty(),
        "Preferred contact point".takeIf { text("preferred") == "true" }.orEmpty(),
        "Legacy matching hint · not a verified contact point".takeIf { text("matching_hint") == "true" }.orEmpty(),
    )).filter { it.isNotBlank() }.joinToString("\n")
    // Preserve phone/email labels used elsewhere while giving opaque source keys a readable title.
    return SplitPresentation(if (opaque) title else "$title: $value", detail, url)
}
