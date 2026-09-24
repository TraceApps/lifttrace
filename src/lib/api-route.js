/**
 * api-route.js: is this request one of ours?
 *
 * apiFetch.js replaces window.fetch for the whole app, and reroutes what it
 * claims: on native, to the connected LiftTrace server with the bearer token
 * added; on the web, through the offline layer. So the claim has to be
 * right, and a path is not enough to make it.
 *
 * It used to be. An absolute URL was reduced to its path and claimed if the
 * path began /api/ or /uploads/, so an OpenAI-compatible base URL of
 * https://openrouter.ai/api became https://<lifttrace-server>/api/v1/chat/
 * completions and answered 404 (issue #118, found by @kgenerozov). Any third
 * party with an /api/ path went the same way: a shared exercise link, a music
 * server's stream.
 *
 * Kept pure, with the app's own origins passed in, so the routing rules can
 * be tested without a browser.
 */

/**
 * @param {string} url            what fetch was called with
 * @param {Iterable<string>} ownOrigins  origins that are this app: the page's,
 *   and on native the LiftTrace server it is connected to
 */
export function isInterceptable(url, ownOrigins) {
  if (!url) return false;
  let path = url;
  if (url.startsWith('http')) {
    let u;
    try { u = new URL(url); } catch { return false; }
    // Somebody else's server, whatever its path looks like.
    if (!new Set(ownOrigins).has(u.origin)) return false;
    path = u.pathname + u.search;
  }
  return path.startsWith('/api/') || path.startsWith('/uploads/');
}

/** The origins that belong to this app, from the page and the server URL. */
export function ownOrigins(pageOrigin, serverUrl) {
  const out = [];
  if (pageOrigin) out.push(pageOrigin);
  if (serverUrl) {
    try { out.push(new URL(serverUrl).origin); } catch { /* not a URL, not an origin */ }
  }
  return out;
}
