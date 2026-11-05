package app.mypeople.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// What the Mac publishes (see src/mypeople/publish.py). Ids are the Mac's database ids.

@Serializable
data class Identifier(val kind: String, val value: String)

@Serializable
data class ChannelCount(val channel: String, val count: Int)

@Serializable
data class Person(
    val name: String,
    val contact_uid: String = "",
    val contact_aliases: List<String> = emptyList(),
    val card: ContactCard? = null,
    val trashed: Boolean = false,
    val can_undo_merge: Boolean = false,
    val contact_conflicts: Map<String, List<ContactConflict>> = emptyMap(),
    val aliases: List<String> = emptyList(),
    val identifiers: List<Identifier> = emptyList(),
    val photo: String? = null,
    val category: String = "unknown",
    val closeness: Double = 0.0,
    val cadence_days: Double? = null,
    val trend: String = "none",
    val days_365: Int = 0,
    val muted: Boolean = false,
    val channels: List<ChannelCount> = emptyList(),
    val first_contact: String? = null,
    val last_contact: String? = null,
)

@Serializable
data class Event(
    val person_id: Int,
    val type: String,
    val value: String,
    val date: String = "",
    val confidence: Double = 1.0,
    val source: String = "",
    val evidence: String? = null,
    val said_at: String? = null,
    val created_at: String = "",
)

@Serializable
data class Profile(
    val person_id: Int,
    val site: String,
    val url: String,
    val title: String = "",
    val status: String = "suggested",
    val assessment: String = "possible",
    val reason: String = "",
    val confidence: Double = 0.0,
)

@Serializable
data class Moment(
    val person_id: Int,
    val kind: String,
    val reason: String,
    val context: String? = null,
    val score: Double = 0.0,
    val surfaced_on: String,
    val status: String = "new",
)

@Serializable
data class Dupes(val person_ids: List<Int>, val clues: List<String> = emptyList())

// The sync protocol (see src/mypeople/server.py).

@Serializable
data class RecordChange(val kind: String, val id: String, val data: JsonElement? = null)

@Serializable
data class OpState(
    val id: Long,
    val client_id: String,
    val kind: String,
    val payload: JsonObject,
    val status: String,
    val message: String? = null,
)

@Serializable
data class Changes(val cursor: Long, val more: Boolean, val records: List<RecordChange>, val ops: List<OpState>)

/** An edit or request made here, waiting for the Mac. */
@Serializable
data class PendingOp(val client_id: String, val kind: String, val payload: JsonObject, val sent: Boolean = false, val created_at: String = "", val completed: Boolean = false)
