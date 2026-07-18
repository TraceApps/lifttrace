# Roadmap

Ideas and planned features for LiftTrace. Not prioritized, this is a living list.

Last refreshed at v1.0.0-rc.7 (2026-07-05).

---

## 1.0 GA Milestone (from 1.0-rc audit, 2026-05-25)

The app went public as v1.0.0-rc.1+ and is functionally complete. These
are the polish items that separate "RC quality" from a confident GA tag.
None are strictly blocking, but the items listed here (test suite +
accessibility cleanup in particular) are worth clearing when practical.
The `-rc` suffix was retired in v1.0.0 as a versioning-scheme change,
independent of these polish items.

### Test coverage (highest leverage)

LiftTrace has **zero automated test coverage** today. Every release is
"build, hope, release." This is the single biggest GA blocker.

Concrete target: a 5-test Playwright smoke suite covering the core flow:

- Login → /diary visible
- Log a workout: add exercise, complete a set, finish → summary appears
- View statistics → chart renders, no console errors
- Create a program → appears in list
- NutriTrace federation save+test (mocked) → "Connected" pill appears

Wire into GitHub Actions on every PR. Roughly a day to scaffold + write.

### i18n extraction to 55-60% coverage

`en.json` is at ~40% extracted today (192 keys). Biggest remaining gaps:

- **Statistics**: chart metric names, range pickers, sparkline labels (mostly
  rendered from JS constants, not keys)
- **Coaching**: feedback prompts, prescription wording, member list strings
- **Error toasts**: about 30% of `showError()` calls still pass hardcoded
  English strings (a top-10 sweep landed in rc.4; ~30 more to extract)
- **Sort/filter chips**: Exercises sort modes (`alpha` / `used` / `recent`)
  render as literal English in the UI

Add ~100-150 keys total. Roughly a day of mechanical work. Worth doing once
volunteer translators start engaging.

### Onboarding tour (first-run overlay)

Wizard finish now shows a brief "You're All Set" celebration (rc.4) but
the diary still drops new users into a UI they've never seen. An overlay
walkthrough, "this is where you log sets, this is your active program,
this is Trace", would lift retention. Pattern: stepped tooltip system
keyed on first-launch flag in `localStorage`. ~1 day.

### Accessibility cleanup

About 20 `svelte-ignore a11y-click-events-have-key-events` blocks live
across Radio, Diary, Trace FAB. Each is a clickable `<div>` that lacks
keyboard reach. Mechanical replacement with `<button>` + `on:keydown`
handlers, plus visible focus indicators on the custom widgets. Matters
more if targeting F-Droid or accessibility-conscious self-hoster lists.
Roughly half a day.

### Smaller deferred audit items

- **Mobile / responsive at <360px**: Settings.svelte has no explicit
  mobile max-width container; on very narrow viewports some setting rows
  push trailing controls off-screen. Most fixes are local; one breakpoint
  pass covers it.
- **`min-width` audit**: exercise sort menu (`160px`), some radio cards,
  fixed-height progress SVG on ExerciseDetail (`100px`). All cosmetic but
  noticeable on edge-case viewports.
- **Loading spinners inside settings sub-sections**: most of the route
  loading states landed a shared `<Spinner>` component in rc.4; a second
  pass to use it inside long-running setting actions (sync now, full
  backup create) would round out the consistency.
- **Per-OIDC-provider verified indicator**: SettingsAuth has a per-provider
  `testProvider` action, but no persistent "verified" pill on the provider
  card. A small green check/red X next to the issuer URL would clarify
  state at a glance.

---

## Paid Android app (future distribution)

Speculative, LiftTrace is currently free everywhere (self-host + free
signed APK from the release page). This section captures what would
need doing IF a paid Play Store / F-Droid distribution ever happens.

### Licensing / distribution work required before the paid Android app

- **Attribution page / About panel** listing every active exercise / media / library source + its license (CC-BY-SA 4.0 for wger, Unlicense for free-db, AGPL for OSS ExerciseDB + hls.js, commercial TOS for RapidAPI, Radio-Browser.info attribution). AscendAPI requires visible credit for any project using their OSS dataset.
- **Build-tier flag** (e.g. `VITE_BUILD_TIER='commercial'`) that filters `SOURCES[]` so the paid Android build does not expose `oss.exercisedb.dev`, their terms explicitly prohibit commercial/monetised use of the OSS endpoint.
- **Explicit warning in the wizard** when a user picks the OSS source: "Personal / non-commercial use only. Safe for self-hosters; paid-app users should use RapidAPI instead."
- **Prebuild a starter SQLite** in CI with just Free Exercise DB (~870 exercises, Public Domain) + its images, bundle into the Android APK assets. First-launch instantly useful with zero network.
- **Local GIF mirror option**: download GIFs to `/uploads/exercisedb/{id}.gif` at import time so URL rotation by upstream can't break the app. 150–300 MB disk, included in full backups. Toggle in Settings → Exercise Catalog.
- **Weekly scheduled re-import** for commercial ExerciseDB sources (URLs rotate every Monday 00:00 UTC per AscendAPI's caching guide). Low priority, the OSS + free sources don't rotate.
- **Commercial dataset snapshot**: buying the v1 dataset outright from AscendAPI's shop so a paid APK could bundle rich GIFs without an ongoing API dependency. One-time cost vs. subscription.

---

## Planned

- **Template auto-suggest**: suggest today's template based on program rotation and last workout date
- **Collapsed-card summary**: when an ExerciseCard auto-collapses after completing all sets, show the best working set on the header (e.g. `Bench Press · 4/4 · 225×5`) instead of just the name
- **RPE back-fill from imported notes**: the Strong / Hevy importers currently stash RPE into set notes as `"RPE 8"`. Promote those to the real `set.rpe` field with a one-shot migration now that RPE exists
- **RPE trend chart in Statistics**: "average RPE at working weight" line chart per exercise. Useful for spotting accumulated fatigue
- **Trace deload suggestions**: proactively suggest a deload week when user has logged RPE 9+ across three consecutive workouts on the same lift

## Considering

- **Achievements / badges**: "100 workouts logged", "First 3-plate bench", "30-day streak", etc. Motivational layer, opt-in
- **Progress photos timeline**: dated photos stored under body-stats, swipeable before/after view
- **Keyboard shortcuts overlay**: `?` opens a cheatsheet listing Space / Arrow / etc. Radio player already has keyboard bindings; surface them
- **Per-entity CSV/JSON export**: workouts.csv, programs.json, exercises.csv separate from the existing full-backup ZIP. Workout CSV landed in rc.6 for one workout at a time; this is the batch / all-entity story
- **Cardio-specific fields on the set row**: distance / pace / heart rate. Useful for users mixing conditioning with lifting. Related to Bundle B (BLE HR) but broader
- **Orphan upload cleanup**: when a custom exercise is deleted, delete its `/uploads/exercises/<uuid>.ext` file too. Minor disk-leak for heavy users
- **Native Android voice input**: current `SmartLogModal` voice path uses Web Speech API; reliability inside Android WebView is patchy. Switch to `@capacitor-community/speech-recognition` when a session lines up to touch that surface

## Migration: additional gym apps

Already supported: Strong, Hevy, FitNotes, Jefit.

- **Garmin FIT file import** (issue [#6](https://github.com/TraceApps/lifttrace/issues/6)), Garmin Connect lets users download the raw `.fit` file for any activity; the FIT format has native strength-training records (per-set exercise category, weight, reps, duration). Parse in Node via `fit-file-parser`, map Garmin's `exercise_category` enum to LT's exercise catalog. Committed publicly on the issue thread. Awaiting a sample `.fit` file from the commenter. ~3 evenings once samples are in hand.
- **Apple Health / Fitness** workouts (XML export from Health app), summary-level only (workout duration + heart rate), no set-level data
- **Google Fit / Health Connect** (less common for lifting, but possible)
- **Fitbod**, **Gymshark Conquer**, **Gravitus**: lower priority, smaller userbases

## Tech debt

- **Emby provider `/emby/*` route split.** Today the Emby library-browsing methods delegate to `jellyfin.*` via `.apply(jellyfin, args)`, which means they hit `/api/subsonic/provider/jf/*` routes on the server (with Emby's URL in radioUrl). Works because Emby is a Jellyfin fork with API-compatible endpoints and both auth with `X-Emby-Token`. Would break if Emby ever diverges from Jellyfin's `/Items`-style routes. Fix = duplicate the jellyfin methods into the emby object with `/emby/` prefixes, or thread a `_prefix` parameter through `_proxyJson`.

- **Android radio HE-AAC decoder workaround.** Chromium WebView's direct `<audio src=...>` path on Android hits a deterministic `PIPELINE_ERROR_DECODE` at exactly stream-timestamp 5461333μs (packet #128) on iHeart-format HE-AAC streams (Z100, KIIS, etc.), same micro on every reconnect. Likely an SBR/PS feature boundary issue in Chromium's media pipeline. Current mitigation (v0.10.0-beta.x onward): WebView intercept proxy adds synthetic CORS headers, stream plays via direct `audio.src` for ~5s then errors; player.js auto-recovers via removeAttribute+load+new src cycle, giving continuous-with-gaps audio. Tried and reverted: wrap proxy URL in synthetic HLS manifest blob URL so hls.js handles AAC ADTS demuxing through MSE (logs looked clean but no audio reached the speaker). Real fix paths to explore: (a) direct MSE pipeline packaging raw AAC ADTS into fragmented MP4 via mux.js; (b) native MediaCodec decode → MP3 re-encode through the proxy; (c) separate Android audio playback path via Java MediaPlayer / ExoPlayer as a Capacitor plugin (loses Web Audio visualizer for streams).

- **Remaining dep major-version upgrade** (only one left after the rc.5 and rc.7 sweeps closed Svelte 4→5, Express 4→5, bcryptjs 2→3, multer 1.4.5-lts.1→2.x, nodemailer 8→9): `openid-client 5 → 6`. Complete rewrite, cleaner API. Defer unless iterating on OIDC. Monthly `npm audit` cadence continues (see memory `project_lifttrace_dep_audit.md`).

## Radio: additional providers

Current: Subsonic (Navidrome/Airsonic/Gonic), Jellyfin, Plex, Emby, HLS / Icecast / Shoutcast streaming stations via Radio-Browser.info directory.

- **Funkwhale**: Subsonic-compatible (may already work) + own API
- **Ampache**: Subsonic-compatible + Ampache API
- **Koel**: own REST API
- **LMS (Lyrion)**: Logitech Media Server API
- **Multiple servers**: browse multiple providers simultaneously (Symphonium-style)

---

## Post-1.0 deferred bundles (from rc.x forum feedback)

These came from public feedback after v1.0.0-rc.x. They're structural
enough that they should NOT land mid-RC, RC is for stabilising what's
out, not piling on. Hold both until at least one cycle of RC feedback
quiet, then start Bundle A.

Recommended sequencing: Bundle A first (unlocks a category of workouts
LT currently can't express at all + the schema work is a prerequisite
for any future "distance" or other non-rep set type). Bundle B second
(purely additive, safer rollout, can land any time after A is stable).

Hold the work until the user explicitly green-lights a bundle start.
Until then this section is the design-decisions snapshot so when the
day comes the work resumes from a known starting point rather than
re-deriving everything.

---

### Bundle A: Time-based exercises + HIIT-style rest

**Original commenter ask** (paraphrased from forum thread):
1. Per-exercise countdown timer for time-based work ("2 minutes of
   weighted carries, start timer, get countdown, get a beep when it
   hits"). Should be settable per exercise.
2. Per-set + per-round rest for HIIT circuits ("20s rest between
   exercises, then 2-minute rest before starting another round").
3. The commenter's mental model: "rest is just an exercise with a
   timer", work and rest as the same primitive.

**Open architectural decision: which framing**

Two viable shapes, neither chosen yet. Pick before writing code.

**Option 1, Rest-as-a-set (closer to commenter's literal ask)**

- Add a single `set.kind: 'work' | 'rest'` flag.
- Both work and rest sets share one primitive: a timed segment.
- HIIT circuits become inline sequences: work / rest / work / rest /
  long-rest.
- Stats math (volume, PRs, time-under-tension) filters `kind='rest'`
  rows out so the workout log isn't polluted by "47 sets of Rest this
  month".
- One concept (timed segment + kind flag) instead of three new fields.
- **Visible cost**: rest periods become inline rows in the diary ,
  every HIIT circuit gets ~10 extra rows. Strength-only users still
  see one work row per set as today, so they only notice it when they
  build a HIIT workout.

**Option 2, Set metadata (original Bundle A as written)**

- Add `set.duration_sec` (null for weight×reps work, number for time-
  based).
- Add `set.rest_after_sec` (null = program default, number = per-set
  override).
- Add `superset.round_break_sec` (rest after the LAST exercise in a
  round).
- Add `exercises.default_set_type: 'reps' | 'time'` for the input
  picker default.
- Three new fields + a fourth on exercises. Cleaner stats (rest never
  exists as a row), messier vocabulary (rest has its own non-set
  identity).
- **Visible cost**: rest stays invisible between rows (current
  behavior). Per-set rest override is hidden behind long-press by
  default. Diary view stays clean.

**My recommendation**: Option 1. It's literally what the commenter
asked for, the diary-row cost is acceptable because strength users
never trigger it, and the schema is genuinely simpler (one flag vs.
four new fields).

**Schema changes once an option lands**

Option 1 path:
- `workout_log` JSON per-set gains: `kind` ('work' default),
  `duration_sec` (null for rep-based work), `weight`/`reps` stay
  exactly as today for backward compat.
- `exercises` gains optional `default_set_type: 'reps' | 'time'`
  (idempotent ALTER). Defaults to 'reps' for everything existing.

Option 2 path:
- `workout_log` JSON per-set gains: `duration_sec`, `rest_after_sec`.
- `workout_log` JSON per-exercise gains: `round_break_sec` on the
  superset wrapper.
- `exercises` gains `default_set_type` same as Option 1.

Both paths are backward-compatible, existing workouts (no new
fields) render exactly as today.

**Implementation phases** (each independently testable)

Phase 1, Schema + SetRow input rendering (~2-3 evenings)
- Add the columns + ALTER migration.
- SetRow renders `duration_sec + weight` row when set is time-based,
  `reps + weight` row when rep-based (current behavior).
- Volume math + share-card render filter / handle time-based sets
  appropriately (don't contribute to volume; do contribute to
  time-under-tension if that becomes a stat).

Phase 2, Active set timer (~3-4 evenings)
- Countdown UI for time-based sets. Reuses the rest-timer audio /
  haptic / Service-Worker-notification plumbing (`src/stores/restTimer.js`
  pattern). Auto-completes on timer end + writes the actual duration.
- Pause / resume / manual stop. Lockscreen behaviour already solved
  by the rest timer's machinery, so this is mostly reuse not new
  build.

Phase 3, Per-set + round rest overrides (~2 evenings)
- Option 1 path: rest rows just exist inline in the diary. Each rest
  set has its own duration field. Round break is just a longer rest
  set at the end of a round.
- Option 2 path: long-press a rest pill to edit just this rest;
  round-break pill on the last set of a superset round. Reuses the
  existing rest timer for the actual countdown.

Total: ~1.5-2 weeks of evenings.

**UI clutter analysis + mitigations**

Without progressive disclosure, Bundle A adds 3-5 new UI surfaces:
ExerciseEditor (+1 field), Superset header (+1 setting), SetRow (input
shape swap), per-set rest override UI, WorkoutSummary (potential TUT
tile).

Mitigations that keep strength-only users from seeing any of it:
- Default `default_set_type = 'reps'` on every existing + new exercise.
  Time UI only renders when an exercise is explicitly set to
  time-based. 95% of users see zero change.
- Hide ExerciseEditor's set-type field behind an Advanced disclosure
  if zero visible churn there matters.
- Per-set rest override hidden behind long-press, never displayed
  inline (Option 2 path only).
- Round break only shown on supersets that opt in (non-null
  `round_break_sec`); plain supersets render exactly as today.
- WorkoutSummary TUT tile only renders if the workout had any
  time-based sets. Reps-only workouts look identical.

**Discipline note for when work starts**

Bigger UI risk than the features themselves: feature creep during
build. If a bundle start happens, lock down which surfaces get the new
UI BEFORE writing code, and reject anything that wants to add a
global setting / Settings screen entry. Discipline matters more than
architecture here.

**Decisions still open before writing code**:
- Option 1 vs Option 2 (recommend Option 1).
- Time-under-tension as a stats metric? Track total seconds per
  exercise alongside volume, or skip stats integration entirely?
- Visible to which screens? Statistics page, exercise history, share
  card all need a small story for time-based work.
- `default_set_type` on the exercise or on the program template's
  exercise-row override? My take: exercise. Template can override if
  needed but the exercise itself usually has a natural set-type
  identity (plank → time, bench → reps).

---

### Bundle B: Live BLE chest-strap heart rate

Cleaner scope than Bundle A, more isolated. Adds an external-device
surface area to test but doesn't touch core workout logging.

**Plumbing** (~3-4 evenings)
- New `src/lib/bleHr.js` abstracts over Web Bluetooth (PWA, Chrome
  only) and `@capacitor-community/bluetooth-le` (Android native, also
  works for iOS later). Both expose GATT Heart Rate Service `0x180D`
  characteristic `0x2A37` the same way, standard payload, Polar /
  Wahoo / generic straps all expose it.
- Pair-and-connect flow: device picker → connect → subscribe to BPM
  notifications → emit samples through a Svelte store.
- AndroidManifest gains `BLUETOOTH_CONNECT`, `BLUETOOTH_SCAN`,
  `ACCESS_FINE_LOCATION` permissions.
- Settings → Connected devices section: pair button, remembered
  device, auto-reconnect on workout start.

**Storage + UI** (~3-4 evenings)
- `workout_log.hr_samples` new column (JSON `[{ ts, bpm }]`).
  Idempotent ALTER, default null.
- Live BPM chip during workout (top of Diary, near the timer).
- WorkoutSummary stats: avg HR, max HR, optional time-in-zones (HR
  zones derived from age via 220-age default, overrideable in
  Settings).
- CSV export gains `hr_avg_bpm`, `hr_max_bpm` columns.

Total: ~1.5 weeks of evenings.

**Decisions still open before writing code**:
- HR zones: derive default from age (220-age × {50%, 60%, 70%, 80%,
  90%}) or let user override? My take: derive default + show Settings
  override.
- iOS later, Web Bluetooth doesn't work on iOS Safari. When iOS
  lands the only BLE option is the same Capacitor plugin. Same JS
  flow, same data shape. Plan: have iOS done from day 1 by using the
  Capacitor plugin on native instead of Web Bluetooth on PWA from the
  start.
- Battery, continuous BLE notifications drain. Stop subscription on
  workout end + on app-pause-to-background-without-active-workout.

---

### Why not start either bundle now

RC is meant to stabilise what's out, not pile on. Both bundles are
structural enough that mid-RC introduction risks regression noise that
drowns out actual RC bug feedback. Hold until at least one cycle has
passed where the RC isn't generating new bug feedback, then start
Bundle A.

The user can override this and start either bundle whenever, these
are deferred, not blocked.

---

## Recently Released (moved from Planned)

### 2026-07-05 (v1.0.0-rc.7)

- ~~Security dep bumps~~, multer 1.4.5-lts.1 → 2.2.0 (three high-severity CVEs on the LTS line: unhandled-exception DoS, crafted-request DoS, unclosed-stream memory leak), nodemailer 8.0.7 → 9.0.3 (five CVEs including raw-option bypass, TLS OAuth cert validation, CRLF header injection), vite bumped alongside for the Windows `server.fs.deny` bypass patch. `npm audit` at both root and server now reports zero vulnerabilities. Retires the standing "multer 1.4.5-lts.1 OK to stay on" rule.

### 2026-07-01 (v1.0.0-rc.6)

- ~~Animated banner redesigned~~, illustrated SVG banners retired across every page. Setting Banner Style to Animated now paints the same compact accent bar as Gradient plus a subtle motion effect. Motion picked under Settings → Appearance → Banner Animation: Shimmer (default), Drift, Pulse, or Aurora. All honour Reduce Motion. Reclaims ~40 pixels of vertical real estate on every page.
- ~~Trace FAB visualizer parity on Android~~, bumped RENDER_LERP 0.08 → 0.35 so the frequency ring tracks music dynamics with the same amplitude as the PWA (was over-damped by an extra JS smoothing layer stacked on Java's already-correct 0.75 STC).
- ~~Cross-device workout save race fix~~, editing the same workout from phone + PWA near-simultaneously could clobber the other device's just-completed sets with a stale in-memory snapshot; the workout store now refetches and merges before writing.
- ~~Password manager password-generation fix~~, `passwordrules` attribute added to all 11 password-CREATION inputs so browsers and password managers generate passwords satisfying the LT policy (upper + lower + digit + special char, 8+ chars).

### 2026-06-29 (dev/main, post-rc.5)

- ~~CSV workout export~~, long-format CSV (one row per set) downloads from
  the WorkoutSummary sheet on the completion screen. PWA path is a direct
  Blob download; Android writes to Cache + opens Share intent. Unilateral
  L/R splits become two rows so neither side is averaged away. Lets the
  forum thread's "feed an external analysis pipeline" use case work
  without any backend changes (purely client-side generator).
- ~~Per-exercise JSON share + URL importer~~, single-exercise export
  ("share as JSON") from the ExerciseDetail header; importer accepts a
  file pick or a URL paste (github.com/blob URLs auto-rewrite to
  raw.githubusercontent.com). Strips install-local fields (id, source,
  created_by) on export and re-creates as `source='custom'` on import.
  Sets up the awesome-lifttrace-exercises community-repo pattern with
  no extra in-app machinery.
- ~~Custom equipment + multi-select "Available today" filter~~, Exercises
  filter chip strip is now multi-select (was single-select). User-defined
  equipment strings (Slackboard, Sandbag, etc.) get a dashed-border chip
  alongside the six normalized buckets when at least one exercise uses
  them. ExerciseEditor's equipment picker shows base + user kit + an
  inline "+ Add" pill. Persists via SERVER_SETTINGS (`customEquipment`)
  so a user's home-gym kit follows them between devices.

### 2026-04-27 (v0.10.0-beta.6)
- ~~Unified Android playback on Media3 ExoPlayer~~, radio + library both flow through `RadioPlayerPlugin` + `RadioPlaybackService`. One MediaSession, one notification UX, lockscreen swaps Prev/Next/Stop layout dynamically. Drops capacitor-music-controls-plugin. PWA path unchanged.
- ~~RDS Italia `Song*` + HLS ID3 (`TIT2`/`TPE1`) parsers~~, three sanitizers (Java/JS/server) all recognize asterisk-delimited and ID3-tagged broadcaster formats; iHeart `text=` and Shoutcast `title=`/`artist=` shapes already handled.
- ~~PWA stream RDS on lockscreen~~, now-playing poll pushes parsed title/artwork into `navigator.mediaSession.metadata` so the OS lockscreen reflects each song change.
- ~~PWA rest timer notifications~~, request `Notification.requestPermission()` from `startRest` (a real user gesture) instead of `_finish`'s setTimeout (silently no-ops).

### 2026-04-22 (v0.9.4-beta.15 → beta.16)
- ~~Radio page polish pass~~, now-playing highlight on station rows, Artists empty state, "Added" chip on duplicate Browse results, bigger reorder arrows on touch, search spinners
- ~~Diary layout polish~~, "Now doing" pill, current-set highlight, progress fill on summary bar, dedupe workout name
- ~~Settings copy consistency~~, Title Case for section names, sentence case for setting rows

### 2026-04-21 (v0.9.4-beta.13 → beta.14)
- ~~Warm-up set generator~~, bar → 50% → 70% → 85%, manual button + opt-in autoGenerate on template load; `warmup` flag propagated through all stats
- ~~RPE / RIR per set~~, opt-in chip + picker on SetRow, stored as `set.rpe`
- ~~Similar exercises~~, "Similar exercises" grid on ExerciseDetail, primary-muscle-overlap scoring
- ~~Selectable rest-timer tones~~, 5 synth presets (Classic, Bells, Beeper, Gym, Minimal) with preview button
- ~~Superset rest timer "Next: X" label~~, shows correct next exercise (first in group) after a superset round, not the one just completed

### 2026-04-21 (v0.9.4-beta.10 → beta.12)
- ~~Workout-history import~~, Strong + Hevy + FitNotes + Jefit CSV adapters, two-step preview → commit, skip/replace on duplicate dates
- ~~NutriTrace-style user management~~, sign-out moved to sidebar footer, "My Profile" shortcut in User Management section, Settings top is clean
- ~~Radio station metadata hardening~~, UTF-8/Latin-1 fallback, HTML entity decode, ad-marker suppression, Icecast `status-json.xsl` + Shoutcast `/stats?json=1` fallback fetchers
- ~~Station groups, rename, in-group reorder~~, datalist suggestions, drag-and-drop cross-group, bulk-rename pencil on group header, up/down arrows for in-group

### 2026-04-20 (v0.9.4-beta.5 → beta.9)
- ~~HLS radio station support~~, lazy-loaded `hls.js` chunk for `.m3u8` streams (TuneIn-style)
- ~~Radio-Browser.info Browse sub-tab~~, search ~40k stations, tap to add
- ~~ICY `StreamTitle` now-playing~~, proxy parses interleaved metadata, client polls `/now-playing`, displays in mini-player + full player + station list
- ~~LiftBot FAB frequency visualizer ring~~, 32 SVG bars around the robot head, Web Audio `AnalyserNode`
- ~~`/api/radio-proxy`~~, routes station streams through the server so Web Audio visualizer isn't CORS-silenced
- ~~Drag auto-scroll during diary reorder~~, edge-zone RAF loop, `behavior: 'instant'` override of global smooth-scroll
- ~~Rest timer rebuild~~, persistent store, absolute `endTime`, countdown beeps at 3/2/1/0 with vibration, background Service Worker notification
- ~~Auto-collapse default ON + persisted collapse state~~, 3-state model (`collapsed` / `expanded` / null) respects explicit user intent across navigation
- ~~Custom exercises (in-app)~~, create/edit/delete with media picker (upload / paste URL / YouTube), "Custom" chip, Settings management section

### 2026-04-18 (v0.9.x earlier)
- ~~Smart Add (workout edition)~~, text + voice parse via LiftBot, hold-to-record on the FAB
- ~~Share workout card~~, PNG render from completion summary
- ~~Streaming radio stations~~
- ~~LiftBot data access~~, live context injected every chat
- ~~Settings sub-component split~~, 890-line orchestrator, one file per section
- ~~Progressive overload auto-fill~~ · Workout completion summary · Body stats · Plate calculator · 1RM · Body weight trend · Calendar heatmap · Offline support · Notifications / scheduler
