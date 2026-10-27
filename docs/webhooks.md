# Outgoing Webhooks

Point LiftTrace at a URL and it fires a signed HTTP POST the instant
something happens: a workout is completed, a personal record is set, an
active program advances to its next week, a body stat is logged, or a
cardio session is logged. The
push counterpart to the [public REST API](public-api.md), for wiring
LiftTrace into n8n, Home Assistant, or any other automation without
polling. Off by default.

## Enabling it

```
WEBHOOKS_ENABLED=1
```

Optionally, to allow a webhook target on a private or loopback address
(a same-Docker-network Home Assistant instance, for example):

```
ALLOW_PRIVATE_WEBHOOK_URLS=1
```

## Configuring a webhook

Settings, Webhooks (admin, multi-user mode only, a webhook needs a real
account to own it). Provide a target URL and pick which events to
subscribe to. A secret is generated automatically (or you can supply
your own), shown exactly once, save it, it is needed to verify
signatures on the receiving end and cannot be retrieved again later.

## Events

| Event | Fires when |
|---|---|
| `workout.completed` | A workout session is marked completed. |
| `body_stat.logged` | Any body-stat value (weight, body fat, a measurement) is logged or updated, whether from the app, the `log_body_stat` MCP tool, or `PUT /api/v1/body-stats/:date`. Sent on every save, including a save that changes nothing. |
| `progress_photo.logged` | A progress photo is attached to a date, whether from the app, an MCP tool, or the REST API. |
| `pr.set` | A new personal record (max weight, estimated 1-rep max, or longest hold on a timed exercise) is set on an exercise, whether from the app, the `log_set` MCP tool, or `POST /api/v1/workouts/:date/sets`. Uses the same record definition the Statistics page and `/api/v1/records` already use. One per exercise whose record moved; a save that moves no record (sent again, or lighter) sends none. |
| `program.advanced` | An active program moves to its next week. |
| `cardio.logged` | A new cardio session is logged, whether from the Diary, Trace, the Android app, an MCP tool, or the REST API. Not sent when a session is edited, or when a re-sent `external_id` returns a session already logged. |

## What sends them, and what doesn't

Webhooks are for something logged now. These send them:

- The web app, the Android app connected to a server, and the watch.
  Changes the Android app or the web app made offline send theirs when
  they reach the server. A change either app sends again (its answer was
  lost on the way back) doesn't send a second `workout.completed`,
  `pr.set` or `cardio.logged`, and makes no second workout or cardio
  session; `body_stat.logged` is sent on every save, as above.
- The MCP tools (`log_set`, `log_body_stat`, `add_progress_photo`,
  `log_cardio`) and the [public REST API](public-api.md).

These bring in history, and send none:

- **Upload**, when an Android app used without a server connects to one
  and sends the workouts, body stats and cardio it holds, including what
  was logged on the phone while it had no server. Uploading again sends
  none either. Coming back to the same account after Disconnect, what you
  changed in rows the server already had goes up as ordinary edits, and
  sends what an edit sends. This needs the server and the app from after 1.4.0.
  With an up-to-date server, the 1.4.0 app's Upload sends nothing for
  workouts and cardio but still sends `body_stat.logged` for each day of
  body stats, and an app before 1.4.0 sends them as it always did.
- Restoring a backup, on the server or in the Android app.
- Importing workouts from Strong, Hevy, FitNotes, Jefit or a Garmin file
  (Settings, Import Workouts).

Deleting a workout, a body stat or a cardio session sends nothing. An
edit to a workout sends `pr.set` if it moved a record, and
`workout.completed` if it marks the workout completed.

## Payload

Every delivery is a JSON POST with this envelope:

```json
{
  "event": "workout.completed",
  "timestamp": "2026-09-12T14:30:00.000Z",
  "data": { ... event-specific ... }
}
```

`data` for `workout.completed` matches the shape `GET /api/v1/workouts/:date`
returns. `data` for `body_stat.logged` is the date and every stat on that
date after the save, as stored:

```json
{
  "date": "2026-09-12",
  "stats": { "weight": 82.4, "bodyFat": 18, "waist": 85 }
}
```

`data` for `pr.set` looks like this (`exercise_id` arrives as a string):

```json
{
  "exercise_id": "42",
  "exercise_name": "Barbell Squat",
  "date": "2026-09-12",
  "new_max_weight": 140,
  "new_max_reps": 5,
  "new_e1rm": 163,
  "previous_max_weight": 135,
  "previous_e1rm": 158,
  "new_max_duration_sec": 0,
  "previous_max_duration_sec": 0
}
```

For a timed exercise (plank, wall sit, dead hang, carry) the record that
moved is the longest hold: `new_max_duration_sec` and
`previous_max_duration_sec` carry it in seconds, and the weight fields stay
at zero unless the exercise also has rep sets.

`data` for `cardio.logged` is the session, in the shape each session has in
`GET /api/v1/cardio`:

```json
{
  "id": 87,
  "date": "2026-09-28",
  "activity": "Running",
  "duration_min": 33,
  "distance": 2.47,
  "distance_unit": "mi",
  "avg_hr": 138,
  "notes": null,
  "external_id": "strava:20368911854",
  "is_template": false,
  "created_at": "2026-09-28 18:02:11"
}
```

## Verifying a delivery

Each request carries:

```
X-LiftTrace-Signature: sha256=<hex hmac-sha256 of the exact raw request body, using your webhook's secret>
X-LiftTrace-Event: workout.completed
X-LiftTrace-Delivery: <a uuid unique to this specific delivery attempt>
```

Recompute the HMAC over the raw body bytes you received (not a
re-serialized copy) and compare it to the signature header. Example in
Node:

```js
import { createHmac, timingSafeEqual } from 'crypto';

function verify(rawBody, signatureHeader, secret) {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = signatureHeader.replace('sha256=', '');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}
```

## Retries and delivery status

A failed delivery (a network error, a timeout, or a non-2xx response)
is retried up to 3 times total, with a short backoff. There is no
persistent delivery queue: if a receiver is down for longer than a few
seconds, that event is not redelivered later. This is a deliberate
tradeoff for a self-hosted, personal-scale feature rather than a full
delivery queue with hours of retry.

Each webhook's last delivery outcome (delivered or failed, with the
error) is shown in Settings, use the "send test event" button there to
verify a target works without waiting for a real event.
