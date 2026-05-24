# Contributing to LiftTrace

Thanks for your interest in LiftTrace.

## Reporting bugs

- Open an issue at [github.com/traceapps/lifttrace/issues](https://github.com/traceapps/lifttrace/issues).
- Include your version (Settings → About), what you expected, and what you saw.
- For sync issues, include whether you're on PWA or native Android, and your server version.
- Don't paste server logs publicly without redacting — `LOG_LEVEL=debug` includes auth tokens that happened to be in flight and (on Android) device identifiers used for native sync.

## Suggesting features

- Open an issue describing the use case before writing code — it helps avoid building something that won't get merged.
- Check [FUTURE.md](FUTURE.md) in the dev repo first; the feature may already be planned or intentionally deferred. (FUTURE.md is dev-only and not shipped to the public repo.)

## Pull requests

- Keep changes focused — one concern per PR.
- Match the existing code style (Svelte 5 in compat mode, no runes, no TypeScript).
- For server changes, ensure all SQL is parameterized and every new route has appropriate `requireAuth` / `requireAdmin` middleware.
- Update `CHANGELOG.md` under the unreleased section if your change is user-visible.
- The Android shell lives in `android/`; if you change web assets the maintainer will run `npx cap sync android` and rebuild the APK.
- No DCO or CLA required.

## Translations

LiftTrace uses [svelte-i18n](https://github.com/kaisermann/svelte-i18n) with one JSON file per locale in `src/i18n/`. The English file at `src/i18n/en.json` is the source of truth. Adding a new language is straightforward and you do not need to touch any other code.

### Adding a new language

1. Copy `src/i18n/en.json` to `src/i18n/<code>.json` where `<code>` is the BCP-47 short code (`fr`, `de`, `nl`, `es`, `pt`, `ja`, etc.).
2. Translate the values. Leave the keys exactly as they are. Keep `{placeholder}` tokens and any HTML tags (`<strong>`, `<code>`, `<br>`) intact and in the right grammatical position for your language.
3. In `src/i18n/index.js`, register the new locale and add it to `AVAILABLE_LOCALES`:
   ```js
   register('fr', () => import('./fr.json'));
   // ...
   export const AVAILABLE_LOCALES = [
     { code: 'en', label: 'English' },
     { code: 'fr', label: 'Français' },
   ];
   ```
   The label is what shows in the Settings → Regional & Units → Language picker. Use the language's native name (e.g. `Français` not `French`).
4. Run `npm run i18n:check` to confirm no keys are missing or orphaned.
5. Open a PR.

### Updating an existing language

If new keys land in `en.json` between releases, your locale file will report them as "missing" in `npm run i18n:check`. The app will fall back to English for those strings until you translate them. There is no urgency — translate at your own pace.

The English source text may also change occasionally without renaming the key. There is no automatic stale-translation detection, so a quick diff of `en.json` against the version you originally translated from is the most reliable way to catch these.

### Translation guidance

- **Domain conventions matter.** For lifting terminology, use the words gym-goers actually use in your country, not literal translations. RPE, AMRAP, 1RM, PR, superset, drop set, deload are loan-words in most languages — leave them as English unless your gym scene actively uses a local equivalent.
- **Weight units stay numeric.** Users pick lb or kg in Settings; don't bake the unit into translated strings.
- **Match the tone.** LiftTrace's English copy is informal and direct ("Tap to start a set"). Try to keep that register rather than translating to a more formal style.
- **Length awareness.** Some buttons are tight on small screens. If your translation is significantly longer than the English, test on a phone-sized viewport.
- **Do not translate proper nouns or product names** — `LiftTrace`, `Trace` (the AI assistant), `wger`, `Strong`, `Hevy`, `FitNotes`, `Jefit`, `Subsonic`, `Jellyfin`, `Plex`, `Emby` stay as-is.

### What's translatable today vs not

Only a subset of UI strings is currently extracted — the surface every user touches every session: navigation, page titles, settings section headers, auth flow, wizard, primary actions in Diary / Programs / Exercises, common toasts, action sheets, the AI assistant FAB. The remaining strings (deep Settings sub-section labels, Statistics chart internals, Coaching) are still English and will be extracted in subsequent releases. If you start translating and notice a screen you use heavily that's not yet in `en.json`, open an issue listing the screen — those are the targets to extract first.

Server-side strings (email subject lines, push notification bodies, AI system prompts) are not currently translatable and stay English.

## Screenshots

README screenshots live in `docs/screenshots/` (numbered prefix for sort order). If your PR meaningfully changes the UI shown in any of them, please replace the affected screenshot at the same dimensions and theme (dark) so the README stays accurate.

## License

By contributing you agree that your contribution is licensed under [AGPL-3.0](LICENSE), the same license as the rest of the server and PWA code.
