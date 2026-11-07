package app.mypeople.data

import android.database.sqlite.SQLiteDatabase
import kotlinx.serialization.json.*

/** Read-only on-device shape audit: no names, numbers, values or entity IDs in output. */
object ConflictAudit {
    @JvmStatic fun main(args: Array<String>) {
        require(args.size == 1)
        SQLiteDatabase.openDatabase(args[0], null, SQLiteDatabase.OPEN_READONLY).use { db ->
            val contacts = mutableMapOf<String, Int>()
            db.rawQuery("""
                SELECT s.id, c.key, c.value, e.type, s.data
                FROM screen s, json_each(s.data,'$.contact_conflicts') c
                LEFT JOIN entities e ON e.id=substr(c.key,1,instr(c.key,'/')-1)
                WHERE s.scope='view' AND s.kind='person' AND s.died IS NULL
                  AND coalesce(json_extract(s.data,'$.trashed'),0)=0
                ORDER BY s.id,c.key
            """.trimIndent(), null).use { cursor ->
                while (cursor.moveToNext()) {
                    val number = contacts.getOrPut(cursor.getString(0)) { contacts.size + 1 }
                    val key = cursor.getString(1)
                    val choices = json.parseToJsonElement(cursor.getString(2)).jsonArray.map { it.jsonObject.getValue("value") }
                    val person = json.decodeFromString<Person>(cursor.getString(4))
                    val target = key.substringBefore('/')
                    val point = person.contactFields().firstOrNull { it.object_id == target }
                    val normalized = if (point?.kind == "phone" && key.substringAfter('/') == "value") choices.map {
                        (it as? JsonPrimitive)?.contentOrNull?.let { value ->
                            if (person.contactCard().canNormalizePhone(point.copy(value=value))) dialable(value,point.region.ifEmpty { person.contactCard().region }) else null
                        }
                    } else emptyList()
                    println("CONFLICT contact=$number entity=${cursor.getString(3).orEmpty()} property=${key.substringAfter('/')} alternatives=${choices.size} distinct=${choices.distinct().size} blank=${choices.count { it is JsonPrimitive && it.contentOrNull.orEmpty().isBlank() }} structured=${choices.any { it is JsonObject || it is JsonArray }} equivalentPhones=${normalized.isNotEmpty() && normalized.all { it != null } && normalized.distinct().size == 1}")
                }
            }
            println("CONFLICT_CONTACTS count=${contacts.size}")
        }
    }
}
