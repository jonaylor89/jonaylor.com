package app.mypeople.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class TransferTest {
    @get:Rule val temp = TemporaryFolder()
    private val source = "11111111-1111-4111-8111-111111111111"
    private val password = "synthetic-transfer-passphrase"
    private fun snapshot(revision: Long = 1) = TransferManifest(type = "snapshot", source = source, revision = revision,
        records = listOf(RecordChange("person", "1", json.encodeToJsonElement(Person("Sample Person")))))

    @Test fun `QR validates expiry addresses and capability without network URLs`() {
        val offer = BluetoothOffer("sherloq-bluetooth", 1, "AA:BB:CC:DD:EE:FF", source, password, source, "synthetic-token-for-testing", 150)
        offer.validate(100)
        try { offer.validate(151); fail("Reject expired QR") } catch (_: IllegalArgumentException) { }
        try { offer.copy(address = "https://example.com").validate(100); fail("Only Bluetooth addresses") } catch (_: IllegalArgumentException) { }
        try { offer.copy(token = "short").validate(100); fail("Reject invalid capability") } catch (_: IllegalArgumentException) { }
    }

    @Test fun `python encrypted fixture decrypts with photos`() {
        val encrypted = javaClass.getResourceAsStream("/python-memory.sherloq")!!.use { it.readBytes() }
        var photos = 0
        val manifest = Transfer.unpack(Transfer.decrypt(encrypted, password)) { _, bytes ->
            assertEquals("synthetic photo", bytes.toString(Charsets.UTF_8)); photos++
        }
        assertEquals(source, manifest.source)
        assertEquals("Sample Person", Records().applyChanges(manifest.records).people[1]?.name)
        assertEquals(1, photos)
    }

    @Test fun `wrong password and tampered files cannot decrypt`() {
        val encrypted = Transfer.encrypt(Transfer.pack(snapshot()), password)
        try { Transfer.decrypt(encrypted, "incorrect-passphrase"); fail("Expected failure") } catch (_: IllegalArgumentException) { }
        encrypted[encrypted.lastIndex] = (encrypted.last().toInt() xor 1).toByte()
        try { Transfer.decrypt(encrypted, password); fail("Expected authentication failure") } catch (_: IllegalArgumentException) { }
    }

    @Test fun `snapshot preserves queue and only receipts acknowledge it`() = runBlocking {
        val dir = temp.newFolder()
        val store = Store(dir)
        store.installOffline(snapshot())
        store.enqueue("rename", buildJsonObject { put("person_id", 1); put("name", "Optimistic") })
        val pending = store.state.value.pending.single()
        val exported = store.exportOffline()
        assertEquals(pending.client_id, exported.ops.single().client_id)
        assertEquals(1, store.state.value.pending.size) // exporting never clears or marks sent
        store.installOffline(snapshot(2))
        assertEquals("Optimistic", store.state.value.records.people[1]?.name)
        val receipt = OpState(0, pending.client_id, pending.kind, pending.payload, "done")
        store.installOffline(snapshot(3).copy(results = listOf(receipt)))
        val restarted = Store(dir)
        restarted.initialize()
        assertTrue(restarted.state.value.pending.isEmpty())
        assertEquals(source, restarted.state.value.offlineSource)
        assertEquals(3L, restarted.state.value.offlineRevision)
    }

    @Test fun `older files and foreign databases cannot overwrite memory or queue`() = runBlocking {
        val store = Store(temp.newFolder())
        store.installOffline(snapshot(2))
        store.enqueue("rename", buildJsonObject { put("person_id", 1); put("name", "Kept") })
        try { store.installOffline(snapshot(1)); fail("Reject old revision") } catch (_: IllegalArgumentException) { }
        try { store.installOffline(snapshot(3).copy(source = "22222222-2222-4222-8222-222222222222")); fail("Protect foreign queue") } catch (_: IllegalArgumentException) { }
        assertEquals("Kept", store.state.value.records.people[1]?.name)
        assertEquals(1, store.state.value.pending.size)
    }

    @Test fun `produce synthetic Android edits fixture for Python interop verification`() {
        val payload = buildJsonObject { put("person_id", 1); put("name", "From Android") }
        val manifest = TransferManifest(type = "edits", source = source, revision = 1,
            ops = listOf(PendingOp("22222222-2222-4222-8222-222222222222", "rename", payload)))
        File("build/interop-edits.sherloq").apply { parentFile.mkdirs(); writeBytes(Transfer.encrypt(Transfer.pack(manifest), password)) }
        assertEquals(manifest, Transfer.unpack(Transfer.decrypt(Transfer.encrypt(Transfer.pack(manifest), password), password)))
    }
}
