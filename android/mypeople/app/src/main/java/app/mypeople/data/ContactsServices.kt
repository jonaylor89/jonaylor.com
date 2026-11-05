package app.mypeople.data

import android.accounts.*
import android.app.Service
import android.content.*
import android.os.Bundle
import android.os.IBinder

/** Local account identity only. There is no password or remote account sign-in. */
class ContactsAccountService : Service() {
    private lateinit var authenticator: AbstractAccountAuthenticator
    override fun onCreate() {
        super.onCreate()
        authenticator = object : AbstractAccountAuthenticator(this) {
            private fun unsupported() = Bundle().apply { putInt(AccountManager.KEY_ERROR_CODE, AccountManager.ERROR_CODE_UNSUPPORTED_OPERATION); putString(AccountManager.KEY_ERROR_MESSAGE, "Enable the local MyPeople account in MyPeople Settings.") }
            override fun editProperties(r: AccountAuthenticatorResponse, type: String) = unsupported()
            override fun addAccount(r: AccountAuthenticatorResponse, type: String, token: String?, features: Array<out String>?, options: Bundle?) = unsupported()
            override fun confirmCredentials(r: AccountAuthenticatorResponse, a: Account, options: Bundle?) = unsupported()
            override fun getAuthToken(r: AccountAuthenticatorResponse, a: Account, type: String, options: Bundle?) = unsupported()
            override fun getAuthTokenLabel(type: String) = "Local contacts"
            override fun updateCredentials(r: AccountAuthenticatorResponse, a: Account, type: String?, options: Bundle?) = unsupported()
            override fun hasFeatures(r: AccountAuthenticatorResponse, a: Account, f: Array<out String>) = Bundle().apply { putBoolean(AccountManager.KEY_BOOLEAN_RESULT, false) }
        }
    }
    override fun onBind(intent: Intent): IBinder = authenticator.iBinder
}

class ContactsSyncService : Service() {
    private lateinit var adapter: AbstractThreadedSyncAdapter
    override fun onCreate() {
        super.onCreate()
        adapter = object : AbstractThreadedSyncAdapter(this, true) {
            override fun onPerformSync(account: Account, extras: Bundle, authority: String, provider: ContentProviderClient, result: SyncResult) {
                val graph = (application as app.mypeople.MyPeopleApp).graph
                runContactsSyncTask({ result.stats.numAuthExceptions++ }, { result.stats.numIoExceptions++ }) {
                    graph.store.initialize()
                    graph.deviceContacts.reconcile()
                }
            }
        }
    }
    override fun onBind(intent: Intent): IBinder = adapter.syncAdapterBinder
}
