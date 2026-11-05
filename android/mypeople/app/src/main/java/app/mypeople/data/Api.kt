package app.mypeople.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.addJsonObject
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiException(message: String) : IOException(message)

val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

/** Adds this device's token to requests for the sync server, and only those. */
class AuthInterceptor(private val settings: Settings) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): okhttp3.Response {
        val request = chain.request()
        val server = settings.serverUrl.toHttpUrlOrNull()
        val ours = server != null && request.url.scheme == server.scheme && request.url.host == server.host && request.url.port == server.port
        return chain.proceed(
            if (ours && settings.token.isNotEmpty()) request.newBuilder().header("Authorization", "Bearer ${settings.token}").build()
            else request
        )
    }
}

fun httpClient(settings: Settings): OkHttpClient = OkHttpClient.Builder()
    .addInterceptor(AuthInterceptor(settings))
    .followRedirects(false)
    .followSslRedirects(false)
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .build()

class Api(private val settings: Settings, private val client: OkHttpClient) {
    private fun url(path: String): String {
        val base = settings.serverUrl.trimEnd('/')
        if (base.isEmpty()) throw ApiException("Add your server in Settings first.")
        validateServerUrl(base)?.let { throw ApiException(it) }
        return base + path
    }

    private fun send(request: Request): String = try {
        client.newCall(request).execute().use { resp ->
            val body = resp.body.string()
            when {
                resp.isSuccessful -> body
                resp.code == 401 -> throw ApiException("The server doesn't know this phone. Check the token in Settings.")
                else -> throw ApiException("The server returned HTTP ${resp.code}. Try syncing again.")
            }
        }
    } catch (e: IllegalArgumentException) {
        throw ApiException("That server address isn't valid.")
    }

    fun changes(since: Long): Changes =
        json.decodeFromString(send(Request.Builder().url(url("/v1/changes?since=$since")).build()))

    fun sendOps(ops: List<PendingOp>): List<OpState> {
        val body = buildJsonObject {
            putJsonArray("ops") {
                for (op in ops) addJsonObject {
                    put("client_id", op.client_id)
                    put("kind", op.kind)
                    put("payload", op.payload)
                }
            }
        }
        val request = Request.Builder().url(url("/v1/ops"))
            .post(body.toString().toRequestBody("application/json".toMediaType())).build()
        val reply = json.decodeFromString<JsonObject>(send(request))
        return json.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(OpState.serializer()), reply["ops"]!!)
    }

    fun photoUrl(hash: String): String = settings.serverUrl.trimEnd('/') + "/v1/photos/$hash"
}
