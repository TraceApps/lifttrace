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
import androidx.compose.runtime.getValue
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
 * LiftTrace on the wrist: the session you are in, changed between sets, with
 * the timer running where you can see it.
 *
 * Four screens. The session and its exercises, one set at a time, and a timer.
 * Planning a session, the exercise catalogue and statistics stay on the phone,
 * where there is room for them; everything you do to a set while training is
 * here.
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

/**
 * A countdown the whole app can see: rest between sets, or a hold.
 *
 * The deadline is written down and an alarm is set for it, so the buzz
 * happens with the app long gone from the screen and the count is still right
 * when you raise your wrist and open it again.
 */
class Countdown(private val ctx: android.content.Context) {
    var label by mutableStateOf("")
        private set
    var total by mutableStateOf(0)
        private set
    var endsAt by mutableStateOf(0L)
        private set
    /** What to do when it reaches zero, for a hold that logs itself. */
    var onDone: (suspend () -> Unit)? = null
        private set
    /**
     * Has this one already rung? Looking at a timer that ran out while you
     * were on another screen should not buzz again, and a hold must be logged
     * once, not once per look.
     */
    var fired by mutableStateOf(true)
        private set

    init {
        Pairing.timer(ctx)?.let { saved ->
            label = saved.label
            total = saved.total
            endsAt = saved.endsAt
            fired = saved.endsAt <= System.currentTimeMillis()
        }
    }

    val running: Boolean get() = endsAt > System.currentTimeMillis()

    fun start(label: String, seconds: Int, onDone: (suspend () -> Unit)? = null) {
        this.label = label
        this.total = seconds
        this.endsAt = System.currentTimeMillis() + seconds * 1000L
        this.onDone = onDone
        this.fired = false
        remember()
    }

    fun extend(seconds: Int) {
        if (endsAt <= 0L) return
        endsAt += seconds * 1000L
        total += seconds
        remember()
    }

    fun markFired() {
        fired = true
    }

    fun stop() {
        endsAt = 0L
        onDone = null
        RestAlarm.cancel(ctx)
        Pairing.clearTimer(ctx)
    }

    private fun remember() {
        Pairing.putTimer(ctx, Pairing.Timer(label, total, endsAt))
        RestAlarm.schedule(ctx, endsAt)
    }

    fun secondsLeft(): Long =
        if (endsAt <= 0L) 0L else maxOf(0L, (endsAt - System.currentTimeMillis() + 999) / 1000)
}

@Composable
fun WearApp(store: WearStore) {
    val nav = rememberSwipeDismissableNavController()
    val state by store.state.collectAsStateWithLifecycle()
    // The timer lives above the screens: it keeps running while you look at
    // the session, and swiping back does not lose the count. It is a deadline
    // rather than a countdown, so a sleeping screen costs nothing.
    val context = LocalContext.current
    val clock = remember { Countdown(context.applicationContext) }
    // A set you are adding, held here until it is logged. Nothing is written
    // into the session by the act of tapping "Add a set", so backing out of
    // one leaves no empty set behind for the phone to inherit.
    var adding by remember { mutableStateOf<Session.Change?>(null) }

    // While the app is open, keep up with the phone: a set ticked off there
    // should not need the watch to be closed and opened again.
    LaunchedEffect(state.paired) {
        while (state.paired) {
            delay(45_000)
            store.refresh(quiet = true)
        }
    }

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
            composable("session") { SessionScreen(store, nav, clock) }
            composable("exercise/{uuid}") { entry ->
                ExerciseScreen(store, nav, entry.arguments?.getString("uuid").orEmpty()) { change ->
                    adding = change
                }
            }
            composable("set/{ex}/{set}") { entry ->
                SetScreen(
                    store, nav, clock,
                    entry.arguments?.getString("ex").orEmpty(),
                    entry.arguments?.getString("set").orEmpty(),
                    adding,
                )
            }
            composable("timer") { TimerScreen(clock, nav) }
            composable("time") { SessionTimeScreen(store, nav) }
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
private fun SessionScreen(store: WearStore, nav: NavHostController, clock: Countdown) {
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
            // How long you have been at it. The same timer the phone keeps, so
            // either can start it, and it is what the session's length is
            // written from. Tap it to start, pause or stop.
            if (state.workout != null) {
                item {
                    val session = state.session
                    var elapsed by remember(session) {
                        mutableStateOf(session?.elapsedMs(System.currentTimeMillis()) ?: 0L)
                    }
                    LaunchedEffect(session) {
                        while (session != null && !session.paused) {
                            elapsed = session.elapsedMs(System.currentTimeMillis())
                            delay(1000)
                        }
                    }
                    Button(
                        onClick = { nav.navigate("time") },
                        label = {
                            Text(
                                when {
                                    session == null -> "Start the session timer"
                                    session.paused -> Session.elapsed(elapsed) + " · paused"
                                    else -> Session.elapsed(elapsed)
                                },
                            )
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            if (state.workout != null) {
                item {
                    Text(
                        Session.progress(state.workout) + " sets" +
                            if (state.workout?.completed == true) " · finished" else "",
                        textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
                    )
                }
            }
            // The timer is reachable whether or not it starts by itself, and
            // whether you are between sets or between exercises.
            item {
                Button(
                    onClick = {
                        if (!clock.running) {
                            val up = state.workout?.let { Session.next(it)?.exercise }
                            clock.start(up?.name ?: "Rest", store.restFor(up?.uuid))
                        }
                        nav.navigate("timer")
                    },
                    label = { Text(if (clock.running) "Back to the timer" else "Start a rest") },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (next != null) {
                item {
                    TitleCard(
                        onClick = { nav.navigate("set/${next.exercise.uuid}/${next.set.uuid}") },
                        title = { Text(next.exercise.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            "Set ${next.setNumber} of ${next.exercise.total} · " +
                                Session.setLine(next.exercise, next.set, state.unit),
                        )
                    }
                }
            } else if (state.workout?.finished == true) {
                item { Message(title = "Every set is done", body = "Finish the session on your phone.") }
            }
            items(state.workout?.exercises.orEmpty(), key = { it.uuid }) { exercise ->
                TitleCard(
                    onClick = { nav.navigate("exercise/${exercise.uuid}") },
                    title = { Text(exercise.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        "${exercise.done} of ${exercise.total} sets" +
                            (if (exercise.inSuperset) " · superset" else "") +
                            (if (exercise.finished) " · done" else ""),
                    )
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

/** One exercise, every set it has, and the chance to add another. */
@Composable
private fun ExerciseScreen(
    store: WearStore,
    nav: NavHostController,
    exerciseUuid: String,
    onAdd: (Session.Change) -> Unit,
) {
    val state by store.state.collectAsStateWithLifecycle()
    val listState = rememberScalingLazyListState()
    val exercise = state.workout?.exercise(exerciseUuid)

    ScreenScaffold(scrollState = listState) {
        if (exercise == null) {
            Box(modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp), contentAlignment = Alignment.Center) {
                Message(title = "Not in this session", body = "It was removed on your phone.")
            }
            return@ScreenScaffold
        }
        CrownColumn(listState) {
            item { ListHeader { Text(exercise.name, maxLines = 2, overflow = TextOverflow.Ellipsis) } }
            exercise.sets.forEachIndexed { index, set ->
                item(key = set.uuid) {
                    TitleCard(
                        onClick = { nav.navigate("set/${exercise.uuid}/${set.uuid}") },
                        title = {
                            Text(
                                "Set ${index + 1}" +
                                    (if (set.warmup) " · warm-up" else "") +
                                    (if (set.completed) " · done" else ""),
                            )
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(Session.setLine(exercise, set, state.unit))
                    }
                }
            }
            item {
                Button(
                    onClick = {
                        val change = Session.addition(exercise)
                        onAdd(change)
                        nav.navigate("set/${exercise.uuid}/${change.setUuid}")
                    },
                    label = { Text("Add a set") },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

/**
 * One set, with everything about it you would change mid-session: the weight,
 * the reps (per side when the phone records them that way) or the hold, and
 * whether it is done. Nothing here asks for a keyboard.
 */
@Composable
private fun SetScreen(
    store: WearStore,
    nav: NavHostController,
    clock: Countdown,
    exerciseUuid: String,
    setUuid: String,
    adding: Session.Change?,
) {
    val state by store.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val listState = rememberScalingLazyListState()
    val haptics = LocalHapticFeedback.current
    val exercise = state.workout?.exercise(exerciseUuid)
    val index = exercise?.sets?.indexOfFirst { it.uuid == setUuid } ?: -1
    // A set being added is not in the session yet, so it is the one held
    // aside rather than one to look up.
    val fresh = if (index < 0 && adding?.setUuid == setUuid) adding else null

    if (exercise == null || (index < 0 && fresh == null)) {
        ScreenScaffold(scrollState = listState) {
            Box(modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp), contentAlignment = Alignment.Center) {
                Message(title = "That set is gone", body = "It was removed on your phone.")
            }
        }
        return
    }

    val suggested = fresh ?: Session.suggest(exercise, index)
    // Keyed on the set, so moving to another one starts from its own numbers
    // rather than keeping what the last one was edited to.
    var draft by remember(setUuid) { mutableStateOf(suggested) }
    val step = Session.weightStep(state.unit)
    val done = fresh == null && exercise.sets[index].completed
    val warmup = fresh == null && exercise.sets[index].warmup
    val position = if (fresh != null) "New set" else "Set ${index + 1} of ${exercise.total}"

    fun commit(change: Session.Change, word: String) {
        runCatching { haptics.performHapticFeedback(HapticFeedbackType.LongPress) }
        scope.launch { store.save(change, word) }
    }

    ScreenScaffold(scrollState = listState) {
        CrownColumn(listState) {
            item { ListHeader { Text(exercise.name, maxLines = 2, overflow = TextOverflow.Ellipsis) } }
            item {
                Text(
                    position +
                        (if (warmup) " · warm-up" else "") +
                        (if (done) " · done" else ""),
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            // What you did of this lift last time, when there is something to
            // say. One line, no tap, nothing to set up: the number you would
            // otherwise take your phone out to look up.
            state.lastTimes[exercise.exerciseId]?.let { last ->
                item {
                    Text(
                        "Last time " + last,
                        textAlign = TextAlign.Center,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.secondary,
                        modifier = Modifier.fillMaxWidth().padding(bottom = 2.dp),
                    )
                }
            }
            item {
                Stepper(
                    text = Session.weightText(draft.weight, state.unit),
                    onDown = { draft = draft.copy(weight = maxOf(0.0, draft.weight - step)) },
                    onUp = { draft = draft.copy(weight = draft.weight + step) },
                )
            }
            if (exercise.timed) {
                item {
                    Stepper(
                        text = Session.clock(draft.durationSec) + " hold",
                        onDown = { draft = draft.copy(durationSec = maxOf(0, draft.durationSec - 5)) },
                        onUp = { draft = draft.copy(durationSec = draft.durationSec + 5) },
                    )
                }
                item {
                    Button(
                        onClick = {
                            val seconds = draft.durationSec
                            val change = draft.copy(completed = true)
                            clock.start(exercise.name, maxOf(1, seconds)) {
                                store.save(change, "Hold logged")
                            }
                            nav.navigate("timer")
                        },
                        label = { Text("Start the hold") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            } else if (draft.repsLeft != null || draft.repsRight != null) {
                item {
                    Stepper(
                        text = "${draft.repsLeft ?: 0} left",
                        onDown = { draft = draft.copy(repsLeft = maxOf(0, (draft.repsLeft ?: 0) - 1)) },
                        onUp = { draft = draft.copy(repsLeft = (draft.repsLeft ?: 0) + 1) },
                    )
                }
                item {
                    Stepper(
                        text = "${draft.repsRight ?: 0} right",
                        onDown = { draft = draft.copy(repsRight = maxOf(0, (draft.repsRight ?: 0) - 1)) },
                        onUp = { draft = draft.copy(repsRight = (draft.repsRight ?: 0) + 1) },
                    )
                }
            } else {
                item {
                    Stepper(
                        text = "${draft.reps} reps",
                        onDown = { draft = draft.copy(reps = maxOf(0, draft.reps - 1)) },
                        onUp = { draft = draft.copy(reps = draft.reps + 1) },
                    )
                }
            }
            item {
                Button(
                    onClick = {
                        val change = draft.copy(completed = true)
                        // What the session will read like once this is in, so
                        // a superset's round can be judged before the save
                        // has been anywhere near the server.
                        val after = state.workout?.let { Session.applyChange(it, change) }
                        commit(change, if (done) "Set changed" else "Set logged")
                        val resting = !done && after != null &&
                            state.restEnabled && state.restAutoStart &&
                            Session.shouldRest(after, exerciseUuid, setUuid)
                        if (resting) {
                            val up = Session.upNext(after!!, exerciseUuid)
                            clock.start(up?.name ?: "Rest", store.restFor(exerciseUuid, after))
                            nav.navigate("timer") { popUpTo("session") }
                        } else {
                            nav.popBackStack()
                        }
                    },
                    label = {
                        Text(
                            when {
                                fresh != null -> "Add the set"
                                done -> "Save the change"
                                else -> "Log the set"
                            },
                        )
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (done) {
                item {
                    Button(
                        onClick = {
                            commit(draft.copy(completed = false), "Set reopened")
                            nav.popBackStack()
                        },
                        label = { Text("Mark it not done") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

/**
 * The session's own clock: how long you have been training, and the three
 * things you ever do to it. Stopping writes the length onto the session, so a
 * workout timed entirely from the wrist still has its length recorded.
 */
@Composable
private fun SessionTimeScreen(store: WearStore, nav: NavHostController) {
    val state by store.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val session = state.session
    var elapsed by remember(session) {
        mutableStateOf(session?.elapsedMs(System.currentTimeMillis()) ?: 0L)
    }
    LaunchedEffect(session) {
        while (session != null && !session.paused) {
            elapsed = session.elapsedMs(System.currentTimeMillis())
            delay(1000)
        }
    }

    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier.padding(horizontal = 24.dp),
        ) {
            Text(Session.elapsed(elapsed), style = MaterialTheme.typography.displayMedium)
            Text(
                when {
                    session == null -> "Not timing"
                    session.paused -> "Paused"
                    else -> "Session time"
                },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(bottom = 8.dp),
            )
            if (session == null) {
                Button(
                    onClick = {
                        store.startSession()
                        nav.popBackStack()
                    },
                    label = { Text("Start") },
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                // Words rather than glyphs: there is room on a screen of its
                // own, and a small round icon is a poor thing to aim at when
                // you are out of breath.
                Button(
                    onClick = { if (session.paused) store.resumeSession() else store.pauseSession() },
                    label = { Text(if (session.paused) "Resume" else "Pause") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = {
                        scope.launch { store.stopSession() }
                        nav.popBackStack()
                    },
                    label = { Text("Stop and save") },
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                )
            }
        }
    }
}

/** A number with a tap either side of it, sized for a thumb. */
@Composable
private fun Stepper(text: String, onDown: () -> Unit, onUp: () -> Unit) {
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
 * The rest between sets, or a hold, counting down where a glance finds it. The
 * watch buzzes at the end, which is the whole reason to have this on a wrist
 * rather than on a phone in a bag.
 */
@Composable
private fun TimerScreen(clock: Countdown, nav: NavHostController) {
    val context = LocalContext.current
    var remaining by remember { mutableStateOf(clock.secondsLeft()) }

    LaunchedEffect(clock.endsAt) {
        if (clock.endsAt <= 0L) return@LaunchedEffect
        while (true) {
            remaining = clock.secondsLeft()
            if (remaining <= 0L) break
            delay(250)
        }
        if (!clock.fired) {
            clock.markFired()
            // The alarm does the buzzing, so it happens whether or not this
            // screen is still up. Here there is only the hold to write down.
            clock.onDone?.invoke()
            clock.stop()
        }
    }

    // A timer you have to keep awake with a finger is no timer at all.
    DisposableEffect(Unit) {
        val window = (context as? Activity)?.window
        window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }

    val total = maxOf(1, clock.total)
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
                if (remaining > 0) clock.label else "Next set",
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(
                modifier = Modifier.padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (remaining > 0) {
                    FilledTonalIconButton(
                        onClick = { clock.extend(30) },
                        modifier = Modifier.size(40.dp),
                    ) { Text("+30") }
                }
                FilledTonalIconButton(
                    onClick = {
                        clock.stop()
                        nav.popBackStack()
                    },
                    modifier = Modifier.size(40.dp),
                ) { Text(if (remaining > 0) "Skip" else "Done") }
            }
        }
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
