# Training depth plan (1.4 and 1.5)

Where LiftTrace is thinnest is not features, it is training intelligence. The app
records what you did accurately and syncs it reliably. It does not yet tell you what
to lift next and why, and a handful of gym-floor details still make it feel like a
log rather than a training tool.

This plan covers that gap. Items are grouped by the release they belong in, with the
cheap, visible ones first so each release has something a user notices on day one.

Status key: `[ ]` not started, `[~]` in progress, `[x]` done.

---

## Release 1.4: the gym-floor pass

Small, visible, mostly independent. Each one is a thing a lifter notices in the
first session after updating.

### [ ] 1. Week start: Monday or Sunday

**Today:** Monday is hardcoded. `server/routes/stats.js:_weekStart()` and the
matching `Stats._weekStart()` in `src/lib/api-native.js` both compute Monday via
`getUTCDay()`, and `server/lib/weekly-summary.js` builds its seven day window
backwards from today. A US user who thinks in Sunday weeks reads every weekly
number off by a day.

**Design:** one setting, `weekStartsOn` (`'monday' | 'sunday'`, default Monday), in
Settings under Language and Region next to date format. It is a user preference, not
a device one, so it belongs in `USER_PREFS` and syncs.

Every place that buckets by week reads it:

- `server/routes/stats.js` weekly volume and workout frequency
- `Stats._weekStart()` in `src/lib/api-native.js`, which must stay identical to the
  server (`scripts/native-stats-parity.test.js` guards this)
- `server/lib/weekly-summary.js` for the email and push summary
- The Diary week strip and This Week peek
- The Statistics calendar and activity heatmap
- Streak math, which counts days and so is unaffected, but verify

**Risk:** the parity test pins the Monday implementation. Update the test to run
both settings through both implementations rather than relaxing it.

**Effort:** 1 day, most of it the sweep.

### [ ] 2. Scope the wake lock to the workout, and default it on

**Today:** more of this exists than it looks. `src/stores/wakeLock.js` works,
`HoldTimer.svelte` takes the lock for the duration of a hold, and a `screenKeepAwake`
setting (Settings, Workout) holds it for as long as the Diary is open
(`Diary.svelte:747`). Two problems: it defaults to **off**, so the common case is
still unlocking the phone between sets, and it is scoped to the **page** rather than
the workout, so it keeps burning battery while you browse last week and never
releases when you finish.

**Design:** tie the lock to the session instead of the route. Acquire when a workout
is open and has at least one logged set, release when it is finished, abandoned, or
the Diary is left. Flip the default to on, and reword the setting to say it releases
when the workout ends. Keep honouring the existing `wantScreenOn` intent so a user
who already keeps the screen on is not fought with, and keep the store's re-acquire
on `visibilitychange` so returning from the lock screen mid-session re-takes it.

**Effort:** half a day, and mostly a scoping change rather than new code.

### [ ] 3. Bodyweight exercises logged as bodyweight

**Today:** pull-ups and dips are logged as `weight: 0`. The weight column is there,
asking a question with no good answer, and the UI offers step buttons for a number
that means nothing.

**Design:** a third value for the existing library-level `exercises.set_type` column
(currently NULL or `'time'`): `'bodyweight'`. It resolves through the same
precedence chain `src/lib/workout.js` already implements for set type: per-instance
choice on the Diary chip, then the library default, then a name-based seed list so
the common 300 or so arrive correct.

Behaviour when a set is bodyweight:

- No weight column, no working-weight prompt. One stepper for reps.
- An "added weight" affordance (dip belt, vest) that reads as `+10 kg` rather than
  replacing bodyweight. Stored as `set.added_weight` so history stays honest.
- Volume math: `server/lib/volume.js` and its client twin treat a bodyweight set as
  bodyweight plus added weight if the user's body weight is known for that date,
  otherwise as reps only, and never as zero.
- Estimated 1RM: only meaningful with added weight. Suppress otherwise rather than
  printing a number built on a zero.

**Migration:** none needed for stored workouts. Existing `weight: 0` rows stay
valid and read as bodyweight.

**Effort:** 3 to 4 days, most of it the volume and 1RM paths plus their tests.

### [ ] 4. Per-exercise bar weight with inline plate math

**Today:** `GymTools.svelte` has a plate calculator with a global bar weight
(20 kg / 45 lb), reached as a separate tool. You do the lookup, then go back to the
set row.

**Design:** add `bar_weight` to the exercise library (nullable, mirroring
`load_type` precedence: per-instance value wins, then library, then a default by
equipment: barbell 20/45, EZ bar 10/25, trap bar 25/55, Smith machine configurable
since it varies by gym). When a set's exercise carries a bar weight, the set row
shows the split under the weight field: `Bar 20 kg · 30 kg per side`.

The logged number stays the total, so history, progression, volume and 1RM keep
meaning exactly what they mean today. This is a display affordance, not a data
change.

**Effort:** 2 days.

### [ ] 5. Log a past workout

**Today:** you can navigate to a date and log into it, which works but is not
discoverable, and nothing handles the case where that day already has a session.

**Design:** an "Add past workout" action in History and in the Diary overflow menu.
Asks for date, optional start time and duration, then routine or freestyle, then
opens the normal workout screen. If the target date already has a session, offer:
add as another session (now natural given multi-session support), replace the
existing one, or cancel.

**PR correctness:** a backfilled session must not claim a personal record against
sessions that were logged after the backfilled date. `lastCompletedSession()` and
the record detection in `server/lib/volume.js` order by date, so a backdated best
set should register as a record *as of that date* and not retroactively invalidate
later records. Add tests for the ordering.

**Effort:** 2 to 3 days.

### [ ] 6. Activity heatmap shaded by time trained

**Today:** the Statistics heatmap is binary: trained or rest.

**Design:** shade by `duration_min` where present, falling back to completed set
count where it is not, in four or five steps. Keep the legend honest: the current
`Rest / Workout` key becomes a gradient with "less" and "more" ends, and the
tooltip names the actual number.

**Effort:** half a day.

---

## Release 1.5: the progression engine

This is the headline. It is the difference between a log and something that tells
you what to lift next, and it is the single biggest functional gap against other
self-hosted trackers.

### [ ] 7. Named progression schemes

**Today:** `server/lib/programWeek.js` resolves which week of a program you are on
(`advance_mode` of `sessions` or `calendar`, plus an `on_complete` policy), and
template weeks carry explicit per-set targets. So progression exists in the sense
that a program can prescribe week 3 differently from week 1, but the targets are
authored by hand. Nothing computes a next weight from what you actually lifted, and
nothing reacts to a missed rep.

**Design:** a progression rule attached to a program, overridable per exercise,
evaluated when a session opens.

Rules to support, each a pure function in a new `server/lib/progression.js` with a
client twin (the phone must compute the same targets offline, same parity test
pattern as `muscle-load.js`):

- **Linear.** Add a fixed increment per session or per week. Configurable
  increment per exercise, defaulting by equipment (barbell 2.5 kg, dumbbell 2 kg,
  machine 5 kg, or the pound equivalents).
- **Double progression.** A visible rep range with both bounds editable. Reps climb
  within the range at a fixed weight; hitting the top of the range on every set
  advances the weight and resets to the bottom.
- **Greyskull LP.** Last set is AMRAP. Beating a rep threshold gives a double
  increment, hitting the target gives a single, missing it holds. Three consecutive
  misses trigger a 10 percent reset.
- **Time progression.** For timed sets: add seconds per session, same shape as
  linear.
- **Reps progression.** For bodyweight exercises: add reps to a ceiling, then add a
  set, then advise loading or a harder variation.

**Stall handling:** a consecutive-miss counter per exercise. On the rule's stall
threshold, apply its deload (percentage or absolute) and say so in the UI. Store the
counter derived from history rather than as state, so it cannot drift out of sync
across devices. This matters: a stored counter is one more thing the merge layer
would have to reconcile.

**Explained targets.** Every prescribed number carries a short reason string:
"+2.5 kg, you hit 3x5 last time", "same weight, 4 of 5 reps last session",
"deload 10 percent after three misses". Compute it alongside the target in the same
function, not in the UI, so MCP, the REST API and Trace all get the same sentence.

**Data model:**

- `programs.progression_rule` (TEXT, JSON: `{type, increment, rep_range, stall_threshold, deload_pct}`)
- Per-exercise override inside the existing template exercise JSON, so no schema
  change there.
- Nothing stored per session. Targets are derived from history at open time, which
  keeps offline and online identical and avoids a migration.

**Effort:** 2 to 3 weeks including tests. The rules themselves are a few days; the
parity, the offline path, the UI for configuring them and the explanations are the
rest.

### [ ] 8. Planned deloads

Once rules exist: a flag on a program or a single week marking it excluded from
progression. Its sessions open with the authored targets, count in history and
statistics, and are skipped when the engine looks back for the baseline to
progress from.

**Effort:** 2 days on top of the engine.

### [ ] 9. Muscle map: Balance, Fatigue and Strength

**Today:** `MuscleRecovery.svelte` draws fatigue by hours since the last completed
set, and a separate muscle balance card shows volume distribution.

**Design:** one figure, three modes behind a segmented control:

- **Fatigue** (today's behaviour), but weighted by how close each set was to the
  user's estimated maximum rather than purely by time, decaying smoothly instead of
  expiring at the window edge.
- **Balance**, folding in the existing card: where volume went over a week, a month
  or all time, and naming the muscles with no volume at all.
- **Strength**, new: time since each muscle was trained, and behind each one the
  exercises that built it with their estimated 1RM.

Plus a preview: while building or editing a routine, show which muscles it hits.
That reuses the same fill function with the routine's exercises as input instead of
history.

**Effort:** 1 week, mostly the Strength mode and the routine preview.

### [ ] 10. RIR alongside RPE

**Note:** ROADMAP.md claims this is done at v0.9.4-beta.13. It is not. The code
stores `set.rpe` only, and there is no RIR scale in the source or in `en.json`. Fix
that ROADMAP line as part of this work.

**Design:** a per-user choice of scale (RPE 1-10 or RIR 0-5+), with each set storing
the scale it was logged with so old data keeps its meaning. Colour code the chip by
level, with a plain sentence per level ("one more rep in the tank"). Progression and
1RM stay independent of it, as they are today.

**Effort:** 2 days.

### [ ] 11. Drop sets and rest-pause

**Design:** extend the set row menu (the set number becomes its own menu, as the
`...` menu already is for exercises) with "drop set" and "rest-pause burst". Both
are child sets attached to a parent, stored as `set.parent_uuid`, so they do not
break set ordering or the merge layer. They count toward volume, they do not count
as separate working sets for progression, and PR detection ignores them.

**Effort:** 3 to 4 days, mostly making sure the merge and the stats paths treat
children correctly.

---

### [ ] 11b. Unit switching converts stored numbers

**Today:** `weightUnit` (`src/stores/settings.js:286`) is a **label only**. Set
weights are stored as bare numbers with no unit attached, and nothing converts them
when the setting changes. A user who logged 185 lb and then switches to kg sees
"185 kg", which is wrong by a factor of 2.2 and silently corrupts every chart, PR
and volume figure that follows.

Body measurements are handled (the wizard and profile convert to and from the stored
canonical values), so this is specific to training weights.

**Design:** on switching the unit, ask once: convert existing entries, or leave them
as typed. Converting rewrites stored set weights, target weights and per-exercise bar
weights, rounding to the nearest sane increment (2.5 kg / 5 lb) and recording that it
happened so it cannot run twice. Leaving them alone is the right answer for someone
who has only just started and typed a few numbers in the new unit already.

Either way it needs a guard so a sync from another device with the other unit setting
cannot double-convert. Storing a canonical unit per workout row is the cleaner long
term fix and a bigger migration; the prompt is the honest short term one.

**Effort:** 2 days for the prompt and conversion, more if we decide to store a
canonical unit instead.

### [ ] 11c. Reschedule a planned session

**Today:** a program prescribes a day. Miss it and there is no way to move it without
editing the program.

**Design:** move a planned session to another date from the Diary or the program
view, without touching the program itself. It lands as a one-off override on the
assignment rather than a change to the shared program, so an athlete rescheduling
their own week never edits a coach's plan.

**Effort:** 2 to 3 days, mostly in how the override is stored and synced.

## Ongoing, not release-gated

### [ ] 12. Share a routine as a file, and print it

Export a program or template as a small JSON file (no workouts, no body data),
import merging rather than overwriting, plus a print stylesheet that produces a
clean one page PDF through the browser's own print dialog. No new dependency.

**Effort:** 2 days.

### [ ] 13. OpenAPI spec for `/api/v1`

`docs/public-api.md` documents the REST API in prose. A checked-in `openapi.yaml`
generated from the route definitions makes it consumable by tooling and gives us a
contract test. Serve it at `/api/v1/openapi.yaml` and link it from the docs site.

**Effort:** 2 days.

### [ ] 14. Passkeys as a login method

The one authentication method LiftTrace does not have. Passwords, OIDC SSO and
biometric unlock in the app all exist; passkeys (WebAuthn) do not, and they are what
both comparable self-hosted trackers lead with.

**Design:** follow the `AUTH_MODE` pattern those projects use: `password`, `passkey`
or `both`, with `both` as the default so nothing changes for existing installs.
Passkeys need the app and API on one origin (already true, the server serves the
built frontend) and an `RP_ID` bound to the deployment hostname, which means a real
HTTPS domain: document it as an optional feature rather than something a
`localhost` install can use.

Server side this is one dependency (`@simplewebauthn/server`) and a credentials
table keyed to the user. The private key never reaches the server.

**Effort:** 4 to 5 days including the enrolment and recovery flows, which are the
part that actually needs care: losing a passkey must not lock someone out of their
own instance.

### [ ] 15. Lazy-loaded locales

`src/i18n/` currently bundles every locale. With three that is fine; the moment
Weblate brings in a handful more it is dead weight in the initial load. Switch to
dynamic import per locale, keeping English in the bundle as the fallback.

**Effort:** 1 day. Worth doing before the locale count grows, not after.

---

## Public demo instances

The single highest-leverage item for adoption, and the one with a cost question
attached. Someone deciding whether to self-host an app will click a demo; most will
not spin up Docker to find out what the Diary looks like.

Two routes, and the free one is genuinely good.

### Route A (recommended): a static in-browser demo, hosted free

The web app already runs without a server in the Android standalone mode, where an
on-device SQLite database answers the API. The same trick works in a browser: build
the app with the network layer swapped for a mock that serves a seeded snapshot out
of IndexedDB.

- The snapshot comes from `design/tools/seed.mjs`, which already generates eight
  weeks of realistic training data and is what the release screenshots use.
- `src/lib/apiFetch.js` is already the single choke point for every request, so the
  demo build points it at a local handler instead of `fetch`.
- Edits work and persist for that visitor, which makes it a real trial rather than a
  screenshot tour. A "reset demo data" button restores the snapshot.
- Hosted on GitHub Pages alongside the docs site. Cost: nothing. No server, no
  database, no abuse surface, no personal data, nothing to moderate or clean up.
- Features that genuinely need a server (sync, OIDC, webhooks, MCP, federation)
  show as disabled with a one line explanation, which doubles as advertising for
  what self-hosting adds.

**Effort:** 3 to 4 days for LiftTrace, then substantially less per app since the
pattern and the mock layer carry over to NutriTrace, CookTrace and NoteTrace.

**Why this over a hosted instance:** it is free forever, it cannot leak anyone's
data, it cannot be defaced, it needs no backups, and it does not fall over when a
release post lands on the front page of a subreddit.

### Route B: one free VM running all four real instances

If a demo that proves *sync* is wanted later:

- **Oracle Cloud Always Free** gives an ARM VM (4 vCPU, 24 GB RAM) at no cost
  indefinitely, enough for all four apps in Docker with room to spare. The catches
  are account signup friction and that idle instances have been reclaimed in the
  past.
- **Render, Fly.io or Hugging Face Spaces** free tiers also run a container, but
  sleep when idle, so a visitor clicking a link waits 30 to 60 seconds for a cold
  start.

Either way a hosted demo needs: a nightly reset via cron, no real email or password
flows, admin features locked, rate limits, and an accepted risk that anything posted
into it is public. That is real maintenance, which is why Route A comes first.

**Decision:** build Route A for LiftTrace alongside the 1.4 work, evaluate Route B
only if a sync demo turns out to be the thing people ask for.

### [ ] Pilot: LiftTrace on GitHub Pages

LiftTrace goes first, as a deliberate trial. If it works, the other three follow;
if it turns out to be more upkeep than it looks, we have spent days rather than
weeks and nothing is hosted that needs shutting down.

**Where it lives.** The LiftTrace repo has no Pages site today (the docs repo is the
only one, serving `traceapps.github.io/docs/` from `main`). Enable Pages on the
LiftTrace repo from a `gh-pages` branch, published by CI, so the demo bundle never
touches `main` or `dev`. The result is `traceapps.github.io/lifttrace/`. Keeping it
on the app's own repo rather than inside the docs site matters: the docs are MkDocs
and a 12 MB app bundle does not belong in that build.

`vite.config.js` already sets `base: './'`, so a subpath deployment needs no config
change. The current `dist/` is about 12 MB, well inside Pages limits.

**How it is built.** A demo build flag (`VITE_DEMO=1`) that swaps the network layer
for a local handler:

- `src/lib/apiFetch.js` is the single choke point every request goes through, so the
  demo build points it at an in-browser handler instead of `fetch`. The Android
  standalone path in `src/lib/api-native.js` is the proof this works: it already
  answers the same API surface from on-device SQLite, so the demo handler is the
  same idea with a simpler store.
- The seed data is **generated at runtime from a deterministic PRNG**, not committed
  as a snapshot, so the dates stay relative to today and the demo never opens on a
  workout from four months ago. Port the shape from `design/tools/seed.mjs`, which
  already produces eight weeks of Push/Pull/Legs with progression, body weight
  history and a half-finished session, and is what the release screenshots use. A
  fixed seed keeps it identical on every reload and for every visitor, which also
  makes it usable for screenshots.
- State lives in **sessionStorage**, so every tab starts clean and nothing survives
  the visit. This is simpler than IndexedDB with a reset button: no reset UI to
  build, and no class of "my demo is in a weird state" reports.
- Anything that needs a real server (sync, OIDC, webhooks, MCP, federation, email)
  renders disabled with one line saying it needs self-hosting. That is advertising,
  not an apology.
- A dismissible banner on first load: this is a demo, data is yours alone and stays
  in this browser, nothing is uploaded.

**Publishing.** A CI job on tagged releases builds with the flag and publishes with
`actions/upload-pages-artifact` and `actions/deploy-pages`, path-filtered to
frontend changes and under a `concurrency: pages` group so overlapping runs cannot
race. The demo tracks stable releases rather than `dev`, so nobody evaluates the app
on a half-finished feature.

**Prior art worth reading before building this.** ForgeFitServer
(`ForgeFitServer/ForgeFitServer`, AGPL) runs this exact setup today: a `VITE_DEMO=1`
build deployed to Pages by `.github/workflows/pages.yml`, a four-line `lib/demo.js`
flag, a `lib/demoSeed.js` that generates data from a seeded PRNG, sessionStorage for
state, and exercise media served from a CDN at build time rather than bundled.
Small project, but the recipe is proven and the workflow file is a straight read.
Our media needs no equivalent: the exercise images are already remote wger and Free
Exercise DB URLs.

**What decides whether the other three follow.** After a month: does the demo link
get clicked (Pages traffic in repo insights), does it turn into installs or stars,
and did it need any upkeep beyond a rebuild per release. If yes, NutriTrace,
CookTrace and NoteTrace get the same treatment and most of the work carries over.

---

## Sequencing

| Release | Contents |
|---|---|
| 1.4 | Week start setting, wake lock, bodyweight exercises, bar weight, past workout logging, heatmap shading |
| 1.4.x | Static demo for LiftTrace on GitHub Pages (pilot), lazy locales, OpenAPI spec |
| 1.5 | Progression engine, planned deloads, muscle map modes, RIR, drop sets, unit conversion, rescheduling |
| Later | Passkeys, routine sharing and print, demos for the other three apps |

The 1.4 items are deliberately all small and independent, so any of them can drop
without blocking a release. The 1.5 items are one coherent theme and should go out
together, since a progression engine without explained targets or deloads is half a
feature.
