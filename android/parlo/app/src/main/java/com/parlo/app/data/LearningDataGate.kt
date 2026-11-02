package com.parlo.app.data

/** Cross-thread leases stop widget starts during restore and stale service teardown releasing a new walk. */
class LearningDataGate {
    private var session: Long? = null
    private var generation = 0L
    private var archive = false

    @Synchronized fun beginSession(): Long? {
        if (archive) return null
        return (++generation).also { session = it }
    }
    @Synchronized fun endSession(lease: Long?) { if (session == lease) session = null }
    @Synchronized fun beginArchive() {
        check(session == null && !archive) { "End your walk and wait for the current backup operation first" }
        archive = true
    }
    @Synchronized fun endArchive() { archive = false }
}
