/**
 * launch-intent.test.js — Characterization and security test suite for FlowTrace
 * LaunchIntent external message handler and capability handshake [REC-2 / TRACE-93].
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let createExternalRouter;
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
      sendMessage: vi.fn(async () => ({})),
      create: vi.fn(async ({ url }) => {
        const tab = { id: ++tabIdCounter, url, status: 'complete' };
        tabsList.push(tab);
        return tab;
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

    ({ createExternalRouter } = await import('../src/core/background/router.js'));
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
