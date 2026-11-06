package app.mypeople.data

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class LargeArchiveTest {
    @get:Rule val temporary = TemporaryFolder()
    private val password = "synthetic-streaming-archive-passphrase"
    private fun state(): GraphState {
        val uid = UUID.randomUUID().toString()
        var state = GraphStore(GraphStore.empty()).saveCard(uid, ContactCard("Synthetic streaming person", notes = "Preserved note"))
        val bytes = ByteArray(2 * ChunkedCrypto.FRAME + 19) { (it % 251).toByte() }
        val hash = GraphStore.digest(bytes)
        val source = VersionedGraph.createObject("SourceRecord", buildJsonObject { put("original", buildJsonObject { put("blob_hash", hash) }) })
        state = GraphStore(state).commit(listOf(source), mapOf(hash to Base64.getEncoder().encodeToString(bytes)))
        return GraphStore(state).indexed()
    }
    @Test fun `Python authenticated frame fixture and raw blob archive decode identically`() {
        val password = "synthetic-stream-archive-cross-language"
        val encrypted = javaClass.getResource("/python-stream-envelope-v2.bin")!!.readBytes()
        val plain = ByteArrayOutputStream()
        ChunkedCrypto.decrypt(encrypted.inputStream(), plain, password)
        assertArrayEquals(ByteArray(257) { if (it < 256) it.toByte() else 'x'.code.toByte() }, plain.toByteArray())
        val archive = temporary.newFile("python.sherloq")
        javaClass.getResourceAsStream("/python-stream-archive-v2.sherloq")!!.use { input -> archive.outputStream().use { input.copyTo(it) } }
        val memory = LargeArchive.read(archive, password, temporary.root, temporary.newFolder()).memory!!
        val projected = GraphStore(GraphState(memory.graph!!)).project()
        assertEquals("Synthetic phone note 5", projected.people.values.single { it.contact_uid == "60000000-0000-4000-8000-000000000001" }.contactCard().notes)
        assertEquals(1, projected.people.values.sumOf { p -> p.channels.sumOf { it.count } })
        assertEquals(6, memory.results.count { it.status == "done" })
    }
    @Test fun `streaming envelope rejects wrong keys truncation corruption and appended bytes`() {
        val bytes = ByteArray(2 * ChunkedCrypto.FRAME + 37) { (it % 253).toByte() }
        val output = ByteArrayOutputStream()
        ChunkedCrypto.encrypt(ByteArrayInputStream(bytes), output, password)
        val encrypted = output.toByteArray()
        val restored = ByteArrayOutputStream()
        ChunkedCrypto.decrypt(ByteArrayInputStream(encrypted), restored, password)
        assertArrayEquals(bytes, restored.toByteArray())
        val damaged = encrypted.copyOf().also { it[100] = (it[100].toInt() xor 1).toByte() }
        for ((data, key) in listOf(encrypted to "wrong-synthetic-password", encrypted.copyOf(encrypted.size - 20) to password, damaged to password, (encrypted + byteArrayOf(0)) to password)) {
            try { ChunkedCrypto.decrypt(ByteArrayInputStream(data), ByteArrayOutputStream(), key); fail("Corrupt envelope accepted") } catch (_: Exception) { }
        }
    }
    @Test fun `file-backed snapshot and backup retain complete bytes through install restart and restore`() = runBlocking {
        val original = state()
        val file = temporary.newFile("memory.sherloq")
        val scratch = temporary.newFolder()
        val source = UUID.randomUUID().toString()
        val memory = TransferManifest(type = "snapshot", source = source, revision = 1, graph = original.bundle)
        file.outputStream().use { LargeArchive.writeMemory(memory, it, password, scratch) }
        val directory = temporary.newFolder()
        val decoded = LargeArchive.read(file, password, scratch, File(directory, "graph-blobs")).memory!!
        assertEquals(original.bundle.blobs, decoded.graph!!.blobs)
        assertTrue(decoded.graph!!.blobs is GraphBlobs)
        val store = Store(directory)
        store.installOffline(decoded)
        val before = store.state.value.records
        val restarted = Store(directory); restarted.initialize()
        assertEquals(before, restarted.state.value.records)
        assertEquals(original.bundle.blobs, restarted.snapshot().graph!!.bundle.blobs)
        val backup = temporary.newFile("backup.sherloq")
        backup.outputStream().use { LargeArchive.writeBackup(ContactBackup(state = restarted.snapshot()), emptyMap(), it, password, scratch, File(directory, "graph-blobs")) }
        val destination = temporary.newFolder()
        val saved = LargeArchive.read(backup, password, scratch, File(destination, "graph-blobs")).backup!!
        assertEquals(restarted.snapshot(), saved.state)
        val restored = Store(destination); restored.restoreBackup(saved.state)
        assertEquals(before, restored.state.value.records)
    }
    @Test fun `checkpoint version eight binds external blobs and refuses missing data`() {
        val state = state()
        val directory = temporary.newFolder()
        val encoded = ByteArrayOutputStream()
        StoreCheckpoint.write(DiskState(graph = state), encoded, blobDirectory = directory)
        try { StoreCheckpoint.snapshot(encoded.toByteArray()); fail("External storage was not required") } catch (_: IllegalArgumentException) { }
        val read = StoreCheckpoint.snapshot(encoded.toByteArray(), directory).state
        assertEquals(state, read.graph)
        assertTrue(read.graph!!.bundle.blobs is GraphBlobs)
        File(directory, state.bundle.blobs.keys.first()).delete()
        try { StoreCheckpoint.snapshot(encoded.toByteArray(), directory); fail("Missing blob was ignored") } catch (_: IllegalArgumentException) { }
    }
    @Test fun `lazy blob unions and filters never read unrelated binary values`() {
        val root = temporary.newFolder()
        val bytes = "synthetic large body".toByteArray(); val hash = GraphStore.digest(bytes)
        GraphBlobs.put(root, hash, bytes.inputStream())
        val blobs = GraphBlobs.files(root, listOf(hash))
        File(root, hash).delete()
        val other = "synthetic new body".toByteArray(); val otherHash = GraphStore.digest(other)
        val merged = GraphBlobs.merge(blobs, mapOf(otherHash to Base64.getEncoder().encodeToString(other)))
        val selected = GraphBlobs.filter(merged) { it == otherHash }
        assertEquals(setOf(hash, otherHash), merged.keys)
        assertEquals(mapOf(otherHash to Base64.getEncoder().encodeToString(other)), selected)
    }
    @Test fun `a new large photo journals only its durable hash and survives restart`() = runBlocking {
        val directory = temporary.newFolder()
        val store = Store(directory)
        val id = store.saveContact(ContactCard("Synthetic new large photo"))
        val bytes = ByteArray(1024 * 1024).also { it[0] = 0x89.toByte(); it[1] = 0x50; it[2] = 0x4e; it[3] = 0x47 }
        val body = Base64.getEncoder().encodeToString(bytes)
        store.saveContact(store.state.value.records.people.getValue(id).contactCard().copy(photo = body), id)
        assertTrue(File(directory, "store.journal").length() < 64 * 1024)
        val restarted = Store(directory); restarted.initialize()
        val card = restarted.state.value.records.people.getValue(id).contactCard()
        assertEquals(GraphStore.digest(bytes), card.photo_hash)
        assertEquals("", card.photo)
        assertEquals(body, restarted.snapshot().graph!!.bundle.blobs[card.photo_hash])
    }
    @Test fun `graph photos stay as hashes through unrelated edits and explicit removal`() = runBlocking {
        val store = Store(temporary.newFolder())
        val image = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0, 1, 2, 3)
        val encoded = Base64.getEncoder().encodeToString(image)
        val id = store.saveContact(ContactCard("Synthetic photo", photo = encoded))
        val card = store.state.value.records.people.getValue(id).contactCard()
        val hash = GraphStore.digest(image)
        assertEquals("", card.photo); assertEquals(hash, card.photo_hash)
        store.saveContact(card.copy(favorite = true), id)
        assertEquals(hash, store.state.value.records.people.getValue(id).contactCard().photo_hash)
        assertEquals(encoded, store.snapshot().graph!!.bundle.blobs[hash])
        store.saveContact(store.state.value.records.people.getValue(id).contactCard().copy(photo_hash = ""), id)
        assertEquals("", store.state.value.records.people.getValue(id).contactCard().photo_hash)
        assertEquals(encoded, store.snapshot().graph!!.bundle.blobs[hash])
    }
}
