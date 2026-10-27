// The language picker and the first-run language: every listed locale has a
// file and a loader, and a phone's language tag maps to the right one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { AVAILABLE_LOCALES, localeForNavigator } from '../src/i18n/index.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('every language in the picker has a file and is registered', () => {
  const index = read('../src/i18n/index.js');
  for (const { code } of AVAILABLE_LOCALES) {
    assert.ok(existsSync(new URL(`../src/i18n/${code}.json`, import.meta.url)), `${code}.json`);
    assert.match(index, new RegExp(`register\\('${code}', \\(\\) => import\\('\\./${code}\\.json'\\)\\)`), code);
  }
});

test('Simplified Chinese is in the picker', () => {
  assert.ok(AVAILABLE_LOCALES.some(l => l.code === 'zh-Hans' && l.label === '简体中文'));
});

test('a phone language tag picks the app locale', () => {
  const cases = {
    'en-US': 'en', 'es-MX': 'es', 'es': 'es', 'it-IT': 'it', 'fr-FR': 'en', 'de': 'en',
    'zh': 'zh-Hans', 'zh-CN': 'zh-Hans', 'zh-SG': 'zh-Hans', 'zh-Hans': 'zh-Hans',
    'zh-Hans-CN': 'zh-Hans', 'zh_CN': 'zh-Hans', 'zh-Hans-TW': 'zh-Hans',
    'zh-TW': 'en', 'zh-HK': 'en', 'zh-MO': 'en', 'zh-Hant': 'en', 'zh-Hant-TW': 'en',
    '': 'en', null: 'en', undefined: 'en',
  };
  for (const [tag, want] of Object.entries(cases)) {
    const input = tag === 'null' ? null : tag === 'undefined' ? undefined : tag;
    assert.equal(localeForNavigator(input), want, String(tag));
  }
});
