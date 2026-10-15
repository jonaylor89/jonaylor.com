package com.parlo.app.gemini

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LiveToolDispatcherTest {
    private fun response(call: FunctionCall) = FunctionResponse(call.id, call.name, buildJsonObject { put("result", "ok") })

    @Test
    fun `slow tools do not block event handling and side effects stay ordered`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val handled = mutableListOf<String?>()
        val replies = mutableListOf<FunctionResponse>()
        val dispatcher = LiveToolDispatcher(backgroundScope, { "gemini-3.8-live" }, { call ->
            handled += call.id
            if (call.id == "slow") gate.await()
            response(call)
        }, replies::add)

        dispatcher.dispatch(listOf(FunctionCall("slow", "note_vocab"), FunctionCall("next", "show_phrase")))
        // Another event can run while the tool is waiting for persistence.
        val audioHandled = CompletableDeferred<Unit>()
        launch { audioHandled.complete(Unit) }
        runCurrent()
        assertTrue(audioHandled.isCompleted)
        assertEquals(listOf("slow"), handled)
        assertTrue(replies.isEmpty())
        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf("slow", "next"), handled)
        assertEquals(listOf("slow", "next"), replies.map { it.id })
        assertTrue(replies.all { it.scheduling == "SILENT" })
    }

    @Test
    fun `cancelled active and queued calls send no replies and do not block later tools`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val handled = mutableListOf<String?>()
        val replies = mutableListOf<FunctionResponse>()
        val dispatcher = LiveToolDispatcher(backgroundScope, { "gemini-3.8-live" }, { call ->
            handled += call.id
            if (call.id == "active") gate.await()
            response(call)
        }, replies::add)
        dispatcher.dispatch(listOf(
            FunctionCall("active", "note_vocab"),
            FunctionCall("queued", "show_phrase"),
            FunctionCall("keep", "update_walk"),
        ))
        runCurrent()
        dispatcher.cancel(listOf("active", "queued"))
        runCurrent()
        assertEquals(listOf("active", "keep"), handled)
        assertEquals(listOf("keep"), replies.map { it.id })
    }

    @Test
    fun `reconnect clears old tools before dispatching for a sequential-only model`() = runTest {
        var model = "gemini-3.8-live"
        val gate = CompletableDeferred<Unit>()
        val replies = mutableListOf<FunctionResponse>()
        val dispatcher = LiveToolDispatcher(backgroundScope, { model }, { call ->
            if (call.id == "old") gate.await()
            response(call)
        }, replies::add)
        dispatcher.dispatch(listOf(FunctionCall("old", "note_vocab")))
        runCurrent()
        dispatcher.clear()
        model = "gemini-3.1-flash-live-preview"
        dispatcher.dispatch(listOf(FunctionCall("new", "note_vocab")))
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf("new"), replies.map { it.id })
        assertEquals(null, replies.single().scheduling)
    }

    @Test
    fun `tool failure returns an error without losing subsequent calls or changing control tool scheduling`() = runTest {
        val replies = mutableListOf<FunctionResponse>()
        val dispatcher = LiveToolDispatcher(backgroundScope, { "gemini-3.8-live" }, { call ->
            if (call.id == "bad") error("disk unavailable")
            response(call)
        }, replies::add)
        dispatcher.dispatch(listOf(FunctionCall("bad", "save_vocab"), FunctionCall("switch", "switch_language")))
        runCurrent()
        assertTrue(replies.first().response.containsKey("error"))
        assertEquals("switch", replies.last().id)
        assertTrue(replies.all { it.scheduling == null })
    }
}
