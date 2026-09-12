# Public REST API

A versioned REST API at `/api/v1`, for scripts and automations that want
plain JSON over HTTP rather than the [Model Context Protocol](https://traceapps.github.io/docs/lifttrace/mcp/)
LiftTrace also speaks. Off by default.

## Enabling it

Set these in your server environment (see `DEPLOY.md`):

```
PUBLIC_API_ENABLED=1        # turns on the read routes below
PUBLIC_API_WRITE_ENABLED=1  # optional, turns on the write routes too
```

## Authentication

Same personal access tokens as MCP: create one in Settings, API Tokens
(admin, multi-user mode only, a token needs a real account to own it).
Send it as a bearer token:

```
Authorization: Bearer lt_pat_...
```

A token's scopes govern both MCP tools and this API the same way: a
token with `mcp:read` can read via either interface, `mcp:write` unlocks
the write routes on either interface too. There is no separate REST-only
scope to create.

## Rate limiting

Each token is limited to 60 requests per minute by default (`API_RATE_LIMIT_PER_MIN`
to change it). Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
and `X-RateLimit-Reset`; a `429` response also carries `Retry-After`.

## Errors

A bad request (an invalid date, an exercise name with no match) returns
`400` with `{"error": "..."}`. A missing or invalid token returns `401`;
a token lacking the required scope returns `403`.

## Endpoints

### Read (require `mcp:read`)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/workouts/:date` | One day's workout, every exercise and set. `date` defaults to today. |
| GET | `/api/v1/workouts/recent?limit=` | Recent workouts, most recent first. `limit` defaults to 10, max 50. |
| GET | `/api/v1/records?exercise_name=` | Personal records per exercise: max weight, reps at that weight, date, estimated 1-rep max. `exercise_name` optionally filters by a case-insensitive substring. |
| GET | `/api/v1/exercises/:name/progress?start=&end=` | Per-session progress for one exercise (max weight, volume, set count, average RPE) over a date range. `:name` is matched case-insensitively by substring; an ambiguous match returns `{ambiguous: true, candidates: [...]}` instead of guessing. Range defaults to the last 90 days. |
| GET | `/api/v1/exercises?query=&limit=` | Search the exercise catalog by name. `limit` defaults to 10, max 25. |
| GET | `/api/v1/programs` | List your programs, owned or coach-assigned. |
| GET | `/api/v1/programs/active` | The currently active program: current week and every weekly template. |
| GET | `/api/v1/body-stats/:date` | Body-stat measurements (weight, body fat, tape measurements) for a date. |

### Write (require `mcp:write` and `PUBLIC_API_WRITE_ENABLED=1`)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/v1/workouts/:date/sets` | `{exercise_id, reps, weight, rpe?, warmup?, completed?}` | Appends one set to an exercise on that day, creating the exercise entry if it isn't logged yet. `exercise_id` comes from the exercises search endpoint. |
| PUT | `/api/v1/body-stats/:date` | `{weight?, weight_unit?, bodyFat?, waist?, hips?, neck?, chest?, biceps?, thighs?, calves?}` | Merges the given values into that day's stats; omitted fields are left alone. `weight_unit: "lb"` converts to kg before storing. |

Not yet exposed here: deleting a workout. That stays MCP-only for now
(see `delete_workout` in the MCP setup guide), since it is an
irreversible hard delete and this surface hasn't needed that capability
yet.

## Examples

```bash
# Today's workout
curl -H "Authorization: Bearer lt_pat_..." \
  https://your-lifttrace.example.com/api/v1/workouts/2026-09-12

# Log a set
curl -X POST -H "Authorization: Bearer lt_pat_..." -H "Content-Type: application/json" \
  -d '{"exercise_id": 42, "reps": 5, "weight": 100}' \
  https://your-lifttrace.example.com/api/v1/workouts/2026-09-12/sets

# Personal records for squat
curl -H "Authorization: Bearer lt_pat_..." \
  "https://your-lifttrace.example.com/api/v1/records?exercise_name=squat"
```
