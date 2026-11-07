package app.mypeople.data

import java.util.Locale

/** A within-card cleanup only: never infer identity or change the surviving number's spelling. */
internal data class DuplicatePhoneCleanup(val card: ContactCard, val removed: Int, val groups: Int)

private val visualPhoneSeparators = Regex("[\\s().-]")
// Refuse parser guesses about arbitrary text, pause sequences, service codes or malformed suffixes.
private val ordinaryPhone = Regex("(?i)^(?:tel:)?[+0-9\\s()./-]+(?:\\s*(?:ext\\.?|extension|x|#|;ext=|;)\\s*[0-9]+)?$")

private fun ContactCard.phoneEqualityKey(field: ContactField): String {
    if (canNormalizePhone(field) && ordinaryPhone.matches(field.value.trim())) {
        dialable(field.value, field.region.ifEmpty { region })?.let { return "international:$it" }
    }
    // Exact/visual duplicates are safe even without a known country, but don't equate
    // explicit differing region overrides, drop a leading zero, or ignore extensions.
    val raw = field.value.trim().lowercase(Locale.ROOT).replace(visualPhoneSeparators, "")
    return "literal:${field.region}:$raw"
}

internal fun ContactCard.withoutDuplicatePhones(): DuplicatePhoneCleanup {
    val phones = fields.indices.filter { fields[it].kind == "phone" && fields[it].value.isNotBlank() }
    val groups = phones.groupBy { phoneEqualityKey(fields[it]) }.values.filter { it.size > 1 }
    val replacements = mutableMapOf<Int, ContactField>()
    val removed = mutableSetOf<Int>()
    var cleanedGroups = 0
    for (indices in groups) {
        val candidates = indices.map { fields[it] }
        // Preserve incompatible structured metadata rather than silently choosing one.
        val structured = candidates.map { it.structured }.filter { it.isNotEmpty() }.distinct()
        if (structured.size > 1) continue
        val survivor = candidates.sortedWith(compareByDescending<ContactField> { it.preferred }
            .thenByDescending { it.user_added }.thenByDescending { it.region.isNotEmpty() }).first()
        val labels = candidates.map { it.label }.filter { it.isNotBlank() }.distinctBy { it.lowercase(Locale.ROOT) }
        val survivorIndex = indices.first { fields[it] === survivor }
        replacements[survivorIndex] = survivor.copy(
            label = labels.joinToString(" / "), preferred = candidates.any { it.preferred },
            user_added = candidates.any { it.user_added }, structured = structured.singleOrNull().orEmpty(),
        )
        removed.addAll(indices.filter { it != survivorIndex }); cleanedGroups++
    }
    if (removed.isEmpty()) return DuplicatePhoneCleanup(this, 0, 0)
    return DuplicatePhoneCleanup(copy(fields = fields.indices.filterNot { it in removed }.map { replacements[it] ?: fields[it] }), removed.size, cleanedGroups)
}
