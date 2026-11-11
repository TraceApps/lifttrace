/**
 * LiftTrace's secrets in user settings (lib/secret-settings.js).
 *
 * WRITE_ONLY: only the server uses them, so they're never sent back (a
 * phone with a server sends its notifications through it). radioToken is
 * the music server's own sign-in, which the server gets and keeps.
 * ENCRYPTED: the app uses them itself (it calls the AI provider, ExerciseDB
 * and the music server directly), so the account's own app still gets them.
 */
export const WRITE_ONLY_SETTINGS = new Set(['ntInstanceToken', 'ntfyToken', 'gotifyToken', 'radioToken']);
export const ENCRYPTED_SETTINGS = new Set(['aiApiKey', 'exerciseDbApiKey', 'radioPassword']);
