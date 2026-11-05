package app.mypeople.data

import android.content.Context

/** Where the server is and this phone's token. Stored in app-private preferences. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("sherloq", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("server_url", "") ?: ""
        set(value) = prefs.edit().putString("server_url", value.trim().trimEnd('/')).apply()

    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(value) = prefs.edit().putString("token", value.trim()).apply()

    var transferPassword: String
        get() = prefs.getString("transfer_password", "") ?: ""
        set(value) = prefs.edit().putString("transfer_password", value).apply()

    var peopleFirst: Boolean
        get() = prefs.getBoolean("people_first", true)
        set(value) = prefs.edit().putBoolean("people_first", value).apply()
    var contactsEnabled: Boolean
        get() = prefs.getBoolean("contacts_enabled", false)
        set(value) = prefs.edit().putBoolean("contacts_enabled", value).apply()
    /** Duplicate groups already shown in Review, so groups from a later sync can be marked new; null before the first visit. */
    var seenDuplicates: Set<String>?
        get() = prefs.getStringSet("seen_duplicates", null)?.toSet()
        set(value) = prefs.edit().apply { if (value == null) remove("seen_duplicates") else putStringSet("seen_duplicates", value.toSet()) }.apply()
    fun prepareRestore(origin: String, peopleFirst: Boolean) {
        check(prefs.edit().putString("server_url", origin).remove("token").remove("transfer_password")
            .putBoolean("contacts_enabled", false).putBoolean("people_first", peopleFirst).commit()) { "Could not safely disconnect sync before restoring." }
    }
    val configured: Boolean get() = serverUrl.isNotEmpty() && token.isNotEmpty()
}
