# Plan: Notes on progress photos

Status: proposed, not started.

## Why the note goes on the photo, not the date

The instinct is "a note about that day," which would live in
`body_stats_log.stats` (already a schema-less JSON blob, so it would cost
no migration at all). That instinct is wrong, and the reason is worth
writing down because it is the decision everything else follows from.

Look at what people actually write against a progress photo:

| Note | Belongs to |
| --- | --- |
| "Start of cut" | the date |
| "Week 4 of 5/3/1" | the date |
| "Bad lighting, ignore this one" | the photo |
| "Front relaxed" / "Side flexed" | the photo |

The last row decides it. `body_stat_media` deliberately allows several
photos per date (the table comment in `server/db.js` says so explicitly:
a front and a side shot the same day), and a **pose label is the single
most useful piece of metadata a progress photo can carry**. It is
inherently per-photo and cannot be expressed at the date level at all.

A date-level note, by contrast, degrades gracefully into a photo-level
one: write "start of cut" on the photo and nothing is lost. The
implication only runs one way, so photo-level is strictly more
expressive.

One notes field also beats two. Adding notes to both tables would make
"where did I write that" a question the user has to answer, which is a
worse outcome than the mild annoyance of typing a phase marker twice on
a day with two photos.

**Decision: `body_stat_media.note`, nullable TEXT. No notes concept is
added to `body_stats_log`.**

## What this unlocks later (and why we still do not build it now)

If photos carry pose labels, compare mode can eventually offer like
against like. Today compare will happily put a front shot against a side
shot, which is useless, and it has no way to know better.

That argues for a *structured* pose field rather than free text. Resist
it for now:

- A taxonomy picked before anyone has formed a habit is a UI plus a
  migration betting on a guess.
- Free text where someone types "front" is fuzzy-matchable later if
  smart compare ever earns its place.
- Pose is not the only thing people will write, so a structured field
  would need a free-text field beside it anyway, and then we are back to
  two fields.

Start with free text. Revisit a `tag` column only if real usage shows
people consistently labelling poses.

## Scope

Notes are the first thing that makes a photo row **editable**. Today the
lifecycle is create and soft-delete only, with no update path anywhere.
That is the bulk of the work here, not the column.

### 1. Schema

`server/db.js`, alongside the existing `addColumnIfMissing` calls
(around line 419):

```js
addColumnIfMissing('body_stat_media', 'note', 'note TEXT');
```

No length constraint in SQL. Cap it in the core function instead (see
below), matching how this app enforces shape in code rather than in DDL.

### 2. Core function and routes

New `server/lib/mcp/tools/update-progress-photo.js` exporting
`updateProgressPhotoCore(userId, { id, note })`, following the exact
shape of the existing `add-progress-photo.js`:

- Ownership-checked (`user_id` matches, or is NULL in single-user mode).
- Refuses a soft-deleted row.
- Trims, treats empty string as NULL, caps at 500 characters. Longer than
  that is not a caption, it is a journal entry, and the UI surfaces
  (a grid tile and a photo overlay) cannot show it.
- Touches `updated_at` so sync carries the edit.

Callers:

- `PATCH /api/body-stats/photos/:id` in `server/routes/body-stats.js`
  (new). Declared with the other `/photos` routes, all of which already
  sit before `/:date`.
- MCP tool `update_progress_photo`, write tier, registered in
  `registerWriteTools`.
- `PATCH /api/v1/body-stats/photos/:id` in `public-api.js`, behind
  `requireWriteEnabled` and `requireScope('mcp:write')`.

`add_progress_photo` gains an optional `note` argument so a note can be
set at creation in one call rather than create-then-patch.
`list_progress_photos` returns `note` in its rows.

**No webhook on a note edit.** `progress_photo.logged` exists because a
photo appearing is an event someone might automate against. Fixing a
typo in a caption is not. Firing on every keystroke-driven save would be
noise, and worse, a retry storm risk for anyone who wired that event to a
notification.

### 3. The five lifecycle touchpoints

This is the checklist worked out when the table was added. A new column
does not need all five, but it needs three of them, and missing any one
fails silently rather than loudly:

1. **`SYNCABLE`**: nothing to do, the table is already listed.
2. **`CLAIM_NULL`**: nothing to do, already listed.
3. **`full-backup.js`**: the restore insert must carry `note`, growing
   from 8 columns to 9. `scripts/progress-photos-wiring.test.js` already
   asserts every column by name, so add `note` to that list and the test
   will catch a miss.
4. **`sync.js`**: pull uses `SELECT *` so it needs nothing. **Push does**:
   the upsert block writes named columns, so without `note` there an
   edit on one device would never reach another, and would look like a
   sync bug rather than a missing column.
5. **Account deletion**: nothing to do, the row-level helper already
   removes whole rows.

### 4. Frontend

Two places to write a note, matching where the two capture doors already
put people:

- **Timeline tile.** The note, when set, renders under the date in
  `.pp-meta`, truncated to one line. No editing from the grid: tiles are
  for finding a photo, and an inline editor in a grid cell is a cramped,
  mis-tap-prone surface.
- **Scrubber.** The real editing surface. The stamp already carries date,
  weight, delta and day offset; the note goes beneath it as a full-width
  line, tap-to-edit, using the same inline-commit pattern
  `WeightQuickLog.svelte` established (Enter commits, Escape cancels,
  writes through, dispatches on success). That component is close enough
  in shape that the note editor should be written as a sibling in the
  same directory rather than generalising it prematurely.

Placeholder copy matters more than usual here, because a blank note field
invites nothing. Use the pose hint: "Front, side, lighting, how you
felt". That teaches the highest-value use without imposing a taxonomy.

### 5. i18n

New `progress.note.*` keys: `placeholder`, `add`, `save`, `saving`,
`save_failed`, `saved`. `en.json` in the same commit, other locales via
Weblate after release, as usual.

## Verification

Static, runnable in this sandbox:

- `note` survives the full-backup restore insert (extend the existing
  column-list assertion).
- Sync push writes `note` (grep the upsert block, same style as the
  existing `server_id` assertions).
- `updateProgressPhotoCore` is the only implementation, called by all
  three callers, with no duplicated UPDATE in either route file. This is
  the same regression guard the create path already has, and it guards
  the same bug class: a write wired into one route only.
- No `progress_photo` webhook dispatch in the update core.

Needs a real server:

- Edit a note on device A, sync, confirm it appears on device B.
- Edit via `PATCH /api/v1/...` with an `mcp:write` token, confirm the app
  shows it and that no webhook fires.
- Backup, wipe, restore, confirm notes survive.
- Set a note, soft-delete the photo, confirm the update route refuses a
  deleted row rather than resurrecting it.

## Estimate and sequencing

Bigger than it looks: one column, but a new verb (update) across three
callers, two lifecycle touchpoints, and a new editing surface. Roughly
comparable to the original photo-attach work, minus the upload handling.

Do it after the in-app camera question is settled, not before. If capture
grows a review step ("here is your shot, keep it?"), that is the natural
place to also ask for a note, and building the note UI first would mean
building it twice.
