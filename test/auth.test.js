/**
 * Extension authentication and upload, against the platform's actual contract.
 *
 * Three things here are not general test hygiene but defences against specific
 * ways this code was wrong:
 *
 * 1. Every platform reply is an `ApiResponse` envelope, so the fake backend
 *    wraps everything. A client that reads the body directly sees `undefined`
 *    for the token and stores it without complaint.
 * 2. Login is two steps when MFA is on, and the first step returns a NULL
 *    token. The test for that asserts the extension is NOT authenticated in
 *    between — the failure mode is an extension that thinks it is signed in.
 * 3. `stepsJson` is a STRING. `RecordingService` calls `.toString()` on it, so
 *    an array arrives as Java's `[{action=click}]` and is persisted as
 *    unparseable garbage behind a 200. The test parses the field back.
 *
 * The gate tests are the important ones. A disabled button proves nothing — the
 * popup is an ordinary page and the service worker's console will post any
 * message you type into it — so they drive the ROUTER directly, which is
 * exactly what an attacker with devtools open would do.
 *
 * The offline tests exist because the tempting implementation of "revalidate on
 * open" signs the user out whenever the request fails, which on a customer VPN
 * means signing them out at random and losing the recording in progress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SCHEMA_VERSION } from '../src/core/shared/schema.js';

/** A JWT this code can read the expiry out of. Signature is irrelevant here. */
function tokenExpiringIn(seconds) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({
    sub: '11111111-1111-4111-8111-111111111111',
    role: 'MEMBER',
    exp: Math.floor(Date.now() / 1000) + seconds,
  }));
  return `${header}.${payload}.not-a-real-signature`;
}

/** The platform's UserInfo: username and email are different fields. */
const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'shivam',
  email: 'operator@example.com',
  fullName: 'Operator',
  role: 'MEMBER',
  tenantId: 'org_dev_local',
  mfaEnabled: false,
  mfaType: null,
};

const ENVIRONMENT = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Fusion DEV',
  type: 'ORACLE_FUSION',
};

/** Fake chrome.storage.local, which is all these modules use. */
function installChrome() {
  const store = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of wanted) if (key in store) out[key] = store[key];
          return out;
        },
        set: async (items) => { Object.assign(store, items); },
        remove: async (key) => { delete store[key]; },
      },
    },
    scripting: { executeScript: async () => [] },
    tabs: { sendMessage: async () => ({}) },
  };
  return store;
}

/** Responses the fake backend will give, keyed by the path requested. */
let routes;
let requests;

function installFetch() {
  requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init });
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) throw new Error(`no route for ${path}`);
    return route(init);
  };
}

/** Success as the platform sends it: wrapped in ApiResponse. */
function ok(data) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, message: 'OK', data, error: null, timestamp: '2026-01-01T00:00:00Z' }),
  };
}

/**
 * Failure as the platform's exception handler sends it — the human sentence in
 * `error`, the literal string "ERROR" in `message`. A client that reads
 * `message` shows the word "ERROR" to the user.
 */
function fail(status, error, message = 'ERROR') {
  return {
    ok: false,
    status,
    json: async () => ({ success: false, message, data: null, error, timestamp: '2026-01-01T00:00:00Z' }),
  };
}

/**
 * Fresh module instances per test — the auth store caches the token in a
 * module-level variable exactly as the service worker does, so a test that
 * signed in would otherwise leak that into the next one.
 */
async function loadModules() {
  vi.resetModules();
  const auth = await import('../src/core/auth/index.js');
  const store = await import('../src/core/auth/store.js');
  const settings = await import('../src/core/shared/settings.js');
  const { createRouter } = await import('../src/core/background/router.js');
  return { auth, store, settings, createRouter };
}

const PATCHES = {
  getPatch: () => ({ id: 'generic', name: 'Generic', version: '1.0.0', postProcess: (e) => e }),
  hasPatch: (id) => id === 'generic',
  listPatches: () => [{ id: 'generic', name: 'Generic' }],
};

/** A signed-in worker with an environment chosen — the normal starting state. */
async function ready() {
  routes['/api/auth/login'] = () => ok({ token: tokenExpiringIn(3600), user: USER, mfaRequired: false });
  const mods = await loadModules();
  await mods.auth.signIn('shivam', 'correct horse');
  await mods.settings.setEnvironment({ id: ENVIRONMENT.id, name: ENVIRONMENT.name });
  return { ...mods, route: mods.createRouter(PATCHES) };
}

const START = { action: 'START_RECORDING', tabId: 1, tabUrl: 'https://example.test/', patchId: 'generic' };

beforeEach(() => {
  installChrome();
  installFetch();
  routes = {};
  globalThis.AbortSignal.timeout = () => undefined;
});

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.fetch;
});

describe('signing in', () => {
  it('posts username and password, and keeps the token out of the envelope', async () => {
    const token = tokenExpiringIn(7 * 24 * 3600);
    routes['/api/auth/login'] = () => ok({ token, user: USER, mfaRequired: false });

    const { auth, store } = await loadModules();
    const result = await auth.signIn('shivam', 'correct horse');

    expect(result.success).toBe(true);
    expect(result.user.username).toBe('shivam');
    expect(store.getToken()).toBe(token);

    // `username`, not `email`. LoginRequest is (username, password) with
    // @NotBlank on both — an `email` key fails validation with a 400.
    const body = JSON.parse(requests[0].init.body);
    expect(Object.keys(body).sort()).toEqual(['password', 'username']);
    expect(body.username).toBe('shivam');
  });

  it('defaults to the platform port, not the invented one', async () => {
    routes['/api/auth/login'] = () => ok({ token: tokenExpiringIn(60), user: USER });
    const { auth } = await loadModules();
    await auth.signIn('shivam', 'correct horse');

    expect(requests[0].url).toBe('http://localhost:3050/api/auth/login');
  });

  it('reports a deactivated account in the server\'s own words, not "ERROR"', async () => {
    routes['/api/auth/login'] = () => fail(403, 'Account has been deactivated. Contact your administrator.');

    const { auth, store } = await loadModules();
    const result = await auth.signIn('shivam', 'correct horse');

    expect(result.success).toBe(false);
    expect(result.error).toContain('deactivated');
    expect(result.error).not.toBe('ERROR');
    expect(store.getToken()).toBeNull();
  });

  it('prefers the sentence over the code when the fields are the other way round', async () => {
    // The access-denied handler puts the code in `error` and the prose in
    // `message` — the opposite of every other failure.
    routes['/api/auth/login'] = () => fail(403, 'ACCESS_DENIED', 'You do not have permission to perform this action');

    const { auth } = await loadModules();
    const result = await auth.signIn('shivam', 'correct horse');

    expect(result.error).toBe('You do not have permission to perform this action');
  });

  it('does not authenticate on a wrong password', async () => {
    routes['/api/auth/login'] = () => fail(401, 'Invalid username or password');

    const { auth, store } = await loadModules();
    expect((await auth.signIn('shivam', 'wrong')).success).toBe(false);
    expect(store.isAuthenticated()).toBe(false);
  });
});

describe('signing in with MFA', () => {
  const MFA_TOKEN = 'pending.mfa.token';

  it('does not treat the first step as a sign-in', async () => {
    routes['/api/auth/login'] = () =>
      ok({ token: null, user: null, mfaRequired: true, mfaType: 'TOTP', mfaToken: MFA_TOKEN });

    const { auth, store } = await loadModules();
    const result = await auth.signIn('shivam', 'correct horse');

    // Not success, and — the failure this guards against — no null token stored.
    expect(result.success).toBe(false);
    expect(result.mfaRequired).toBe(true);
    expect(result.mfaType).toBe('TOTP');
    expect(store.getToken()).toBeNull();
    expect(await auth.isAuthenticated()).toBe(false);
  });

  it('never hands the MFA token to the caller', async () => {
    routes['/api/auth/login'] = () =>
      ok({ token: null, user: null, mfaRequired: true, mfaType: 'EMAIL', mfaToken: MFA_TOKEN });

    const { auth } = await loadModules();
    const result = await auth.signIn('shivam', 'correct horse');

    // The popup gets a flag, not a bearer of partial authority.
    expect(JSON.stringify(result)).not.toContain(MFA_TOKEN);
  });

  it('completes on verify-mfa with the stashed token and the code', async () => {
    const token = tokenExpiringIn(3600);
    routes['/api/auth/login'] = () =>
      ok({ token: null, user: null, mfaRequired: true, mfaType: 'TOTP', mfaToken: MFA_TOKEN });
    routes['/api/auth/verify-mfa'] = () => ok({ token, user: USER, mfaRequired: false });

    const { auth, store } = await loadModules();
    await auth.signIn('shivam', 'correct horse');
    const result = await auth.verifyMfa('123456');

    expect(result.success).toBe(true);
    expect(store.getToken()).toBe(token);

    // The exact field names on VerifyMfaRequest.
    const body = JSON.parse(requests[1].init.body);
    expect(Object.keys(body).sort()).toEqual(['code', 'mfaToken']);
    expect(body.mfaToken).toBe(MFA_TOKEN);
    expect(body.code).toBe('123456');
  });

  it('keeps the attempt alive after a wrong code', async () => {
    routes['/api/auth/login'] = () =>
      ok({ token: null, user: null, mfaRequired: true, mfaType: 'TOTP', mfaToken: MFA_TOKEN });
    routes['/api/auth/verify-mfa'] = () => fail(401, 'Invalid or expired MFA code');

    const { auth } = await loadModules();
    await auth.signIn('shivam', 'correct horse');

    const result = await auth.verifyMfa('000000');
    expect(result.success).toBe(false);
    expect(result.mfaRequired).toBe(true);
    expect(auth.mfaPending().mfaRequired).toBe(true);
  });

  it('refuses a code when no sign-in is in progress', async () => {
    const { auth } = await loadModules();
    const result = await auth.verifyMfa('123456');

    expect(result.success).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it('the worker still refuses to record between the two steps', async () => {
    routes['/api/auth/login'] = () =>
      ok({ token: null, user: null, mfaRequired: true, mfaType: 'TOTP', mfaToken: MFA_TOKEN });

    const { auth, createRouter } = await loadModules();
    await auth.signIn('shivam', 'correct horse');

    expect((await createRouter(PATCHES)(START, {})).unauthenticated).toBe(true);
  });
});

describe('revalidating when the popup opens', () => {
  beforeEach(() => {
    routes['/api/auth/login'] = () => ok({ token: tokenExpiringIn(3600), user: USER });
  });

  it('signs the user out when the server says 401', async () => {
    routes['/api/auth/me'] = () => fail(401, 'Invalid or missing authentication token');

    const { auth, store } = await loadModules();
    await auth.signIn('shivam', 'correct horse');
    expect(store.isAuthenticated()).toBe(true);

    const result = await auth.revalidate();
    expect(result.authenticated).toBe(false);
    expect(store.getToken()).toBeNull();
  });

  it('signs the user out when the server says 403', async () => {
    routes['/api/auth/me'] = () => fail(403, 'Account has been deactivated.');

    const { auth, store } = await loadModules();
    await auth.signIn('shivam', 'correct horse');
    await auth.revalidate();

    expect(store.getToken()).toBeNull();
  });

  it('does NOT sign the user out when the network fails', async () => {
    routes['/api/auth/me'] = () => { throw new TypeError('Failed to fetch'); };

    const { auth, store } = await loadModules();
    await auth.signIn('shivam', 'correct horse');

    const result = await auth.revalidate();
    expect(result.authenticated).toBe(true);
    expect(result.offline).toBe(true);
    expect(store.getToken()).not.toBeNull();
  });

  it('does NOT sign the user out when the server errors', async () => {
    routes['/api/auth/me'] = () => fail(500, 'An unexpected error occurred.');

    const { auth, store } = await loadModules();
    await auth.signIn('shivam', 'correct horse');

    expect((await auth.revalidate()).authenticated).toBe(true);
    expect(store.getToken()).not.toBeNull();
  });

  it('reads the user out of the envelope, not off the body', async () => {
    routes['/api/auth/me'] = () => ok({ ...USER, fullName: 'Renamed Operator' });

    const { auth } = await loadModules();
    await auth.signIn('shivam', 'correct horse');

    expect((await auth.revalidate()).user.fullName).toBe('Renamed Operator');
  });
});

describe('expiry', () => {
  it('treats a lapsed token as signed out without asking the server', async () => {
    routes['/api/auth/login'] = () => ok({ token: tokenExpiringIn(-1), user: USER });

    const { auth, store } = await loadModules();
    await auth.signIn('shivam', 'correct horse');

    expect(store.getToken()).toBeNull();
    expect(store.isAuthenticated()).toBe(false);
    expect((await auth.revalidate()).authenticated).toBe(false);
    // No /me call was made — there was nothing to ask about.
    expect(requests.filter((r) => r.url.includes('/me'))).toHaveLength(0);
  });
});

describe('signing out', () => {
  it('clears the token and the user', async () => {
    routes['/api/auth/login'] = () => ok({ token: tokenExpiringIn(3600), user: USER });

    const { auth, store } = await loadModules();
    await auth.signIn('shivam', 'correct horse');
    await auth.signOut();

    expect(store.getToken()).toBeNull();
    expect(store.getUser()).toBeNull();
    expect((await chrome.storage.local.get('auth')).auth).toBeUndefined();
  });
});

describe('the service-worker gate', () => {
  it('refuses START_RECORDING posted straight at the worker when signed out', async () => {
    const { createRouter } = await loadModules();
    const route = createRouter(PATCHES);

    // This is the bypass: no popup involved, the message goes to the same
    // handler chrome.runtime.onMessage would have called.
    const resp = await route(START, {});

    expect(resp.success).toBe(false);
    expect(resp.unauthenticated).toBe(true);

    // And nothing was set in motion — no content script injected, no session.
    const status = await route({ action: 'GET_STATUS' }, {});
    expect(status.session.isRecording).toBe(false);
  });

  it('refuses when the token has lapsed, not merely when it is absent', async () => {
    routes['/api/auth/login'] = () => ok({ token: tokenExpiringIn(-1), user: USER });

    const { auth, createRouter } = await loadModules();
    await auth.signIn('shivam', 'correct horse');

    expect((await createRouter(PATCHES)(START, {})).unauthenticated).toBe(true);
  });

  it('drops no events either, because the recording never started', async () => {
    const { createRouter } = await loadModules();
    const route = createRouter(PATCHES);
    await route(START, {});

    const resp = await route({
      action: 'RECORD_EVENT',
      event: { type: 'click', selector: '#a', meta: {} },
    }, {});

    expect(resp.accepted).toBe(false);
  });

  it('allows START_RECORDING once signed in with an environment chosen', async () => {
    const { route } = await ready();

    const resp = await route(START, {});
    expect(resp.success).toBe(true);
    expect(resp.environment.id).toBe(ENVIRONMENT.id);

    const status = await route({ action: 'GET_STATUS' }, {});
    expect(status.session.isRecording).toBe(true);
  });
});

describe('the environment gate', () => {
  it('refuses START_RECORDING with a valid token but no environment', async () => {
    // Signed in, nothing chosen. This is the wasted-recording case: without the
    // gate the refusal would arrive at Save, after the work was done.
    routes['/api/auth/login'] = () => ok({ token: tokenExpiringIn(3600), user: USER });
    const { auth, createRouter } = await loadModules();
    await auth.signIn('shivam', 'correct horse');

    const resp = await createRouter(PATCHES)(START, {});

    expect(resp.success).toBe(false);
    expect(resp.environmentRequired).toBe(true);
    expect(resp.unauthenticated).toBeUndefined();
  });

  it('refuses a message posted straight at the worker, not just a click', async () => {
    routes['/api/auth/login'] = () => ok({ token: tokenExpiringIn(3600), user: USER });
    const { auth, createRouter } = await loadModules();
    await auth.signIn('shivam', 'correct horse');
    const route = createRouter(PATCHES);

    await route(START, {});
    expect((await route({ action: 'GET_STATUS' }, {})).session.isRecording).toBe(false);
  });

  it('rejects an environment id that is not a UUID', async () => {
    const { route } = await ready();

    const resp = await route({ action: 'SET_ENVIRONMENT', environment: { id: 'not-a-uuid' } }, {});
    expect(resp.success).toBe(false);
  });

  it('will not move the environment mid-recording', async () => {
    const { route } = await ready();
    await route(START, {});

    const resp = await route({
      action: 'SET_ENVIRONMENT',
      environment: { id: '33333333-3333-4333-8333-333333333333', name: 'Other' },
    }, {});

    expect(resp.success).toBe(false);
  });

  it('lists environments out of the envelope', async () => {
    const { route } = await ready();
    routes['/api/environments'] = () => ok([ENVIRONMENT]);

    const resp = await route({ action: 'GET_ENVIRONMENTS' }, {});
    expect(resp.success).toBe(true);
    expect(resp.environments).toEqual([ENVIRONMENT]);

    const call = requests.find((r) => r.url.endsWith('/api/environments'));
    expect(call.init.headers.Authorization).toMatch(/^Bearer \S+$/);
  });
});

describe('uploading a recording', () => {
  async function recordAndUpload(route, msg = { action: 'UPLOAD_RECORDING', name: 'Test run' }) {
    await route(START, {});
    await route({
      action: 'RECORD_EVENT',
      event: { type: 'click', selector: '#save', label: 'Save', role: 'button', text: 'Save', meta: {} },
    }, {});
    await route({ action: 'STOP_RECORDING' }, {});
    return route(msg, {});
  }

  it('posts to the Oracle recordings route with a stringified stepsJson', async () => {
    const { route } = await ready();
    routes['/api/oracle/recordings'] = () => ok({ id: 'rec-1', name: 'Test run' });

    const resp = await recordAndUpload(route);
    expect(resp.success).toBe(true);
    expect(resp.recording.id).toBe('rec-1');

    // `/api/oracle/recordings`, not `/api/recordings` — the latter is a 404.
    const upload = requests.find((r) => r.url.endsWith('/api/oracle/recordings'));
    expect(upload).toBeDefined();
    expect(upload.init.headers.Authorization).toMatch(/^Bearer \S+$/);

    const body = JSON.parse(upload.init.body);
    expect(body.environmentId).toBe(ENVIRONMENT.id);
    expect(body.name).toBe('Test run');

    // A STRING. RecordingService calls .toString() on this value, so an array
    // would be persisted as Java's `[{action=click}]` behind a 200 response.
    expect(typeof body.stepsJson).toBe('string');

    // And it carries the schema ENVELOPE, not a bare array. RecordingService
    // keeps only environmentId/stepsJson/name/description, so this string is the
    // only place a version marker can survive — without it a stored recording
    // cannot be identified later, which is how the existing corpus ended up with
    // three undocumented dialects.
    const envelope = JSON.parse(body.stepsJson);
    expect(envelope.schemaVersion).toBe(SCHEMA_VERSION);
    expect(Array.isArray(envelope.actions)).toBe(true);
    expect(envelope.actions.length).toBeGreaterThan(0);
    expect(typeof envelope.recordedAt).toBe('string');
  });

  it('names no owner — tenant and creator come from the JWT', async () => {
    const { route } = await ready();
    routes['/api/oracle/recordings'] = () => ok({ id: 'rec-1' });

    await recordAndUpload(route);
    const body = JSON.parse(requests.find((r) => r.url.endsWith('/api/oracle/recordings')).init.body);

    expect(body.tenantId).toBeUndefined();
    expect(body.createdBy).toBeUndefined();
    expect(body.customerId).toBeUndefined();
    expect(body.userId).toBeUndefined();
  });

  it('refuses to upload without a token', async () => {
    const { createRouter } = await loadModules();
    const route = createRouter(PATCHES);

    const resp = await route({ action: 'UPLOAD_RECORDING', name: 'Test run' }, {});
    expect(resp.success).toBe(false);
    expect(resp.unauthenticated).toBe(true);
  });

  it('does NOT sign the user out on a 403 from the roles check', async () => {
    // A VIEWER has a perfectly good session and simply cannot save. Signing
    // them out would look like an expiry and send them back to be refused
    // identically.
    const { route, store } = await ready();
    routes['/api/oracle/recordings'] = () =>
      fail(403, 'ACCESS_DENIED', 'You do not have permission to perform this action');

    const resp = await recordAndUpload(route);

    expect(resp.success).toBe(false);
    expect(resp.unauthenticated).toBeUndefined();
    expect(resp.error).toContain('permission');
    expect(store.getToken()).not.toBeNull();
  });

  it('does sign the user out on a 401', async () => {
    const { route, store } = await ready();
    routes['/api/oracle/recordings'] = () => fail(401, 'Invalid or missing authentication token');

    const resp = await recordAndUpload(route);

    expect(resp.unauthenticated).toBe(true);
    expect(store.getToken()).toBeNull();
  });

  it('reports the server\'s rejection sentence', async () => {
    const { route } = await ready();
    routes['/api/oracle/recordings'] = () => fail(400, 'stepsJson is required');

    const resp = await recordAndUpload(route);
    expect(resp.error).toBe('stepsJson is required');
  });
});
