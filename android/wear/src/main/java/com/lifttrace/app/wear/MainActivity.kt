package com.lifttrace.app.wear

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.navigation.NavHostController
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListScope
import androidx.wear.compose.foundation.lazy.ScalingLazyListState
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.foundation.rotary.RotaryScrollableDefaults
import androidx.wear.compose.foundation.rotary.rotaryScrollable
import androidx.wear.compose.material3.AlertDialog
import androidx.wear.compose.material3.AlertDialogDefaults
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.CircularProgressIndicator
import androidx.wear.compose.material3.ProgressIndicatorDefaults
import androidx.wear.compose.material3.EdgeButton
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
import kotlinx.coroutines.CoroutineScope
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
    /** Where to go on opening, when something outside the app said where. */
    private var route by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = WearStore(applicationContext)
        route = intent?.getStringExtra(EXTRA_ROUTE)
        setContent { WearApp(store, route) { route = null } }
    }

    // Tapping the rest on the watch face with the app already open: the same
    // journey, and it should still go to the timer rather than wherever the
    // app happened to be left.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        route = intent.getStringExtra(EXTRA_ROUTE)
    }

    companion object {
        const val EXTRA_ROUTE = "com.lifttrace.app.wear.ROUTE"
    }

    override fun onResume() {
        super.onResume()
        // The phone only sends a rest to a watch that has been used lately,
        // and this is what it goes by.
        Pairing.publishAwake(applicationContext)
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
    var onDone: (() -> Unit)? = null
        private set
    /**
     * Has this one already rung? Looking at a timer that ran out while you
     * were on another screen should not buzz again, and a hold must be logged
     * once, not once per look.
     */
    var fired by mutableStateOf(true)
        private set

    /**
     * The phone can start a rest too, and it arrives on a background service
     * as a written record rather than a call into this. Held as a field
     * because what registers it keeps only a weak reference.
     */
    private val watcher = Pairing.watch(ctx) { key ->
        if (key == Pairing.KEY_TIMER) reload()
    }

    init {
        reload()
    }

    /** Whatever the saved rest now says, without telling anyone about it. */
    private fun reload() {
        val saved = Pairing.timer(ctx)
        if (saved == null) {
            endsAt = 0L
            onDone = null
            fired = true
            return
        }
        label = saved.label
        total = saved.total
        endsAt = saved.endsAt
        fired = saved.endsAt <= System.currentTimeMillis()
    }

    val running: Boolean get() = endsAt > System.currentTimeMillis()

    fun start(label: String, seconds: Int, onDone: (() -> Unit)? = null) {
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
        RestOngoing.hide(ctx)
        Pairing.publishRest(ctx, null)
        // Skipping a hold means it was not held: it should not log itself
        // later because an alarm was still out there.
        Pairing.clearHold(ctx)
    }

    private fun remember() {
        Pairing.putTimer(ctx, Pairing.Timer(label, total, endsAt))
        RestAlarm.schedule(ctx, endsAt)
        RestOngoing.refresh(ctx)
        Pairing.publishRest(ctx, Pairing.Timer(label, total, endsAt))
    }

    fun secondsLeft(): Long =
        if (endsAt <= 0L) 0L else maxOf(0L, (endsAt - System.currentTimeMillis() + 999) / 1000)
}

@Composable
fun WearApp(store: WearStore, route: String? = null, onRouted: () -> Unit = {}) {
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

    // Opened from the rest on the watch face: go where it points, once.
    LaunchedEffect(route) {
        if (route != null) {
            nav.navigate(route)
            onRouted()
        }
    }

    // Asked the first time there is something to show, not on first launch:
    // a permission prompt makes sense next to the thing it is for. Refused,
    // everything still works except the entry on the face.
    val notify = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        RestOngoing.refresh(context)
    }
    val resting = clock.endsAt > 0L
    LaunchedEffect(resting) {
        if (!resting || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return@LaunchedEffect
        val granted = ContextCompat.checkSelfPermission(
            context, android.Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) notify.launch(android.Manifest.permission.POST_NOTIFICATIONS)
    }

    // While the app is open, keep up with the phone: a set ticked off there
    // should not need the watch to be closed and opened again.
    WhileWatching(state.paired) {
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
 * Work that only happens while the app is actually in front of you.
 *
 * A LaunchedEffect lives as long as the composition, and on a watch the
 * composition outlives the screen by a long way: drop your wrist and the app
 * stays top of the stack, just not visible. Anything ticking or polling in
 * one of those carries on all night. Measured on a real watch: fifty minutes
 * of "top sleeping" and most of the app's processor time spent with the
 * screen off. Tying it to the lifecycle is the difference.
 */
@Composable
private fun WhileWatching(vararg keys: Any?, block: suspend CoroutineScope.() -> Unit) {
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(owner, *keys) {
        owner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { block() }
    }
}

/**
 * A list the crown scrolls, until you pick a number for it to turn.
 *
 * The crown is the scroll wheel of a watch, and taking that away by default
 * is a surprise: a turn on any other screen moves the list, so on this one it
 * should too. Tapping a number hands the crown to it, which is the fast way
 * to go from 135 to 185 without ten taps on a plus sign, and tapping again
 * gives it back to the list.
 */
@Composable
private fun DialColumn(
    listState: ScalingLazyListState,
    dialing: Boolean,
    onTurn: (Int) -> Unit,
    content: ScalingLazyListScope.() -> Unit,
) {
    val focus = remember { FocusRequester() }
    // A detent is worth a step; what a watch reports per detent varies, so
    // this adds up what it sends and spends it a step at a time.
    var carried by remember { mutableStateOf(0f) }
    val crown = if (dialing) {
        Modifier
            .onRotaryScrollEvent { event ->
                carried += event.verticalScrollPixels
                var steps = 0
                while (carried >= DETENT) { carried -= DETENT; steps++ }
                while (carried <= -DETENT) { carried += DETENT; steps-- }
                if (steps != 0) onTurn(steps)
                true
            }
            .focusRequester(focus)
            .focusable()
    } else {
        Modifier.rotaryScrollable(RotaryScrollableDefaults.behavior(listState), focusRequester = focus)
    }
    ScalingLazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize().then(crown),
        content = content,
    )
    // Whichever mode it is in has to hold the crown, and half a turn carried
    // over from the other one is not part of the next.
    LaunchedEffect(dialing) {
        carried = 0f
        runCatching { focus.requestFocus() }
    }
}

/** How far the crown has to turn to be worth one step. */
private const val DETENT = 40f

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
            // The set you are on, first. Everything else here is something you
            // glance at; this is the thing you came to tap, and on a round
            // screen anything below the first card means scrolling for it.
            if (next != null) {
                item(key = "next-up") {
                    val day = state.workout
                    val label = day?.let { Session.supersetLabel(it, next.exercise) }
                    val title = day?.let { Session.setTitle(it, next.exercise, next.set) }
                        ?: "Set ${next.setNumber}"
                    TitleCard(
                        onClick = { nav.navigate("set/${next.exercise.uuid}/${next.set.uuid}") },
                        title = { Text(next.exercise.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            (if (label != null) "$label · " else "") + title + " · " +
                                Session.setLine(next.exercise, next.set, state.unit),
                        )
                    }
                }
            } else if (state.workout?.finished == true) {
                item(key = "all-done") {
                    Message(title = "Every set is done", body = "Finish the session on your phone.")
                }
            }
            if (state.workout != null) {
                item {
                    val session = state.session
                    var elapsed by remember(session) {
                        mutableStateOf(session?.elapsedMs(System.currentTimeMillis()) ?: 0L)
                    }
                    WhileWatching(session) {
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
                RestRow(
                    clock = clock,
                    onStart = {
                        val up = state.workout?.let { Session.next(it)?.exercise }
                        clock.start(up?.name ?: "Rest", store.restFor(up?.uuid))
                        nav.navigate("timer")
                    },
                    onOpen = { nav.navigate("timer") },
                )
            }
            // What is left to do, in the order you do it, and then what is
            // finished under a heading of its own.
            val day = state.workout
            if (day != null) {
                val (todo, finished) = Session.ordered(day)
                exerciseBlocks(day, todo, next?.exercise?.uuid) { nav.navigate("exercise/$it") }
                if (finished.isNotEmpty()) {
                    item(key = "completed") { ListHeader { Text("Completed", maxLines = 1) } }
                    exerciseBlocks(day, finished, next?.exercise?.uuid) { nav.navigate("exercise/$it") }
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
            state.workout?.let { day ->
                val label = Session.supersetLabel(day, exercise)
                val with = Session.partners(day, exercise).joinToString(", ") { it.name }
                if (label != null) {
                    item {
                        Text(
                            "$label · with $with",
                            textAlign = TextAlign.Center,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.secondary,
                            modifier = Modifier.fillMaxWidth().padding(bottom = 2.dp),
                        )
                    }
                }
            }
            exercise.sets.forEachIndexed { index, set ->
                item(key = set.uuid) {
                    TitleCard(
                        onClick = { nav.navigate("set/${exercise.uuid}/${set.uuid}") },
                        title = {
                            val title = state.workout?.let { Session.setTitle(it, exercise, set) }
                                ?: "Set ${index + 1}"
                            Text(title + if (set.completed) " · done" else "")
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
    // Which number the crown is turning, if any. Nothing by default: the
    // crown scrolls the list until you tap a number to hand it over.
    var dialing by remember(setUuid) { mutableStateOf<String?>(null) }
    val step = Session.weightStep(state.unit)
    val done = fresh == null && exercise.sets[index].completed
    val label = state.workout?.let { Session.supersetLabel(it, exercise) }
    val named = if (fresh != null) "New set"
        else state.workout?.let { Session.setTitle(it, exercise, exercise.sets[index]) }
            ?: "Set ${index + 1}"
    val position = (if (label != null) "$label · " else "") + named

    fun commit(change: Session.Change, word: String) {
        runCatching { haptics.performHapticFeedback(HapticFeedbackType.LongPress) }
        scope.launch { store.save(change, word) }
    }

    // The one thing you came here to do sits on the bottom edge of the
    // screen, always there, whatever you have scrolled to. Between sets, out
    // of breath, you should not have to hunt for it.
    val log: () -> Unit = {
        val change = draft.copy(completed = true)
        // What the session will read like once this is in, so a superset's
        // round can be judged before the save has been anywhere near the
        // server.
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
        Unit
    }

    ScreenScaffold(
        scrollState = listState,
        edgeButton = {
            EdgeButton(onClick = log) {
                Text(
                    when {
                        fresh != null -> "Add the set"
                        done -> "Save the change"
                        else -> "Log the set"
                    },
                )
            }
        },
    ) {
        // The crown scrolls, as it does everywhere else, until you tap a
        // number to hand it over. Then it turns that one, and tapping it
        // again gives the crown back to the list.
        DialColumn(listState, dialing = dialing != null, onTurn = { steps ->
            draft = when (dialing) {
                "weight" -> draft.copy(weight = maxOf(0.0, draft.weight + steps * step))
                "hold" -> draft.copy(durationSec = maxOf(0, draft.durationSec + steps * 5))
                "reps" -> draft.copy(reps = maxOf(0, draft.reps + steps))
                "left" -> draft.copy(repsLeft = maxOf(0, (draft.repsLeft ?: 0) + steps))
                "right" -> draft.copy(repsRight = maxOf(0, (draft.repsRight ?: 0) + steps))
                else -> draft
            }
            runCatching { haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove) }
        }) {
            item { ListHeader { Text(exercise.name, maxLines = 2, overflow = TextOverflow.Ellipsis) } }
            if (dialing == null) {
                item {
                    Text(
                        "Tap a number to turn it with the crown",
                        textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth().padding(bottom = 2.dp),
                    )
                }
            }
            item {
                Text(
                    position + (if (done) " · done" else ""),
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            // What you did of this lift last time, when there is something to
            // say. One line, no tap, nothing to set up: the number you would
            // otherwise take your phone out to look up.
            Session.lastKeys(exercise).firstNotNullOfOrNull { state.lastTimes[it] }?.let { last ->
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
                    selected = dialing == "weight",
                    onSelect = { dialing = if (dialing == "weight") null else "weight" },
                    onDown = { draft = draft.copy(weight = maxOf(0.0, draft.weight - step)) },
                    onUp = { draft = draft.copy(weight = draft.weight + step) },
                )
            }
            if (exercise.timed) {
                item {
                    Stepper(
                        text = Session.clock(draft.durationSec) + " hold",
                        selected = dialing == "hold",
                        onSelect = { dialing = if (dialing == "hold") null else "hold" },
                        onDown = { draft = draft.copy(durationSec = maxOf(0, draft.durationSec - 5)) },
                        onUp = { draft = draft.copy(durationSec = draft.durationSec + 5) },
                    )
                }
                item {
                    Button(
                        onClick = {
                            val seconds = draft.durationSec
                            store.armHold(draft.copy(completed = true))
                            clock.start(exercise.name, maxOf(1, seconds)) { store.completeHold() }
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
                        selected = dialing == "left",
                        onSelect = { dialing = if (dialing == "left") null else "left" },
                        onDown = { draft = draft.copy(repsLeft = maxOf(0, (draft.repsLeft ?: 0) - 1)) },
                        onUp = { draft = draft.copy(repsLeft = (draft.repsLeft ?: 0) + 1) },
                    )
                }
                item {
                    Stepper(
                        text = "${draft.repsRight ?: 0} right",
                        selected = dialing == "right",
                        onSelect = { dialing = if (dialing == "right") null else "right" },
                        onDown = { draft = draft.copy(repsRight = maxOf(0, (draft.repsRight ?: 0) - 1)) },
                        onUp = { draft = draft.copy(repsRight = (draft.repsRight ?: 0) + 1) },
                    )
                }
            } else {
                item {
                    Stepper(
                        text = "${draft.reps} reps",
                        selected = dialing == "reps",
                        onSelect = { dialing = if (dialing == "reps") null else "reps" },
                        onDown = { draft = draft.copy(reps = maxOf(0, draft.reps - 1)) },
                        onUp = { draft = draft.copy(reps = draft.reps + 1) },
                    )
                }
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
    var discarding by remember { mutableStateOf(false) }
    var elapsed by remember(session) {
        mutableStateOf(session?.elapsedMs(System.currentTimeMillis()) ?: 0L)
    }
    WhileWatching(session) {
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
                // Throwing the time away is a real loss and one tap from
                // "stop", so it asks first.
                Button(
                    onClick = { discarding = true },
                    label = { Text("Discard") },
                    colors = ButtonDefaults.filledTonalButtonColors(),
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                )
            }
        }
    }

    AlertDialog(
        visible = discarding,
        onDismissRequest = { discarding = false },
        title = { Text("Throw this time away?") },
        text = { Text("The session goes back to having no length recorded.") },
        confirmButton = {
            AlertDialogDefaults.ConfirmButton(onClick = {
                discarding = false
                scope.launch { store.discardSession() }
                nav.popBackStack()
            })
        },
        dismissButton = {
            AlertDialogDefaults.DismissButton(onClick = { discarding = false })
        },
    )
}

/** A number with a tap either side of it, sized for a thumb. */
@Composable
private fun Stepper(
    text: String,
    selected: Boolean = false,
    onSelect: (() -> Unit)? = null,
    onDown: () -> Unit,
    onUp: () -> Unit,
) {
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
        // Outlined while it holds the crown, so which number a turn will move
        // is something you can see rather than remember.
        val picked = Modifier
            .weight(1f)
            .padding(horizontal = 4.dp)
            .then(
                if (selected) {
                    Modifier.border(
                        1.dp,
                        MaterialTheme.colorScheme.primary,
                        RoundedCornerShape(percent = 50),
                    )
                } else {
                    Modifier
                }
            )
            .then(if (onSelect == null) Modifier else Modifier.clickable { tap(onSelect) })
            .padding(vertical = 4.dp)
        Text(
            text,
            textAlign = TextAlign.Center,
            maxLines = 1,
            style = MaterialTheme.typography.titleMedium,
            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
            modifier = picked,
        )
        FilledTonalIconButton(
            onClick = { tap(onUp) },
            modifier = Modifier.size(40.dp),
        ) { Text("+") }
    }
}

/** Green while there is time, amber when it is getting on, red at the death. */
@Composable
private fun ringColour(urgency: Session.Urgency): Color = when (urgency) {
    Session.Urgency.NOW -> MaterialTheme.colorScheme.error
    Session.Urgency.SOON -> Color(0xFFE8B931)
    Session.Urgency.CALM -> Color(0xFF4CC38A)
}

/**
 * The rest, wherever you are in the session: the time left in the colour it
 * has earned, and a way back into the timer. A card is a status you can open;
 * the button is an action, and a rest already running is not one, so the row
 * is one or the other and never a dead label. The same row CookTrace shows
 * over a pan.
 *
 * It keeps its own second hand, tied to the screen being in front of you, and
 * stops it at zero: nothing ticks behind a rest that is over.
 */
@Composable
private fun RestRow(clock: Countdown, onStart: () -> Unit, onOpen: () -> Unit) {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    WhileWatching(clock.endsAt) {
        if (clock.endsAt <= 0L) return@WhileWatching
        while (true) {
            now = System.currentTimeMillis()
            if (clock.endsAt <= now) break
            delay(1000)
        }
    }
    val left = if (clock.endsAt <= 0L) 0 else maxOf(0L, (clock.endsAt - now + 999) / 1000).toInt()
    if (left <= 0) {
        Button(
            onClick = onStart,
            label = { Text("Start a rest") },
            modifier = Modifier.fillMaxWidth(),
        )
        return
    }
    val total = maxOf(1, clock.total)
    TitleCard(
        onClick = onOpen,
        title = {
            Text(
                Session.clock(left),
                maxLines = 1,
                color = ringColour(Session.urgency(left, total)),
            )
        },
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            "Resting" + (if (clock.label.isBlank()) "" else " before " + clock.label),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
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

    WhileWatching(clock.endsAt) {
        if (clock.endsAt <= 0L) return@WhileWatching
        while (true) {
            remaining = clock.secondsLeft()
            if (remaining <= 0L) break
            delay(500)
        }
        if (!clock.fired) {
            clock.markFired()
            // The alarm does the buzzing, so it happens whether or not this
            // screen is still up. Here there is only the hold to write down,
            // and the alarm will have done that too if it got there first.
            // The hold is logged before the timer is cleared: clearing it is
            // also what cancels a hold, and doing that first would throw away
            // the very set this is here to write down.
            clock.onDone?.invoke()
            clock.stop()
        }
    }

    // A timer you have to keep awake with a finger is no timer at all, but
    // only while it is counting: once it reaches zero the screen was being
    // held on at full brightness until somebody swiped it away.
    val counting = remaining > 0
    DisposableEffect(counting) {
        val window = (context as? Activity)?.window
        if (counting) window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }

    val total = maxOf(1, clock.total)
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(
            progress = { (remaining.toFloat() / total.toFloat()).coerceIn(0f, 1f) },
            // Green while there is time, amber when it is getting on, red at
            // the death, so a glance tells you without reading the number.
            colors = ProgressIndicatorDefaults.colors(
                indicatorColor = ringColour(Session.urgency(remaining.toInt(), total)),
            ),
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

/**
 * A run of exercise cards, with a heading over every block.
 *
 * A superset is two or three exercises you move between, and on a list you
 * scroll past there is no other way to see where one starts and the next
 * begins. Saying which exercises belong together only helps if it is equally
 * plain which ones belong to nothing, so a run of standalone lifts gets one
 * heading too, the same word the phone's own cards use.
 */
private fun ScalingLazyListScope.exerciseBlocks(
    day: Session.Workout,
    blocks: List<List<Session.Exercise>>,
    nowUuid: String?,
    onOpen: (String) -> Unit,
) {
    blocks.forEachIndexed { index, block ->
        val first = block.first()
        val label = Session.supersetLabel(day, first)
        if (first.inSuperset && label != null) {
            item(key = "head-" + first.uuid) {
                ListHeader { Text("Superset ${label.first()}", maxLines = 1) }
            }
        } else if (!first.inSuperset && blocks.getOrNull(index - 1)?.first()?.inSuperset != false) {
            // One heading over a run of them, not one each.
            item(key = "head-" + first.uuid) {
                ListHeader { Text("Standalone", maxLines = 1) }
            }
        }
        block.forEach { exercise ->
            val own = Session.supersetLabel(day, exercise)
            item(key = exercise.uuid) {
                TitleCard(
                    onClick = { onOpen(exercise.uuid) },
                    title = {
                        Text(
                            (if (own != null) "$own  " else "") + exercise.name,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    // Where this one stands, on the list itself: what it is
                    // due for next and how much is behind you, with an arrow
                    // on the one you are actually up to.
                    Text((if (nowUuid == exercise.uuid) "→ " else "") + Session.standing(exercise))
                }
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
