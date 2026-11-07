package app.mypeople.data

import android.database.sqlite.SQLiteDatabase
import java.io.File
import kotlinx.serialization.json.*

/** Operator-only aggregate diagnostics. Opens SQLite READONLY; no Store, Application,
 * migrations, provider access, contact payload output, or edits. Invoked with app_process. */
object FactAudit {
    @JvmStatic fun main(args: Array<String>) {
        require(args.size == 1)
        SQLiteDatabase.openDatabase(args[0], null, SQLiteDatabase.OPEN_READONLY).use { db ->
            fun counts(label: String, sql: String) {
                db.rawQuery(sql, null).use { cursor ->
                    while (cursor.moveToNext()) {
                        // All selected columns are constant labels or aggregates, never content.
                        println("$label " + (0 until cursor.columnCount).joinToString(" ") { index -> "${cursor.getColumnName(index)}=${cursor.getString(index)}" })
                    }
                }
            }
            counts("DISPLAY", """
                SELECT scope, count(*) AS events,
                  sum(CASE WHEN length(trim(coalesce(json_extract(data,'$.value'),'')))>0 THEN 1 ELSE 0 END) AS with_text,
                  sum(CASE WHEN json_extract(data,'$.type')='note' THEN 1 ELSE 0 END) AS notes
                FROM screen WHERE kind='event' AND died IS NULL GROUP BY scope
            """.trimIndent())
            counts("GRAPH", """
                SELECT e.type, r.property, json_type(r.value) AS value_type, count(*) AS alternatives,
                  sum(CASE WHEN json_type(r.value)='text' AND length(trim(json_extract(r.value,'$')))>0 THEN 1 ELSE 0 END) AS with_text
                FROM registers r JOIN entities e ON e.id=r.entity
                WHERE e.type IN ('Claim','Note') AND e.active=1 AND r.died IS NULL AND r.property IN ('value','body')
                GROUP BY e.type,r.property,json_type(r.value)
            """.trimIndent())
            counts("DISPLAY_GRAPH", """
                SELECT count(*) AS displayed,
                  sum(CASE WHEN length(trim(coalesce(json_extract(s.data,'$.value'),'')))=0 THEN 1 ELSE 0 END) AS blank,
                  sum(CASE WHEN length(trim(coalesce(json_extract(s.data,'$.value'),'')))=0 AND EXISTS (
                    SELECT 1 FROM registers r WHERE r.entity=s.id AND r.property IN ('value','body') AND r.died IS NULL
                    AND json_type(r.value)='text' AND length(trim(json_extract(r.value,'$')))>0
                  ) THEN 1 ELSE 0 END) AS blank_but_graph_has_text
                FROM screen s WHERE s.scope='view' AND s.kind='event' AND s.died IS NULL
            """.trimIndent())
            counts("BLANK_ENTITY", """
                SELECT coalesce(e.type,'missing') AS entity_type, count(*) AS blank_rows,
                  sum(CASE WHEN e.active=1 THEN 1 ELSE 0 END) AS active
                FROM screen s LEFT JOIN entities e ON e.id=s.id
                WHERE s.scope='view' AND s.kind='event' AND s.died IS NULL
                  AND length(trim(coalesce(json_extract(s.data,'$.value'),'')))=0
                GROUP BY e.type
            """.trimIndent())
            counts("BLANK_PROVENANCE", """
                SELECT count(*) AS blank,
                  sum(CASE WHEN e.type='Note' AND EXISTS (SELECT 1 FROM registers r WHERE r.entity=e.id AND r.property='origin' AND r.died IS NULL AND r.value IN ('"contact_card_notes"','"legacy_card_notes"')) THEN 1 ELSE 0 END) AS card_note_placeholders,
                  sum(CASE WHEN e.type='Claim' AND EXISTS (SELECT 1 FROM registers r WHERE r.entity=e.id AND r.property='asserted_by' AND r.died IS NULL AND r.value IN ('"contact_card"','"legacy_contact_card"')) THEN 1 ELSE 0 END) AS card_scalar_placeholders
                FROM screen s JOIN entities e ON e.id=s.id
                WHERE s.scope='view' AND s.kind='event' AND s.died IS NULL
                  AND length(trim(coalesce(json_extract(s.data,'$.value'),'')))=0
            """.trimIndent())
            counts("DETACHED_SOURCE_FACTS", """
                SELECT count(DISTINCT e.id) AS facts,
                  count(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM registers p WHERE p.entity=e.id AND p.property='predicate' AND p.died IS NULL AND p.value IN ('"birthday"','"organization"','"title"')) THEN e.id ELSE NULL END) AS card_named_predicates,
                  count(DISTINCT op.commit_seq) AS retraction_commits,
                  min(op.commit_seq) AS first_retraction_sequence, max(op.commit_seq) AS last_retraction_sequence
                FROM entities e JOIN entities a ON a.src=e.id AND a.type='originated_from' AND a.active=1
                JOIN registers t ON t.entity=a.dst AND t.property='table' AND t.died IS NULL AND t.value='"events"'
                JOIN entities owner ON owner.dst=e.id AND owner.type IN ('subject_of','has_note') AND owner.active=0
                JOIN registers lifecycle ON lifecycle.entity=owner.id AND lifecycle.property='_lifecycle' AND lifecycle.died IS NULL AND lifecycle.value='"retracted"'
                JOIN operations op ON op.id=lifecycle.op
                WHERE e.type IN ('Claim','Note') AND e.active=1
                  AND NOT EXISTS (SELECT 1 FROM entities live WHERE live.dst=e.id AND live.type IN ('subject_of','has_note') AND live.active=1)
            """.trimIndent())
            counts("CREATED_TEXT", """
                SELECT json_extract(payload,'$.type') AS type, count(*) AS created,
                  sum(CASE WHEN length(trim(coalesce(json_extract(payload,'$.properties.value'),'')))>0 THEN 1 ELSE 0 END) AS value_with_text,
                  sum(CASE WHEN length(trim(coalesce(json_extract(payload,'$.properties.body'),'')))>0 THEN 1 ELSE 0 END) AS body_with_text
                FROM operations WHERE kind='create_object' AND json_extract(payload,'$.type') IN ('Claim','Note')
                GROUP BY json_extract(payload,'$.type')
            """.trimIndent())
            counts("TEXT_EDITS", """
                SELECT json_extract(payload,'$.property') AS property, count(*) AS edits,
                  sum(CASE WHEN length(trim(coalesce(json_extract(payload,'$.value'),'')))>0 THEN 1 ELSE 0 END) AS with_text
                FROM operations WHERE kind='set_property' AND target IN (SELECT id FROM entities WHERE type IN ('Claim','Note'))
                  AND json_extract(payload,'$.property') IN ('value','body') GROUP BY json_extract(payload,'$.property')
            """.trimIndent())
            val displayByOriginal = mutableMapOf<String, MutableList<String>>()
            db.rawQuery("""
                SELECT json_extract(o.value,'$.blob_hash'), json_extract(s.data,'$.value')
                FROM screen s JOIN entities a ON a.src=s.id AND a.type='originated_from' AND a.active=1
                JOIN registers o ON o.entity=a.dst AND o.property='original' AND o.died IS NULL
                WHERE s.scope='view' AND s.kind='event' AND s.died IS NULL
            """.trimIndent(), null).use { cursor ->
                while (cursor.moveToNext()) {
                    val hash = cursor.getString(0) ?: continue
                    displayByOriginal.getOrPut(hash) { mutableListOf() }.add(cursor.getString(1).orEmpty())
                }
            }
            val reasonsByOriginal = mutableMapOf<String, MutableSet<String>>()
            db.rawQuery("""
                SELECT json_extract(o.value,'$.blob_hash'),
                  CASE
                    WHEN a.active=0 OR e.active=0 THEN 'inactive_or_retracted'
                    WHEN EXISTS (SELECT 1 FROM registers r WHERE r.entity=e.id AND r.property='status' AND r.died IS NULL AND r.value IN ('"rejected"','"forgotten"')) THEN 'rejected_or_forgotten'
                    WHEN EXISTS (SELECT 1 FROM entities t JOIN entities d ON d.id=t.src JOIN registers r ON r.entity=d.id AND r.property='action' AND r.died IS NULL WHERE t.type='targets' AND t.dst=e.id AND t.active=1 AND d.active=1 AND r.value IN ('"reject"','"rejected"','"forget"','"forgotten"')) THEN 'review_decision'
                    WHEN NOT EXISTS (SELECT 1 FROM entities owner WHERE owner.type IN ('subject_of','has_note') AND owner.dst=e.id AND owner.active=1) THEN 'no_active_attribution'
                    WHEN EXISTS (SELECT 1 FROM entities owner JOIN components c ON c.person=owner.src AND c.died IS NULL JOIN components m ON m.root=c.root AND m.died IS NULL JOIN registers r ON r.entity=m.person AND r.property='is_me' AND r.died IS NULL AND r.value='true' WHERE owner.type IN ('subject_of','has_note') AND owner.dst=e.id AND owner.active=1) THEN 'self_contact'
                    ELSE 'needs_investigation'
                  END AS reason
                FROM registers o JOIN entities a ON a.dst=o.entity AND a.type='originated_from'
                JOIN entities e ON e.id=a.src AND e.type IN ('Claim','Note')
                WHERE o.property='original' AND o.died IS NULL
            """.trimIndent(), null).use { cursor ->
                while (cursor.moveToNext()) {
                    val hash = cursor.getString(0) ?: continue
                    reasonsByOriginal.getOrPut(hash) { mutableSetOf() }.add(cursor.getString(1))
                }
            }
            val omissionReasons = mutableMapOf<String, Int>()
            var originals = 0; var originalText = 0; var originalBlank = 0; var unreadable = 0
            var matches = 0; var mismatches = 0; var notDisplayed = 0
            val blobDirectory = File(File(args[0]).parentFile!!.parentFile, "graph-blobs")
            db.rawQuery("""
                SELECT DISTINCT json_extract(o.value,'$.blob_hash') FROM registers t JOIN registers o ON o.entity=t.entity
                JOIN entities e ON e.id=t.entity
                WHERE e.type='SourceRecord' AND t.property='table' AND t.value='"events"' AND t.died IS NULL
                  AND o.property='original' AND o.died IS NULL
            """.trimIndent(), null).use { cursor ->
                while (cursor.moveToNext()) {
                    originals++
                    val hash = cursor.getString(0)
                    if (hash == null || !Regex("[0-9a-f]{64}").matches(hash)) { unreadable++; continue }
                    val file = File(blobDirectory, hash)
                    if (!file.isFile || file.length() > 8 * 1024 * 1024) { unreadable++; continue }
                    try {
                        require(file.inputStream().use(GraphBlobs::verifiedHash) == hash)
                        val row = json.parseToJsonElement(file.readText()).jsonObject
                        val original = row.text("value").ifBlank { row.text("body") }
                        if (original.isNotBlank()) originalText++ else originalBlank++
                        val displayed = displayByOriginal[hash].orEmpty()
                        if (displayed.isEmpty()) {
                            notDisplayed++
                            val reasons = reasonsByOriginal[hash].orEmpty().ifEmpty { setOf("no_current_origin_link") }
                            for (reason in reasons) omissionReasons[reason] = (omissionReasons[reason] ?: 0) + 1
                        }
                        for (text in displayed) if (text == original) matches++ else mismatches++
                    } catch (_: Exception) { unreadable++ }
                }
            }
            println("SOURCE_EVENTS originals=$originals with_text=$originalText blank=$originalBlank unreadable=$unreadable displayMatches=$matches displayMismatches=$mismatches notDisplayed=$notDisplayed")
            println("SOURCE_OMISSIONS " + omissionReasons.entries.sortedBy { it.key }.joinToString(" ") { "${it.key}=${it.value}" })
            counts("HISTORY", """
                SELECT count(*) AS commits, (SELECT count(*) FROM operations) AS operations,
                  (SELECT count(*) FROM blob_catalog) AS blobs FROM commits
            """.trimIndent())
        }
    }
}
