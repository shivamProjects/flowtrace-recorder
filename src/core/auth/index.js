/**
 * auth — the extension authenticates itself to the platform, or it does nothing.
 *
 * This is CORE rather than a patch for the same reason the password rules are:
 * it is about the extension, not about any application being recorded. A patch
 * adapts the recorder to Oracle or IBM; who is allowed to run the recorder at
 * all is a property of the product, and swapping patches must not change it.
 *
 * The backend contract (platform-api AuthLoginController):
 *   POST /api/auth/login      { username, password }
 *   POST /api/auth/verify-mfa { mfaToken, code }
 *   GET  /api/auth/me         Bearer <token>
 * Every reply is an `ApiResponse` envelope; the payload is `.data`.
 *
 * `username`, NOT `email`. `LoginRequest` is a record of (username, password)
 * with `@NotBlank` on both, and `AuthService` looks the account up with
 * `findByUsername` — posting `{ email, password }` fails bean validation with a
 * 400 before any account is consulted. Platform users have a username distinct
 * from their email address.
 *
 * Sign-in is TWO steps whenever the account has MFA enabled. `login` then
 * returns `mfaRequired: true` with a NULL token and a NULL user, and a second
 * call to `verify-mfa` is what mints a usable one. Treating the first reply as
 * final stores a null token and produces an extension that believes it is
 * signed in and 401s on everything it then does.
 *
 * Nothing in this module logs a password, an MFA code, a token or the
 * intermediate MFA token. The password and the code exist as parameters for the
 * duration of one fetch and are not stored, cached, or echoed into an error
 * message; error text from the server is passed through, and the server does
 * not echo them back either.
 */

import { apiErrorMessage, apiUrl, unwrap } from '../shared/settings.js';
import * as store from './store.js';

/** How long to wait on the backend before deciding the network is the problem. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The half-authenticated state between the two login calls.
 *
 * Deliberately a worker-memory variable and NOT chrome.storage: the MFA token
 * is a bearer of partial authority — whoever holds it plus a code becomes the
 * user — so it must not outlive the sign-in attempt or be written to disk.
 * Losing it to a worker eviction costs one retyped password, which is much the
 * cheaper of the two failures.
 */
let pendingMfa = null;

/**
 * Step one. Succeeds outright for an account without MFA; otherwise reports
 * what the second step will need.
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{success: boolean, user?: Object, error?: string,
 *                    mfaRequired?: boolean, mfaType?: string}>}
 */
export async function signIn(username, password) {
  pendingMfa = null;

  if (!username || !password) {
    return { success: false, error: 'Enter your username and password.' };
  }

  const result = await post('/api/auth/login', { username, password });
  if (!result.ok) return { success: false, error: result.error };

  const login = result.data;
  if (!login) return { success: false, error: 'The server did not return a login result.' };

  if (login.mfaRequired) {
    if (!login.mfaToken) {
      // A demanded second factor with nothing to present it against cannot be
      // completed, and saying so beats a code prompt that can only ever fail.
      return { success: false, error: 'The server asked for an MFA code but issued no MFA token.' };
    }
    pendingMfa = { token: login.mfaToken, type: login.mfaType || null };
    return { success: false, mfaRequired: true, mfaType: login.mfaType || null };
  }

  return finish(login);
}

/**
 * Step two. Exchanges the code for a real token.
 *
 * @param {string} code
 * @returns {Promise<{success: boolean, user?: Object, error?: string, mfaRequired?: boolean}>}
 */
export async function verifyMfa(code) {
  if (!pendingMfa) {
    return { success: false, error: 'That sign-in attempt has expired. Sign in again.' };
  }
  if (!code || !String(code).trim()) {
    return { success: false, mfaRequired: true, error: 'Enter the code from your authenticator or email.' };
  }

  const result = await post('/api/auth/verify-mfa', {
    mfaToken: pendingMfa.token,
    code: String(code).trim(),
  });

  if (!result.ok) {
    // A mistyped code is worth another attempt against the same MFA token. The
    // server rejects a spent or lapsed one on its own, so discarding it here
    // would only send someone back to the password field for a typo.
    return { success: false, mfaRequired: true, error: result.error };
  }

  return finish(result.data);
}

/** Whether the current sign-in attempt is waiting on a code. */
export function mfaPending() {
  return pendingMfa ? { mfaRequired: true, mfaType: pendingMfa.type } : { mfaRequired: false };
}

/** The tail both paths share: a LoginResponse that should be carrying a token. */
async function finish(login) {
  if (!login || !login.token) {
    return { success: false, error: 'The server did not return a token.' };
  }
  pendingMfa = null;
  await store.save(login.token, login.user || null);
  return { success: true, user: store.getUser() };
}

/**
 * Re-ask the server who this token belongs to.
 *
 * This is what makes deactivating a customer take effect inside a session
 * instead of at the end of the token's seven days, so it runs every time the
 * popup opens rather than on a timer.
 *
 * A network failure is NOT a sign-out. The extension is used on customer
 * networks behind proxies and VPNs that drop connections routinely, and logging
 * someone out mid-recording because a request timed out would lose their work
 * to a condition that has nothing to do with their account. Only the server
 * saying no — 401 or 403 — clears the token.
 *
 * @returns {Promise<{authenticated: boolean, user: ?Object, offline?: boolean}>}
 */
export async function revalidate() {
  await store.ensureLoaded();
  const token = store.getToken();
  if (!token) {
    // An expired token is genuinely dead; nothing on the wire will revive it.
    if (store.isExpired()) await store.clear();
    return { authenticated: false, user: null };
  }

  let response;
  try {
    response = await request('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // Unreachable, not rejected. Keep the session and say so.
    return { authenticated: true, user: store.getUser(), offline: true };
  }

  if (response.status === 401 || response.status === 403) {
    await store.clear();
    return { authenticated: false, user: null };
  }

  if (!response.ok) {
    // A 500 is the server's problem, not this account's. Same reasoning as the
    // network case: only an explicit rejection ends the session.
    return { authenticated: true, user: store.getUser(), offline: true };
  }

  const user = unwrap(await response.json().catch(() => null));
  if (user && user.id) await store.updateUser(user);

  return { authenticated: true, user: store.getUser() };
}

export async function signOut() {
  pendingMfa = null;
  await store.clear();
  return { success: true };
}

/** State for the UI, without ever handing the token to it. */
export async function status() {
  await store.ensureLoaded();
  return {
    authenticated: store.isAuthenticated(),
    user: store.getUser(),
    ...mfaPending(),
  };
}

/**
 * The token for an outgoing platform request, or null.
 * @returns {Promise<?string>}
 */
export async function bearerToken() {
  await store.ensureLoaded();
  return store.getToken();
}

/** Whether the extension is currently allowed to do anything. */
export async function isAuthenticated() {
  await store.ensureLoaded();
  return store.isAuthenticated();
}

/**
 * An unauthenticated POST reduced to either its unwrapped payload or a
 * sentence. Both login steps fail in the same ways, and reporting them
 * identically is what lets the callers above branch on the flow rather than on
 * the transport.
 *
 * @returns {Promise<{ok: true, data: ?Object} | {ok: false, error: string}>}
 */
async function post(path, body) {
  let response;
  try {
    response = await request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: reachabilityError(err) };
  }

  const parsed = await response.json().catch(() => null);

  if (!response.ok) {
    return { ok: false, error: apiErrorMessage(parsed, response.status, defaultFor(response.status)) };
  }
  return { ok: true, data: unwrap(parsed) };
}

async function request(path, init) {
  const url = await apiUrl(path);
  // AbortSignal.timeout rather than a manual timer: a hung fetch in a service
  // worker keeps the worker alive indefinitely.
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/**
 * Wording for the cases the server does not describe itself, because "invalid
 * username or password" and "account has been deactivated" are different
 * problems for the person reading them.
 */
function defaultFor(status) {
  if (status === 401) return 'Invalid username, password or code.';
  if (status === 403) return 'This account has been deactivated.';
  if (status === 429) return 'Too many attempts. Try again in a few minutes.';
  return `Sign-in failed (${status}).`;
}

function reachabilityError(err) {
  if (err && err.name === 'TimeoutError') return 'The platform did not respond.';
  return 'Could not reach the platform. Check the API base in Settings.';
}
