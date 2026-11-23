/**
 * launch-intent.test.js — Characterization and security test suite for FlowTrace
 * LaunchIntent external message handler and capability handshake [REC-2 / TRACE-93].
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let createExternalRouter;
let createRouter;
let session;
let patches;
let uploadRecording;
let FlowTraceDestination;

const EXT_ID = 'ijbehkijmihjnhbmbdmoglbbajbkadbd';
const VALID_COCKPIT_ORIGIN = 'http://localhost:3200';
const VALID_EXTERNAL_SENDER = { origin: VALID_COCKPIT_ORIGIN, url: `${VALID_COCKPIT_ORIGIN}/recordings` };

function installChrome() {
  const store = {};
  const tabsList = [];
  let tabIdCounter = 10;

  globalThis.chrome = {
    runtime: { id: EXT_ID },
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
    scripting: {
      executeScript: vi.fn(async () => []),
    },
    tabs: {
      sendMessage: vi.fn(async (tabId, msg) => {
        if (msg?.action === 'ACTIVATE_RECORDING') {
          return { ok: true };
        }
        return {};
      }),
      create: vi.fn(async ({ url }) => {
        const tab = { id: ++tabIdCounter, url, status: 'complete' };
        tabsList.push(tab);
        return tab;
      }),
      remove: vi.fn(async (id) => {
        const idx = tabsList.findIndex((t) => t.id === id);
        if (idx !== -1) tabsList.splice(idx, 1);
      }),
      get: vi.fn(async (id) => tabsList.find((t) => t.id === id) || { id, url: 'about:blank', status: 'complete' }),
      query: vi.fn(async () => tabsList),
      update: vi.fn(async (id, updateInfo) => ({ id, ...updateInfo })),
      onUpdated: {
        addListener: (fn) => { setTimeout(() => fn(tabIdCounter, { status: 'complete' }), 0); },
        removeListener: () => {},
      },
    },
  };
  return { store, tabsList };
}

describe('REC-2 / TRACE-93: FlowTrace Extension LaunchIntent Bridge', () => {
  beforeEach(async () => {
    vi.resetModules();
    installChrome();

    ({ createExternalRouter, createRouter } = await import('../src/core/background/router.js'));
    session = await import('../src/core/background/session.js');
    ({ uploadRecording } = await import('../src/core/background/upload.js'));
    patches = await import('@flowtrace/recorder-core');
    ({ FlowTraceDestination } = await import('@flowtrace/recorder-core'));

    await session.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Capability Handshake (PING_EXTENSION)', () => {
    it('returns explicit capabilities including launch_intent_v1', async () => {
      const router = createExternalRouter(patches);
      const res = await router({ action: 'PING_EXTENSION' }, VALID_EXTERNAL_SENDER);

      expect(res.success).toBe(true);
      expect(res.installed).toBe(true);
      expect(res.version).toBe('1.0.0');
      expect(res.isRecording).toBe(false);
      expect(Array.isArray(res.capabilities)).toBe(true);
      expect(res.capabilities).toContain('launch_intent_v1');
    });

    it('rejects PING_EXTENSION from unauthorized external origin', async () => {
      const router = createExternalRouter(patches);
      const res = await router({ action: 'PING_EXTENSION' }, { origin: 'https://attacker.example.com' });

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/unauthorized/i);
    });
  });

  describe('FLOWTRACE_LAUNCH_INTENT Security & Input Validation', () => {
    it('rejects external callers without matching origin in allowlist', async () => {
      const router = createExternalRouter(patches);
      const res = await router(
        { action: 'FLOWTRACE_LAUNCH_INTENT', intentId: 'abc', token: 'tok', signedEnvelope: 'env' },
        { origin: 'https://evil.site.com' },
      );

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/unauthorized/i);
    });

    it('rejects missing or malformed intent credentials', async () => {
      const router = createExternalRouter(patches);

      const missingToken = await router(
        { action: 'FLOWTRACE_LAUNCH_INTENT', intentId: '11111111-1111-4111-8111-111111111111', signedEnvelope: 'env' },
        VALID_EXTERNAL_SENDER,
      );
      expect(missingToken.success).toBe(false);
      expect(missingToken.error).toMatch(/missing or invalid launch intent credentials/i);

      const missingEnv = await router(
        { action: 'FLOWTRACE_LAUNCH_INTENT', intentId: '11111111-1111-4111-8111-111111111111', token: 'raw-token' },
        VALID_EXTERNAL_SENDER,
      );
      expect(missingEnv.success).toBe(false);
      expect(missingEnv.error).toMatch(/missing or invalid launch intent credentials/i);
    });

    it('rejects untrusted API base URL to prevent credential exfiltration', async () => {
      const router = createExternalRouter(patches);
      const res = await router(
        {
          action: 'FLOWTRACE_LAUNCH_INTENT',
          intentId: '11111111-1111-4111-8111-111111111111',
          token: 'raw-token',
          signedEnvelope: 'signed-envelope',
          apiBase: 'http://attacker-controlled.site',
        },
        VALID_EXTERNAL_SENDER,
      );

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/untrusted or invalid api base origin/i);
    });

    it('refuses launch if a recording is already active', async () => {
      session.get().isRecording = true;
      const router = createExternalRouter(patches);

      const res = await router(
        {
          action: 'FLOWTRACE_LAUNCH_INTENT',
          intentId: '11111111-1111-4111-8111-111111111111',
          token: 'raw-token',
          signedEnvelope: 'signed-envelope',
        },
        VALID_EXTERNAL_SENDER,
      );

      expect(res.success).toBe(false);
      expect(res.error).toBe('Recording already in progress.');
    });

    it('refuses launch if another launch reservation is held', async () => {
      session.acquireLaunchReservation();
      try {
        const router = createExternalRouter(patches);
        const res = await router(
          {
            action: 'FLOWTRACE_LAUNCH_INTENT',
            intentId: '11111111-1111-4111-8111-111111111111',
            token: 'raw-token',
            signedEnvelope: 'signed-envelope',
          },
          VALID_EXTERNAL_SENDER,
        );

        expect(res.success).toBe(false);
        expect(res.error).toBe('Recording or launch already in progress.');
      } finally {
        session.releaseLaunchReservation();
      }
    });
  });

  describe('FLOWTRACE_LAUNCH_INTENT Claim & Tab Activation', () => {
    it('truthfully handles server rejection on claim failure', async () => {
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 410,
        json: async () => ({
          error: { code: 'INTENT_EXPIRED', message: 'Launch intent claim window has expired.' },
        }),
      }));

      const router = createExternalRouter(patches);
      const res = await router(
        {
          action: 'FLOWTRACE_LAUNCH_INTENT',
          intentId: '11111111-1111-4111-8111-111111111111',
          token: 'expired-token',
          signedEnvelope: 'expired-envelope',
        },
        VALID_EXTERNAL_SENDER,
      );

      expect(res.success).toBe(false);
      expect(res.status).toBe(410);
      expect(res.code).toBe('INTENT_EXPIRED');
      expect(res.error).toBe('Launch intent claim window has expired.');
      expect(session.get().isRecording).toBe(false);
    });

    it('claims intent, provisions target tab, injects scripts, and arms scoped upload context', async () => {
      const claimPayload = {
        intentId: '33333333-3333-4333-8333-333333333333',
        targetUrl: 'https://fusion.oracle.com/fscmUI/faces/FuseWelcome',
        patchId: 'oracle',
        environmentId: '44444444-4444-4444-8444-444444444444',
        uploadToken: 'raw-upload-token-secret-1234',
        signedUploadEnvelope: 'signed.upload.envelope.token',
        uploadExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };

      globalThis.fetch = vi.fn(async (url, init) => {
        expect(url).toContain('/api/v1/recorder/launch-intents/33333333-3333-4333-8333-333333333333/claim');
        const body = JSON.parse(init.body);
        expect(body.token).toBe('raw-claim-token');
        expect(body.signedEnvelope).toBe('signed.claim.envelope');
        return {
          ok: true,
          status: 200,
          json: async () => claimPayload,
        };
      });

      const router = createExternalRouter(patches);
      const res = await router(
        {
          action: 'FLOWTRACE_LAUNCH_INTENT',
          intentId: '33333333-3333-4333-8333-333333333333',
          token: 'raw-claim-token',
          signedEnvelope: 'signed.claim.envelope',
          apiBase: 'http://localhost:3200',
        },
        VALID_EXTERNAL_SENDER,
      );

      expect(res.success).toBe(true);
      expect(res.intentId).toBe('33333333-3333-4333-8333-333333333333');
      expect(res.targetUrl).toBe('https://fusion.oracle.com/fscmUI/faces/FuseWelcome');
      expect(res.environmentId).toBe('44444444-4444-4444-8444-444444444444');

      // Verify active session state
      const currentSession = session.get();
      expect(currentSession.isRecording).toBe(true);
      expect(currentSession.patchId).toBe('oracle');
      expect(currentSession.sourceUrl).toBe('https://fusion.oracle.com/fscmUI/faces/FuseWelcome');
      expect(currentSession.activeTabId).toBeGreaterThan(0);

      // Verify scoped upload context is held in session
      expect(currentSession.uploadContext).toEqual({
        intentId: '33333333-3333-4333-8333-333333333333',
        environmentId: '44444444-4444-4444-8444-444444444444',
        uploadToken: 'raw-upload-token-secret-1234',
        signedUploadEnvelope: 'signed.upload.envelope.token',
        uploadExpiresAt: claimPayload.uploadExpiresAt,
        apiBase: 'http://localhost:3200',
      });

      // Verify script injection was triggered for target tab
      expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { tabId: currentSession.activeTabId, allFrames: true },
          files: ['selector-engine.js', 'content.js'],
        }),
      );
    });

    it('cleans up session, tab, and observers when executeScript injection rejects', async () => {
      const claimPayload = {
        intentId: '55555555-5555-4555-8555-555555555555',
        targetUrl: 'https://restricted.example.com',
        patchId: 'generic',
        environmentId: '44444444-4444-4444-8444-444444444444',
        uploadToken: 'raw-upload-token-secret-1234',
        signedUploadEnvelope: 'signed.upload.envelope.token',
        uploadExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };

      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => claimPayload,
      }));

      // Simulate executeScript rejecting (e.g. restricted chrome:// or policy block)
      chrome.scripting.executeScript.mockRejectedValueOnce(
        new Error('Cannot script restricted origin'),
      );

      const router = createExternalRouter(patches);
      const res = await router(
        {
          action: 'FLOWTRACE_LAUNCH_INTENT',
          intentId: '55555555-5555-4555-8555-555555555555',
          token: 'raw-claim-token',
          signedEnvelope: 'signed.claim.envelope',
          apiBase: 'http://localhost:3200',
        },
        VALID_EXTERNAL_SENDER,
      );

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Failed to activate recording in target tab: Cannot script restricted origin/i);

      // Session must be completely cleared
      const s = session.get();
      expect(s.isRecording).toBe(false);
      expect(s.uploadContext).toBeNull();
      expect(session.isLaunchInProgress()).toBe(false);
      expect(chrome.tabs.remove).toHaveBeenCalled();
    });

    it('cleans up session, tab, and observers when content activation ACK fails or is negative', async () => {
      const claimPayload = {
        intentId: '66666666-6666-4666-8666-666666666666',
        targetUrl: 'https://example.com/app',
        patchId: 'generic',
        environmentId: '44444444-4444-4444-8444-444444444444',
        uploadToken: 'raw-upload-token-secret-1234',
        signedUploadEnvelope: 'signed.upload.envelope.token',
        uploadExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };

      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => claimPayload,
      }));

      // Content script replies with negative ACK or fails
      chrome.tabs.sendMessage.mockResolvedValueOnce({ ok: false });

      const router = createExternalRouter(patches);
      const res = await router(
        {
          action: 'FLOWTRACE_LAUNCH_INTENT',
          intentId: '66666666-6666-4666-8666-666666666666',
          token: 'raw-claim-token',
          signedEnvelope: 'signed.claim.envelope',
          apiBase: 'http://localhost:3200',
        },
        VALID_EXTERNAL_SENDER,
      );

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/activation acknowledgement failed/i);

      const s = session.get();
      expect(s.isRecording).toBe(false);
      expect(s.uploadContext).toBeNull();
      expect(session.isLaunchInProgress()).toBe(false);
      expect(chrome.tabs.remove).toHaveBeenCalled();
    });
  });

  describe('Competing Launch & Reservation Isolation', () => {
    it('refuses START_RECORDING and PLATFORM_LAUNCH_SESSION while launch reservation is held', async () => {
      const internalRouter = createRouter(patches);
      const externalRouter = createExternalRouter(patches);

      // Acquire launch reservation (simulating in-flight intent claim / load)
      expect(session.acquireLaunchReservation()).toBe(true);

      try {
        // 1. Popup / internal START_RECORDING must be rejected
        const startRes = await internalRouter({
          action: 'START_RECORDING',
          tabId: 10,
          tabUrl: 'https://example.com',
        }, { url: `chrome-extension://${EXT_ID}/popup.html`, origin: `chrome-extension://${EXT_ID}` });

        expect(startRes.success).toBe(false);
        expect(startRes.error).toBe('Recording or launch already in progress.');

        // 2. External PLATFORM_LAUNCH_SESSION must be rejected
        const platformRes = await externalRouter({
          action: 'PLATFORM_LAUNCH_SESSION',
          targetUrl: 'https://example.com',
        }, VALID_EXTERNAL_SENDER);

        expect(platformRes.success).toBe(false);
        expect(platformRes.error).toBe('Recording or launch already in progress.');

        // 3. PING_EXTENSION must report isLaunchInProgress: true
        const pingRes = await externalRouter({
          action: 'PING_EXTENSION',
        }, VALID_EXTERNAL_SENDER);

        expect(pingRes.isLaunchInProgress).toBe(true);
      } finally {
        session.releaseLaunchReservation();
      }

      // After release, isLaunchInProgress must be false
      expect(session.isLaunchInProgress()).toBe(false);
    });

    it('proves inverse-order race protection: when legacy PLATFORM_LAUNCH_SESSION is delayed at storage, competing FLOWTRACE_LAUNCH_INTENT is rejected and never claims or creates tab', async () => {
      const externalRouter = createExternalRouter(patches);

      let releaseStorage;
      const storageBlocker = new Promise((resolve) => {
        releaseStorage = resolve;
      });

      // Intercept chrome.storage.local.set to delay completion
      const originalSet = chrome.storage.local.set;
      chrome.storage.local.set = vi.fn(async (items) => {
        await storageBlocker;
        return originalSet(items);
      });

      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      // 1. Initiate legacy PLATFORM_LAUNCH_SESSION (will block at storage.local.set)
      const legacyPromise = externalRouter(
        {
          action: 'PLATFORM_LAUNCH_SESSION',
          targetUrl: 'https://example.com/legacy',
          environment: { id: '00000000-0000-4000-8000-000000000002', name: 'ERP Dev1' },
        },
        VALID_EXTERNAL_SENDER,
      );

      // Give microtasks a turn to enter platformLaunchSession and reach storage
      await new Promise((r) => setTimeout(r, 10));

      // 2. Verify reservation is held immediately before storage finishes
      expect(session.isLaunchInProgress()).toBe(true);

      // 3. Competing FLOWTRACE_LAUNCH_INTENT arrives during the in-flight legacy setup
      const competingRes = await externalRouter(
        {
          action: 'FLOWTRACE_LAUNCH_INTENT',
          intentId: '99999999-9999-4999-8999-999999999999',
          token: 'token',
          signedEnvelope: 'envelope',
          apiBase: 'http://localhost:3200',
        },
        VALID_EXTERNAL_SENDER,
      );

      expect(competingRes.success).toBe(false);
      expect(competingRes.error).toBe('Recording or launch already in progress.');
      expect(mockFetch).not.toHaveBeenCalled(); // Competing intent never claims from backend

      // 4. Release storage to let legacy finish or fail
      releaseStorage();
      await legacyPromise.catch(() => {});

      chrome.storage.local.set = originalSet;
    });
  });

  describe('Scoped Ingress Upload Wiring', () => {
    it('transmits scoped upload headers when session has uploadContext', async () => {
      // Setup active session with uploadContext
      const s = session.get();
      s.isRecording = false;
      s.actions = [
        { action: 'navigate', value: 'https://fusion.oracle.com/home' },
        { action: 'click', selector: '#login-btn' },
      ];
      s.steps = [...s.actions];
      s.uploadContext = {
        intentId: 'intent-uuid-1',
        environmentId: 'env-uuid-2',
        uploadToken: 'secret-upload-token-abc',
        signedUploadEnvelope: 'signed-upload-envelope-jwt',
        uploadExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        apiBase: 'http://localhost:3200',
      };

      let capturedHeaders = null;
      globalThis.fetch = vi.fn(async (url, init) => {
        expect(url).toBe('http://localhost:3200/api/v1/recordings');
        capturedHeaders = init.headers;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: 'rec-uuid-123',
            status: 'saved',
            recording: { id: 'rec-uuid-123' },
          }),
        };
      });

      const res = await uploadRecording({ name: 'Scoped Upload Test' });

      expect(res.success).toBe(true);
      expect(capturedHeaders['x-flowtrace-upload-envelope']).toBe('signed-upload-envelope-jwt');
      expect(capturedHeaders['x-flowtrace-upload-token']).toBe('secret-upload-token-abc');

      // Upload context should be cleared following successful save
      expect(session.get().uploadContext).toBeNull();
    });
  });
});
