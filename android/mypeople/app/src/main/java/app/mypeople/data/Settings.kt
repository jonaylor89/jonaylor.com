package app.mypeople.data

import android.content.Context

/** This phone's preferences and transfer key, in app-private storage. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("sherloq", Context.MODE_PRIVATE)

    init {
        // An earlier version could connect to a server. Don't keep its address or token around.
        if (prefs.contains("server_url") || prefs.contains("token")) prefs.edit().remove("server_url").remove("token").apply()
    }

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
    fun prepareRestore(peopleFirst: Boolean) {
        check(prefs.edit().remove("transfer_password")
            .putBoolean("contacts_enabled", false).putBoolean("people_first", peopleFirst).commit()) { "Could not safely disconnect sync before restoring." }
    }
}
