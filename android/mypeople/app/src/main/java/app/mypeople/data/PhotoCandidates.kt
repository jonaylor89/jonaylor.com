package app.mypeople.data

import kotlinx.serialization.json.*

internal const val PHOTO_POLICY_VERSION = "1"

internal fun photoDimensions(data: ByteArray): Pair<Int, Int> {
    fun u16(at: Int) = ((data[at].toInt() and 255) shl 8) or (data[at + 1].toInt() and 255)
    if (data.size >= 24 && data[0] == 0x89.toByte() && data[1] == 0x50.toByte()) {
        val buffer = java.nio.ByteBuffer.wrap(data)
        return buffer.getInt(16) to buffer.getInt(20)
    }
    var i = 2
    while (i + 9 < data.size && data[0] == 0xff.toByte() && data[1] == 0xd8.toByte()) {
        if (data[i] != 0xff.toByte()) break
        val marker = data[i + 1].toInt() and 255
        if (marker in 0xc0..0xcf && marker !in setOf(0xc4, 0xc8, 0xcc)) return u16(i + 7) to u16(i + 5)
        i += 2 + u16(i + 2)
    }
    return 0 to 0
}

fun photoSourceLabel(source: String): String = when (source) {
    "groupme" -> "GroupMe"
    "whatsapp" -> "WhatsApp"
    "google" -> "Google Contacts"
    "linkedin" -> "LinkedIn"
    "manual" -> "Added by you"
    "unknown" -> "Imported photo"
    else -> source.replaceFirstChar { it.uppercaseChar() }
}

/** Provenance is separate from bytes: several candidates can share one graph blob. */
data class PhotoCandidate(
    val id: String, val hash: String, val source: String, val sourceIdentity: String,
    val width: Int, val height: Int, val firstObserved: String, val lastObserved: String,
    val sourceUpdatedAt: String, val legacyManual: Boolean,
)
data class PhotoChoices(
    val candidates: List<PhotoCandidate>, val selected: String, val preferred: String,
    val automatic: Boolean, val conflict: Boolean, val unavailablePreference: Boolean, val observed: List<String>, val automaticSelected: String,
)

fun GraphStore.photoChoices(uid: String): PhotoChoices {
    val members = graph.components().membersByPerson[uid] ?: listOf(uid)
    val candidates = associated(uid).filter { (_, e) -> e.type == "has_asset" && graph.active(e.to!!) }
        .map { it.second.to!! }.distinct().sorted().mapNotNull { obj ->
            val role = text(obj, "role")
            if (role !in setOf("", "contact_photo", "profile_photo") || role.isEmpty() && text(obj, "compat_table") != "photos") return@mapNotNull null
            val hash = (graph.value(obj, "content") as? JsonObject)?.get("blob_hash")?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            fun number(key: String) = (graph.value(obj, key) as? JsonPrimitive)?.intOrNull ?: 0
            PhotoCandidate(obj, hash, text(obj, "source").ifBlank { if (role == "contact_photo") "manual" else "unknown" },
                text(obj, "source_identity"), number("width"), number("height"), text(obj, "first_observed"), text(obj, "last_observed"), text(obj, "source_updated_at"), role == "contact_photo")
        }
    val choices = members.flatMap { graph.alternatives(it, "photo_choice") }.mapNotNull { (it.value as? JsonPrimitive)?.contentOrNull }.toSet()
    val pinned = candidates.filter { it.id in choices || choices.isEmpty() && it.legacyManual }.map { it.id }.sorted()
    fun side(c: PhotoCandidate) = minOf(c.width, c.height.takeIf { it > 0 } ?: c.width)
    val automatic = candidates.maxWithOrNull(compareBy<PhotoCandidate> { side(it) >= 96 }.thenBy { it.sourceUpdatedAt }.thenBy { minOf(side(it), 512) }.thenBy { it.id })
    val selected = candidates.firstOrNull { it.id == pinned.firstOrNull() } ?: automatic
    return PhotoChoices(candidates, selected?.id.orEmpty(), pinned.firstOrNull().orEmpty(), choices == setOf("") || choices.isEmpty() && pinned.isEmpty(), choices.size > 1, choices.any { it.isNotEmpty() } && pinned.isEmpty(), members.flatMap { graph.alternatives(it, "photo_choice").map { alternative -> alternative.operation } }.sorted(), automatic?.id.orEmpty())
}

fun GraphStore.choosePhoto(uid: String, candidate: String, observed: List<String>? = null): GraphState {
    val members = requireNotNull(graph.components().membersByPerson[uid]) { "This contact is no longer available." }
    val current = photoChoices(uid)
    require(observed == null || observed == current.observed) { "The photo preference changed on another device. Reload photos before choosing again." }
    require(candidate.isEmpty() || current.candidates.any { it.id == candidate }) { "This photo is no longer available. Reopen the photo chooser." }
    return commit(members.map { graph.edit(it, "photo_choice", JsonPrimitive(candidate)) })
}
