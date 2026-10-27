/**
 * plain-http-guard.js: the backstop for plain HTTP in the Android app (from
 * TraceApps/nutritrace#194). A fetch or XMLHttpRequest to http:// fails as a
 * network error, before anything is sent, unless it goes to a confirmed
 * server on the person's own network (lib/plain-http.js).
 *
 * Installed from main.js before anything else wraps fetch, so every later
 * wrapper calls through it. The web app and the PWA never install it.
 */
import { requestAllowed, blockedError, logBlocked } from './plain-http.js';

let installed = false;

// XMLHttpRequest gets the same check. A refused request fails the way a
// network error does (an error event, status 0), with nothing sent.
function _guardXhr() {
  const XHR = window.XMLHttpRequest;
  if (!XHR?.prototype?.open) return;
  const open = XHR.prototype.open;
  const send = XHR.prototype.send;
  XHR.prototype.open = function (method, url, ...rest) {
    this.__plainHttpBlocked = !requestAllowed(url, window.location.href);
    if (this.__plainHttpBlocked) logBlocked(url);
    return open.call(this, method, url, ...rest);
  };
  XHR.prototype.send = function (...args) {
    if (!this.__plainHttpBlocked) return send.apply(this, args);
    setTimeout(() => {
      this.dispatchEvent(new Event('error'));
      this.dispatchEvent(new Event('loadend'));
    }, 0);
  };
}

export function installPlainHttpGuard() {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const originalFetch = window.fetch.bind(window);
  _guardXhr();
  window.fetch = async (input, init) => {
    const rawUrl = typeof Request !== 'undefined' && input instanceof Request ? input.url : String(input?.url ?? input);
    if (!requestAllowed(rawUrl, window.location.href)) {
      logBlocked(rawUrl);
      throw blockedError(rawUrl);
    }
    return originalFetch(input, init);
  };
}
