/**
 * store.js — the token and who it belongs to, and when it stops being true.
 *
 * The same MV3 problem session.js has: the service worker is evicted whenever
 * Chrome feels like it and every module-level variable goes with it. So the
 * token lives in chrome.storage.local and the in-memory copy is a cache that
 * every entry point re-warms through `ensureLoaded()`.
 *
 * Expiry is read out of the JWT rather than tracked separately. The backend
 * signs a 7-day token and is the only thing that can validate one; decoding the
 * `exp` claim locally is not a security check — the server still verifies every
 * request — it is how the extension knows to stop pretending it is signed in
 * and show the sign-in screen instead of failing every call with a 401.
 */

const STORAGE_KEY = 'auth';

let state = { token: null, user: null, expiresAt: null, authMode: 'platform' };
let loaded = false;

export async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const saved = stored[STORAGE_KEY];
    if (saved && saved.token) {
      state = {
        token: saved.token,
        user: saved.user || null,
        expiresAt: saved.expiresAt ?? null,
        authMode: saved.authMode || 'platform',
      };
    }
  } catch (err) {
    // Storage unavailable is indistinguishable from signed out, and signed out
    // is the safe reading of the two.
    console.warn('[recorder] could not restore auth:', err.message);
  }
}

export async function save(token, user, authMode = 'platform') {
  state = { token, user: user || null, expiresAt: expiryOf(token), authMode };
  loaded = true;
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

/** Replace the user without touching the token — what revalidation produces. */
export async function updateUser(user) {
  if (!state.token) return;
  state = { ...state, user: user || null };
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

export async function clear() {
  state = { token: null, user: null, expiresAt: null, authMode: 'platform' };
  loaded = true;
  await chrome.storage.local.remove(STORAGE_KEY);
}

export function getAuthMode() {
  return state.authMode || 'platform';
}

/**
 * The bearer token, or null when there is none or it has lapsed.
 *
 * An expired token is reported as absent rather than returned with a flag,
 * because every caller would have to remember to check the flag and one of them
 * would not.
 */
export function getToken() {
  if (!state.token) return null;
  if (state.expiresAt != null && state.expiresAt <= Date.now()) return null;
  return state.token;
}

export function getUser() {
  return getToken() ? state.user : null;
}

export function isAuthenticated() {
  return getToken() !== null;
}

/** True when there is a token and it is past its expiry — worth saying so in the UI. */
export function isExpired() {
  return !!state.token && state.expiresAt != null && state.expiresAt <= Date.now();
}

/**
 * The `exp` claim, in milliseconds.
 *
 * Deliberately does not verify the signature: nothing here could, and a token
 * this extension cannot read is one the server will reject anyway. A token with
 * no readable expiry is treated as non-expiring locally and left for the server
 * to refuse.
 *
 * @param {string} token
 * @returns {?number}
 */
function expiryOf(token) {
  try {
    const payload = String(token).split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json);
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}
