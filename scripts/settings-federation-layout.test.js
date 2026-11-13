import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/components/settings/SettingsFederation.svelte', import.meta.url), 'utf8');

test('body federation auxiliary content aligns with setting rows', () => {
  assert.match(
    source,
    /\.body-sync-heading,\s*\.body-sync-actions,\s*\.body-sync-warning,\s*\.body-sync-ok\s*\{\s*padding-inline:\s*16px;/s,
  );
});
