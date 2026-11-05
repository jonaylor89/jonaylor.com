package app.mypeople

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import app.mypeople.ui.MyPeople

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val graph = (application as MyPeopleApp).graph
        if (intent?.action != android.content.Intent.ACTION_MAIN) graph.incoming.value = intent
        setContent {
            MyPeople(graph) {
                reportFullyDrawn()
                if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0)
                    android.util.Log.i("MyPeopleStartup", "content=${android.os.SystemClock.elapsedRealtime() - android.os.Process.getStartElapsedRealtime()}ms")
            }
        }
    }
    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        (application as MyPeopleApp).graph.incoming.value = intent
    }
}
