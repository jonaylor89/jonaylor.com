package app.mypeople.ui

import app.mypeople.ui.icons.*

import androidx.compose.foundation.clickable
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.material.icons.outlined.*
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import app.mypeople.data.TabTapTracker
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.*
import app.mypeople.AppGraph
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
fun MyPeople(graph: AppGraph, onContentReady: () -> Unit = {}) {
    MyPeopleTheme {
        val state by graph.store.state.collectAsStateWithLifecycle()
        val nav = rememberNavController()
        val startDestination = remember { if (graph.settings.peopleFirst) "people" else "home" }
        val entry by nav.currentBackStackEntryAsState()
        val route = entry?.destination?.route
        val snackbar = remember { SnackbarHostState() }
        val scope = rememberCoroutineScope()
        val tabTaps = remember { TabTapTracker(android.view.ViewConfiguration.getDoubleTapTimeout().toLong()) }
        var resetSequence by rememberSaveable { mutableLongStateOf(0) }
        var resetTarget by rememberSaveable { mutableStateOf("") }
        fun topRequest(target: String): Long = if (resetTarget == target) resetSequence else 0
        ContactLaunchHandler(graph) { nav.navigate("person/$it") }
        val navigationLabel = MaterialTheme.typography.labelMedium.copy(
            fontSize = if (LocalDensity.current.fontScale > 1.3f) 11.sp else 12.sp,
            letterSpacing = 0.sp,
        )
        fun openTab(target: String) {
            if (nav.currentDestination == null) return
            nav.navigate(target) {
                popUpTo(nav.graph.startDestinationId) { saveState = true }
                launchSingleTop = true
                restoreState = true
            }
        }
        val openSettings = { openTab("settings") }
        fun returnToTop(target: String) {
            resetTarget = target
            resetSequence++
            if (nav.currentDestination?.route != target) nav.navigate(target) {
                popUpTo(nav.graph.startDestinationId) { saveState = false }
                launchSingleTop = true
                // A double tap must exit a detail page, not restore its saved stack.
                restoreState = false
            }
        }
        val lifecycle = LocalLifecycleOwner.current.lifecycle
        DisposableEffect(lifecycle) {
            val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) { graph.sync.now(); graph.reconcileContacts() } }
            lifecycle.addObserver(observer)
            onDispose { lifecycle.removeObserver(observer) }
        }
        LaunchedEffect(Unit) { graph.sync.now(); graph.feedback.collect { snackbar.showSnackbar(it) } }
        LaunchedEffect(state.notices.firstOrNull()?.id) {
            state.notices.firstOrNull()?.let { notice ->
                snackbar.showSnackbar(notice.message, duration = SnackbarDuration.Long)
                graph.store.dismissNotice(notice.id)
            }
        }
        LaunchedEffect(state.lastError) { state.lastError?.let { snackbar.showSnackbar(it) } }
        // Derive each tab's data off the main thread whenever records change.
        LaunchedEffect(state.records) { withContext(Dispatchers.Default) { Derived.prewarm(state.records, java.time.LocalDate.now()) } }
        LaunchedEffect(state.ready) {
            if (state.ready) { withFrameNanos { }; onContentReady() }
        }
        Scaffold(
            snackbarHost = { SnackbarHost(snackbar) { Snackbar(it, shape = RoundedCornerShape(KinRadius.sm)) } },
            bottomBar = {
                // Three destinations, never a fourth: settings live behind the account button.
                NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainer, tonalElevation = 0.dp) {
                    val destinations = listOf(
                        NavDestination("home", "Home", Symbols.Home, Symbols.HomeFilled),
                        NavDestination("people", "People", Symbols.Group, Symbols.GroupFilled),
                        NavDestination("review", "Fix & manage", Symbols.Build, Symbols.BuildFilled),
                    )
                    destinations.forEach { (target, label, icon, activeIcon) ->
                        val selected = route == target || (target == "people" && route == "person/{id}")
                        NavigationBarItem(selected = selected, enabled = entry != null, onClick = { if (tabTaps.tap(target, android.os.SystemClock.uptimeMillis())) returnToTop(target) else openTab(target) }, modifier = Modifier.testTag("nav-$target").semantics { customActions = listOf(CustomAccessibilityAction("Return to top of $label") { returnToTop(target); true }) }, icon = { Icon(if (selected) activeIcon else icon, contentDescription = null) }, label = { Text(label, style = navigationLabel, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            colors = NavigationBarItemDefaults.colors(indicatorColor = MaterialTheme.colorScheme.secondaryContainer, selectedIconColor = MaterialTheme.colorScheme.onSecondaryContainer, selectedTextColor = MaterialTheme.colorScheme.onSurface, unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant, unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant))
                    }
                }
            },
        ) { insets ->
            Column(Modifier.fillMaxSize().padding(insets)) {
                if (state.lastError != null || state.pending.isNotEmpty()) {
                    Surface(color = if (state.lastError != null) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer) {
                        Row(Modifier.fillMaxWidth().clickable { openTab("settings") }.heightIn(min = 48.dp).padding(horizontal = 24.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Icon(if (state.lastError != null) Icons.Outlined.CloudOff else Icons.Outlined.Schedule, null, Modifier.size(18.dp))
                            Text(if (!state.ready) "Couldn’t open saved memory" else if (state.lastError != null) "Couldn’t sync · viewing saved memory" else if (state.offlineSource != null) "${state.pending.size} queued · sync with your Mac" else "${state.pending.size} queued · waiting for your Mac", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                            if (!state.ready) TextButton(onClick = { graph.openMemory() }) { Text("Retry") }
                            else Icon(Icons.Default.ChevronRight, null, Modifier.size(18.dp))
                        }
                    }
                }
                Box(Modifier.weight(1f)) {
                // Create navigation immediately, independently of cache decoding. The actual
                // screen renders a few neutral rows during the one-time legacy migration.
                NavHost(nav, startDestination = startDestination) {
                    composable("home") { HomeScreen(state.records, graph, scrollToTopRequest = topRequest("home"), loading = !state.ready, openPeople = { openTab("people") }, openSettings = openSettings) { nav.navigate("person/$it") } }
                    composable("people") { PeopleScreen(state.records, graph, scrollToTopRequest = topRequest("people"), loading = !state.ready && state.records.people.isEmpty(), canEdit = state.ready, openSettings = openSettings) { nav.navigate("person/$it") } }
                    composable("review") { ReviewScreen(state.records, graph, scrollToTopRequest = topRequest("review"), loading = !state.ready, openSettings = openSettings) { nav.navigate("person/$it") } }
                    composable("settings") { SettingsScreen(graph, state, scrollToTopRequest = topRequest("settings"), onBack = { if (!nav.popBackStack()) openTab(startDestination) }) { message -> scope.launch { snackbar.showSnackbar(message) } } }
                    composable("person/{id}") { back ->
                        val id = back.arguments?.getString("id")?.toIntOrNull()
                        if (state.ready) PersonScreen(id, state, graph, onBack = { nav.popBackStack() })
                        else SavedRowsPlaceholder()
                    }
                }
                if (state.syncing) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp).align(Alignment.TopCenter), trackColor = MaterialTheme.colorScheme.surface)
                }
            }
        }
    }
}

private data class NavDestination(val route: String, val label: String, val icon: ImageVector, val activeIcon: ImageVector)
