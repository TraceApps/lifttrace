/**
 * The app reads its address settings from window.__LT_CONFIG__, which the
 * server writes into the page. Settings > Single Sign-On read NutriTrace's
 * name for it (__NT_CONFIG__), so under BASE_URL a new provider's suggested
 * redirect address left the subpath out; saved as it was, the identity
 * provider sent people back to an address outside LiftTrace and sign-in failed.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const files = (dir) => readdirSync(dir).flatMap(n => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(js|svelte)$/.test(n) ? [p] : [];
});

test('the app reads only the config the server writes', () => {
  const server = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(server, /window\.__LT_CONFIG__ = \{ basePath:/);
  for (const f of files(src)) {
    const other = readFileSync(f, 'utf8').match(/__(?!LT_)[A-Z]+_CONFIG__/)?.[0];
    assert.ok(!other, `${f.slice(src.length)} reads ${other}`);
  }
});

test('under BASE_URL a new provider suggests the redirect address with the subpath', () => {
  const svelte = readFileSync(new URL('../src/components/settings/SettingsAuth.svelte', import.meta.url), 'utf8');
  const start = svelte.indexOf('function _defaultRedirectUri()');
  const body = svelte.slice(start, svelte.indexOf('\n  }\n', start) + 4);
  const window = { __LT_CONFIG__: { basePath: '/lifttrace' }, location: { origin: 'https://home.example.com' } };
  const uri = runInNewContext(`${body}; _defaultRedirectUri()`, { window, oidcEditing: { id: 3 } });
  assert.equal(uri, 'https://home.example.com/lifttrace/api/auth/oidc/callback/3');
});
