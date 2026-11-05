package app.mypeople.data

import kotlinx.serialization.json.*
import java.security.MessageDigest

/** Format-2 manifests intern repeated parent frontiers without changing a single change UUID,
 * causal edge, or operation payload. Plain format-1 transfers remain readable. Never persist
 * unresolved references in ContactHistory or receipts. Opaque JsonElements are not re-encoded
 * through numeric serializers (which could change retry fingerprints).
 */
internal object ContactWire {
    private val fullJson = Json(json) { encodeDefaults = true }
    private fun digest(parents: List<String>) = MessageDigest.getInstance("SHA-256").digest(parents.joinToString("\n").toByteArray(Charsets.US_ASCII)).joinToString("") { "%02x".format(it) }
    private fun parents(c: JsonObject): List<String> = c["parents"]?.jsonArray?.map { require(it.jsonPrimitive.isString); it.jsonPrimitive.content }.orEmpty()
    private fun array(strings: List<String>) = JsonArray(strings.map(::JsonPrimitive))

    fun encode(manifest: TransferManifest): JsonObject {
        val counts = mutableMapOf<List<String>, Int>()
        fun count(p: List<String>) { counts[p] = (counts[p] ?: 0) + 1 }
        manifest.contact_history.forEach { count(it.parents) }
        manifest.ops.filter { it.kind == "contact_change" }.forEach { count(parents(it.payload)) }
        manifest.results.filter { it.kind == "contact_change" }.forEach { count(parents(it.payload)) }
        val repeated = counts.filter { (p, n) -> p.size > 1 && n > 1 }.keys.associateWith(::digest)
        fun patch(raw: JsonObject, p: List<String>): JsonObject {
            val ref = repeated[p] ?: return raw
            return JsonObject(raw.filterKeys { it != "parents" } + ("parent_frontier" to JsonPrimitive(ref)))
        }
        fun payload(kind: String, raw: JsonObject): JsonObject = if (kind == "contact_change") patch(raw, parents(raw)) else raw
        fun change(c: ContactChange): JsonObject {
            val scalar = fullJson.encodeToJsonElement(c.copy(parents = emptyList(), values = JsonObject(emptyMap()), adds = emptyMap())).jsonObject
            val raw = JsonObject(scalar + mapOf("values" to c.values, "adds" to JsonObject(c.adds.mapValues { JsonArray(it.value) })))
            return if (c.parents in repeated) patch(raw, c.parents) else JsonObject(raw + ("parents" to array(c.parents)))
        }
        val root = fullJson.encodeToJsonElement(manifest.copy(records = emptyList(), ops = emptyList(), results = emptyList(), contact_history = emptyList())).jsonObject.toMutableMap()
        root["records"] = JsonArray(manifest.records.map { r -> buildJsonObject { put("kind", r.kind); put("id", r.id); r.data?.let { put("data", it) } } })
        root["ops"] = JsonArray(manifest.ops.map { o -> buildJsonObject {
            put("client_id", o.client_id); put("kind", o.kind); put("payload", payload(o.kind, o.payload)); put("sent", o.sent); put("created_at", o.created_at); put("completed", o.completed)
        } })
        root["results"] = JsonArray(manifest.results.map { o -> buildJsonObject {
            put("id", o.id); put("client_id", o.client_id); put("kind", o.kind); put("payload", payload(o.kind, o.payload)); put("status", o.status); o.message?.let { put("message", it) }
        } })
        root["contact_history"] = JsonArray(manifest.contact_history.map(::change))
        if (repeated.isNotEmpty()) {
            root["format"] = JsonPrimitive(2); root["contact_wire"] = JsonPrimitive(1)
            root["contact_frontiers"] = JsonObject(repeated.entries.associate { (p, ref) -> ref to array(p) })
        }
        return JsonObject(root)
    }

    fun decode(raw: JsonObject): TransferManifest {
        val format = raw["format"]?.jsonPrimitive?.intOrNull
        require(format in 1..2) { "Unsupported transfer format." }
        val frontiers = mutableMapOf<String, List<String>>()
        val frontierJson = mutableMapOf<String, JsonArray>()
        var tableEdges = 0L
        if (format == 2) {
            require(raw["contact_wire"]?.jsonPrimitive?.intOrNull == 1) { "Unsupported contact wire format." }
            val table = requireNotNull(raw["contact_frontiers"]) { "Missing contact frontier table." }.jsonObject
            require(table.size <= 100_000) { "Invalid contact frontier table." }
            val validUuids = mutableSetOf<String>()
            table.forEach { (ref, value) ->
                require(Regex("[a-f0-9]{64}").matches(ref)) { "Invalid contact frontier." }
                val items = value.jsonArray
                require(items.size <= 100_000) { "Invalid contact frontier." }
                tableEdges += items.size
                require(tableEdges <= 8_000_000) { "Contact frontier table exceeds supported size." }
                val p = items.map { element ->
                    require(element.jsonPrimitive.isString) { "Invalid parent UUID." }
                    element.jsonPrimitive.content.also { if (validUuids.add(it)) ContactHistory.uuid(it) }
                }
                require(p.distinct().size == p.size && digest(p) == ref) { "Contact frontier digest does not match its parents." }
                frontiers[ref] = p; frontierJson[ref] = items
            }
        } else require(raw["contact_frontiers"] == null) { "Contact frontier references require transfer format 2." }
        var expanded = 0L
        fun reference(c: JsonObject): String? {
            val ref = c["parent_frontier"]?.jsonPrimitive?.content
            if (ref != null) require(format == 2 && ref in frontiers && "parents" !in c) { "Invalid or ambiguous contact frontier reference." }
            expanded += if (ref == null) c["parents"]?.jsonArray?.size ?: 0 else frontiers.getValue(ref).size
            require(expanded <= 24_000_000) { "Expanded contact frontiers exceed supported size." }
            return ref
        }
        fun expandPayload(c: JsonObject): JsonObject {
            val ref = reference(c) ?: return c
            return JsonObject(c.filterKeys { it != "parent_frontier" } + ("parents" to frontierJson.getValue(ref)))
        }
        val history = raw["contact_history"]?.jsonArray.orEmpty()
        require(history.size <= 100_000) { "Invalid contact history inventory." }
        val changes = history.map { element ->
            val c = element.jsonObject; val ref = reference(c)
            if (ref == null) json.decodeFromJsonElement<ContactChange>(c)
            else json.decodeFromJsonElement<ContactChange>(JsonObject(c.filterKeys { it != "parent_frontier" })).copy(parents = frontiers.getValue(ref))
        }
        val root = raw.filterKeys { it !in setOf("contact_history", "contact_frontiers") }.toMutableMap()
        root["format"] = JsonPrimitive(1)
        for (key in listOf("ops", "results")) raw[key]?.let { rows ->
            root[key] = JsonArray(rows.jsonArray.map { row ->
                val o = row.jsonObject
                if (o.text("kind") == "contact_change") JsonObject(o + ("payload" to expandPayload(o.getValue("payload").jsonObject))) else o
            })
        }
        return json.decodeFromJsonElement<TransferManifest>(JsonObject(root)).copy(contact_history = changes)
    }
}
