/**
 * watch-relay.js: the phone answering its watch in Local mode (#156).
 *
 * With a server, the watch talks to it directly. In Local mode there is no
 * server, so the watch sends the same four requests to the phone over the
 * Wear connection (WearPairingPlugin), and they are answered here by the same
 * local handler the phone's own screens use (api-native.js). Nothing about a
 * day's rules is kept twice.
 *
 * Only what the watch asks for is answered: the day, the last few sessions,
 * the settings, and the day sent back.
 */

/** The address a phone in Local mode gives its watch instead of a server's. */
export const PHONE_ADDRESS = 'phone:';

const ROUTES = [
  ['GET', /^\/api\/workout\/\d{4}-\d{2}-\d{2}$/],
  ['GET', /^\/api\/workout\/recent$/],
  ['GET', /^\/api\/settings$/],
  ['PUT', /^\/api\/workout\/\d{4}-\d{2}-\d{2}$/],
];

/**
 * Answer one request from the watch.
 *
 * @param {{ method?: string, path?: string, body?: string|null }} req
 * @param {{ localMode: boolean, handle: (method: string, path: string, body: any, query: object) => Promise<any>, isUnsupported?: (e: any) => boolean }} deps
 * @returns {Promise<{ status: number, body: string, savedDate?: string, finished?: { name: string } }>}
 */
export async function answerWatchRequest(req, { localMode, handle, isUnsupported = () => false }) {
  const reply = (status, data) => ({ status, body: JSON.stringify(data) });
  // Switched to a server since the watch paired: it pairs again with that.
  if (!localMode) return reply(409, { error: 'The phone is connected to a server now.' });
  const method = String(req?.method || 'GET').toUpperCase();
  let url;
  try { url = new URL(String(req?.path || ''), 'http://phone'); } catch { return reply(400, { error: 'Bad request' }); }
  const path = url.pathname;
  if (!ROUTES.some(([m, re]) => m === method && re.test(path))) return reply(404, { error: 'Not found' });
  let body = null;
  if (req?.body != null && req.body !== '') {
    try { body = JSON.parse(req.body); } catch { return reply(400, { error: 'Bad request' }); }
  }
  try {
    // Finished on the watch: whether this save is what finishes it, so the
    // phone says so once, as a server does (server/lib/watch-finish.js).
    let wasDone = false;
    if (method === 'PUT' && body?.finished_on === 'watch') {
      const before = await handle('GET', path, null, body.id != null ? { id: String(body.id) } : {});
      wasDone = !!before?.workout?.completed;
    }
    const result = await handle(method, path, body, Object.fromEntries(url.searchParams.entries()));
    const out = reply(200, result === undefined ? {} : result);
    if (method === 'PUT') {
      out.savedDate = path.slice('/api/workout/'.length);
      if (body?.finished_on === 'watch' && !wasDone && result?.workout?.completed) out.finished = { name: result.workout.name || '' };
    }
    return out;
  } catch (e) {
    if (isUnsupported(e)) return reply(501, { error: e.message });
    return reply(500, { error: e?.message || 'The phone could not answer' });
  }
}
