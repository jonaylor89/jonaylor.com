package com.parlo.app.data

import org.junit.Assert.*
import org.junit.Test

class LearningDataGateTest {
    @Test fun `backup cannot replace a live walk and widgets cannot start during restore`() {
        val gate = LearningDataGate()
        val session = gate.beginSession()
        try { gate.beginArchive(); fail("Live walk must block restore") } catch (_: IllegalStateException) { }
        gate.endSession(session)
        gate.beginArchive()
        assertNull(gate.beginSession())
        gate.endArchive()
        assertNotNull(gate.beginSession())
    }

    @Test fun `stale teardown cannot release a newer service's lease`() {
        val gate = LearningDataGate()
        val old = gate.beginSession()
        val current = gate.beginSession()
        gate.endSession(old)
        try { gate.beginArchive(); fail("New walk must still own its lease") } catch (_: IllegalStateException) { }
        gate.endSession(current)
        gate.beginArchive()
    }
}
