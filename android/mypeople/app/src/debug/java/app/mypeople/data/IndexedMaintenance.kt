package app.mypeople.data

import android.app.Instrumentation
import android.content.Context
import android.os.Bundle
import android.os.PowerManager
import java.io.File
import kotlinx.coroutines.runBlocking

/** Operator-invoked migration/health/backup commands on the EXISTING store.
 * No fixtures, edits, provider calls, resets, defaults or personal payload logs. */
class IndexedMaintenance : Instrumentation() {
    private var options=Bundle()
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); options=arguments ?: Bundle(); start() }
    override fun onStart() {
        val context=targetContext
        val marker=File(context.cacheDir,"index-maintenance")
        val output=Bundle()
        val lock=(context.getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"MyPeople:index-maintenance")
        try {
            require(marker.isFile) { "Stop the app and explicitly prepare maintenance first" }
            lock.acquire(30*60*1000L)
            runBlocking {
                val directory=File(context.filesDir,"memory")
                val op=options.getString("op") ?: "check"
                val start=System.nanoTime()
                if (op == "verify-backup") {
                    val archive=LargeArchive.read(File(context.cacheDir,"indexed-before.sherloq"),File(context.cacheDir,"indexed-key").readText().trim(),context.cacheDir,File(directory,"graph-blobs")).backup!!
                    output.putString("stream","BACKUP VERIFIED graph=${archive.state.graph != null} pending=${archive.state.pending.size}")
                } else {
                    require(op in setOf("index","check","backup"))
                    val stages=mutableListOf<String>()
                    val store=Store(directory,startupTiming={stage,ms->stages+="$stage=${ms}ms"}); store.initialize()
                    val state=store.snapshot(); val records=store.state.value.records
                    val graph=state.graph!!.bundle.reducer as IndexedGraph
                    if (op == "backup") {
                        val photos=File(context.filesDir,"offline-photos").listFiles().orEmpty().filter { it.isFile && Regex("[0-9a-f]{64}").matches(it.name) }.associateBy { it.name }
                        java.io.FileOutputStream(File(context.cacheDir,"indexed-before.sherloq")).use { file ->
                            LargeArchive.writeBackup(ContactBackup(state=state),photos,file,File(context.cacheDir,"indexed-key").readText().trim(),context.cacheDir,File(directory,"graph-blobs")); file.fd.sync()
                        }
                    }
                    output.putString("stream","INDEXED READY people=${records.people.size} messages=${records.people.values.sumOf { p->p.channels.sumOf { it.count } }} commits=${graph.commits.size} operations=${graph.database.scalar("SELECT count(*) FROM operations")} blobs=${state.graph.bundle.blobs.size} pending=${state.pending.size} failed=${state.failedEdits.size} elapsedMs=${(System.nanoTime()-start)/1000000} stages=$stages")
                }
            }
            finish(0,output)
        } catch (error: Throwable) {
            output.putString("stream","Maintenance failed: ${error.javaClass.simpleName}; original data/recovery copies retained.")
            finish(1,output)
        } finally { if (lock.isHeld) lock.release() }
    }
}
