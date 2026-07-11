import db from './db.js';

export function seedAiFromEnv() {
  // AI_BASE_URL enables server-side proxying for the `oai-compat` provider
  // (Ollama, LM Studio, LocalAI, vLLM, etc.). Required when
  // AI_PROVIDER=oai-compat; ignored otherwise. Lets self-hosters put an LLM
  // on a private Docker network — the browser never talks to it directly,
  // so mixed-content and internal-DNS resolution stop being blockers.
  // Mirrors NutriTrace commit d9cb8ff (issue #90 gentlecolts).
  const map = { AI_ENABLED: 'ai_enabled', AI_PROVIDER: 'ai_provider', AI_API_KEY: 'ai_api_key', AI_MODEL: 'ai_model', AI_BASE_URL: 'ai_base_url' };
  const upsert = db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const del = db.prepare('DELETE FROM app_config WHERE key = ?');
  let locked = false;
  for (const [envKey, dbKey] of Object.entries(map)) {
    if (process.env[envKey] != null) { upsert.run(dbKey, process.env[envKey]); locked = true; }
  }
  if (locked) {
    upsert.run('ai_env_locked', 'true');
  } else {
    // No AI_* env vars set — clear any prior lock so removing AI_* from
    // compose and restarting actually unlocks the UI. Mirrors NutriTrace #36.
    del.run('ai_env_locked');
  }
}

export function getAiConfig() {
  const rows = db.prepare("SELECT key, value FROM app_config WHERE key LIKE 'ai_%'").all();
  const cfg = {};
  for (const { key, value } of rows) cfg[key] = value;
  return cfg;
}

export function isAiEnvLocked() {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get('ai_env_locked');
  return row?.value === 'true';
}
