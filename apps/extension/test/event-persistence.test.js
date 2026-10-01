/**
 * event-persistence.test.js — no captured interaction may be lost to an
 * MV3 service-worker eviction.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * RECORD_EVENT persisted only every 5th event (`s.events.length % 5 === 0`).
 * Chrome evicts an idle MV3 worker without warning, and `session.ensureLoaded()`
 * restores whatever was last written — so up to FOUR captured interactions
 * vanished, and the restored session carried NO marker that anything was
 * missing. The operator sees a recording that looks complete and is not.
 *
 * That is worse than a recorder that crashes: a crash is visible.
 *
 * ── Why the fix is coalescing and not "persist every time" ──────────────────
 *
 * `persist()` writes the WHOLE session object. Writing it per interaction would
 * queue a full-session write behind every click in a fast burst, which is the
 * cost the original batching existed to avoid. `persistSoon()` marks dirty and
 * schedules one write that absorbs the burst — so no event is ever outside the
 * write that covers it, and a burst still costs one write.
 *
 * These tests assert the PROPERTY (nothing is lost), not the mechanism, so a
 * future change of strategy does not have to rewrite them.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let session;
let createRouter;
let auth;
let settings;
let patches;
let store;

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'shivam',
  email: 'operator@example.com',
  role: 'MEMBER',
  tenantId: 'org_dev_local',
};

const ENVIRONMENT = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Fusion DEV',
  type: 'ORACLE_FUSION',
};

function installChrome() {
  store = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of wanted) if (key in store) out[key] = structuredClone(store[key]);
          return out;
        },
        // structuredClone matters: without it the stored value would alias the
        // live session object and every test would pass regardless of whether
        // a write ever happened.
        set: async (items) => {
          for (const [k, v] of Object.entries(items)) store[k] = structuredClone(v);
        },
        remove: async (key) => { delete store[key]; },
      },
    },
    scripting: { executeScript: async () => [] },
    tabs: {
      sendMessage: async () => ({}),
      create: async () => ({ id: 7, url: 'https://erp.example/home' }),
      get: async () => ({ id: 7, url: 'https://erp.example/home' }),
      query: async () => [{ id: 7 }],
      update: async () => ({ id: 7 }),
      onUpdated: {
        addListener: (fn) => { setTimeout(() => fn(7, { status: 'complete' }), 0); },
        removeListener: () => {},
      },
    },
  };
}

/** What a restored worker would see: only what actually reached storage. */
const persistedEvents = () => store.recorderSession?.events?.length ?? 0;

/**
 * START_RECORDING seeds a `navigate` event from tabUrl (router.js:237), so the
 * stored count is always the captured interactions PLUS that one. Named rather
 * than sprinkled as `+ 1`, because a bare +1 in an assertion is the kind of
 * fudge that later hides a real off-by-one.
 */
const SEEDED_NAVIGATE = 1;

beforeEach(async () => {
  vi.resetModules();
  installChrome();
  globalThis.fetch = async () => { throw new Error('no network in these tests'); };

  ({ createRouter } = await import('../src/core/background/router.js'));
  session = await import('../src/core/background/session.js');
  auth = await import('../src/core/auth/index.js');
  settings = await import('@flowtrace/recorder-core');
  patches = await import('@flowtrace/recorder-core');

  await auth.setSessionToken('a'.repeat(40), USER);
  await settings.setEnvironment(ENVIRONMENT);
});

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.fetch;
});

const route = (msg, sender = {}) => createRouter(patches)(msg, sender);

async function startRecording() {
  const res = await route({
    action: 'START_RECORDING',
    tabId: 7,
    tabUrl: 'https://erp.example/home',
    patchId: 'generic',
  });
  expect(res.success).toBe(true);
}

const clickEvent = (n) => ({
  type: 'click',
  selector: `#btn-${n}`,
  tagName: 'BUTTON',
  timestamp: Date.now() + n,
});

describe('no captured interaction is lost to a worker eviction', () => {
  it('persists a single event — the worst case under the old batching', async () => {
    await startRecording();

    await route({ action: 'RECORD_EVENT', event: clickEvent(1) }, { tab: { id: 7 } });
    // The coalescing window has to elapse. Under the old `% 5` rule this event
    // was never written at all, so no amount of waiting would have saved it.
    await session.flush();

    // >= 1 would be satisfied by the seeded navigate alone, which
    // START_RECORDING persists — so it passed on the BROKEN code. The real
    // claim is that the CAPTURED CLICK reached storage.
    expect(persistedEvents()).toBe(1 + SEEDED_NAVIGATE);
    expect(store.recorderSession.events.at(-1).selector).toBe('#btn-1');
  });

  it('loses nothing when the worker dies after four events', async () => {
    await startRecording();

    // Four is the exact worst case: the old rule wrote at 5, so 1-4 were lost.
    for (let i = 1; i <= 4; i++) {
      await route({ action: 'RECORD_EVENT', event: clickEvent(i) }, { tab: { id: 7 } });
    }
    await session.flush();

    // A restored worker reads storage, not memory. This is what it would see.
    expect(persistedEvents()).toBe(4 + SEEDED_NAVIGATE);
  });

  it('survives a simulated eviction with every event intact', async () => {
    await startRecording();
    for (let i = 1; i <= 7; i++) {
      await route({ action: 'RECORD_EVENT', event: clickEvent(i) }, { tab: { id: 7 } });
    }
    await session.flush();

    // Evict: drop the module's in-memory state entirely and reload from storage,
    // which is what Chrome does to an idle MV3 worker.
    vi.resetModules();
    const revived = await import('../src/core/background/session.js');
    await revived.ensureLoaded();

    const s = revived.get();
    expect(s.events.length).toBe(7 + SEEDED_NAVIGATE);
    expect(s.isRecording).toBe(true);
    // Not merely the count — the actual interactions, in order.
    // The seeded navigate is first; the seven interactions follow, in order.
    expect(s.events.slice(1).map((e) => e.selector)).toEqual([
      '#btn-1', '#btn-2', '#btn-3', '#btn-4', '#btn-5', '#btn-6', '#btn-7',
    ]);
  });

  it('a burst does not cost one storage write per interaction', async () => {
    await startRecording();

    let writes = 0;
    const realSet = globalThis.chrome.storage.local.set;
    globalThis.chrome.storage.local.set = async (items) => { writes++; return realSet(items); };

    for (let i = 1; i <= 10; i++) {
      await route({ action: 'RECORD_EVENT', event: clickEvent(i) }, { tab: { id: 7 } });
    }
    await session.flush();

    // The point of coalescing: ten interactions, far fewer than ten writes.
    // Asserted as a bound rather than an exact number so the strategy can change.
    expect(writes).toBeLessThan(10);
    expect(persistedEvents()).toBe(10 + SEEDED_NAVIGATE);
  });

  it('stopping a recording persists everything captured', async () => {
    await startRecording();
    for (let i = 1; i <= 3; i++) {
      await route({ action: 'RECORD_EVENT', event: clickEvent(i) }, { tab: { id: 7 } });
    }

    // Before stop: an eviction here is the case that matters, because
    // STOP_RECORDING persists unconditionally and would mask a lost event.
    await session.flush();
    expect(persistedEvents()).toBe(3 + SEEDED_NAVIGATE);

    // No explicit flush needed: stop must not depend on the caller remembering.
    await route({ action: 'STOP_RECORDING' });
    expect(persistedEvents()).toBe(3 + SEEDED_NAVIGATE);
    expect(store.recorderSession.isRecording).toBe(false);
  });
});
