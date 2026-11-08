package app.mypeople.data

import kotlinx.serialization.json.*

/** A merge/separation contradiction is not a competing phone/name value. */
internal fun isMergeDecisionConflict(field: String, choices: List<ContactConflict>): Boolean =
    field.endsWith("/_lifecycle") && choices.size == 1 &&
        choices.single().change == "retract:${field.substringBefore('/')}" &&
        choices.single().value == JsonPrimitive("retracted")

internal fun Person.mergeDecisionConflicts() = contact_conflicts.filter { (field, choices) -> isMergeDecisionConflict(field, choices) }
internal fun Person.canCleanDuplicatePhones() = !trashed && contact_conflicts.all { (field, choices) -> isMergeDecisionConflict(field, choices) }

internal fun conflictFieldTitle(field: String, person: Person): String {
    val property = field.substringAfterLast('/')
    val point = person.contactFields().firstOrNull { it.object_id == field.substringBefore('/') }
    return when (property) {
        "_trashed" -> "Trash status"
        "_lifecycle" -> "Removed or restored detail"
        "display", "name" -> "Name"
        "given" -> "First name"
        "family" -> "Last name"
        "middle" -> "Middle name"
        "prefix" -> "Name prefix"
        "suffix" -> "Name suffix"
        "phonetic" -> "Name pronunciation"
        "body", "notes" -> "Notes"
        "region" -> "Phone country"
        "label" -> if (point?.kind == "phone") "Phone label" else "Detail label"
        "preferred" -> "Default contact detail"
        "value" -> when (point?.kind) { "phone" -> "Phone number"; "email" -> "Email address"; else -> "Contact detail or fact" }
        "originals", "source_records" -> "Imported source history"
        "card_metadata" -> "Contact metadata"
        else -> property.replace('_', ' ').replaceFirstChar { it.uppercase() }
    }
}

internal fun Person.contactConflictSummary(): String {
    val merge = mergeDecisionConflicts()
    val details = contact_conflicts.filterKeys { it !in merge }
    return if (merge.isNotEmpty()) "Earlier keep-separate decision" + if (details.isNotEmpty()) " · ${details.size} other details" else ""
    else details.keys.map { conflictFieldTitle(it, this) }.distinct().joinToString(" · ")
}
