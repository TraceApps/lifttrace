# Licenses & Data Sources

LiftTrace's source code is licensed under [AGPL-3.0](LICENSE). Some of the integrations and data sources it can talk to are covered by separate licenses. This file lists them so operators and contributors know what applies to what.

## Code

- **LiftTrace**: AGPL-3.0 (see [LICENSE](LICENSE)). Applies to the entire codebase in this repository including the Android app source.

## Exercise data sources

LiftTrace does not bundle any exercise catalog inside the Docker image. All exercise data is either created by the user or imported live from the source's public endpoint. Which sources are active is controlled per-instance by the `EXERCISE_SOURCES` env var and per-user in Settings.

| Source                          | License                                | How LiftTrace uses it                                                                                                                    |
| ------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **wger**                        | [CC-BY-SA 4.0][cc-by-sa]               | Live queries against `wger.de/api/v2`. ~600 exercises with descriptions, muscles, and equipment cached per-user in that user's SQLite.   |
| **Free Exercise DB**            | Public Domain                          | Live queries against the project's public asset repo. ~870 exercises with start/end position images cached per-user.                     |
| **ExerciseDB (RapidAPI)**       | Commercial Terms of Use ([RapidAPI][rapidapi]) | User-provided API key. Only URL references stored; the ~1,300 animated GIFs are served by ExerciseDB's CDN and require the user's active subscription to load. |
| **ExerciseDB (Open Source)**    | Same content as ExerciseDB, self-hostable mirror | Optional. Points at `oss.exercisedb.dev` by default; override with `EXERCISEDB_OSS_URL` to run your own. No API key required. |
| **Custom exercises**            | Owned by the user                      | Created via the app UI (name, muscles, equipment, uploaded images / GIFs / videos / YouTube embed).                                      |
| **Custom XLSX catalogs**        | Owned by the user (or the source they came from) | Bulk-imported via `Settings > Exercises > Import from XLSX`. LiftTrace acts only as an importer.                                         |

[cc-by-sa]: https://creativecommons.org/licenses/by-sa/4.0/
[rapidapi]: https://rapidapi.com/justin-WFnsXH_t6/api/exercisedb/

## Music playback sources

LiftTrace's optional Radio player streams from user-provided music servers or public radio streams. LiftTrace does not host, redistribute, or cache the audio content itself.

| Source                                                | Notes                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Subsonic / Jellyfin / Plex / Emby**                 | User provides server URL + credentials. Playback of the user's own library. No LiftTrace-side redistribution. |
| **Icecast / Shoutcast / HLS public radio streams**    | Playback of publicly-broadcast station content. Station operators own the content and its licensing.        |

## Notes for operators

### wger (CC-BY-SA 4.0)

wger's exercise catalog is CC-BY-SA licensed. Individual per-request records are queried on demand and only a small per-user cache accumulates in each user's SQLite; no substantial derived database is redistributed by LiftTrace itself, so share-alike terms don't apply to the default configuration.

If you extend, restructure, or publish the wger data beyond straight lookups (for example, redistributing an enriched export to a public dataset), CC-BY-SA's attribution and share-alike terms would apply. Straightforward attribution is: "Exercise data from [wger](https://wger.de/) under CC-BY-SA 4.0."

Single-user self-hosters running the wger source for personal use don't have public-facing obligations.

### Free Exercise DB

Public domain. No attribution is legally required, but it's still nice to mention (project link: [github.com/yuhonas/free-exercise-db](https://github.com/yuhonas/free-exercise-db)).

### ExerciseDB (RapidAPI)

Commercial. Each user brings their own RapidAPI subscription and API key; the key is stored in that user's `user_settings` row and used only to make outbound requests to the ExerciseDB API. GIF assets are served by ExerciseDB's CDN and require the user's subscription to remain active. LiftTrace never caches the GIFs or re-serves them.

### ExerciseDB (Open Source mirror)

Same exercise data as the RapidAPI source but reachable at `oss.exercisedb.dev` (or your own mirror via `EXERCISEDB_OSS_URL`). Self-hostable. Check the mirror project's own license before enabling it in a public-facing multi-user instance.

## Third-party code dependencies

Bundled Node.js dependencies (Express, better-sqlite3, Svelte, Capacitor plugins, etc.) each carry their own permissive licenses (MIT / Apache-2.0 / BSD variants). See `package.json` and `server/package.json` for the full dependency lists; run `npm ls --long` or `npx license-checker` in either directory for machine-readable output.

## Questions

If any of the above needs clarification or you spot something worth correcting, open an issue on the [GitHub repository][repo] and it'll get looked at.

[repo]: https://github.com/TraceApps/lifttrace/issues
