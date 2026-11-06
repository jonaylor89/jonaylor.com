package app.mypeople.data

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.*

/** A per-decode symbol table, not String.intern/global state. UUIDs and property
 * names occur many times in a complete graph; share their exact strings without
 * retaining a second copy in every operation/payload/index. No normalization. */
internal object GraphAtoms {
    private val current = ThreadLocal<MutableMap<String, String>?>()
    fun <T> decoding(block: () -> T): T {
        val previous = current.get()
        if (previous == null) current.set(HashMap())
        return try { block() } finally { if (previous == null) current.remove() else current.set(previous) }
    }
    fun string(value: String): String {
        val pool = current.get() ?: return value
        return if (value.length <= 64) pool.getOrPut(value) { value } else value
    }
    fun element(value: JsonElement, depth: Int = 0): JsonElement {
        if (current.get() == null) return value
        require(depth <= 100) { "Graph JSON nesting exceeds supported depth" }
        return when (value) {
            is JsonObject -> {
                var changed = false
                val next = LinkedHashMap<String, JsonElement>(value.size)
                for ((key, child) in value) {
                    val name = string(key); val item = element(child, depth + 1)
                    if (name !== key || item !== child) changed = true
                    next[name] = item
                }
                if (changed) JsonObject(next) else value
            }
            is JsonArray -> {
                val next = value.map { element(it, depth + 1) }
                if (next.indices.any { next[it] !== value[it] }) JsonArray(next) else value
            }
            is JsonPrimitive -> if (value.isString) {
                val next = string(value.content)
                if (next === value.content) value else JsonPrimitive(next)
            } else value
        }
    }
}

@Serializable
private data class GraphOperationWire(val id: String, val kind: String, val target: String, val payload: JsonObject, val replaces: List<String>)

internal object GraphOperationSerializer : KSerializer<GraphOperation> {
    override val descriptor = GraphOperationWire.serializer().descriptor
    override fun serialize(encoder: Encoder, value: GraphOperation) = encoder.encodeSerializableValue(GraphOperationWire.serializer(), GraphOperationWire(value.id, value.kind, value.target, value.payload, value.replaces))
    override fun deserialize(decoder: Decoder): GraphOperation {
        val value = decoder.decodeSerializableValue(GraphOperationWire.serializer())
        return GraphOperation(GraphAtoms.string(value.id), GraphAtoms.string(value.kind), GraphAtoms.string(value.target), GraphAtoms.element(value.payload).jsonObject, value.replaces.map(GraphAtoms::string))
    }
}
