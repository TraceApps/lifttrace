---
name: Integration test report
about: Validate workout history import (Strong / Hevy / FitNotes / Jefit) or Radio source (Subsonic / Jellyfin / Plex / Emby / Internet station) on your data
title: "[Integration Test] "
labels: integration, testing
---

LiftTrace is tested against a small set of sample data files and music
servers, so reports from your real export or library are extremely
valuable for spotting integration-specific quirks.

## Integration
<!-- Pick one:
  - Workout import (Strong / Hevy / FitNotes / Jefit CSV)
  - Radio: Subsonic-compatible (Navidrome, Airsonic, Funkwhale, etc.)
  - Radio: Jellyfin / Plex / Emby
  - Radio: Internet station (Icecast / Shoutcast / HLS) — paste the stream URL if shareable
-->

## LiftTrace version
<!-- Settings → About -->

## Source app or server version
<!-- e.g. Strong v5.1.2 export / Hevy v22 export / Navidrome v0.52.0 / Jellyfin v10.9 / Plex v1.40 -->

## What worked

<!--
For workout imports, mark each:
✅ — imported correctly
❌ — broken / wrong value / missing
N/A — your data doesn't have this

- Exercise name matching (got mapped to a library exercise vs left as free-text):
- Weight values + unit (lb / kg):
- Reps:
- RPE:
- Warm-up sets flagged correctly:
- Supersets grouped correctly:
- Workout duration:
- Workout notes / free-text:
- Date / time:

For Radio, mark each:
- Library browse (artists / albums / playlists):
- Cover art:
- Playback (gapless / no audio gaps):
- Now-playing metadata:
- Background playback on Android:
- Lockscreen controls on Android:
-->

## What didn't work
<!-- Specific entries, error messages, anything weird -->

## Sample file or stream URL (optional)
<!--
A redacted sample CSV or a public stream URL helps reproduce the issue.
Strip personal notes / dates before sharing.
-->

## Screenshots
<!-- Diary / Workout History Import preview / Radio Now Playing — whichever is most useful -->

## Logs (if anything errored)
<!-- See bug_report.md for log locations and redaction guidance -->
