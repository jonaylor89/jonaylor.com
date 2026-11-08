package app.mypeople.data

import android.database.sqlite.SQLiteDatabase

/** Read-only per-contact count audit. The named contact's values never leave the device. */
object ContactPhoneAudit {
    @JvmStatic fun main(args: Array<String>) {
        require(args.size == 2)
        SQLiteDatabase.openDatabase(args[0],null,SQLiteDatabase.OPEN_READONLY).use { db ->
            var matches=0
            db.rawQuery("SELECT data FROM screen WHERE scope='view' AND kind='person' AND died IS NULL AND json_extract(data,'$.name')=? COLLATE NOCASE",arrayOf(args[1])).use { cursor ->
                while(cursor.moveToNext()) {
                    matches++
                    val person=json.decodeFromString<Person>(cursor.getString(0))
                    val card=person.contactCard()
                    val hints=card.fields.filter { field ->
                        field.kind=="phone" && field.object_id.isNotEmpty() && db.rawQuery("SELECT property,value FROM registers WHERE entity=? AND died IS NULL AND property IN ('matching_hint','compat_table')",arrayOf(field.object_id)).use { flags ->
                            var hint=false
                            while(flags.moveToNext()) if((flags.getString(0)=="matching_hint" && flags.getString(1)=="true") || (flags.getString(0)=="compat_table" && flags.getString(1)=="\"identifiers\"")) hint=true
                            hint
                        }
                    }
                    val numbers=card.phoneNumberGroups()
                    val known=card.copy(fields=card.fields.filterNot { it in hints }).phoneNumberGroups()
                    val cleanup=card.withoutDuplicatePhones()
                    val merge=person.mergeDecisionConflicts().size
                    println("PHONE_PROVENANCE knownEntries=${known.sumOf { it.entries }} knownNumbers=${known.size} importHints=${hints.size}")
                    println("PHONE_AUDIT match=$matches entries=${numbers.sumOf { it.entries }} distinctNumbers=${numbers.size} removableCopies=${cleanup.removed} groupSizes=${numbers.map { it.entries }} mergeWarnings=$merge otherConflicts=${person.contact_conflicts.size-merge} unverified=${card.legacy_unverified}")
                }
            }
            println("PHONE_AUDIT matches=$matches")
        }
    }
}
