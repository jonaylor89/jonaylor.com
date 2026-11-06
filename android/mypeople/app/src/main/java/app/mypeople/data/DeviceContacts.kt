package app.mypeople.data

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentProviderOperation
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract as C
import android.provider.ContactsContract.CommonDataKinds as K
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.Base64

/** Only writes raw contacts owned by our account. Never updates Google/SIM/other raw contacts.
 * A persisted baseline distinguishes external edits from our own observer callbacks.
 * Conflicting edits stop at that contact until the user explicitly chooses a side.
 */
class DeviceContacts(private val context: Context, private val graph: app.mypeople.AppGraph) {
    companion object {
        const val ACCOUNT_TYPE = "app.sherloq.contacts"
        const val ACCOUNT_NAME = "Sherloq"
    }
    private val resolver = context.contentResolver
    private val mutex = Mutex()
    private val mirror = ContactMirror(File(context.filesDir, "contacts-mirror.json"))
    private var observer: android.database.ContentObserver? = null
    // Provider VERSION of each raw contact when it last settled, guarded by mutex. A contact whose
    // version and MyPeople card are both unchanged since then can't need work, so a reconcile
    // after one edit reads one row instead of every contact. Empty after a restart: one full pass.
    private val settledVersions = mutableMapOf<String, Long>()
    private fun observe() {
        if (observer != null) return
        val next = object : android.database.ContentObserver(android.os.Handler(android.os.Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) { graph.reconcileContacts() }
        }
        resolver.registerContentObserver(C.AUTHORITY_URI, true, next)
        observer = next
    }
    private val mutableStatus = kotlinx.coroutines.flow.MutableStateFlow("Android integration is off.")
    val statusFlow: kotlinx.coroutines.flow.StateFlow<String> = mutableStatus
    var status: String
        get() = mutableStatus.value
        private set(value) { mutableStatus.value = value }
    fun permitted() = listOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS).all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
    private fun syncUri(uri: Uri): Uri = uri.buildUpon().appendQueryParameter(C.CALLER_IS_SYNCADAPTER, "true").appendQueryParameter(C.RawContacts.ACCOUNT_NAME, ACCOUNT_NAME).appendQueryParameter(C.RawContacts.ACCOUNT_TYPE, ACCOUNT_TYPE).build()
    fun ensureAccount() {
        require(permitted()) { "Allow Contacts permission first." }
        val manager = AccountManager.get(context)
        val account = Account(ACCOUNT_NAME, ACCOUNT_TYPE)
        if (manager.getAccountsByType(ACCOUNT_TYPE).none { it == account }) {
            require(manager.addAccountExplicitly(account, null, null)) { "Could not add the MyPeople account." }
            // Explicitly re-enabling a removed account is a fresh export, not a
            // mass external deletion of every contact in the previous baseline.
            saveMirror(MirrorState())
        }
        android.content.ContentResolver.setIsSyncable(account, C.AUTHORITY, 1)
        android.content.ContentResolver.setSyncAutomatically(account, C.AUTHORITY, true)
    }
    private fun rawContacts(ours: Boolean, onlyUids: Set<String>? = null): List<Triple<Long, String, Boolean>> {
        if (onlyUids != null && onlyUids.isEmpty()) return emptyList()
        var selection = if (ours) "${C.RawContacts.ACCOUNT_TYPE}=?" else "(${C.RawContacts.ACCOUNT_TYPE} IS NULL OR ${C.RawContacts.ACCOUNT_TYPE}<>?) AND ${C.RawContacts.DELETED}=0"
        val args = mutableListOf(ACCOUNT_TYPE)
        if (onlyUids != null) {
            selection += " AND ${C.RawContacts.SOURCE_ID} IN (${onlyUids.joinToString { "?" }})"
            args.addAll(onlyUids)
        }
        return resolver.query(syncUri(C.RawContacts.CONTENT_URI), arrayOf(C.RawContacts._ID, C.RawContacts.SOURCE_ID, C.RawContacts.DELETED), selection, args.toTypedArray(), null)?.use { c ->
            buildList { while (c.moveToNext()) add(Triple(c.getLong(0), c.getString(1).orEmpty(), c.getInt(2) != 0)) }
        }.orEmpty()
    }
    private fun versions(onlyUids: Set<String>? = null): Map<String, Long> {
        if (onlyUids != null && onlyUids.isEmpty()) return emptyMap()
        var selection = "${C.RawContacts.ACCOUNT_TYPE}=? AND ${C.RawContacts.DELETED}=0"
        val args = mutableListOf(ACCOUNT_TYPE)
        if (onlyUids != null) {
            selection += " AND ${C.RawContacts.SOURCE_ID} IN (${onlyUids.joinToString { "?" }})"
            args.addAll(onlyUids)
        }
        return resolver.query(syncUri(C.RawContacts.CONTENT_URI), arrayOf(C.RawContacts.SOURCE_ID, C.RawContacts.VERSION), selection, args.toTypedArray(), null)?.use { c ->
            buildMap { while (c.moveToNext()) c.getString(0)?.let { put(it, c.getLong(1)) } }
        }.orEmpty()
    }
    private fun needsPhones(card: ContactCard) = card.legacy_unverified && card.fields.any { it.kind == "phone" }
    /** Nothing changed on either side since this contact last settled. */
    private fun settled(person: Person, old: MirrorEntry?, version: Long?, prefer: String): Boolean {
        if (prefer.isNotEmpty() || version == null || old == null || person.trashed || person.contact_conflicts.isNotEmpty()) return false
        if (settledVersions[person.contact_uid] != version) return false
        val local = person.contactCard()
        return local == old.local && !needsPhones(local) && !(local.fields.any { it.kind == "phone" } && old.phoneFormat != 1)
    }
    private fun readCard(rawId: Long, importing: Boolean = false): ContactCard {
        var card = ContactCard(""); val fields = mutableListOf<ContactField>(); var unknownCountry = false
        resolver.query(C.Data.CONTENT_URI, null, "${C.Data.RAW_CONTACT_ID}=?", arrayOf(rawId.toString()), C.Data._ID)?.use { c ->
            fun s(name: String) = c.getColumnIndex(name).takeIf { it >= 0 }?.let { c.getString(it) }.orEmpty()
            while (c.moveToNext()) {
                val value = s(C.Data.DATA1); val label = s(C.Data.DATA3).ifEmpty {
                    when (s(C.Data.DATA2)) { "1" -> "Home"; "2" -> if (s(C.Data.MIMETYPE) == K.Phone.CONTENT_ITEM_TYPE) "Mobile" else "Work"; "3" -> "Work"; else -> "Other" }
                }
                val pref = s(C.Data.IS_SUPER_PRIMARY) == "1"
                val before = fields.size
                val objectId = if (importing) "" else s(C.Data.SYNC1).takeIf { id -> runCatching { java.util.UUID.fromString(id).toString() == id }.getOrDefault(false) }.orEmpty()
                when (s(C.Data.MIMETYPE)) {
                    K.StructuredName.CONTENT_ITEM_TYPE -> card = card.copy(name = value, given = s(K.StructuredName.GIVEN_NAME), family = s(K.StructuredName.FAMILY_NAME), middle = s(K.StructuredName.MIDDLE_NAME), prefix = s(K.StructuredName.PREFIX), suffix = s(K.StructuredName.SUFFIX), phonetic = s(K.StructuredName.PHONETIC_GIVEN_NAME))
                    K.Phone.CONTENT_ITEM_TYPE -> {
                        val region = if (importing) phoneRegion(s(K.Phone.NORMALIZED_NUMBER)).orEmpty() else ""
                        if (importing && region.isEmpty() && !hasInternationalPrefix(value)) unknownCountry = true
                        fields.add(ContactField("phone", value, label, pref, region = region))
                    }
                    K.Email.CONTENT_ITEM_TYPE -> fields.add(ContactField("email", value, label, pref))
                    K.StructuredPostal.CONTENT_ITEM_TYPE -> fields.add(ContactField("address", value, label, pref))
                    K.Website.CONTENT_ITEM_TYPE -> fields.add(ContactField("website", value, label, pref))
                    K.Im.CONTENT_ITEM_TYPE -> fields.add(ContactField("im", value, label, pref))
                    K.Note.CONTENT_ITEM_TYPE -> card = card.copy(notes = value)
                    K.Organization.CONTENT_ITEM_TYPE -> card = card.copy(organization = value, title = s(K.Organization.TITLE))
                    K.Event.CONTENT_ITEM_TYPE -> if (s(K.Event.TYPE) == K.Event.TYPE_BIRTHDAY.toString()) card = card.copy(birthday = value) else fields.add(ContactField("anniversary", value, label))
                    K.Photo.CONTENT_ITEM_TYPE -> {
                        val index = c.getColumnIndex(K.Photo.PHOTO)
                        val bytes = if (index >= 0) c.getBlob(index) else null
                        if (bytes != null && bytes.size <= 2 * 1024 * 1024) card = card.copy(photo = Base64.getEncoder().encodeToString(bytes))
                    }
                }
                if (fields.size > before && objectId.isNotEmpty()) fields[fields.lastIndex] = fields.last().copy(object_id = objectId)
            }
        }
        val favorite = resolver.query(ContentUris.withAppendedId(C.RawContacts.CONTENT_URI, rawId), arrayOf(C.RawContacts.STARRED), null, null, null)?.use { it.moveToFirst() && it.getInt(0) != 0 } ?: false
        return card.copy(favorite = favorite, legacy_unverified = unknownCountry, name = card.name.ifBlank { fields.firstOrNull()?.value ?: "Unnamed contact" }, fields = fields)
    }
    suspend fun importCandidates(): List<ContactCard> = withContext(Dispatchers.IO) {
        require(ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED) { "Allow Contacts permission first." }
        rawContacts(false).map { readCard(it.first, importing = true) }
    }
    private fun write(uid: String, card: ContactCard, existing: Long?): Long {
        require(card.fields.sumOf { it.value.toByteArray().size + it.label.toByteArray().size } + card.notes.toByteArray().size <= 512 * 1024) { "This contact is too large for Android Contacts. Its original details are safe in MyPeople." }
        val ops = arrayListOf<ContentProviderOperation>()
        if (existing == null) ops.add(ContentProviderOperation.newInsert(syncUri(C.RawContacts.CONTENT_URI)).withValue(C.RawContacts.ACCOUNT_NAME, ACCOUNT_NAME).withValue(C.RawContacts.ACCOUNT_TYPE, ACCOUNT_TYPE).withValue(C.RawContacts.SOURCE_ID, uid).build())
        else ops.add(ContentProviderOperation.newDelete(C.Data.CONTENT_URI).withSelection("${C.Data.RAW_CONTACT_ID}=?", arrayOf(existing.toString())).build())
        fun data(mime: String, values: Map<String, Any?>) {
            val b = ContentProviderOperation.newInsert(syncUri(C.Data.CONTENT_URI)).withValue(C.Data.MIMETYPE, mime)
            if (existing == null) b.withValueBackReference(C.Data.RAW_CONTACT_ID, 0) else b.withValue(C.Data.RAW_CONTACT_ID, existing)
            values.forEach { (k, v) -> b.withValue(k, v) }; ops.add(b.build())
        }
        data(K.StructuredName.CONTENT_ITEM_TYPE, mapOf(K.StructuredName.DISPLAY_NAME to card.name, K.StructuredName.GIVEN_NAME to card.given, K.StructuredName.FAMILY_NAME to card.family, K.StructuredName.MIDDLE_NAME to card.middle, K.StructuredName.PREFIX to card.prefix, K.StructuredName.SUFFIX to card.suffix, K.StructuredName.PHONETIC_GIVEN_NAME to card.phonetic))
        for (f in card.fields) {
            val mime = mapOf("phone" to K.Phone.CONTENT_ITEM_TYPE, "email" to K.Email.CONTENT_ITEM_TYPE, "address" to K.StructuredPostal.CONTENT_ITEM_TYPE, "website" to K.Website.CONTENT_ITEM_TYPE, "im" to K.Im.CONTENT_ITEM_TYPE, "anniversary" to K.Event.CONTENT_ITEM_TYPE)[f.kind] ?: continue
            val values = mutableMapOf<String, Any?>(C.Data.DATA1 to (if (f.kind == "phone") phoneCallTarget(f.value, f.region.ifEmpty { card.region }) ?: f.value else f.value), C.Data.DATA2 to 0, C.Data.DATA3 to f.label, C.Data.IS_PRIMARY to if (f.preferred) 1 else 0, C.Data.IS_SUPER_PRIMARY to if (f.preferred) 1 else 0)
            if (f.object_id.isNotEmpty()) values[C.Data.SYNC1] = f.object_id
            data(mime, values)
        }
        if (card.notes.isNotEmpty()) data(K.Note.CONTENT_ITEM_TYPE, mapOf(K.Note.NOTE to card.notes))
        if (card.organization.isNotEmpty() || card.title.isNotEmpty()) data(K.Organization.CONTENT_ITEM_TYPE, mapOf(K.Organization.COMPANY to card.organization, K.Organization.TITLE to card.title))
        if (card.birthday.isNotEmpty()) data(K.Event.CONTENT_ITEM_TYPE, mapOf(K.Event.START_DATE to card.birthday, K.Event.TYPE to K.Event.TYPE_BIRTHDAY))
        if (card.photo.isNotEmpty()) {
            val original = Base64.getDecoder().decode(card.photo)
            val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            android.graphics.BitmapFactory.decodeByteArray(original, 0, original.size, bounds)
            require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Unreadable contact photo." }
            val options = android.graphics.BitmapFactory.Options()
            while (maxOf(bounds.outWidth, bounds.outHeight) / options.inSampleSize.coerceAtLeast(1) > 768) options.inSampleSize = options.inSampleSize.coerceAtLeast(1) * 2
            val bitmap = requireNotNull(android.graphics.BitmapFactory.decodeByteArray(original, 0, original.size, options)) { "Unreadable contact photo." }
            val scale = (384.0 / maxOf(bitmap.width, bitmap.height)).coerceAtMost(1.0)
            val small = android.graphics.Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt().coerceAtLeast(1), (bitmap.height * scale).toInt().coerceAtLeast(1), true)
            val out = java.io.ByteArrayOutputStream(); small.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, out)
            if (small !== bitmap) small.recycle(); bitmap.recycle()
            data(K.Photo.CONTENT_ITEM_TYPE, mapOf(K.Photo.PHOTO to out.toByteArray()))
        }
        val results = resolver.applyBatch(C.AUTHORITY, ops)
        val id = existing ?: ContentUris.parseId(requireNotNull(results.first().uri))
        resolver.update(syncUri(ContentUris.withAppendedId(C.RawContacts.CONTENT_URI, id)), android.content.ContentValues().apply { put(C.RawContacts.DIRTY, 0); put(C.RawContacts.STARRED, if (card.favorite) 1 else 0) }, null, null)
        return id
    }
    private fun originalField(f: ContactField, previous: MirrorEntry?, local: ContactCard): ContactField {
        if (f.object_id.isNotEmpty()) {
            val original = local.fields.firstOrNull { it.object_id == f.object_id }
            if (original != null) {
                val exported = previous?.exported?.fields?.firstOrNull { it.object_id == f.object_id }
                if (exported != null && exported.value == f.value && exported.label == f.label) return original.copy(preferred = f.preferred)
                return original.copy(value = f.value, label = f.label, preferred = f.preferred,
                    structured = f.structured.ifEmpty { original.structured })
            }
        }
        val index = previous?.exported?.fields?.indexOfFirst { it.kind == f.kind && it.value == f.value && it.label == f.label } ?: -1
        val original = previous?.local?.fields?.filter { it.kind in setOf("phone", "email", "address", "website", "im", "anniversary") }?.getOrNull(index)
        if (original != null) return original.copy(preferred = f.preferred)
        return local.fields.firstOrNull { it.kind == f.kind && it.value == f.value && it.label == f.label }?.copy(preferred = f.preferred)
            ?: f.copy(object_id = "", region = local.fields.firstOrNull { it.kind == f.kind && it.label == f.label }?.region.orEmpty())
    }
    private fun loadMirror(): MirrorState = mirror.load()
    private fun saveMirror(state: MirrorState) = mirror.save(state)
    suspend fun <T> exclusive(block: suspend () -> T): T = mutex.withLock { block() }
    private data class Outcome(val message: String, val conflicts: Boolean = false, val changed: Int = 0, val unverified: Int = 0)
    suspend fun reconcile(prefer: String = ""): String = reconcileScope(prefer, null).message
    suspend fun prepareMerge(personIds: Set<Int>) {
        val result = reconcileScope("", personIds)
        if (result.conflicts) throw EditRejected("Resolve Android contact conflicts for the selected people in Settings before merging. No merge was queued.")
    }
    private suspend fun reconcileScope(prefer: String, onlyPeople: Set<Int>?): Outcome {
        if (onlyPeople != null) return reconcileBatch(prefer, onlyPeople, true)
        // Release the lock between small batches. A two-person merge never queues
        // behind an entire address book's provider queries/photo writes.
        var changed = 0; var unverified = 0; val conflicts = mutableListOf<String>()
        // One query finds the few contacts that can need work; everyone else is skipped unread.
        val candidates = mutex.withLock { withContext(Dispatchers.IO) {
            if (!graph.settings.contactsEnabled || !permitted()) return@withContext graph.store.state.value.records.people.keys.toList()
            // Checked here too: when nothing needs work there's no batch to notice a removed account.
            if (AccountManager.get(context).getAccountsByType(ACCOUNT_TYPE).none { it.name == ACCOUNT_NAME }) {
                graph.settings.contactsEnabled = false
                status = "MyPeople Android account was removed. Integration paused; your MyPeople contacts were kept."
                return@withContext emptyList()
            }
            val baseline = loadMirror(); val current = versions()
            graph.store.state.value.records.people.filter { (_, person) ->
                if (person.contact_uid.isBlank()) false
                else if (!person.trashed && needsPhones(person.contactCard())) { unverified++; false }
                else !settled(person, baseline.entries[person.contact_uid], current[person.contact_uid], prefer)
            }.keys.toList()
        } }
        for (ids in candidates.chunked(8)) {
            val result = reconcileBatch(prefer, ids.toSet(), false)
            changed += result.changed; unverified += result.unverified
            if (result.conflicts) conflicts.add(result.message)
            kotlinx.coroutines.yield()
        }
        mutex.withLock { withContext(Dispatchers.IO) {
            if (graph.settings.contactsEnabled && permitted() && graph.store.state.value.ready) {
                val baseline = loadMirror(); val next = baseline.entries.toMutableMap()
                val live = graph.store.state.value.records.people.values.map { it.contact_uid }.toSet()
                for (raw in rawContacts(true)) if (raw.second !in live && raw.second in baseline.entries) {
                    resolver.delete(syncUri(ContentUris.withAppendedId(C.RawContacts.CONTENT_URI, raw.first)), null, null)
                    next.remove(raw.second)
                }
                saveMirror(MirrorState(next))
            }
        } }
        val message = if (conflicts.isNotEmpty()) conflicts.distinct().joinToString("\n") else "Android contacts up to date · $changed changes" +
            if (unverified > 0) "\n$unverified contacts need original numbers re-imported or verified before Android export." else ""
        status = message
        return Outcome(message, conflicts.isNotEmpty(), changed, unverified)
    }
    private suspend fun reconcileBatch(prefer: String, onlyPeople: Set<Int>, preparing: Boolean): Outcome = mutex.withLock { withContext(Dispatchers.IO) {
        if (!graph.settings.contactsEnabled || !permitted()) return@withContext Outcome("Contacts integration is off or permission was revoked.")
        if (AccountManager.get(context).getAccountsByType(ACCOUNT_TYPE).none { it.name == ACCOUNT_NAME }) {
            graph.settings.contactsEnabled = false
            status = "MyPeople Android account was removed. Integration paused; your MyPeople contacts were kept."
            return@withContext Outcome(status)
        }
        observe()
        if (!graph.store.state.value.ready) {
            if (preparing) throw EditRejected("Wait for the current sync to finish, then try merging again.")
            return@withContext Outcome(status, status.startsWith("Conflicts"))
        }
        val baseline = loadMirror()
        val people = graph.store.state.value.records.people.filterKeys { it in onlyPeople }
        val next = baseline.entries.toMutableMap(); val raws = rawContacts(true, people.values.map { it.contact_uid }.toSet()).associateBy { it.second }
        val conflicts = mutableListOf<String>(); val unverified = mutableListOf<String>(); var changed = 0; var edited = false
        val settledNow = mutableSetOf<String>()
        for ((id, person) in people) {
            val uid = person.contact_uid
            if (uid.isBlank()) continue
            if (person.contact_conflicts.isNotEmpty()) { conflicts.add("${person.name} (review offline edits in MyPeople)"); continue }
            val raw = raws[uid]; val old = baseline.entries[uid]
            val local = person.contactCard()
            if (!person.trashed && local.legacy_unverified && local.fields.any { it.kind == "phone" }) { unverified.add(person.name); continue }
            val external = raw?.takeUnless { it.third }?.let { readCard(it.first) }
            // Never overwrite an existing provider copy after losing our baseline.
            if (raw != null && old == null && prefer.isEmpty()) { conflicts.add(person.name); continue }
            val externalChanged = (raw != null && old == null) || (old != null && (external == null || external != old.exported))
            val localChanged = old != null && local != old.local
            if (externalChanged && (localChanged || person.trashed) && prefer.isEmpty()) { conflicts.add(person.name); continue }
            val preferLocal = externalChanged && (localChanged || person.trashed || old == null) && prefer == "mypeople"
            if (externalChanged && !preferLocal) {
                if (external == null) {
                    try { graph.store.enqueue("contact_trash", buildJsonObject { put("person_id", id); put("contact_uid", uid) }, expectedPerson = person) }
                    catch (_: EditRejected) { conflicts.add(person.name); continue }
                    if (raw != null) resolver.delete(syncUri(ContentUris.withAppendedId(C.RawContacts.CONTENT_URI, raw.first)), null, null)
                    next.remove(uid); settledVersions.remove(uid)
                } else {
                    // Preserve fields the provider can't represent and imported original properties.
                    val retained = local.fields.filter { it.kind !in setOf("phone", "email", "address", "website", "im", "anniversary") }
                    val updated = local.copy(favorite = external.favorite, name = external.name, given = external.given, family = external.family, middle = external.middle, prefix = external.prefix, suffix = external.suffix, phonetic = external.phonetic, fields = external.fields.map { f -> originalField(f, old, local) } + retained, birthday = external.birthday, organization = external.organization, title = external.title, notes = external.notes, photo = if (external.photo == old?.exported?.photo) local.photo else external.photo)
                    try { graph.store.saveContact(updated, id, expectedPerson = person, restore = person.trashed) }
                    catch (_: EditRejected) { conflicts.add(person.name); continue }
                    next[uid] = MirrorEntry(raw.first, external, updated, old?.phoneFormat ?: 0)
                    settledNow.add(uid)
                }
                changed++; edited = true; continue
            }
            if (person.trashed) {
                if (raw != null) resolver.delete(syncUri(ContentUris.withAppendedId(C.RawContacts.CONTENT_URI, raw.first)), null, null)
                next.remove(uid); settledVersions.remove(uid); continue
            }
            if (raw == null || raw.third || localChanged || preferLocal || (local.fields.any { it.kind == "phone" } && old?.phoneFormat != 1)) {
                if (raw?.third == true) resolver.delete(syncUri(ContentUris.withAppendedId(C.RawContacts.CONTENT_URI, raw.first)), null, null)
                val rawId = write(uid, local, raw?.takeUnless { it.third }?.first)
                next[uid] = MirrorEntry(rawId, readCard(rawId), local, phoneFormat = 1); changed++
            }
            settledNow.add(uid)
        }
        saveMirror(MirrorState(next))
        settledVersions.putAll(versions(settledNow))
        var message = if (conflicts.isEmpty()) "Android contacts up to date · $changed changes" else "Conflicts (left untouched): ${conflicts.joinToString()}. Choose which version to keep in Settings."
        if (unverified.isNotEmpty()) message += "\n${unverified.size} contacts need original numbers re-imported or verified before Android export."
        Outcome(message, conflicts.isNotEmpty(), changed, unverified.size)
    } }
    fun uidFor(uri: Uri): String? = uidsFor(uri).singleOrNull()
    fun uidsFor(uri: Uri): List<String> {
        if (uri.authority != C.AUTHORITY) return emptyList()
        val contactId = resolver.query(uri, arrayOf(C.Contacts._ID), null, null, null)?.use { if (it.moveToFirst()) it.getLong(0) else null } ?: return emptyList()
        return resolver.query(C.RawContacts.CONTENT_URI, arrayOf(C.RawContacts.SOURCE_ID), "${C.RawContacts.CONTACT_ID}=? AND ${C.RawContacts.ACCOUNT_TYPE}=?", arrayOf(contactId.toString(), ACCOUNT_TYPE), null)?.use { c -> buildList { while (c.moveToNext()) c.getString(0)?.let { add(it) } }.distinct() }.orEmpty()
    }
    fun lookup(uid: String, mime: String? = null): Uri? {
        val raw = rawContacts(true).firstOrNull { it.second == uid && !it.third } ?: return null
        if (mime == K.Phone.CONTENT_TYPE || mime == K.Phone.CONTENT_ITEM_TYPE || mime == K.Email.CONTENT_TYPE || mime == K.Email.CONTENT_ITEM_TYPE) {
            val item = if (mime.contains("phone")) K.Phone.CONTENT_ITEM_TYPE else K.Email.CONTENT_ITEM_TYPE
            return resolver.query(C.Data.CONTENT_URI, arrayOf(C.Data._ID), "${C.Data.RAW_CONTACT_ID}=? AND ${C.Data.MIMETYPE}=?", arrayOf(raw.first.toString(), item), "${C.Data.IS_SUPER_PRIMARY} DESC")?.use { if (it.moveToFirst()) ContentUris.withAppendedId(C.Data.CONTENT_URI, it.getLong(0)) else null }
        }
        val contactId = resolver.query(ContentUris.withAppendedId(C.RawContacts.CONTENT_URI, raw.first), arrayOf(C.RawContacts.CONTACT_ID), null, null, null)?.use { if (it.moveToFirst()) it.getLong(0) else null } ?: return null
        return C.Contacts.getLookupUri(resolver, ContentUris.withAppendedId(C.Contacts.CONTENT_URI, contactId))
    }
}
