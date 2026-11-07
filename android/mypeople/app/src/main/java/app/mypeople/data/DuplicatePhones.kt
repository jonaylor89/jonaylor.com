package app.mypeople.data

import java.util.Locale
import kotlinx.serialization.json.*

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

/** Plan only phone-link/metadata operations, so a merge decision and cleanup can commit together. */
internal fun GraphStore.duplicatePhoneOperations(person: Person, cleanup: DuplicatePhoneCleanup): List<GraphOperation> {
    if (cleanup.removed == 0) return emptyList()
    val before = person.contactCard()
    val members = graph.components().groups.values.first { person.contact_uid in it }.toSet()
    val retained = cleanup.card.fields.map { it.object_id }.toSet()
    val removed = before.fields.filter { it.kind == "phone" && it.object_id !in retained }.map { it.object_id }.toSet()
    require(removed.size == cleanup.removed && removed.none { it.isEmpty() })
    val ops = mutableListOf<GraphOperation>()
    for (owner in members) graph.outgoing(owner).filter { (edge, entity) ->
        entity.type == "has_contact_point" && entity.to in removed && graph.active(edge)
    }.forEach { (edge, _) -> ops += graph.edit(edge, "_lifecycle", JsonPrimitive("retracted")) }
    for (field in cleanup.card.fields.filter { it.kind == "phone" }) {
        val previous = before.fields.first { it.object_id == field.object_id }
        val updates = buildMap<String, JsonElement> {
            if (previous.label != field.label) put("label", JsonPrimitive(field.label))
            if (previous.preferred != field.preferred) put("preferred", JsonPrimitive(field.preferred))
            if (previous.user_added != field.user_added) put("user_added", JsonPrimitive(field.user_added))
            if (previous.structured != field.structured) put("structured", JsonPrimitive(field.structured))
        }
        if (updates.isNotEmpty()) {
            require(graph.incoming(field.object_id).none { (edge, entity) ->
                entity.type == "has_contact_point" && entity.from !in members && graph.active(edge)
            }) { "Shared contact-point metadata needs review. Turn off phone cleanup to save only the merge decision." }
            updates.forEach { (key, value) -> ops += graph.edit(field.object_id, key, value) }
        }
    }
    require(ops.isNotEmpty())
    return ops
}
