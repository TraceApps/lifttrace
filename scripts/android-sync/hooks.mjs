// Module hooks for register.mjs: Capacitor plugins and platform.js resolve to
// the shims here; .svelte files to nothing; import.meta.env to production.
import { readFile } from 'node:fs/promises';

const here = new URL('./', import.meta.url);
const src = new URL('../../src/', import.meta.url).href;

export async function resolve(spec, ctx, next) {
  if (spec === '@capacitor-community/sqlite') return { url: new URL('sqlite.mjs', here).href, shortCircuit: true };
  if (/(^|\/)platform\.js$/.test(spec) && ctx.parentURL?.startsWith(src)) return { url: new URL('platform.mjs', here).href, shortCircuit: true };
  if (spec.startsWith('@capacitor/')) return { url: new URL('capacitor.mjs', here).href, shortCircuit: true };
  if (spec.endsWith('.svelte')) return { url: new URL('empty.mjs', here).href, shortCircuit: true };
  return next(spec, ctx);
}

export async function load(url, ctx, next) {
  if (url.startsWith(src) && url.endsWith('.js')) {
    const source = (await readFile(new URL(url), 'utf8')).replaceAll('import.meta.env', '({ DEV: false, PROD: true })');
    return { format: 'module', source, shortCircuit: true };
  }
  return next(url, ctx);
}
