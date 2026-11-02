package com.parlo.app.data

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.parlo.app.ParloApp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/** Durable queue: survives service teardown, process death and network failures. */
class LearningWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        return try {
            val container = ParloApp.container(applicationContext)
            container.recovery.await()
            val apiKey = container.settings.apiKey.value
            if (apiKey.isBlank()) return Result.success() // Startup/key changes enqueue the persisted backlog again.
            val requested = inputData.getLong(SESSION, 0)
            val ids = if (requested != 0L) listOf(requested) else container.db.sessionDao().pendingMemory(3)
            for (id in ids) {
                withContext(Dispatchers.IO) { container.learning.consolidate(id, apiKey, container.memoryAnalyzer) }
                val s = container.sessions.getSession(id) ?: continue
                if (s.endedAt != null && s.remember) {
                    when (container.vocabCapture.mine(id)) {
                        is VocabCapture.Outcome.Failed -> return Result.retry()
                        VocabCapture.Outcome.NoApiKey -> return Result.retry()
                        else -> Unit
                    }
                }
            }
            // Successful backfill batches continue immediately. Backoff is only for actual failures.
            if (requested == 0L && container.db.sessionDao().pendingMemory(1).isNotEmpty()) {
                enqueue(applicationContext, continuation = true)
            }
            Result.success()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w("LearningWorker", "Checkpoint deferred; saved transcript will be retried", e)
            Result.retry()
        }
    }

    companion object {
        private const val SESSION = "session"
        fun enqueue(context: Context, sessionId: Long = 0, continuation: Boolean = false) {
            val request = OneTimeWorkRequestBuilder<LearningWorker>()
                .setInputData(Data.Builder().putLong(SESSION, sessionId).build())
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                "learning-$sessionId", if (sessionId == 0L && !continuation) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.APPEND_OR_REPLACE, request,
            )
        }
    }
}
