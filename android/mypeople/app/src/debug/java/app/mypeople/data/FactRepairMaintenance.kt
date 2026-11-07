package app.mypeople.data

import android.app.Instrumentation
import android.content.Context
import android.os.Bundle
import android.os.PowerManager
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable
private data class CardFactRepairPlan(val token: String, val collection: String, val heads: List<String>, val edges: List<String>)

/** Explicit operator recovery, not a test runner. Never seed, reset, or overwrite a book. */
class FactRepairMaintenance : Instrumentation() {
    private var options = Bundle()
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); options = arguments ?: Bundle(); start() }
    override fun onStart() {
        val context = targetContext
        val output = Bundle()
        val lock = (context.getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MyPeople:fact-repair")
        try {
            require(File(context.cacheDir, "index-maintenance").isFile)
            lock.acquire(30 * 60 * 1000L)
            runBlocking {
                val directory = File(context.filesDir, "memory")
                val store = Store(directory); store.initialize()
                val state = store.snapshot()
                val native = requireNotNull(state.graph)
                val planFile = File(context.cacheDir, "card-fact-repair-plan.json")
                if (options.getString("op") == "preview") {
                    val edges = GraphStore(native).repairableCardFactAttributions()
                    val plan = CardFactRepairPlan(UUID.randomUUID().toString(), native.bundle.collection, native.bundle.heads, edges)
                    maintenanceWrite(planFile, json.encodeToString(plan))
                    output.putString("stream", "FACT REPAIR PREVIEW attributions=${edges.size} plan=${plan.token}")
                } else {
                    require(options.getString("op") == "apply")
                    val plan = json.decodeFromString<CardFactRepairPlan>(planFile.readText())
                    require(options.getString("confirm") == plan.token)
                    require(native.bundle.collection == plan.collection && native.bundle.heads == plan.heads)
                    require(GraphStore(native).repairableCardFactAttributions() == plan.edges)
                    if (plan.edges.isEmpty()) output.putString("stream", "FACT REPAIR APPLIED attributions=0")
                    else {
                        val recovery = verifiedMaintenanceRecovery(context, state, "fact-repair", json.encodeToString(plan))
                        store.repairCardFactAttributions(plan.heads, plan.edges)
                        val reopened = Store(directory); reopened.initialize()
                        val gs = GraphStore(reopened.snapshot().graph!!)
                        require(plan.edges.all { gs.graph.active(it) })
                        val committed = gs.graph.ordered.last().operations
                        require(committed.size == plan.edges.size && committed.all {
                            it.kind == "set_lifecycle" && it.target in plan.edges && it.payload["value"] == kotlinx.serialization.json.JsonPrimitive("active")
                        }) { "Unexpected authority change; recovery retained" }
                        maintenanceWrite(File(recovery, "result.txt"), "attributions=${plan.edges.size}\n")
                        output.putString("stream", "FACT REPAIR APPLIED attributions=${plan.edges.size} recovery=${recovery.name}")
                    }
                }
            }
            finish(0, output)
        } catch (error: Throwable) {
            output.putString("stream", "Fact repair stopped: ${error.javaClass.simpleName}; history and recovery retained.")
            finish(1, output)
        } finally { if (lock.isHeld) lock.release() }
    }
}
