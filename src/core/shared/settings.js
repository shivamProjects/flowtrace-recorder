/**
 * settings.js — the extension's own configuration, as opposed to a recording's.
 *
 * Two settings, and both of them are about where a recording ends up:
 *
 *  - `apiBase`, the platform's origin. It replaced a hand-typed endpoint URL per
 *    feature, which meant the sign-in and the upload could be pointed at two
 *    different servers and nothing would say so until an upload failed with a
 *    token the other server had issued.
 *  - the selected environment. The platform files every recording under an
 *    environment and rejects one that arrives without an id, so this is not a
 *    preference — it is a precondition, and the recorder refuses to start
 *    without it.
 *
 * This module also owns the shape of the platform's replies, because that shape
 * is a property of the server this file points at. Every controller returns
 * `ApiResponse { success, message, data, error, timestamp }`, so the payload a
 * caller wants is always `.data` and never the body itself.
 */

const API_BASE_KEY = 'apiBase';
const ENVIRONMENT_KEY = 'environment';

/**
 * Default target — the shared dev platform on `nitro`, verified live:
 * `GET http://nitro:3050/api/health` returns `{"database":"CONNECTED","status":"UP"}`.
 * The Spring server listens on 3050 with no context path, so paths are literal.
 * Override per install from the popup's settings field.
 */
export const DEFAULT_API_BASE = 'http://nitro:3050';

export async function getApiBase() {
  try {
    const stored = await chrome.storage.local.get(API_BASE_KEY);
    return normaliseBase(stored[API_BASE_KEY]) || DEFAULT_API_BASE;
  } catch {
    return DEFAULT_API_BASE;
  }
}

export async function setApiBase(value) {
  const base = normaliseBase(value) || DEFAULT_API_BASE;
  await chrome.storage.local.set({ [API_BASE_KEY]: base });
  return base;
}

/** Absolute URL for a backend path. */
export async function apiUrl(path) {
  return `${await getApiBase()}${path}`;
}

// ── the selected environment ───────────────────────────────────────────────

/**
 * The environment a recording will be filed under, or null.
 * @returns {Promise<?{id: string, name: string}>}
 */
export async function getEnvironment() {
  try {
    const stored = await chrome.storage.local.get(ENVIRONMENT_KEY);
    const env = stored[ENVIRONMENT_KEY];
    return env && isUuid(env.id) ? { id: env.id, name: env.name || env.id } : null;
  } catch {
    return null;
  }
}

/**
 * Remember (or, with null, forget) the environment.
 *
 * The id is checked against the UUID shape here rather than at upload time.
 * `UUID.fromString` on the server throws on anything else, and a malformed id
 * discovered after a recording has been made costs the whole recording — the
 * same reasoning that puts the environment requirement before Start rather than
 * before Save.
 *
 * @param {?{id: string, name?: string}} env
 */
export async function setEnvironment(env) {
  if (!env || !env.id) {
    await chrome.storage.local.remove(ENVIRONMENT_KEY);
    return null;
  }
  if (!isUuid(env.id)) throw new Error('Environment id is not a UUID.');

  const value = { id: env.id, name: env.name || env.id };
  await chrome.storage.local.set({ [ENVIRONMENT_KEY]: value });
  return value;
}

// ── the platform's response envelope ───────────────────────────────────────

/**
 * The payload out of an `ApiResponse`.
 *
 * Tolerant of an unwrapped body, so that a proxy or an endpoint that answers
 * with the object directly does not read as an empty response. The
 * discriminator is the envelope's own `success` flag, which no payload the
 * extension asks for carries.
 */
export function unwrap(body) {
  if (body && typeof body === 'object' && typeof body.success === 'boolean' && 'data' in body) {
    return body.data;
  }
  return body;
}

/**
 * Something worth showing a person, out of a failed response.
 *
 * The platform is not consistent about which field holds the prose. Its
 * exception handler puts the human sentence in `error` and the literal string
 * "ERROR" in `message`; its access-denied handler does the reverse, putting the
 * code `ACCESS_DENIED` in `error` and the sentence in `message`. Neither field
 * can be trusted by name, so prefer whichever one is not a machine code.
 *
 * @param {?Object} body  the parsed response body, if there was one
 * @param {number} status
 * @param {string} [fallback]
 */
export function apiErrorMessage(body, status, fallback) {
  const prose = [body?.error, body?.message].find(
    (t) => typeof t === 'string' && t.trim() && !isMachineCode(t),
  );
  return prose || fallback || `Request failed (${status}).`;
}

/** `ACCESS_DENIED`, `ERROR`, `OK` — a code, not a sentence. */
function isMachineCode(text) {
  return /^[A-Z][A-Z0-9_]*$/.test(text.trim());
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
}

/**
 * A trailing slash here and an absolute path there produces `//api/auth/login`,
 * which some routers accept and some 404. Stripped once, at the point the value
 * is stored, rather than defended against at every call site.
 */
function normaliseBase(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  return trimmed || null;
}
