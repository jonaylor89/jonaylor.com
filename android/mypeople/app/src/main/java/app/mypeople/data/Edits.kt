package app.mypeople.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/** An intentional, safe-to-display validation error rather than an SDK/network exception. */
class EditRejected(message: String) : IllegalArgumentException(message)

/** Ignore relationship-score refreshes, but never overwrite a concurrent contact edit. */
fun sameContactVersion(current: Person?, expected: Person): Boolean = current != null &&
    current.contact_uid == expected.contact_uid && current.card == expected.card &&
    current.name == expected.name && current.trashed == expected.trashed &&
    (current.card != null || current.identifiers == expected.identifiers)

fun mergePeople(payload: JsonObject, records: Records): Set<Int> {
    val raw = payload["person_ids"] as? JsonArray ?: throw EditRejected("Choose at least two contacts to merge.")
    val ids = raw.map { (it as? JsonPrimitive)?.takeUnless { value -> value.isString }?.intOrNull ?: throw EditRejected("These contacts changed. Reopen duplicate review and try again.") }.toSet()
    if (ids.size < 2) throw EditRejected("Choose at least two different contacts to merge.")
    if (ids.any { it !in records.people }) throw EditRejected("These contacts changed. Reopen duplicate review and try again.")
    return ids
}
