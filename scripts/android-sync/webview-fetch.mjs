// The Android WebView's fetch to the server: another origin than the app's
// own (https://app.lifttrace.local), so CORS applies as the Fetch standard
// says. A request that needs a preflight (PUT, an Authorization header, any
// header not on the safe list) is asked about with OPTIONS first, and goes
// only if the server's answer allows its origin, method and every header;
// otherwise it fails as the WebView's does, with "TypeError: Failed to
// fetch" (the app then takes it for no connection). An answer that doesn't
// allow the origin fails the same way, and only the headers the server
// exposes can be read from it.
//
// https://fetch.spec.whatwg.org/#cors-preflight-fetch

const SAFE_METHODS = new Set(['GET', 'HEAD', 'POST']);
const SAFE_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']);
const SAFE_RESPONSE = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);

const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const blocked = () => new TypeError('Failed to fetch');

/** Header names this request carries that aren't CORS-safelisted, lowercased and sorted. */
export function unsafeHeaderNames(headers) {
  const out = [];
  for (const [name, value] of new Headers(headers || {})) {
    if (name === 'accept' || name === 'accept-language' || name === 'content-language') continue;
    if (name === 'content-type' && SAFE_TYPES.has(String(value).split(';')[0].trim().toLowerCase())) continue;
    out.push(name);
  }
  return out.sort();
}

function _allowsOrigin(res, origin, withCredentials) {
  const allowed = res.headers.get('access-control-allow-origin');
  if (allowed === '*') return !withCredentials;
  if (allowed !== origin) return false;
  return !withCredentials || res.headers.get('access-control-allow-credentials') === 'true';
}

// The answer as a page reads it: only the safelisted headers and the ones
// the server exposes.
function _exposed(res) {
  const exposed = new Set(list(res.headers.get('access-control-expose-headers')).map(h => h.toLowerCase()));
  const filter = (r) => {
    const h = new Headers();
    for (const [k, v] of r.headers) if (SAFE_RESPONSE.has(k) || exposed.has(k)) h.set(k, v);
    Object.defineProperty(r, 'headers', { value: h, configurable: true });
    const clone = r.clone.bind(r);
    Object.defineProperty(r, 'clone', { value: () => filter(clone()), configurable: true });
    return r;
  };
  return filter(res);
}

/** A fetch that behaves like the WebView's at `origin()`, on top of `realFetch`. */
export function webviewFetch(realFetch, origin) {
  return async (input, init = {}) => {
    const from = origin();
    const url = new URL(typeof input === 'string' ? input : input.url, from);
    if (url.origin === from) return realFetch(input, init);
    const method = String(init.method || 'GET').toUpperCase();
    const withCredentials = init.credentials === 'include';
    const unsafe = unsafeHeaderNames(init.headers);
    if (!SAFE_METHODS.has(method) || unsafe.length) {
      let pre;
      try {
        pre = await realFetch(url.href, {
          method: 'OPTIONS',
          headers: { Origin: from, 'Access-Control-Request-Method': method, ...(unsafe.length ? { 'Access-Control-Request-Headers': unsafe.join(',') } : {}) },
          signal: init.signal,
        });
      } catch (e) { if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw e; throw blocked(); }
      try { await pre.body?.cancel(); } catch { /* empty */ }
      if (pre.status < 200 || pre.status > 299 || !_allowsOrigin(pre, from, withCredentials)) throw blocked();
      const methods = list(pre.headers.get('access-control-allow-methods'));
      if (!SAFE_METHODS.has(method) && !methods.includes(method) && !(methods.includes('*') && !withCredentials)) throw blocked();
      const allowed = new Set(list(pre.headers.get('access-control-allow-headers')).map(h => h.toLowerCase()));
      for (const name of unsafe) {
        // A wildcard never stands for Authorization.
        if (!allowed.has(name) && !(allowed.has('*') && !withCredentials && name !== 'authorization')) throw blocked();
      }
    }
    const headers = new Headers(init.headers || {});
    headers.set('Origin', from);
    const res = await realFetch(url.href, { ...init, headers });
    if (!_allowsOrigin(res, from, withCredentials)) { try { await res.body?.cancel(); } catch { /* empty */ } throw blocked(); }
    return _exposed(res);
  };
}
