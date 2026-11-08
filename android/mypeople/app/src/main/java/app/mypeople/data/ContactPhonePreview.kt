package app.mypeople.data

import kotlinx.serialization.json.JsonPrimitive

internal data class SourceContactPreview(val name: String, val numbers: List<String>)
internal data class SeparationDecisionPreview(val left: SourceContactPreview, val right: SourceContactPreview)

internal data class ContactPhonePreview(
    val source: Person,
    val numbers: List<PhoneNumberGroup>,
    val importHints: List<ContactField>,
    val cleanup: DuplicatePhoneCleanup,
    val earlierSeparation: List<SeparationDecisionPreview> = emptyList(),
) {
    val entries: Int get() = numbers.sumOf { it.entries }
    val remainingEntries: Int get() = cleanup.card.fields.count { it.kind == "phone" && it.value.isNotBlank() && it.object_id !in importHints.map { hint -> hint.object_id } }
}

internal fun Person.phonePreview(hintIds: Set<String> = emptySet()): ContactPhonePreview {
    val card=contactCard()
    val hints=card.fields.filter { it.kind=="phone" && it.object_id in hintIds }
    val known=card.copy(fields=card.fields.filterNot { it.kind=="phone" && it.object_id in hintIds })
    return ContactPhonePreview(this,known.phoneNumberGroups(),hints,card.withoutDuplicatePhones(hintIds))
}

/** Provenance comes from the graph, not a guessed country or matching phone suffix. */
internal fun GraphStore.phonePreview(person: Person): ContactPhonePreview {
    val hints=person.contactFields().filter { it.kind=="phone" && it.object_id.isNotEmpty() }.filter {
        text(it.object_id,"compat_table")=="identifiers" || graph.value(it.object_id,"matching_hint")==JsonPrimitive(true)
    }.map { it.object_id }.toSet()
    fun sourceRecord(uid: String): SourceContactPreview {
        val edges=graph.outgoing(uid).filter { graph.active(it.first) }
        val name=edges.firstNotNullOfOrNull { (_, edge) ->
            if(edge.type=="has_name" && graph.active(edge.to!!)) text(edge.to,"display").takeIf { it.isNotBlank() } else null
        } ?: "Original contact record"
        val points=edges.filter { it.second.type=="has_contact_point" }.mapNotNull { it.second.to }.toSet()-hints
        val card=person.contactCard().copy(fields=person.contactFields().filter { it.kind=="phone" && it.object_id in points })
        return SourceContactPreview(name,card.phoneNumberGroups().map { it.number })
    }
    val decisions=person.mergeDecisionConflicts().keys.mapNotNull { field ->
        val edge=graph.edges[field.substringBefore('/')]
        if(edge?.type=="distinct_person") SeparationDecisionPreview(sourceRecord(edge.from!!),sourceRecord(edge.to!!)) else null
    }
    return person.phonePreview(hints).copy(earlierSeparation=decisions)
}
