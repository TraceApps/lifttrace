/**
 * local-account.js: whose data the phone's local database holds.
 *
 * Server mode keeps a copy of the account in SQLite, and one phone can sign
 * in to more than one account (or server). The copy is tagged with the
 * account it belongs to (sync_meta 'account', JSON: the server's instance
 * id "i", its address "s", the user id "u"), so that:
 *   - signing in as someone else never shows the previous account's
 *     programs, workouts or settings: the copy is cleared and filled from
 *     the new account on the next sync;
 *   - the previous account's changes that never reached the server are
 *     never sent under the new one. If there are any, the person signing in
 *     is asked first; saying no undoes the sign-in, and the changes go up
 *     the next time that account signs in here;
 *   - signing out and back in to the same account keeps everything,
 *     including changes still waiting.
 *
 * Same account means the same user id on the same server. The server is
 * known by the random id it reports (/api/auth/status instance_id), not by
 * its address, so the same server at a LAN IP and at its domain is one
 * server. A server too old to report one is matched on the user id alone:
 * an address change never counts as another account.
 *
 * Copies made before this tag existed, and copies in local mode (no server,
 * or after Disconnect), go to the first account that signs in, as they
 * always did. Same design as NutriTrace's.
 */
import { writable, get } from 'svelte/store';
import { getServerUrl, getAuthToken } from './platform.js';
import { getSyncMeta, setSyncMeta, dbCountUnsynced, dbClearUserData, dbQuery } from './db-native.js';
import { copyMoving, setCopyMoving, signedOut, markSignedOut } from './account-gen.js';

const META_KEY = 'account';

function _server(url = getServerUrl()) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

// The user id inside the session token (the server signs { id, ... }).
export function tokenUserId(token = getAuthToken()) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return json?.id ?? null;
  } catch {
    return null;
  }
}

// The server's instance id, asked once per address per app run and kept
// (sync_meta) for when it can't be reached. null: a server too old to
// report one, or not reachable now and never reached from here. `tries`:
// how often to ask when the network fails (a decision rests on the answer).
const _instances = new Map();
export async function serverInstanceId(serverUrl = getServerUrl(), { tries = 1 } = {}) {
  const url = _server(serverUrl);
  if (!url) return null;
  if (_instances.has(url)) return _instances.get(url);
  const metaKey = `instance@${url}`;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 700));
    try {
      const res = await fetch(`${String(serverUrl).trim().replace(/\/+$/, '')}/api/auth/status`, {
        credentials: 'include', signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        const id = typeof body?.instance_id === 'string' && body.instance_id ? body.instance_id : null;
        if (id) await setSyncMeta(metaKey, id);
        _instances.set(url, id);
        return id;
      }
    } catch { /* the network: try again, then the last one seen here */ }
  }
  return (await getSyncMeta(metaKey)) || null;
}

async function _readOwner() {
  const raw = await getSyncMeta(META_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
const _unowned = owner => !owner || owner.local || owner.u == null;
async function _current(userId, serverUrl = getServerUrl(), opts = {}) {
  return { i: await serverInstanceId(serverUrl, opts), s: _server(serverUrl), u: userId };
}

/**
 * Whose data the copy (tagged `owner`) is, for the account `cur`:
 *   - 'same': the same user id on the same server: both servers report an
 *     instance id and it's the same, or (one can't tell) the same address;
 *   - 'other': another user id, or two different instance ids;
 *   - 'ask': the same user id at another address, and one of the servers
 *     can't say which it is (too old, or not reachable). User ids repeat
 *     across servers (the first account is 1 everywhere), so this is never
 *     decided silently: the person is asked whether it's the same server.
 * A copy with no owner yet (local mode, or made before tags) is 'same'.
 */
export function compareAccount(owner, cur) {
  if (_unowned(owner)) return 'same';
  if (String(owner.u) !== String(cur.u)) return 'other';
  if (owner.i && cur.i) return owner.i === cur.i ? 'same' : 'other';
  if (owner.s && owner.s === cur.s) return 'same';
  return 'ask';
}
export function sameAccount(owner, cur) {
  return compareAccount(owner, cur) === 'same';
}
async function _setOwner(cur) {
  await setSyncMeta(META_KEY, JSON.stringify(cur));
}
const _ownerStatement = (tag) => ({ statement: `INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)`, values: [META_KEY, JSON.stringify(tag)] });
const _metaStatement = (k, v) => ({ statement: `INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)`, values: [k, v] });

/** Which account's rows Disconnect kept, and which an account is now, in
 *  row_origin's terms: the server (its instance id, or its address) and
 *  the user id. */
const _match = (tag) => ({ inst: tag.i || `addr:${tag.s}`, uid: tag.u ?? null });

// One change of hands at a time: the account check, a sync claiming a copy
// with no owner, Connect, Disconnect and Upload's preparation wait for each
// other, so two never move the same rows at once.
let _copyLock = Promise.resolve();
function _withCopy(fn) {
  const run = _copyLock.then(fn, fn);
  _copyLock = run.catch(() => {});
  return run;
}

// A sync still running for the previous holder stops (and is waited for)
// before the copy is cleared or handed over: it would write the previous
// account's rows into the next one's copy.
async function _stopSync() {
  try { await (await import('./sync.js')).stopSyncForAccountChange(); } catch { /* sync not loaded */ }
}

// The server's session cookie from an earlier sign-in, which CapacitorHttp
// sends with every request on Android: gone when the phone changes hands,
// so it can never speak for the previous account (servers before the
// header won read it first). Only LiftTrace's own cookie, by name, at every
// address it may be kept under: any named here (Connect's new server), the
// one in use, the one the copy was last tagged with, and the app's own
// address (Capacitor keeps a copy there of every cookie a native response
// sets). Every other cookie stays, a sign-in gate's on the same host
// (Cloudflare Access, Authelia) included.
const SERVER_COOKIES = ['lt_token'];
const APP_ADDRESS = 'https://app.lifttrace.local';
export async function forgetServerCookies(...urls) {
  try {
    const { CapacitorCookies, Capacitor } = await import('@capacitor/core');
    if (!Capacitor?.isNativePlatform?.()) return;
    let tagged = null;
    try { tagged = (await _readOwner())?.s || null; } catch { /* no copy */ }
    const all = [...urls, getServerUrl(), tagged, APP_ADDRESS].map(u => String(u || '').trim().replace(/\/+$/, '')).filter(Boolean);
    for (const url of new Set(all.map(u => u.toLowerCase()))) {
      for (const key of SERVER_COOKIES) {
        try { await CapacitorCookies.deleteCookie({ url, key }); } catch { /* none there */ }
      }
    }
  } catch { /* none kept */ }
}

// What the app holds in memory for an account goes with it (user-state.js).
async function _resetUserState() {
  try { await (await import('./user-state.js')).resetUserState(); } catch { /* nothing loaded */ }
}

async function _pulledBefore() {
  return !!((await getSyncMeta('last_server_time')) || (await getSyncMeta('last_pull_at')));
}
// A copy that is the phone's own: handed back by Disconnect, or never
// connected to a server (no owner, never pulled).
const _isPhones = async (owner) => !!owner?.local || (!owner && !(await _pulledBefore()));

/**
 * The copy becomes `cur`'s on a server, in one transaction: rows
 * Disconnect took from this same account go back to its rows, rows only
 * the phone has get ids below zero (sync.js adoptLocalCopy), and it is
 * tagged as `cur`'s. A copy handed back by Disconnect also starts its pull
 * from the beginning. A copy an earlier version kept for a server (never
 * tagged, pulled before) is only tagged here: sync.js sorts it out, with
 * the server's list in hand.
 */
async function _takeCopy(owner, cur, match = _match(cur)) {
  const extra = [_ownerStatement(cur)];
  if (!(await _isPhones(owner))) {
    await _setOwner(cur);
    return;
  }
  const sync = await import('./sync.js');
  if (owner?.local) {
    for (const k of ['last_server_time', 'last_pull_at', 'since_floor', 'full_pull_when_drained', 'temp_ids']) extra.push(_metaStatement(k, ''));
    extra.push(_metaStatement('full_pull', '1'));
  }
  extra.push(_metaStatement('local_ids', '1'));
  await sync.adoptLocalCopy({ match, extra });
  sync.forgetDeviceIds();
}

/**
 * Whose rows Disconnect kept count as `cur`'s, in row_origin's terms. When
 * this server can't say which it is (no instance id, even asked again) but
 * the rows came from a server that did, it isn't decided silently: the
 * person is asked whether it's the same server (`ask`; once per address
 * and account). "Same" puts the rows back in place; "different" leaves
 * them the phone's own, to go up as new. Without `ask` (a sync can't ask),
 * undecided is null.
 */
const _serverAnswers = new Map();
async function _resolveMatch(cur, ask) {
  const plain = _match(cur);
  if (cur.i) return plain;
  const uid = cur.u == null ? null : String(cur.u);
  const known = (await dbQuery(
    `SELECT DISTINCT inst FROM row_origin WHERE inst NOT LIKE 'addr:%' AND (? IS NULL OR uid IS NULL OR uid = ?)`, [uid, uid]
  )).map(r => r.inst);
  if (!known.length) return plain;
  const key = `${cur.s}#${cur.u}`;
  if (!_serverAnswers.has(key)) {
    if (!ask) return null;
    _serverAnswers.set(key, !!(await ask((await getSyncMeta('disconnected_from')) || '', cur.s)));
  }
  return _serverAnswers.get(key) && known.length === 1 ? { inst: known[0], uid: cur.u ?? null } : plain;
}

/** A copy with no owner, claimed for `cur` (once, however many ask).
 *  False while it can't be decided without asking (a sync). */
function _claim(cur, ask = null) {
  return _withCopy(async () => {
    const owner = await _readOwner();
    if (!_unowned(owner)) return compareAccount(owner, cur) === 'same';
    const match = (await _isPhones(owner)) ? await _resolveMatch(cur, ask) : _match(cur);
    if (!match) return false;
    await _takeCopy(owner, cur, match);
    return true;
  });
}

/**
 * A copy kept for a server by a version from before the owner tag: tagged
 * now (the server it's connected to, the account last signed in here),
 * before anyone signs in, rather than going to whoever signs in first.
 * App.svelte calls it at startup.
 */
export async function tagLegacyCopy() {
  try {
    if (!getServerUrl() || (await _readOwner()) || !(await _pulledBefore())) return false;
    const u = Number(localStorage.getItem('wl:userId'));
    if (!Number.isSafeInteger(u) || u <= 0) return false;
    await _setOwner({ i: null, s: _server(), u });
    return true;
  } catch { return false; }
}

/**
 * Sync gate: false only when the local data is known to be another
 * account's than the one whose token the request carries (`token`, the
 * one a sync started with), or might be (asked at sign-in), or the copy is
 * changing hands right now. A copy with no owner yet is claimed for it. A
 * token with no user id in it (servers without accounts) doesn't block.
 */
export async function localDataIsThisAccount(token = getAuthToken()) {
  if (copyMoving()) return false;
  const id = tokenUserId(token);
  // Signed out: nobody's session to send the queue under.
  if (id == null && signedOut()) return false;
  if (id == null) return true;
  const owner = await _readOwner();
  if (!_unowned(owner) && String(owner.u) !== String(id)) return false;
  const cur = await _current(id);
  if (compareAccount(owner, cur) !== 'same') return false;
  if (_unowned(owner)) {
    if (!(await _claim(cur))) return false;
    return !copyMoving();
  }
  // Same account: keep the tag current (new address, or a server that
  // now reports its id).
  if (owner.s !== cur.s || (cur.i && owner.i !== cur.i)) await _setOwner(cur);
  return !copyMoving();
}

/**
 * Connecting to a server from Settings, after the person chose what
 * happens to the phone's data. `clear` empties the copy (Download), so it
 * fills from that account; otherwise the copy is kept and goes up under it.
 * Either way it's that account's now, so signing in afterwards neither asks
 * nor clears.
 */
export async function claimForServer(serverUrl, userId, { clear = false, confirmServer = askSameServer } = {}) {
  await _stopSync();
  await forgetServerCookies(serverUrl);
  resetAccountGate();
  const cur = await _current(userId, serverUrl, { tries: 3 });
  await _withCopy(async () => {
    if (clear) {
      await dbClearUserData();
      await _setOwner(cur);
      try { (await import('./sync.js')).forgetDeviceIds(); } catch { /* not loaded */ }
    } else {
      const owner = await _readOwner();
      const own = owner?.local || !owner ? owner : { local: true };
      await _takeCopy(own, cur, await _resolveMatch(cur, confirmServer));
    }
  });
  await _resetUserState();
}

/**
 * Before an Upload to `serverUrl` as `userId`: rows Disconnect took from
 * that same account go back to its rows (unchanged ones as they were,
 * changed ones queued as updates), so only what is new goes up; the rest
 * get ids below zero. Only for a copy that is the phone's own.
 */
export async function prepareCopyForUpload(serverUrl = getServerUrl(), userId = tokenUserId(), { confirmServer = askSameServer } = {}) {
  return _withCopy(async () => {
    const owner = await _readOwner();
    if (!(await _isPhones(owner))) return null;
    const cur = await _current(userId, serverUrl, { tries: 3 });
    return (await import('./sync.js')).adoptLocalCopy({ match: await _resolveMatch(cur, confirmServer) });
  });
}

/** Whether the copy is the phone's own (handed back by Disconnect, or
 *  never connected): what an Upload sends from. */
export async function copyIsPhones() {
  return _isPhones(await _readOwner());
}

/** For the count shown before an Upload: what in the copy came from that
 *  same account (it goes back rather than up). */
export async function uploadMatch(serverUrl = getServerUrl(), userId = tokenUserId(), { confirmServer = askSameServer } = {}) {
  const owner = await _readOwner();
  if (!(await _isPhones(owner)) || !serverUrl) return null;
  return _resolveMatch(await _current(userId, serverUrl, { tries: 3 }), confirmServer);
}

/**
 * Before the phone's queued changes would be thrown away (Disconnect, or
 * Download over the phone's data): try to send them first; if some still
 * can't go, ask. True to go ahead (the rest are discarded), false to stop.
 * Never discards them without asking. `ask(count)` replaces the dialog.
 */
export async function settleQueuedChanges(kind, { ask = _askToDropQueued(kind), send = true } = {}) {
  const { dbQuery, dbRun } = await import('./db-native.js');
  const queued = async () => Number((await dbQuery(`SELECT COUNT(*) AS n FROM sync_queue`, []))[0]?.n || 0);
  if (!(await queued())) return true;
  if (send && getServerUrl()) {
    try { await (await import('./sync.js')).fullSync(true, true); } catch { /* still queued */ }
  }
  const left = await queued();
  if (!left) return true;
  if (!(await ask(left))) return false;
  await dbRun(`DELETE FROM sync_queue`, []);
  return true;
}

function _askToDropQueued(kind) {
  return async (count) => {
    const { confirmDialog } = await import('../stores/confirmDialog.js');
    const { _ } = await import('svelte-i18n');
    const say = get(_);
    return confirmDialog({
      title: say('sync.waiting_title'),
      message: say(kind === 'download' ? 'sync.download_waiting' : 'sync.disconnect_waiting', { values: { count } }),
      confirmText: say(kind === 'download' ? 'sync.download_anyway' : 'sync.disconnect_anyway'),
      dangerous: true,
    });
  };
}

/**
 * Local mode (Disconnect): the data is this phone's own now, and goes to
 * whichever account it's connected to next. Every row the account had
 * here becomes the phone's own (ids below zero, not on any server), so it
 * stays, and an Upload to another server sends all of it; each remembers
 * where it came from, so connecting back to this account puts it back in
 * place. One transaction, the tag included: stopped part way, the copy is
 * as it was, still this account's. No sync runs while it happens.
 */
export async function setLocalOwner() {
  setCopyMoving(true);
  try {
    await _stopSync();
    await forgetServerCookies();
    resetAccountGate();
    await _withCopy(async () => {
      const owner = await _readOwner();
      const origin = _unowned(owner) ? null : _match(owner);
      await (await import('./sync.js')).renumberLocalRows({
        all: true, origin,
        extra: [_ownerStatement({ local: true }), _metaStatement('local_ids', ''), _metaStatement('disconnected_from', owner?.s || '')],
      });
    });
  } catch (e) {
    console.warn('[account] keeping the rows as the phone\'s own failed:', e?.message || e);
    throw e;
  } finally {
    setCopyMoving(false);
  }
  await _resetUserState();
}

/** The question asked before discarding another account's waiting
 *  changes: true to sign in anyway (discard), false to keep them. */
export async function askToDiscard(count) {
  const { confirmDialog } = await import('../stores/confirmDialog.js');
  const { _ } = await import('svelte-i18n');
  const say = get(_);
  return confirmDialog({
    title: say('sync.switch_account_waiting_title'),
    message: say('sync.switch_account_waiting', { values: { count } }),
    confirmText: say('sync.switch_account_anyway'),
    dangerous: true,
  });
}

/** The question when the same user id signs in at another address and a
 *  server can't say whether it's the same one: true for the same server. */
export async function askSameServer(before, now) {
  const { confirmDialog } = await import('../stores/confirmDialog.js');
  const { _ } = await import('svelte-i18n');
  const say = get(_);
  return confirmDialog({
    title: say('sync.same_server_title'),
    message: say('sync.same_server', { values: { before: before || '', now: now || '' } }),
    confirmText: say('sync.same_server_yes'),
    cancelText: say('sync.same_server_no'),
  });
}

/**
 * Make the copy this account's. Returns false when the person chose to
 * keep the previous account's unsent changes: the caller then undoes the
 * sign-in. `confirm(count)` and `confirmServer(before, now)` replace the
 * dialogs (tests).
 */
export async function prepareLocalAccount(user, { confirm = askToDiscard, confirmServer = askSameServer } = {}) {
  if (!user || user.id == null) return true;
  // Someone is signing in: syncs may run again once the copy is theirs.
  markSignedOut(false);
  const owner = await _readOwner();
  // Asked again when the network failed: whether it's the same server
  // rests on the answer.
  const cur = await _current(user.id, getServerUrl(), { tries: 3 });
  let cmp = compareAccount(owner, cur);
  if (cmp === 'ask') cmp = (await confirmServer(owner.s, cur.s)) ? 'same' : 'other';
  if (cmp === 'same') {
    if (_unowned(owner)) return _claim(cur, confirmServer);
    if (owner.s !== cur.s || owner.i !== cur.i) await _setOwner({ ...cur, i: cur.i || owner.i || null });
    return true;
  }
  const waiting = await dbCountUnsynced();
  if (waiting > 0 && !(await confirm(waiting))) return false;
  await _stopSync();
  await forgetServerCookies();
  await _withCopy(async () => {
    await dbClearUserData();
    await _setOwner(cur);
  });
  try { (await import('./sync.js')).forgetDeviceIds(); } catch { /* not loaded */ }
  await _resetUserState();
  return true;
}

// ── The gate App.svelte shows the app behind ─────────────────────────────
// One check at a time, and one per account: asking again for the account
// being checked (Svelte re-running its reactive block, a refreshed user
// object) gets the same answer, never a second dialog. A check that ends
// in signing out stays the running one until the sign-out has finished.
// state: 'idle' | 'checking' | 'ready' | 'signing_out' | 'error'
export const accountGate = writable({ state: 'idle', key: null, error: null });
let _running = null; // { key, promise }
const _gateKey = userId => `${_server()}#${userId}`;

export function resetAccountGate() {
  if (!_running) accountGate.set({ state: 'idle', key: null, error: null });
}

export function ensureLocalAccount(user, { confirm, signOut } = {}) {
  if (!user || user.id == null) return Promise.resolve(true);
  const key = _gateKey(user.id);
  const now = get(accountGate);
  if (now.state === 'ready' && now.key === key && !_running) return Promise.resolve(true);
  if (_running?.key === key) return _running.promise;
  const before = _running?.promise || Promise.resolve();
  const promise = before.catch(() => {}).then(() => _check(user, key, { confirm, signOut }));
  const run = { key, promise };
  _running = run;
  promise.finally(() => { if (_running === run) _running = null; });
  return promise;
}

async function _check(user, key, { confirm, signOut }) {
  accountGate.set({ state: 'checking', key, error: null });
  let ok;
  try {
    ok = await prepareLocalAccount(user, confirm ? { confirm } : {});
  } catch (e) {
    // Not knowing whose data this is: show nothing of it, say so, and
    // offer to try again or sign out.
    accountGate.set({ state: 'error', key, error: e?.message || String(e) });
    return false;
  }
  if (!ok) {
    accountGate.set({ state: 'signing_out', key, error: null });
    try { await signOut?.(); } catch { /* the sign-in is undone either way */ }
    accountGate.set({ state: 'idle', key: null, error: null });
    return false;
  }
  // The setting stores read this account's values (a no-op when they
  // already do).
  try { (await import('../stores/settings.js')).reloadSettingStores(); } catch { /* not loaded */ }
  accountGate.set({ state: 'ready', key, error: null });
  return true;
}

/** Whether the app may show the data for this user now. */
export function accountReadyFor(gate, userId) {
  return gate?.state === 'ready' && gate.key === _gateKey(userId);
}
