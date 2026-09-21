package com.lifttrace.app.wear

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.navigation.NavHostController
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListScope
import androidx.wear.compose.foundation.lazy.ScalingLazyListState
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.foundation.rotary.RotaryScrollableDefaults
import androidx.wear.compose.foundation.rotary.rotaryScrollable
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.CircularProgressIndicator
import androidx.wear.compose.material3.FilledTonalIconButton
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TitleCard
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * LiftTrace on the wrist: the set you are on, logged between sets, and the
 * rest timer running where you can see it.
 *
 * Deliberately three screens. A watch in a gym is for the set in front of you:
 * planning a session, browsing the catalogue and reading statistics all stay
 * on the phone, where there is room for them.
 */
class MainActivity : ComponentActivity() {

    private lateinit var store: WearStore

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = WearStore(applicationContext)
        setContent { WearApp(store) }
    }

    override fun onResume() {
        super.onResume()
        // Coming back from the watch face should show where the session is now,
        // and is the moment to send anything logged while there was no signal.
        lifecycleScope.launch { store.refresh() }
    }
}

@Composable
fun WearApp(store: WearStore) {
    val nav = rememberSwipeDismissableNavController()
    val state by store.state.collectAsStateWithLifecycle()
    // The rest timer lives above the screens: it keeps running while you look
    // at the session, and swiping back does not lose the count. It is a
    // deadline rather than a countdown, so a sleeping screen costs nothing.
    val restEndsAt = remember { mutableLongStateOf(0L) }
    val restLength = remember { mutableLongStateOf(0L) }

    // "Set logged", said once and then gone, so a tap in a noisy gym is
    // answered by something other than a number quietly changing.
    val flash = state.flash
    if (flash != null) {
        LaunchedEffect(flash) {
            delay(1200)
            store.clearFlash()
        }
        AppScaffold {
            Box(
                modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    flash + (if (state.offline || state.pending > 0) ", waiting for a connection" else ""),
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.titleMedium,
                )
            }
        }
        return
    }

    AppScaffold {
        SwipeDismissableNavHost(navController = nav, startDestination = "session") {
            composable("session") { SessionScreen(store, nav, restEndsAt) }
            composable("log") { LogScreen(store, nav, restEndsAt, restLength) }
            composable("rest") { RestScreen(restEndsAt, restLength, nav) }
        }
    }
}

/**
 * A list the crown scrolls, not only a finger, so the bezel works the way it
 * does everywhere else on the watch.
 */
@Composable
private fun CrownColumn(
    listState: ScalingLazyListState,
    content: ScalingLazyListScope.() -> Unit,
) {
    val focus = remember { FocusRequester() }
    ScalingLazyColumn(
        state = listState,
        modifier = Modifier
            .fillMaxSize()
            .rotaryScrollable(RotaryScrollableDefaults.behavior(listState), focusRequester = focus),
        content = content,
    )
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
}

@Composable
private fun SessionScreen(store: WearStore, nav: NavHostController, restEndsAt: MutableState<Long>) {
    val state by store.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val listState = rememberScalingLazyListState()
    val next = Session.next(state.workout)

    ScreenScaffold(scrollState = listState) {
        if (!state.paired) {
            Box(
                modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 28.dp),
                contentAlignment = Alignment.Center,
            ) {
                Message(
                    title = "Pair from your phone",
                    body = "Open LiftTrace on your phone and sign in. The watch pairs itself.",
                )
            }
            return@ScreenScaffold
        }
        CrownColumn(listState) {
            item {
                ListHeader {
                    Text(
                        state.workout?.name ?: "LiftTrace",
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (state.pending > 0 || state.offline || state.error != null) {
                item { StatusLine(state) }
            }
            if (state.workout != null) {
                item {
                    Text(
                        Session.progress(state.workout) + " sets",
                        textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
                    )
                }
            }
            // Still resting: the count is one tap away rather than gone.
            if (restEndsAt.value > System.currentTimeMillis()) {
                item {
                    Button(
                        onClick = { nav.navigate("rest") },
                        label = { Text("Back to the timer") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            if (next != null) {
                item {
                    TitleCard(
                        onClick = { nav.navigate("log") },
                        title = { Text(next.exercise.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        val (weight, reps) = Session.suggest(next.exercise, next.setNumber - 1)
                        Text(
                            "Set ${next.setNumber} of ${next.exercise.total}" +
                                if (reps > 0) " · ${Session.weightText(weight, state.unit)} x $reps" else "",
                        )
                    }
                }
            } else if (state.workout?.finished == true) {
                item { Message(title = "Session done", body = "Every set is logged.") }
            }
            items(state.workout?.exercises.orEmpty(), key = { it.uuid }) { exercise ->
                TitleCard(
                    onClick = { nav.navigate("log") },
                    title = { Text(exercise.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("${exercise.done} of ${exercise.total} sets")
                }
            }
            item {
                Button(
                    onClick = { scope.launch { store.refresh() } },
                    label = { Text(if (state.loading) "Refreshing" else "Refresh") },
                    icon = { Icon(painter = painterResource(R.drawable.ic_refresh), contentDescription = null) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (state.workout == null) {
                item {
                    Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp)) {
                        Message(
                            title = if (state.loading) "Loading" else "Nothing planned today",
                            body = if (state.loading) "" else "Sessions you plan on your phone show up here.",
                        )
                    }
                }
            }
        }
    }
}

/**
 * The set in front of you. Everything is pre-filled from the plan or from the
 * set before it, so a normal set is one tap and a hard one is two or three:
 * nothing here asks for a keyboard.
 */
@Composable
private fun LogScreen(
    store: WearStore,
    nav: NavHostController,
    restEndsAt: MutableState<Long>,
    restLength: MutableState<Long>,
) {
    val state by store.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val listState = rememberScalingLazyListState()
    val haptics = LocalHapticFeedback.current
    val next = Session.next(state.workout)

    if (next == null) {
        ScreenScaffold(scrollState = listState) {
            Box(
                modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp),
                contentAlignment = Alignment.Center,
            ) {
                Message(title = "Nothing left", body = "Every set in this session is logged.")
            }
        }
        return
    }

    val suggested = Session.suggest(next.exercise, next.setNumber - 1)
    // Keyed on the set, so moving to the next one starts from its own numbers
    // rather than keeping what the last one was edited to.
    var weight by remember(next.set.uuid) { mutableStateOf(suggested.first) }
    var reps by remember(next.set.uuid) { mutableStateOf(suggested.second) }
    val step = Session.weightStep(state.unit)

    ScreenScaffold(scrollState = listState) {
        CrownColumn(listState) {
            item { ListHeader { Text(next.exercise.name, maxLines = 2, overflow = TextOverflow.Ellipsis) } }
            item {
                Text(
                    "Set ${next.setNumber} of ${next.exercise.total}" + if (next.set.warmup) " · warm-up" else "",
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                Stepper(
                    text = Session.weightText(weight, state.unit),
                    label = "weight",
                    onDown = { weight = maxOf(0.0, weight - step) },
                    onUp = { weight += step },
                )
            }
            item {
                Stepper(
                    text = "$reps reps",
                    label = "reps",
                    onDown = { reps = maxOf(0, reps - 1) },
                    onUp = { reps += 1 },
                )
            }
            item {
                Button(
                    onClick = {
                        runCatching { haptics.performHapticFeedback(HapticFeedbackType.LongPress) }
                        scope.launch {
                            store.logSet(next.exercise.uuid, next.set.uuid, weight, reps)
                        }
                        if (store.state.value.restAutoStart) {
                            val seconds = store.state.value.restSeconds
                            restLength.value = seconds.toLong()
                            restEndsAt.value = System.currentTimeMillis() + seconds * 1000L
                            nav.navigate("rest") { popUpTo("session") }
                        } else {
                            nav.popBackStack()
                        }
                    },
                    label = { Text("Log set") },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

/** A number with a tap either side of it, sized for a thumb. */
@Composable
private fun Stepper(text: String, label: String, onDown: () -> Unit, onUp: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    val tap = { action: () -> Unit ->
        runCatching { haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove) }
        action()
    }
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        FilledTonalIconButton(
            onClick = { tap(onDown) },
            modifier = Modifier.size(40.dp),
        ) { Text("−") }
        Text(
            text,
            textAlign = TextAlign.Center,
            maxLines = 1,
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.weight(1f).padding(horizontal = 4.dp),
        )
        FilledTonalIconButton(
            onClick = { tap(onUp) },
            modifier = Modifier.size(40.dp),
        ) { Text("+") }
    }
}

/**
 * The rest between sets, counting down where a glance finds it. The watch
 * buzzes at the end, which is the whole reason to have this on a wrist rather
 * than on a phone in a bag.
 */
@Composable
private fun RestScreen(restEndsAt: MutableState<Long>, restLength: MutableState<Long>, nav: NavHostController) {
    val context = LocalContext.current
    var remaining by remember { mutableStateOf(secondsLeft(restEndsAt.value)) }
    var buzzed by remember { mutableStateOf(false) }

    LaunchedEffect(restEndsAt.value) {
        buzzed = false
        while (true) {
            remaining = secondsLeft(restEndsAt.value)
            if (remaining <= 0) break
            delay(250)
        }
        if (!buzzed) {
            buzzed = true
            buzz(context)
        }
    }

    // A timer you have to keep awake with a finger is no timer at all.
    DisposableEffect(Unit) {
        val window = (context as? Activity)?.window
        window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }

    val total = maxOf(1L, restLength.value)
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(
            progress = { (remaining.toFloat() / total.toFloat()).coerceIn(0f, 1f) },
            modifier = Modifier.fillMaxSize().padding(4.dp),
        )
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier.padding(horizontal = 36.dp),
        ) {
            Text(
                if (remaining > 0) Session.clock(remaining.toInt()) else "Go",
                style = MaterialTheme.typography.displayMedium,
            )
            Text(
                if (remaining > 0) "Rest" else "Next set",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(
                modifier = Modifier.padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (remaining > 0) {
                    FilledTonalIconButton(
                        onClick = { restEndsAt.value += 30_000L; restLength.value += 30 },
                        modifier = Modifier.size(40.dp),
                    ) { Text("+30") }
                }
                FilledTonalIconButton(
                    onClick = {
                        restEndsAt.value = 0L
                        nav.popBackStack()
                    },
                    modifier = Modifier.size(40.dp),
                ) { Text(if (remaining > 0) "Skip" else "Done") }
            }
        }
    }
}

private fun secondsLeft(endsAt: Long): Long =
    if (endsAt <= 0L) 0L else maxOf(0L, (endsAt - System.currentTimeMillis() + 999) / 1000)

/** Rest is over: two short buzzes, which a sleeve does not hide. */
private fun buzz(context: android.content.Context) {
    val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        (context.getSystemService(VibratorManager::class.java))?.defaultVibrator
    } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Vibrator::class.java)
    }
    runCatching {
        vibrator?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 200, 120, 200), -1))
    }
}

@Composable
private fun StatusLine(state: WearStore.State) {
    val text = when {
        state.error != null -> state.error
        state.offline && state.pending > 0 -> "Offline, ${state.pending} waiting"
        state.offline -> "Offline"
        state.pending > 0 -> "${state.pending} waiting"
        else -> ""
    }
    if (text.isBlank()) return
    Text(
        text,
        textAlign = TextAlign.Center,
        color = if (state.error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.secondary,
        style = MaterialTheme.typography.labelSmall,
        modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
    )
}

@Composable
private fun Message(title: String, body: String) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(title, textAlign = TextAlign.Center, style = MaterialTheme.typography.titleMedium)
        if (body.isNotBlank()) {
            Text(
                body,
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}
