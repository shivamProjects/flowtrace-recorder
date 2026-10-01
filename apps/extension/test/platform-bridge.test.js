/**
 * platform-bridge.test.js — the two messages the PLATFORM sends, not the popup.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * `PING_EXTENSION` and `PLATFORM_LAUNCH_SESSION` are the extension's entire
 * contract with the platform web app, and NOTHING in this repository sent them.
 * The caller lives in another repo, so both defects below were invisible to
 * every local test and to every run of the extension by hand:
 *
 *   1. `authenticated: auth.isAuthenticated()` was not awaited. A Promise
 *      structured-clones across the message boundary as `{}` — truthy — so a
 *      platform doing `if (ping.authenticated)` was told TRUE for a signed-out
 *      user. Observed live as {"authenticated":{}} before the fix.
 *   2. `platformLaunchSession` returned a hardcoded `success: true` and buried
 *      the real outcome in a sibling `startResult`, discarding three
 *      well-shaped refusals.
 *
 * The second is a DATA-LOSS path. `startRecording`'s own comment says refusing
 * at Start costs a click while refusing at Save costs the whole recording: a
 * caller told `success: true` records the entire flow and loses it at save.
 *
 * These tests drive the REAL router with a fake `chrome` and a fake backend,
 * the same way auth.test.js does — the point is the router's own logic, not the
 * transport.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let createRouter;
let auth;
let settings;
let session;
let patches; // the real registry — createRouter calls patches.hasPatch()

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'shivam',
  email: 'operator@example.com',
  fullName: 'Operator',
  role: 'MEMBER',
  tenantId: 'org_dev_local',
};

const ENVIRONMENT = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Fusion DEV',
  type: 'ORACLE_FUSION',
};

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
    tabs: {
      sendMessage: async () => ({}),
      // The launch path opens a tab and waits for it to finish loading.
      create: async () => ({ id: 7, url: 'https://erp.example/home', status: 'complete' }),
      get: async () => ({ id: 7, url: 'https://erp.example/home', status: 'complete' }),
      query: async () => [{ id: 7, url: 'https://erp.example/home', status: 'complete' }],
      update: async () => ({ id: 7 }),
      // waitForTabComplete() listens for status 'complete' and otherwise falls
      // back to an 8s timeout — longer than vitest's default, which read as a
      // hang. Firing immediately makes the fake behave like a tab that loaded.
      onUpdated: {
        addListener: (fn) => { setTimeout(() => fn(7, { status: 'complete' }), 0); },
        removeListener: () => {},
      },
    },
  };
  return store;
}

beforeEach(async () => {
  vi.resetModules();
  installChrome();
  globalThis.fetch = async () => { throw new Error('no network in these tests'); };

  ({ createRouter } = await import('../src/core/background/router.js'));
  auth = await import('../src/core/auth/index.js');
  settings = await import('@flowtrace/recorder-core');
  session = await import('../src/core/background/session.js');
  patches = await import('@flowtrace/recorder-core');
  await settings.setEnvironment(null);
  await session.reset?.();
});

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.fetch;
});

const route = (msg) => createRouter(patches)(msg, {});

describe('PING_EXTENSION', () => {
  it('reports authenticated as a real boolean, never a Promise', async () => {
    const res = await route({ action: 'PING_EXTENSION' });

    // The defect: an un-awaited Promise arrives as {} — typeof 'object',
    // and truthy. Asserting `=== false` rather than `!res.authenticated`
    // is deliberate: the latter passes on the broken code.
    expect(typeof res.authenticated).toBe('boolean');
    expect(res.authenticated).toBe(false);
    expect(res.installed).toBe(true);
  });

  it('reports true once a session token exists', async () => {
    await auth.setSessionToken('a'.repeat(40), USER);
    const res = await route({ action: 'PING_EXTENSION' });
    expect(res.authenticated).toBe(true);
  });
});

describe('PLATFORM_LAUNCH_SESSION reports what actually happened', () => {
  it('reports FAILURE, not success, when the user is not signed in', async () => {
    const res = await route({
      action: 'PLATFORM_LAUNCH_SESSION',
      targetUrl: 'https://erp.example/home',
    });

    expect(res.success).toBe(false);
    expect(res.unauthenticated).toBe(true);
    // The nested truth and the top-level answer must agree. Disagreement is the
    // whole defect: the caller reads one and the log shows the other.
    expect(res.startResult?.success).toBe(false);
  });

  it('reports environmentRequired rather than a generic failure', async () => {
    await auth.setSessionToken('a'.repeat(40), USER);

    const res = await route({
      action: 'PLATFORM_LAUNCH_SESSION',
      targetUrl: 'https://erp.example/home',
    });

    // This is the data-loss path: told success, the caller records a whole flow
    // and loses it at save because no environment was ever chosen.
    expect(res.success).toBe(false);
    expect(res.environmentRequired).toBe(true);
    expect(String(res.error)).toMatch(/environment/i);
  });

  it('reports success only when recording actually started', async () => {
    await auth.setSessionToken('a'.repeat(40), USER);
    await settings.setEnvironment(ENVIRONMENT);

    const res = await route({
      action: 'PLATFORM_LAUNCH_SESSION',
      targetUrl: 'https://erp.example/home',
    });

    expect(res.startResult?.success).toBe(true);
    expect(res.success).toBe(true);
    expect(res.error).toBeUndefined();
    expect(session.get().isRecording).toBe(true);
  });

  it('never reports success while startResult says otherwise', async () => {
    // The invariant, stated once and independent of which gate refused: the two
    // must never disagree. A future gate added to startRecording is covered by
    // this without anyone remembering to extend the suite.
    for (const setup of [
      async () => {},
      async () => { await auth.setSessionToken('a'.repeat(40), USER); },
    ]) {
      vi.resetModules();
      installChrome();
      ({ createRouter } = await import('../src/core/background/router.js'));
      auth = await import('../src/core/auth/index.js');
      settings = await import('@flowtrace/recorder-core');
      patches = await import('@flowtrace/recorder-core');
      await setup();

      const res = await createRouter(patches)(
        { action: 'PLATFORM_LAUNCH_SESSION', targetUrl: 'https://erp.example/home' },
        {},
      );
      expect(res.success).toBe(res.startResult?.success === true);
    }
  });
});
