// The Capacitor plugins sync.js and friends touch. The network is the real
// one, unless globalThis.__offline is set (airplane mode). Scenarios can slow
// writes (__slowWrites) or answer a request themselves (__httpHook).
const realFetch = globalThis.__realFetch || globalThis.fetch;
// Android's cookie jar: CapacitorHttp stores what a response sets and sends
// it with every later request to that host, as the phone does, and (as
// Capacitor does) keeps a copy of it under the app's own address too.
const jar = new Map();   // host -> Map(name -> value)
const APP_HOST = 'app.lifttrace.local';
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
async function http(method, o) {
  if (globalThis.__offline) throw new TypeError('Failed to fetch');
  if (globalThis.__slowWrites && method !== 'GET') await globalThis.__slowWrites(method, o.url);
  if (globalThis.__httpHook) { const hooked = await globalThis.__httpHook(method, o); if (hooked) return hooked; }
  const headers = { ...(o.headers || {}) };
  const kept = jar.get(hostOf(o.url));
  if (kept?.size) headers.Cookie = [...kept].map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await realFetch(o.url, { method, headers, body: o.data != null ? JSON.stringify(o.data) : undefined });
  for (const c of r.headers.getSetCookie?.() || []) {
    const [pair, ...attrs] = c.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
    const gone = !value || attrs.some(a => /expires=thu, 01 jan 1970/i.test(a) || /max-age=0/i.test(a));
    for (const host of [hostOf(o.url), APP_HOST]) {
      if (!jar.has(host)) jar.set(host, new Map());
      if (gone) jar.get(host).delete(name); else jar.get(host).set(name, value);
    }
  }
  const t = await r.text();
  let data = t;
  try { data = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, data };
}
export const CapacitorHttp = {
  get: o => http('GET', o), post: o => http('POST', o), put: o => http('PUT', o),
  delete: o => http('DELETE', o), request: o => http(o.method || 'GET', o),
};
export const CapacitorCookies = {
  clearAllCookies: async () => { jar.clear(); },
  clearCookies: async ({ url }) => { jar.delete(hostOf(url)); },
  deleteCookie: async ({ url, key }) => { jar.get(hostOf(url))?.delete(key); },
  setCookie: async ({ url, key, value }) => { const h = hostOf(url); if (!jar.has(h)) jar.set(h, new Map()); jar.get(h).set(key, value); },
  getCookies: async ({ url } = {}) => Object.fromEntries(jar.get(hostOf(url)) || []),
};
export const Capacitor = { isNativePlatform: () => true, convertFileSrc: x => x, getPlatform: () => 'android', isPluginAvailable: () => false };
export const registerPlugin = () => new Proxy({}, { get: () => async () => ({}) });
export const Network = {
  getStatus: async () => ({ connected: !globalThis.__offline, connectionType: globalThis.__offline ? 'none' : 'wifi' }),
  addListener: async () => ({ remove() {} }),
};
export const Filesystem = { readdir: async () => ({ files: [] }), stat: async () => { throw new Error('none'); }, readFile: async () => { throw new Error('none'); }, writeFile: async () => ({}), mkdir: async () => ({}), deleteFile: async () => ({}) };
export const Directory = { Data: 'DATA', Cache: 'CACHE', Documents: 'DOCUMENTS' };
export const App = { addListener: async () => ({ remove() {} }) };
export const Preferences = { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} };
export default {};
