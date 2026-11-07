# Roadmap

Ideas and planned enhancements. Grouped by area. No commitment to order or timeline.
Items marked ~~strikethrough~~ have been implemented, with the version they were released in.
"On dev" means the work is on the `dev` branch and goes out with the next release.

Last refreshed 2026-11-06: v1.4.0 (released 2026-10-16) plus what is on dev since.

The detailed design notes for the next training features (week start, bodyweight
exercises, past workouts, progression schemes, deloads, RIR, drop sets and more) live in
[`docs/plans/training-depth-plan.md`](docs/plans/training-depth-plan.md).

---

## Left over from the 1.0 audit (2026-05-25)

v1.0.0 was released on 2026-07-18. These were the polish items from the 1.0 release
candidate audit; the ones still open are kept here.

### ~~Test coverage~~ *(done, first tests in v1.0.2, CI since v1.1.2)*

The 1.0 audit found no automated tests. LiftTrace now runs `node --test scripts/*.test.js`
(180 test files and about 1,800 tests on dev, 111 files in v1.4.0) plus the i18n key check,
on every pull request and every push to `main` and `dev` (`.github/workflows/ci.yml`).
The tests cover the server routes, sync and offline queues, MCP and the REST API, backup
and restore, the Android sync layer through a Node harness, and wiring checks on the
Svelte components.

Still not covered: a browser end-to-end suite (the Playwright smoke run the audit
proposed: sign in, log a workout, open Statistics, create a program).

### ~~i18n extraction to 55-60% coverage~~ *(done, v1.1.0)*

The original target was about 340 keys. v1.1.0 moved every hardcoded string into
`src/i18n/en.json`, which now holds about 2,250 strings. Released languages: English,
Spanish and Italian (v1.2.0), and Simplified Chinese (v1.4.0), translated on Weblate. A
Russian translation is finished on Weblate and its file is on dev, but it is not in the language picker yet
([#149](https://github.com/TraceApps/lifttrace/issues/149)).

### Onboarding tour (first-run overlay)

Not started. Setup ends with a "You're All Set" screen, then the Diary opens on a UI new
users have never seen. An overlay walkthrough ("this is where you log sets, this is your
active program, this is Trace") would help. Pattern: a stepped tooltip system keyed on a
first-launch value in `localStorage`.

### Accessibility cleanup

Still open, and larger than first counted: about 30 `svelte-ignore a11y-click-events-have-key-events`
blocks (both spellings) (and more `a11y_no_static_element_interactions`) across the Diary, Trace, the radio
players, sheets and dialogs. Each is a clickable `<div>` without keyboard reach. The fix is
`<button>` or keyboard handlers plus visible focus indicators on the custom widgets.

### Smaller audit items

- **Mobile / responsive at <360px**: Settings rows with trailing controls on very narrow screens. Not rechecked since the audit.
- **`min-width` audit**: fixed `min-width: 160px` on the exercise sort menu and a few other controls, and the fixed-height progress chart on ExerciseDetail (`100px`). Cosmetic, still there.
- **Loading spinners inside settings sub-sections**: the shared `<Spinner>` is used by API Tokens and Webhooks, but not yet by long-running actions such as Sync Now and creating a full backup.
- **Per-OIDC-provider verified indicator**: Settings > Authentication has a per-provider Test button, but no lasting "verified" mark on the provider card.

---

## Workouts & Sets

### ~~Warm-up set generator~~ *(done, v0.9.4-beta.13)*
Bar → 50% → 70% → 85% ramp; manual button + opt-in `autoGenerate` on template load; `warmup` field propagated through all stats math so warm-ups don't inflate volume totals. On dev, warm-up steps only ever climb and stay under the working weight.

### ~~RPE per set~~ *(done, v0.9.4-beta.13)*
Opt-in chip + picker on SetRow, stored as `set.rpe`. RIR is not done (this line used to say it was); see "RIR alongside RPE" below.

### RIR alongside RPE
Not started. A per-user choice of RPE or RIR, each set storing the scale it was logged with. Design in the training-depth plan, item 10.

### ~~Rest timer rebuild~~ *(done, v0.9.4-beta.5→9)*
Persistent store, absolute `endTime`, countdown beeps at 3/2/1/0 with vibration, background Service Worker notification.

### ~~Rest timer on the lock screen, Pause, and Play Through Do Not Disturb~~ *(done, on dev)*
On Android a running rest shows in the notification shade and on the lock screen with what you lift next. Pause and Resume on the rest bar, the notification and the watch. Settings → Workout → Play Through Do Not Disturb plays the rest alert on the alarm stream.

### ~~Selectable rest-timer tones~~ *(done, v0.9.4-beta.13)*
5 synth presets (Classic, Bells, Beeper, Gym, Minimal) with preview button.

### ~~Superset rest timer "Next: X" label~~ *(done, v0.9.4-beta.13)*
Shows correct next exercise (first in group) after a superset round, not the one just completed.

### ~~Auto-collapse default ON + persisted collapse state~~ *(done, v0.9.4-beta.5→9)*
3-state model (`collapsed` / `expanded` / null) respects explicit user intent across navigation.

### ~~Drag auto-scroll during diary reorder~~ *(done, v0.9.4-beta.5→9)*
Edge-zone RAF loop, `behavior: 'instant'` override of global smooth-scroll.

### ~~Library-level load type~~ *(done, v1.1.0, [#24](https://github.com/TraceApps/lifttrace/issues/24))*
Bilateral, Per Side or Alternating set on the exercise, so it travels with it into every workout.

### ~~Timed sets for planks, holds and carries~~ *(done, v1.3.0, [#89](https://github.com/TraceApps/lifttrace/issues/89))*
An exercise can be tracked by Time instead of Reps, with a hold timer. See Bundle A below.

### ~~Several workouts in one day~~ *(done, v1.3.0, [#76](https://github.com/TraceApps/lifttrace/issues/76))*
Independent sessions on the same date, such as a stretching routine and a lifting session.

### ~~Excuse a day you couldn't train~~ *(done, on dev, [#121](https://github.com/TraceApps/lifttrace/issues/121))*
Injury, Illness, Appointment or Other, with a note. Comes off the weekly goal, has its own mark in the calendar and heatmap, and pauses a calendar-based program.

### ~~Cardio session logging~~ *(done, v1.1.0, [#23](https://github.com/TraceApps/lifttrace/issues/23))*
Opt-in Track Cardio: sessions with activity, duration, optional distance and average heart rate, kept apart from lifting volume and PRs, with a weekly Cardio view in Statistics and pinned quick-log templates.

### ~~Track by distance or calories~~ *(done, on dev, [#119](https://github.com/TraceApps/lifttrace/issues/119))*
An exercise tracked by Distance (m, km, yd or mi) or Calories next to Reps and Time, for rowers, SkiErgs, sled pushes, carries, runs and air bikes, with weight still there for a loaded sled. Longest distance and most calories are records; built-ins that are naturally distance or calorie based start that way only if never logged. This replaces the old "cardio fields on the set row" idea for distance. Live heart rate on a set is not planned (see Bundle B).

### ~~Per-side hold timer~~ *(done, on dev, [#143](https://github.com/TraceApps/lifttrace/issues/143))*
A timed Alternating exercise times the left side, counts a switch down, then times the right, and keeps both times; the shorter side is the set's time, so the longest-hold record tracks the weaker side. Per Side (both sides at once) keeps one timer. A program can't prescribe a different time for each side yet.

### Collapsed-card summary
Not started. When an ExerciseCard auto-collapses after completing all sets, show the best working set on the header (e.g. `Bench Press · 4/4 · 225×5`) instead of only the set count.

---

## Programs & Templates

### ~~Multi-week progression plans~~ *(done, v1.0.1, [#13](https://github.com/TraceApps/lifttrace/issues/13))*
A program spans a block of weeks with a per-week Sets / Reps / Tempo / Rest / Load matrix, advancing by sessions or by the calendar.

### ~~Start a program's workout from the API~~ *(done, on dev, [#140](https://github.com/TraceApps/lifttrace/issues/140))*
`POST /api/v1/workouts/:date/start` and the MCP tool `start_program_workout` start the active program's next day, planned the way Load Workout plans it.

### Template auto-suggest
Partly done. The API and MCP above pick the program's next day (the one after the last finished). The Diary does not suggest it yet: its active-program card opens the program's day list for you to pick.

### Share a routine as a file, and print it
Not started. Export a program or template as a JSON file and import it, plus a print layout. Training-depth plan, item 12. Today single exercises can be shared as JSON.

---

## Statistics

### ~~Body weight trend~~ *(done)*
### ~~Progressive overload auto-fill~~ *(done)*
### ~~Calendar heatmap~~ *(done)*
### ~~1RM~~ *(done)*
### ~~Plate calculator~~ *(done)*

### ~~RPE trend chart~~ *(done, v0.9.4-beta.18)*
A dashed average-RPE line on the Exercise Progress chart, with its own legend, when RPE was logged for that exercise.

### ~~Muscle Balance body map~~ *(done, v1.0.2)*
Front and back figures shaded by volume per muscle group; the figure was redrawn in v1.3.0.

### ~~Second body measurement on the Body Weight chart~~ *(done, v1.3.0)*

### Custom muscle targeting and recovery
Draft pull request open ([#117](https://github.com/TraceApps/lifttrace/pull/117), for [#110](https://github.com/TraceApps/lifttrace/issues/110)).

### Weekly summary, next steps ([#98](https://github.com/TraceApps/lifttrace/issues/98))
Since v1.3.0 the summary reports sessions against the weekly goal, sets, volume, time trained, PRs and sets per muscle group, each against the average week over the month before, with a link into Statistics. Still to come:
- **Translated emails.** Server emails are English for every locale (the numbers already follow the language setting). A family-wide job, since CookTrace and NutriTrace have the same gap.
- **Choosing what goes in.** Per-user picks for which metrics and which comparison, before any editable template.
- **Program-aware comparison.** Week 3 of this block against week 3 of the last one, from the `program_id` and `program_week` already stamped on every workout.
- **Admin-set schedule.** An instance-wide default day and time, the way scheduled backups are set.
- **An exact week link.** Statistics only has rolling ranges, so the email opens the last seven days rather than that calendar week.

---

## Exercises & Equipment

### ~~Custom exercises~~ *(done, v0.9.4-beta.5→9)*
Create / edit / delete with media picker (upload / paste URL / YouTube), "Custom" chip, Settings management section.

### ~~Custom equipment + multi-select "Available today" filter~~ *(done, v1.0.0-rc.6)*
Exercises filter chip strip is now multi-select. User-defined equipment strings (Slackboard, Sandbag, etc.) get a dashed-border chip alongside the six normalized buckets when at least one exercise uses them. Persists via SERVER_SETTINGS (`customEquipment`).

### ~~Similar exercises~~ *(done, v0.9.4-beta.13)*
"Similar exercises" grid on ExerciseDetail, primary-muscle-overlap scoring.

### ~~Per-exercise JSON share + URL importer~~ *(done, v1.0.0-rc.6)*
Single-exercise export from ExerciseDetail; importer accepts file pick or URL paste (github.com/blob auto-rewrites to raw.githubusercontent.com). Strips install-local fields on export, re-creates as `source='custom'` on import.

### ~~Exercise browser density toggle~~ *(done, v1.3.0, [#74](https://github.com/TraceApps/lifttrace/issues/74))*

### ~~Public catalogs in the standalone Android app~~ *(done, v1.0.2, [#18](https://github.com/TraceApps/lifttrace/issues/18))*

### Orphan upload cleanup
Still open. When a custom exercise is deleted, its `/uploads/exercises/<uuid>.ext` file stays on disk. Progress photos and set videos already delete their files.

---

## Trace AI

### ~~Smart Add (workout edition)~~ *(done, v0.9.x)*
Text + voice parse, hold-to-record on the FAB.

### ~~Trace data access~~ *(done, v0.9.x; tool use since v1.0.2)*
Trace calls typed read and write tools instead of a pre-stuffed context; since v1.3.0 it also reads progress photos and cardio and logs cardio, and on dev it reads excused days.

### ~~Custom model IDs~~ *(done, v1.0.1)*
A Custom option on the Model list for Claude, OpenAI and Gemini.

### ~~Markdown in Trace replies~~ *(done, v1.2.0, [#52](https://github.com/TraceApps/lifttrace/pull/52))*

### ~~Trace FAB frequency visualizer ring~~ *(done, v0.9.4-beta.5→9)*
32 SVG bars around the robot head, Web Audio `AnalyserNode`.

### ~~Trace FAB visualizer parity on Android~~ *(done, v1.0.0-rc.6)*
RENDER_LERP 0.08 → 0.35 so the frequency ring tracks music dynamics with the same amplitude as the PWA.

### Trace deload suggestions
Not started. Trace mentions a deload when asked and the RPE trend calls for it, but it does not suggest one on its own. Planned deloads in programs are item 8 of the training-depth plan.

---

## Import & Migration

Supported: Strong, Hevy, FitNotes, Jefit (CSV) and Garmin FIT. No longer marked Experimental since v1.4.0.

### ~~Workout-history import~~ *(done, v0.9.4-beta.10→12)*
Strong + Hevy + FitNotes + Jefit CSV adapters, two-step preview → commit, skip/replace on duplicate dates.

### ~~Garmin FIT file import~~ *(done, [#6](https://github.com/TraceApps/lifttrace/issues/6))*
Adapter at `server/lib/workout-import/garmin-fit.js` via `@garmin/fitsdk`, mapping Garmin's `exercise_category` enum to LiftTrace's catalog via `garmin-exercise-map.js`.

### Batch FIT import
Not started. One `.fit` file per import today; a folder of files at once would help.

### RPE back-fill from imported notes
Not started. The Strong and Hevy importers put RPE into set notes as `"RPE 8"`. Promote those to the real `set.rpe` field with a one-time migration.

### Other apps' exports (Apple Health, Fitbod, Gymshark Conquer, Gravitus)
Ideas only, lower priority. These would be one-off file imports. Ongoing device sync (Health Connect, Apple Health, Fitbit, Garmin Connect) stays out of LiftTrace: NutriTrace owns wearables, and LiftTrace connects to it through federation.

---

## Body Stats & Photos

### ~~Body stats~~ *(done, v0.9.x)*

### ~~Progress photos timeline~~ *(done, v1.3.0)*
Dated photos on their own `/progress` page, reached from Statistics and the Body Stats sheet, with a drag-to-compare before/after view. Photos never expire; they are the long-term record the feature exists for. Coaching clips (#57) are a separate concern with a separate lifetime.

### Photo notes
Not started. A free-text note per photo, not per date. The deciding case is the pose label ("front relaxed", "side flexed"): the table deliberately allows several photos on one date, and a pose is inherently per-photo, while a date-level note ("start of cut") degrades perfectly well into a per-photo one. The implication only runs one way, so the photo is the right owner, and one notes field beats two.

Deliberately free text rather than a structured pose picker for now. A taxonomy chosen before anyone has formed a habit is a UI plus a migration betting on a guess, and free text stays fuzzy-matchable if smart compare (offering like against like) ever earns its place.

Bigger than the one nullable column suggests: notes are the first thing that makes a photo row editable, so this adds an update verb across the app route, the MCP tool and the REST route, plus the sync-push and backup-restore column lists. Full plan in [`docs/plans/photo-notes.md`](docs/plans/photo-notes.md).

### Body measurements from NutriTrace
Open ([#113](https://github.com/TraceApps/lifttrace/issues/113), pull request [#123](https://github.com/TraceApps/lifttrace/pull/123) under review): read body measurements logged in NutriTrace into LiftTrace.

---

## Coaching

### ~~Coaching (trainer and client)~~ *(done, v0.8.4-beta)*
A Trainer role with a Coaching page listing assigned clients, their programs and history.

### ~~Coaching asks first~~ *(done, v1.4.0)*
Nothing is shared with a coach until the client accepts the request. Coach and client conversation with photos, prescribed workouts that ask before they load, set videos for coach review ([#57](https://github.com/TraceApps/lifttrace/issues/57)), coaching notifications, and an assigned program that opens read-only for the client.

---

## External Integrations

### ~~NutriTrace federation~~ *(done, v1.0.0-rc.4, `write:workouts` scope)*
LiftTrace posts each completed workout's estimated calories into NutriTrace's workout history via bearer-scoped `/api/v1/*` federation.

### ~~Model Context Protocol (MCP) server~~ *(done, v1.3.0, [#78](https://github.com/TraceApps/lifttrace/issues/78))*
`/api/mcp` for external AI clients (Claude Desktop, Cursor, Codex, VS Code). Off by default (`MCP_ENABLED=1` plus a token with `mcp:read`); write tools need `MCP_WRITE_ENABLED=1` and `mcp:write`, the delete tool `MCP_DESTROY_ENABLED=1` and `mcp:destroy`.

v1.4.0 has 15 tools (11 read, 3 write, 1 delete), including the date-range reads `get_workouts` and `get_body_stats` ([#93](https://github.com/TraceApps/lifttrace/pull/93)). Dev has 19: `get_cardio` and `log_cardio` ([#134](https://github.com/TraceApps/lifttrace/issues/134)), `start_program_workout` ([#140](https://github.com/TraceApps/lifttrace/issues/140)) and `get_excused_days` ([#121](https://github.com/TraceApps/lifttrace/issues/121)). Not done from the original sketch: `edit_set` and `create_custom_exercise`.

### ~~Public REST API~~ *(done, v1.3.0, [#77](https://github.com/TraceApps/lifttrace/issues/77))*
A versioned API at `/api/v1`, off by default (`PUBLIC_API_ENABLED`). Reference in [`docs/public-api.md`](docs/public-api.md). An OpenAPI spec for it is item 13 of the training-depth plan.

### ~~Outgoing webhooks~~ *(done, v1.3.0, [#79](https://github.com/TraceApps/lifttrace/issues/79))*
Signed POSTs on events: `workout.completed`, `pr.set`, `body_stat.logged`, `progress_photo.logged`, `program.advanced`, plus `cardio.logged` on dev. Reference in [`docs/webhooks.md`](docs/webhooks.md).

### Prometheus metrics
Open ([#136](https://github.com/TraceApps/lifttrace/issues/136), pull request [#137](https://github.com/TraceApps/lifttrace/pull/137) under review): optional metrics for HTTP requests.

---

## Radio (audio during workouts)

### ~~Streaming radio stations~~ *(done, v0.9.x)*

### ~~HLS radio station support~~ *(done, v0.9.4-beta.5→9)*
Lazy-loaded `hls.js` chunk for `.m3u8` streams (TuneIn-style).

### ~~Radio-Browser.info Browse sub-tab~~ *(done, v0.9.4-beta.5→9)*
Search ~40k stations, tap to add.

### ~~ICY `StreamTitle` now-playing~~ *(done, v0.9.4-beta.5→9)*
Proxy parses interleaved metadata, client polls `/now-playing`, displays in mini-player + full player + station list.

### ~~Station groups, rename, in-group reorder~~ *(done, v0.9.4-beta.10→12)*
Datalist suggestions, drag-and-drop cross-group, bulk-rename pencil on group header, up/down arrows for in-group.

### ~~/api/radio-proxy~~ *(done, v0.9.4-beta.5→9)*
Routes station streams through the server so the Web Audio visualizer isn't CORS-silenced.

### ~~Radio station metadata hardening~~ *(done, v0.9.4-beta.10→12)*
UTF-8 / Latin-1 fallback, HTML entity decode, ad-marker suppression, Icecast `status-json.xsl` + Shoutcast `/stats?json=1` fallback fetchers.

### ~~RDS Italia `Song*` + HLS ID3 (`TIT2`/`TPE1`) parsers~~ *(done, v0.10.0-beta.6)*
Three sanitizers (Java/JS/server) all recognize asterisk-delimited and ID3-tagged broadcaster formats.

### ~~PWA stream RDS on lockscreen~~ *(done, v0.10.0-beta.6)*
Now-playing poll pushes parsed title/artwork into `navigator.mediaSession.metadata` so the OS lockscreen reflects each song change.

### Additional providers

Current: Subsonic (Navidrome/Airsonic/Gonic), Jellyfin, Plex, Emby, HLS / Icecast / Shoutcast streaming stations via Radio-Browser.info directory. Ideas, none started:

- **Funkwhale**: Subsonic-compatible (may already work) + own API
- **Ampache**: Subsonic-compatible + Ampache API
- **Koel**: own REST API
- **LMS (Lyrion)**: Logitech Media Server API
- **Multiple servers**: browse multiple providers simultaneously (Symphonium-style)

---

## Android App (Capacitor)

### ~~Unified Android playback on Media3 ExoPlayer~~ *(done, v0.10.0-beta.6)*
Radio + library both flow through `RadioPlayerPlugin` + `RadioPlaybackService`. One MediaSession, one notification UX, lockscreen swaps Prev/Next/Stop layout dynamically. Drops `capacitor-music-controls-plugin`. PWA path unchanged.

### ~~Offline support~~ *(done, v0.9.x)*

### ~~Notifications / scheduler~~ *(done, v0.9.x)*

### ~~PWA rest timer notifications~~ *(done, v0.10.0-beta.6)*
Request `Notification.requestPermission()` from `startRest` (a real user gesture) instead of `_finish`'s setTimeout (silently no-ops).

### ~~In-app updates~~ *(done, v1.1.0)*
Settings → Updates checks for a newer release and, on Android, downloads the signed APK. Since v1.4.0 checks are off until you turn them on, and the server does the asking.

### ~~Wear OS app~~ *(done, v1.4.0)*
For watches on Wear OS 3 and up: opens on the set in front of you with weight and reps filled in. On dev the watch also finishes a workout like the phone does.

### ~~Preliminary foldable support~~ *(done, v1.4.0)*
Half open like a book, Settings splits on the crease and dialogs, sheets, the rest timer and Trace keep off the fold; opened flat, Programs and Exercises split into list and preview.

### ~~Plain HTTP to a server on your own network~~ *(done, on dev)*
The Android app connects to an `http://` address on your own network after a warning that the connection is not encrypted.

### ~~App icon shortcuts~~ *(done, on dev)*
Long-press the app icon (Android, or the installed web app) for quick actions.

### Native Android voice input
Not started. Voice input in Smart Log and Trace uses the Web Speech API, which is patchy inside the Android WebView. Switch to a native speech recognition plugin.

---

## Sync & Multi-Device

### ~~Cross-device workout save race fix~~ *(done, v1.0.0-rc.6)*
Editing the same workout from phone + PWA near-simultaneously could clobber the other device's just-completed sets with a stale in-memory snapshot; the workout store now refetches and merges before writing.

### ~~Per-entry merge for the workout log~~ *(done, v1.2.0)*
Two devices editing the same day merge per exercise and per set instead of one payload replacing the other. On dev, sync keeps the newer edit of each field, by the rule every Trace app shares.

### ~~Pull-to-refresh sync and a connection banner that says why~~ *(done, v1.1.0)*
On Android, swipe down to sync; when sync fails the banner names the cause (no network, server unreachable, HTTP error).

### ~~Sync status in the sidebar~~ *(done, v1.3.0)*

### ~~NutriTrace-style user management~~ *(done, v0.9.4-beta.10→12)*
Sign-out moved to sidebar footer, "My Profile" shortcut in User Management section, Settings top is clean.

---

## Accounts & Sign-In

### ~~Multi-user with roles~~ *(done, from v0.1.0-alpha)*
Admin, trainer and member roles (a coached member is called a "client" since v1.4.0), invites, session policy.

### ~~OIDC single sign-on~~ *(done, v0.10.1-beta.5)*
Any compliant provider; SSO-only mode via `OIDC_ENABLE_EMAIL_PASSWORD_LOGIN=0` since v1.0.1 ([#16](https://github.com/TraceApps/lifttrace/issues/16)).

### ~~Two-step sign-in~~ *(done, on dev)*
An authenticator app code after the password, with recovery codes; admins can require it. From [nutritrace#222](https://github.com/TraceApps/nutritrace/issues/222).

### Passkeys
Not started. Training-depth plan, item 14.

---

## Export & Sharing

### ~~CSV workout export~~ *(done, v1.0.0-rc.6)*
Long-format CSV (one row per set) downloads from WorkoutSummary. PWA path is a direct Blob download; Android writes to Cache + opens Share intent. Unilateral L/R splits become two rows.

### ~~Share workout card~~ *(done, v0.9.x)*
PNG render from completion summary.

### Per-entity CSV/JSON export
Not started in the app. Workouts.csv, programs.json, exercises.csv separate from the full-backup ZIP; CSV export is still one workout at a time. Since v1.3.0 the REST API reads the same data for scripts.

---

## UI / UX Polish

### ~~Animated banner redesigned~~ *(done, v1.0.0-rc.6)*
Illustrated SVG banners retired across every page. Setting Banner Style to Animated now paints the same compact accent bar as Gradient plus a subtle motion effect (Shimmer / Drift / Pulse / Aurora, all honor Reduce Motion). Reclaims ~40px of vertical real estate.

### ~~Password manager password-generation fix~~ *(done, v1.0.0-rc.6)*
`passwordrules` attribute added to all 11 password-CREATION inputs so browsers and password managers generate passwords satisfying the LiftTrace policy.

### ~~Diary layout polish~~ *(done, v0.9.4-beta.15→16)*
"Now doing" pill, current-set highlight, progress fill on summary bar, dedupe workout name.

### ~~Settings copy consistency~~ *(done, v0.9.4-beta.15→16)*
Title Case for section names, sentence case for setting rows.

### ~~Desktop wide layout~~ *(done, v1.2.0)*
Wide-screen layouts for the main pages and a Diary side rail with pin, hide and overlay.

### ~~Support page~~ *(done, v1.4.0)*
Settings > Support, next to About.

### Keyboard shortcuts overlay
Not started. `?` opens a cheatsheet listing Space / Arrow / etc. Radio player already has keyboard bindings; surface them.

---

## Distribution & Licensing

### ~~Docker Hub mirror~~ *(done, v1.1.1)*
Images on Docker Hub (`traceapps/lifttrace`) next to GHCR.

### Paid Android app (future)

Speculative. LiftTrace is free everywhere (self-host + free signed APK from the release page). This section captures what would need doing IF a paid Play Store / F-Droid distribution ever happens. None of it is started.

- **Attribution page / About panel** listing every active exercise / media / library source + its license (CC-BY-SA 4.0 for wger, Unlicense for free-db, AGPL for OSS ExerciseDB + hls.js, commercial TOS for RapidAPI, Radio-Browser.info attribution). AscendAPI requires visible credit for any project using their OSS dataset.
- **Build-tier setting** (e.g. `VITE_BUILD_TIER='commercial'`) that filters `SOURCES[]` so the paid Android build does not expose `oss.exercisedb.dev`. Their terms explicitly prohibit commercial/monetized use of the OSS endpoint.
- **Explicit warning in the wizard** when a user picks the OSS source: "Personal / non-commercial use only. Safe for self-hosters; paid-app users should use RapidAPI instead."
- **Prebuild a starter SQLite** in CI with just Free Exercise DB (~870 exercises, Public Domain) + its images, bundle into the Android APK assets. First-launch instantly useful with zero network.
- **Local GIF mirror option**: download GIFs to `/uploads/exercisedb/{id}.gif` at import time so URL rotation by upstream can't break the app. 150-300 MB disk, included in full backups. Toggle in Settings → Exercise Catalog.
- **Weekly scheduled re-import** for commercial ExerciseDB sources (URLs rotate every Monday 00:00 UTC per AscendAPI's caching guide). Low priority, the OSS + free sources don't rotate.
- **Commercial dataset snapshot**: buying the v1 dataset outright from AscendAPI's shop so a paid APK could bundle rich GIFs without an ongoing API dependency. One-time cost vs. subscription.

---

## Engagement / Achievements

### Achievements / badges
Not started. "100 workouts logged", "First 3-plate bench", "30-day streak", etc. Motivational layer, opt-in.

---

## Offline

### ~~Offline PWA editing~~ *(done, v1.4.0)*

The installed web app works in a dead zone the way the Android app does: it opens, shows
your data, and logs workouts with no signal, sending them when the connection is back.
Built on NoteTrace's browser offline model, in the order NutriTrace, LiftTrace, CookTrace.

How it works: Workbox caches the app shell, an IndexedDB mirror answers reads when the
server can't be reached, an outbox holds edits and shows them at once, new rows get
temporary ids that are mapped to real ids after they go up, and the queue goes through the
same routes the app uses online, so the server merges browser edits exactly as it merges
the phone's. A Web Lock stops two tabs sending at once and a BroadcastChannel keeps them in
step. Deliberately not the Service Worker Background Sync API, which Safari doesn't
support: the page sends the queue itself, with retries backing off from 3s to 30s plus
`online` events.

Covered offline: sets, notes, body stats, cardio, your own exercises, progress photos and
settings. Still online only: Trace, exercise videos, catalog imports, editing programs, and
anything admin. The menu button shows an amber cloud while anything waits to go up.

iOS caveat: Safari evicts site data after about 7 days of no use unless the PWA is on the
Home Screen.

---

## Tech debt

### Emby provider `/emby/*` route split
Still open. The Emby library-browsing methods delegate to `jellyfin.*` via `.apply(jellyfin, args)`, which means they hit `/api/subsonic/provider/jf/*` routes on the server (with Emby's URL in radioUrl). Works because Emby is a Jellyfin fork with API-compatible endpoints and both auth with `X-Emby-Token`. Would break if Emby ever diverges from Jellyfin's `/Items`-style routes. Fix = duplicate the jellyfin methods into the emby object with `/emby/` prefixes, or thread a `_prefix` parameter through `_proxyJson`.

### ~~Android radio HE-AAC decoder workaround~~ *(done, v0.10.0-beta.6)*
Chromium WebView's `<audio>` path failed at the same point on every iHeart-style HE-AAC stream. Fixed by the third option this entry listed: Android plays radio and library audio through native ExoPlayer (the `LtRadioPlayer` plugin, see "Unified Android playback" above), so streams no longer go through the WebView decoder. The old WebView proxy in `src/lib/stream-proxy.js` is left over from the workaround and no longer plays anything on Android.

### `openid-client 5 → 6`
Still open: the server is on `openid-client` 5. Version 6 is a complete rewrite with a cleaner API. Deferred unless the OIDC code is being reworked. Dependencies are checked monthly with `npm audit`.

### ~~Security dep bumps~~ *(done, v1.0.0-rc.7)*
Multer 1.4.5-lts.1 → 2.2.0 (three high-severity CVEs on the LTS line: unhandled-exception DoS, crafted-request DoS, unclosed-stream memory leak), nodemailer 8.0.7 → 9.0.3 (five CVEs including raw-option bypass, TLS OAuth cert validation, CRLF header injection), vite bumped alongside for the Windows `server.fs.deny` bypass patch.

### ~~Settings sub-component split~~ *(done, v0.9.x)*
890-line orchestrator, one file per section.

---

## Bundles from the 1.0 release candidate feedback

These came from public feedback during the v1.0.0 release candidates. Bundle A is mostly
done; Bundle B is not planned. The notes below are kept as the design record.

---

### Bundle A: Time-based exercises + HIIT-style rest

**Original commenter ask** (paraphrased from forum thread):

1. Per-exercise countdown timer for time-based work ("2 minutes of weighted carries, start timer, get countdown, get a beep when it hits"). Should be settable per exercise.
2. Per-set + per-round rest for HIIT circuits ("20s rest between exercises, then 2-minute rest before starting another round").
3. The commenter's mental model: "rest is just an exercise with a timer": work and rest as the same primitive.

**Status:** phases 1 and 2 (timed sets and the hold timer) were released in v1.3.0
([#89](https://github.com/TraceApps/lifttrace/issues/89)). Phase 3 (per-set and per-round
rest) is not started, and the framing question below is still open. Per-exercise rest is
already set per week in a program (`rest_sec`, v1.0.1).

**Open architectural decision: which framing**

Two viable shapes, neither chosen yet. Pick before writing code.

**Option 1, Rest-as-a-set (closer to commenter's literal ask)**

- Add a single `set.kind: 'work' | 'rest'` value.
- Both work and rest sets share one primitive: a timed segment.
- HIIT circuits become inline sequences: work / rest / work / rest / long-rest.
- Stats math (volume, PRs, time-under-tension) filters `kind='rest'` rows out so the workout log isn't polluted by "47 sets of Rest this month".
- One concept (timed segment + kind value) instead of three new fields.
- **Visible cost**: rest periods become inline rows in the diary. Every HIIT circuit gets ~10 extra rows. Strength-only users still see one work row per set as today, so they only notice it when they build a HIIT workout.

**Option 2, Set metadata**

- Add `set.rest_after_sec` (null = program default, number = per-set override).
- Add `superset.round_break_sec` (rest after the LAST exercise in a round).
- Cleaner stats (rest never exists as a row), messier vocabulary (rest has its own non-set identity).
- **Visible cost**: rest stays invisible between rows (current behavior). Per-set rest override is hidden behind long-press by default. Diary view stays clean.

**Leaning**: Option 1. It's literally what the commenter asked for, the diary-row cost is acceptable because strength users never trigger it, and the schema is simpler.

**Phase 1, Schema + SetRow input rendering** *(done, v1.3.0, issue #89)*

Released as the timed-sets slice of Bundle A, without deciding the rest-framing question: the fields it needs (`set.duration_sec`, and a `set_type` of `'reps' | 'time'` on the exercise instance and the library row) are the same under Option 1 and Option 2. Named `set_type` rather than `default_set_type` to match the existing `load_type`, which has the same per-instance / library / remembered-preference layering. Recorded set data outranks every default, so history never changes shape. Covered: Diary chip and set row, exercise editor, templates (a real `duration` field through the weeks matrix and per-set specs), Statistics and exercise detail (longest hold), records and the `pr.set` webhook, CSV export, Strong and Hevy import, Smart-Add, Trace, MCP and the REST API.

**Phase 2, Active set timer** *(done, v1.3.0, issue #89)*

Built as a count-up hold timer with a 3s lead-in and a cue at the set's target time, rather than a pure countdown, so holding past the target still logs the real time.

**Phase 3, Per-set + round rest overrides** *(not started)*

- Option 1 path: rest rows exist inline in the diary. Each rest set has its own duration field. Round break is a longer rest set at the end of a round.
- Option 2 path: long-press a rest pill to edit just this rest; round-break pill on the last set of a superset round. Reuses the existing rest timer for the actual countdown.

**Keeping it out of the way**

- Round break only shown on supersets that opt in; plain supersets render exactly as today.
- Per-set rest override hidden behind long-press, never displayed inline (Option 2 path only).
- No new global setting or Settings screen entry for it.

**Decisions still open before writing phase 3**:

- Option 1 vs Option 2 (leaning Option 1).
- Time-under-tension as a stats metric, or skip it.

---

### Bundle B: Live BLE chest-strap heart rate

**Not planned.** Since v1.1.0 the line is that device and heart-rate sync (chest straps,
watches, Fitbit, Garmin, Health Connect, Apple Health) stays out of LiftTrace: NutriTrace
owns wearables, and LiftTrace sends it workouts through federation. Cardio sessions in
LiftTrace take an average heart rate typed in by hand.

The original sketch is kept as a record: a `src/lib/bleHr.js` over Web Bluetooth and
`@capacitor-community/bluetooth-le` reading the standard GATT Heart Rate Service
(`0x180D`, characteristic `0x2A37`), a live BPM chip in the Diary, `workout_log.hr_samples`,
and average / max heart rate on the workout summary and in CSV export.
