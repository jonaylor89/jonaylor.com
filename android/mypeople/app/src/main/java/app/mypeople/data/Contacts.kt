package app.mypeople.data

import com.google.i18n.phonenumbers.PhoneNumberUtil
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import java.util.Base64
import java.util.Locale
import java.util.UUID

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class ContactField(val kind: String, val value: String, val label: String = "", val preferred: Boolean = false, val structured: String = "", val region: String = "",
    @EncodeDefault(EncodeDefault.Mode.NEVER) val user_added: Boolean = false,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val object_id: String = "")

@Serializable
data class ContactCard(
    val name: String,
    val given: String = "", val family: String = "", val middle: String = "",
    val prefix: String = "", val suffix: String = "", val phonetic: String = "",
    val fields: List<ContactField> = emptyList(),
    val birthday: String = "", val organization: String = "", val title: String = "",
    val notes: String = "", val photo: String = "", val favorite: Boolean = false,
    val preferred_channel: String = "", val region: String = "US",
    val originals: List<String> = emptyList(),
    val source_records: List<String> = emptyList(),
    val user_edited: Boolean = false,
    val edit_id: String = "",
    val legacy_unverified: Boolean = false,
)

fun Person.contactCard(): ContactCard = card ?: ContactCard(name = name, legacy_unverified = true, fields = identifiers.filter { it.kind in setOf("phone", "email") }.map { ContactField(it.kind, it.value) })
fun Person.contactFields(): List<ContactField> = contactCard().fields
/** Old matching keys have no reliable country: never silently turn them into +1. */
fun ContactCard.canNormalizePhone(field: ContactField): Boolean = !legacy_unverified || hasInternationalPrefix(field.value)
/** Explicit identity merge, not an inferred overwrite or an importer match. */
fun mergeCards(a: ContactCard, b: ContactCard): ContactCard {
    val incoming = b.fields.map { if (it.kind == "phone" && it.region.isEmpty()) it.copy(region = b.region) else it }
    val fields = (a.fields + incoming).distinct()
    return a.copy(
        given = a.given.ifBlank { b.given }, family = a.family.ifBlank { b.family },
        middle = a.middle.ifBlank { b.middle }, prefix = a.prefix.ifBlank { b.prefix }, suffix = a.suffix.ifBlank { b.suffix },
        phonetic = a.phonetic.ifBlank { b.phonetic }, birthday = a.birthday.ifBlank { b.birthday },
        organization = a.organization.ifBlank { b.organization }, title = a.title.ifBlank { b.title },
        notes = listOf(a.notes, b.notes).filter { it.isNotBlank() }.distinct().joinToString("\n\n"),
        photo = a.photo.ifBlank { b.photo }, favorite = a.favorite || b.favorite,
        preferred_channel = a.preferred_channel.ifBlank { b.preferred_channel },
        fields = fields, originals = (a.originals + b.originals).distinct(), source_records = (a.source_records + b.source_records).distinct(),
        legacy_unverified = a.legacy_unverified || b.legacy_unverified,
    )
}
/** Called by the editor only, never by imports, favorites, or Provider reconciliation. */
fun ContactCard.withManualWebsites(previous: ContactCard? = null): ContactCard {
    val known = previous?.fields.orEmpty().filter { it.kind == "website" }.map { it.value.trim() }.toSet()
    return copy(fields = fields.map { if (it.kind == "website" && it.value.trim() !in known) it.copy(user_added = true) else it })
}
fun newContactUid(): String = UUID.randomUUID().toString()

fun ContactCard.validate() {
    require(name.isNotBlank()) { "Enter a name." }
    require(json.encodeToString(ContactCard.serializer(), this).toByteArray().size <= 4 * 1024 * 1024) { "This contact exceeds the sync size limit. Reduce its photo or notes; originals have not been discarded." }
    require(fields.filter { it.object_id.isNotEmpty() }.map { it.object_id }.let { it.distinct().size == it.size }) { "A contact point cannot appear twice." }
    fields.filter { it.object_id.isNotEmpty() }.forEach { require(UUID.fromString(it.object_id).toString() == it.object_id) { "Invalid contact point identity" } }
    require(fields.size <= 500 && originals.sumOf { it.length } <= 2 * 1024 * 1024) { "This contact is too large." }
    val regions = PhoneNumberUtil.getInstance().supportedRegions
    require(region in regions) { "Use a supported country code, such as US, DE or GB." }
    require(fields.all { it.region.isEmpty() || it.region in regions }) { "Use a supported country code for each phone override, or leave it blank." }
    require(birthday.isEmpty() || normalizeDate(birthday).isNotEmpty()) { "Use YYYY-MM-DD or --MM-DD for birthdays." }
    if (photo.isNotEmpty()) {
        val bytes = Base64.getDecoder().decode(photo)
        require(bytes.size <= 2 * 1024 * 1024 && (bytes.take(3) == listOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte()) || bytes.take(4) == listOf(0x89.toByte(), 0x50.toByte(), 0x4e.toByte(), 0x47.toByte()))) { "Choose a JPEG/PNG photo under 2 MiB." }
    }
}

object VCards {
    private fun escape(s: String) = s.replace("\\", "\\\\").replace("\n", "\\n").replace(";", "\\;").replace(",", "\\,").replace("\r", "")
    private fun unescape(s: String): String {
        val out = StringBuilder(); var escaped = false
        for (c in s) { if (escaped) { out.append(if (c == 'n' || c == 'N') '\n' else c); escaped = false } else if (c == '\\') escaped = true else out.append(c) }
        if (escaped) out.append('\\')
        return out.toString()
    }
    private fun parts(s: String): List<String> = s.split(Regex("(?<!\\\\);" )).map(::unescape)
    private fun unfold(s: String): List<String> {
        val out = mutableListOf<String>()
        for (line in s.replace("\r\n", "\n").split('\n')) {
            if (line.startsWith(" ") || line.startsWith("\t")) { if (out.isNotEmpty()) out[out.lastIndex] += line.drop(1) }
            else out.add(line)
        }
        return out
    }
    private fun property(line: String) = line.substringBefore(':').substringBefore(';').substringAfterLast('.').uppercase(Locale.ROOT)
    fun parse(text: String): List<ContactCard> {
        require(text.toByteArray().size <= 16 * 1024 * 1024) { "vCard file is too large." }
        val result = mutableListOf<ContactCard>(); var lines: MutableList<String>? = null
        for (line in unfold(text)) {
            if (line.equals("BEGIN:VCARD", true)) { require(lines == null) { "Nested vCard." }; lines = mutableListOf(line) }
            else if (lines != null) {
                lines.add(line)
                if (line.equals("END:VCARD", true)) {
                    result.add(parseCard(lines)); lines = null
                    require(result.size <= 10000) { "Too many contacts." }
                }
            }
        }
        require(lines == null && result.isNotEmpty()) { "No complete contacts found." }
        return result
    }
    private fun parseCard(lines: List<String>): ContactCard {
        var card = ContactCard(""); val fields = mutableListOf<ContactField>(); val groups = mutableListOf<String>(); val labels = mutableMapOf<String, String>(); val originalPhones = mutableMapOf<String, String>()
        for (line in lines) {
            if (!line.contains(':')) continue
            val head = line.substringBefore(':'); val raw = line.substringAfter(':'); val value = unescape(raw)
            val params = head.substringAfter(';', "")
            val group = if (head.substringBefore(';').contains('.')) head.substringBefore('.') else ""
            val type = Regex("(?:^|;)TYPE=([^;]+)", RegexOption.IGNORE_CASE).find(params)?.groupValues?.get(1)?.trim('"') ?: ""
            val preferred = params.contains("PREF", true)
            when (property(line)) {
                "FN" -> card = card.copy(name = value)
                "N" -> { val p = parts(raw) + List(5) { "" }; card = card.copy(family = p[0], given = p[1], middle = p[2], prefix = p[3], suffix = p[4]) }
                "TEL", "EMAIL", "ADR", "URL", "IMPP", "ANNIVERSARY" -> {
                    val kind = mapOf("TEL" to "phone", "EMAIL" to "email", "ADR" to "address", "URL" to "website", "IMPP" to "im", "ANNIVERSARY" to "anniversary").getValue(property(line))
                    fields.add(ContactField(kind, if (kind == "address") parts(raw).filter { it.isNotBlank() }.joinToString("\n") else value.removePrefix(if (kind == "phone") "tel:" else ""), type, preferred, if (kind == "address") raw else "", Regex("(?:^|;)X-SHERLOQ-REGION=([A-Z]{2})", RegexOption.IGNORE_CASE).find(params)?.groupValues?.get(1)?.uppercase(Locale.ROOT).orEmpty())); groups.add(group)
                }
                "X-ABLABEL" -> labels[group] = value.removePrefix("_$!<").removeSuffix(">!\$_")
                "BDAY" -> card = card.copy(birthday = when { params.contains("OMIT-YEAR", true) -> "--${raw.takeLast(5)}"; raw.matches(Regex("--\\d{4}")) -> "--${raw.substring(2,4)}-${raw.takeLast(2)}"; raw.matches(Regex("\\d{8}")) -> "${raw.take(4)}-${raw.substring(4,6)}-${raw.takeLast(2)}"; else -> raw })
                "ORG" -> card = card.copy(organization = value)
                "TITLE" -> card = card.copy(title = value)
                "NOTE" -> card = card.copy(notes = value)
                "PHOTO" -> if (params.contains("ENCODING=b", true)) card = card.copy(photo = raw)
                "X-SHERLOQ-LEGACY-UNVERIFIED" -> card = card.copy(legacy_unverified = raw == "1")
                "X-SHERLOQ-FAVORITE" -> card = card.copy(favorite = raw == "1")
                "X-SHERLOQ-CHANNEL" -> card = card.copy(preferred_channel = value)
                "X-SHERLOQ-REGION" -> card = card.copy(region = value.uppercase(Locale.ROOT))
                "X-SHERLOQ-ORIGINAL-PHONE" -> originalPhones[group] = value
                "X-PHONETIC-FIRST-NAME" -> card = card.copy(phonetic = value)
                "X-SHERLOQ-SOURCE-RECORD" -> card = card.copy(source_records = card.source_records + value)
            }
        }
        card = card.copy(name = card.name.ifBlank { listOf(card.given, card.family).filter { it.isNotBlank() }.joinToString(" ").ifBlank { fields.firstOrNull()?.value ?: "Unnamed contact" } }, fields = fields.mapIndexed { i, f ->
            val original = originalPhones[groups[i]]
            val region = f.region.ifEmpty { card.region }
            val restoreOriginal = f.kind == "phone" && original != null && dialable(f.value, region) != null && dialable(original, region) == dialable(f.value, region)
            f.copy(label = labels[groups[i]] ?: f.label, value = if (restoreOriginal) original!! else f.value)
        }, originals = listOf(lines.joinToString("\r\n") + "\r\n"))
        // Originals retain unsupported photos even if they cannot be displayed.
        return runCatching { card.validate(); card }.getOrElse { card.copy(photo = "") }
    }
    private val owned = setOf("BEGIN", "END", "VERSION", "FN", "N", "TEL", "EMAIL", "ADR", "URL", "IMPP", "ANNIVERSARY", "BDAY", "ORG", "TITLE", "NOTE", "PHOTO", "X-ABLABEL", "X-SHERLOQ-FAVORITE", "X-SHERLOQ-CHANNEL", "X-SHERLOQ-REGION", "UID", "X-PHONETIC-FIRST-NAME", "X-SHERLOQ-SOURCE-RECORD", "X-SHERLOQ-ORIGINAL-PHONE", "X-SHERLOQ-LEGACY-UNVERIFIED")
    fun export(cards: List<ContactCard>): String = cards.joinToString("") { card ->
        val lines = mutableListOf("BEGIN:VCARD", "VERSION:3.0", "FN:${escape(card.name)}", "N:${listOf(card.family, card.given, card.middle, card.prefix, card.suffix).joinToString(";", transform = ::escape)}")
        card.fields.forEachIndexed { i, f ->
            val prop = mapOf("phone" to "TEL", "email" to "EMAIL", "address" to "ADR", "website" to "URL", "im" to "IMPP", "anniversary" to "ANNIVERSARY")[f.kind]
            if (prop != null) {
                val value = if (f.kind == "phone" && card.canNormalizePhone(f)) dialable(f.value, f.region.ifEmpty { card.region }) ?: f.value else f.value
                val raw = if (f.kind == "address") f.structured.ifEmpty { ";;${escape(f.value)};;;;" } else escape(value)
                lines.add("item$i.$prop${if (f.preferred) ";TYPE=PREF" else ""}${if (f.region.isNotEmpty()) ";X-SHERLOQ-REGION=${f.region}" else ""}:$raw")
                if (f.kind == "phone" && value != f.value) lines.add("item$i.X-SHERLOQ-ORIGINAL-PHONE:${escape(f.value)}")
                if (f.label.isNotBlank()) lines.add("item$i.X-ABLabel:${escape(f.label)}")
            }
        }
        listOf("BDAY" to card.birthday, "ORG" to card.organization, "TITLE" to card.title, "NOTE" to card.notes, "X-SHERLOQ-CHANNEL" to card.preferred_channel, "X-SHERLOQ-REGION" to card.region, "X-PHONETIC-FIRST-NAME" to card.phonetic).filter { it.second.isNotEmpty() }.forEach { (k, v) -> lines.add("$k:${escape(v)}") }
        if (card.photo.isNotEmpty()) lines.add("PHOTO;ENCODING=b;TYPE=JPEG:${card.photo}")
        if (card.favorite) lines.add("X-SHERLOQ-FAVORITE:1")
        if (card.legacy_unverified) lines.add("X-SHERLOQ-LEGACY-UNVERIFIED:1")
        // Unknown properties survive import/edit/export instead of silently disappearing.
        card.originals.flatMap(::unfold).filter { it.contains(':') && property(it) !in owned }.distinct().forEach(lines::add)
        lines.add("END:VCARD")
        lines.joinToString("\r\n", postfix = "\r\n") { line ->
            // Fold by UTF-8 byte length, never in the middle of a Unicode code point.
            val out = StringBuilder(); var bytes = 0
            line.codePoints().forEach { point -> val s = String(Character.toChars(point)); val n = s.toByteArray().size; if (bytes + n > 74) { out.append("\r\n "); bytes = 1 }; out.append(s); bytes += n }
            out.toString()
        }
    }
}

data class MigrationReport(val contacts: Int, val legacy: Int, val invalid: List<String>, val shared: List<String>) {
    fun summary() = "$contacts contacts\n$legacy need original contact re-import (legacy numbers/labels may be incomplete)\n${invalid.size} numbers need a country/format check\n${shared.size} shared identifiers — review, don't auto-merge" + (invalid + shared).take(30).joinToString("\n", prefix = "\n")
}
fun Records.migrationReport(): MigrationReport {
    val live = people.values.filterNot { it.trashed }; val seen = mutableMapOf<String, MutableSet<String>>(); val invalid = mutableListOf<String>()
    live.forEach { p -> p.contactFields().filter { it.kind in setOf("phone", "email") }.forEach { f ->
        val key = if (f.kind == "phone") dialable(f.value, f.region.ifEmpty { p.contactCard().region }) else f.value.lowercase().trim()
        if (key == null) invalid.add("${p.name}: ${f.value}") else seen.getOrPut("${f.kind}:$key") { mutableSetOf() }.add(p.name)
    } }
    return MigrationReport(live.size, live.count { it.card == null || it.card.legacy_unverified }, invalid, seen.filterValues { it.size > 1 }.map { "${it.key}: ${it.value.joinToString()}" })
}
