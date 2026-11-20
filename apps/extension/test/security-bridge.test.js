/**
 * security-bridge.test.js — REC-SEC: Content Bridge Security Hardening regression suite.
 *
 * Verifies:
 * 1. isPrivilegedExtensionSender strictly fails closed for absent/empty/malformed/foreign senders
 *    and requires valid runtime ID and extension UI origin.
 * 2. Content scripts cannot invoke privileged UI management actions (Allowlist enforcement).
 * 3. Sanitized content status isolation: GET_STATUS and GET_CAPTURE_ACTIVE never leak events, steps,
 *    actions, or code to content scripts.
 * 4. Active/registered-tab gate: unregistered tabs are rejected for state mutations AND query actions
 *    (RECORD_EVENT, PATCH_CONTEXT_UPDATE, PAUSE, RESUME, STOP, GET_STATUS, GET_CAPTURE_ACTIVE, PING).
 * 5. Content scripts receiving STOP_RECORDING receive strictly sanitized outcome ({ success, eventCount }),
 *    never leaking generated code, steps, or actions.
 * 6. Stopped-state GET_STATUS is scoped strictly to authorized callers; unregistered tabs receive inactive state.
 * 7. Comprehensive matrix of absent/null/empty/foreign/no-tab/malformed tabs across all allowlisted actions
 *    proves zero state mutations and zero leaked payloads.
 * 8. Dual-entrypoint verification: both apps/extension and packages/recorder-core content scripts eliminate launch relays.
 * 9. Behavioral built-bundle execution: dist/content.js executed in JSDOM ignores hostile launches and preserves ping/pong.
 * 10. End-to-end navigation reactivation lifecycle preserves event counts on active tab and rejects foreign tabs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createRouter,
  isPrivilegedExtensionSender,
  CONTENT_SCRIPT_ALLOWED_ACTIONS,
} from '../src/core/background/router.js';
import * as session from '../src/core/background/session.js';
import { bus } from '@flowtrace/recorder-core';

const EXTENSION_ID = 'ijbehkijmihjnhbmbdmoglbbajbkadbd';
const ACTIVE_TAB_ID = 42;
const UNREGISTERED_TAB_ID = 999;
const PRIVILEGED_UI_SENDER = {
  url: `chrome-extension://${EXTENSION_ID}/popup.html`,
  origin: `chrome-extension://${EXTENSION_ID}`,
  id: EXTENSION_ID,
};
const AUTHORIZED_ACTIVE_TAB_SENDER = {
  id: EXTENSION_ID,
  tab: { id: ACTIVE_TAB_ID },
  url: 'https://erp.example.com/app',
};

function installMockChrome(extId = EXTENSION_ID) {
  const store = {};
  globalThis.chrome = {
    runtime: {
      id: extId,
      lastError: null,
      sendMessage: vi.fn(),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    storage: {
      local: {
        get: async (keys) => {
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of wanted) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (items) => { Object.assign(store, items); },
        remove: async (k) => { delete store[k]; },
      },
    },
    scripting: { executeScript: async () => [] },
    tabs: {
      sendMessage: async () => ({}),
      get: async (id) => ({ id, url: 'https://erp.example.com/app', status: 'complete' }),
    },
  };
  return store;
}

describe('REC-SEC: Fail-Closed Extension Sender Authorization', () => {
  beforeEach(() => {
    installMockChrome(EXTENSION_ID);
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('strictly fails closed for absent, null, undefined, or empty sender', () => {
    expect(isPrivilegedExtensionSender(undefined)).toBe(false);
    expect(isPrivilegedExtensionSender(null)).toBe(false);
    expect(isPrivilegedExtensionSender({})).toBe(false);
    expect(isPrivilegedExtensionSender('invalid')).toBe(false);
  });

  it('strictly fails closed when runtime ID is missing or empty', () => {
    globalThis.chrome.runtime.id = undefined;
    expect(isPrivilegedExtensionSender({
      url: `chrome-extension://${EXTENSION_ID}/popup.html`,
    })).toBe(false);

    globalThis.chrome.runtime.id = '';
    expect(isPrivilegedExtensionSender({
      url: `chrome-extension://${EXTENSION_ID}/popup.html`,
    })).toBe(false);
  });

  it('authorizes UI sender strictly matching THIS extension ID and extension origin/URL', () => {
    expect(isPrivilegedExtensionSender({
      url: `chrome-extension://${EXTENSION_ID}/popup.html`,
      id: EXTENSION_ID,
    })).toBe(true);

    expect(isPrivilegedExtensionSender({
      origin: `chrome-extension://${EXTENSION_ID}`,
      id: EXTENSION_ID,
    })).toBe(true);

    expect(isPrivilegedExtensionSender({
      url: `chrome-extension://${EXTENSION_ID}/popup.html`,
    })).toBe(true);

    // Bare ID without extension URL or origin fails closed
    expect(isPrivilegedExtensionSender({
      id: EXTENSION_ID,
    })).toBe(false);
  });

  it('rejects sender with a DIFFERENT extension ID as unprivileged (fail closed)', () => {
    const hostileExtId = 'fakeextensionidfakeextensionidfa';
    expect(isPrivilegedExtensionSender({
      url: `chrome-extension://${hostileExtId}/exploit.html`,
    })).toBe(false);

    expect(isPrivilegedExtensionSender({
      origin: `chrome-extension://${hostileExtId}`,
    })).toBe(false);

    expect(isPrivilegedExtensionSender({
      id: hostileExtId,
    })).toBe(false);
  });

  it('rejects content scripts injected into web page tabs as unprivileged', () => {
    expect(isPrivilegedExtensionSender({
      tab: { id: ACTIVE_TAB_ID },
      url: 'https://erp.example.com/workspace',
    })).toBe(false);

    expect(isPrivilegedExtensionSender({
      tab: { id: ACTIVE_TAB_ID },
      origin: 'https://erp.example.com',
    })).toBe(false);
  });

  it('rejects external web origins and URLs as unprivileged', () => {
    expect(isPrivilegedExtensionSender({
      url: 'https://attacker.example.com/login',
    })).toBe(false);

    expect(isPrivilegedExtensionSender({
      origin: 'https://attacker.example.com',
    })).toBe(false);
  });
});

describe('REC-SEC: Content Script Allowlist & Privileged Boundary', () => {
  let router;
  const mockPatches = {
    getPatch: () => ({ id: 'generic', name: 'Generic', postProcess: (e) => e }),
    hasPatch: (id) => id === 'generic',
    listPatches: () => [{ id: 'generic', name: 'Generic' }],
  };

  beforeEach(async () => {
    installMockChrome(EXTENSION_ID);
    await session.clear();
    router = createRouter(mockPatches);
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('strictly blocks content scripts from executing privileged management actions', async () => {
    const restrictedActions = [
      'PLATFORM_LAUNCH_SESSION',
      'START_RECORDING',
      'UPLOAD_RECORDING',
      'AUTH_DEV_BYPASS',
      'AUTH_SIGN_IN',
      'AUTH_SIGN_OUT',
      'AUTH_STATUS',
      'AUTH_REVALIDATE',
      'GET_SETTINGS',
      'SET_SETTINGS',
      'GET_ENVIRONMENTS',
      'GET_ENVIRONMENT',
      'SET_ENVIRONMENT',
      'GET_PATCHES',
      'SET_PATCH',
      'CLEAR_RECORDING',
      'DELETE_STEP',
      'COMPILE_CODE',
      'PING_EXTENSION',
    ];

    for (const action of restrictedActions) {
      const res = await router({ action }, AUTHORIZED_ACTIVE_TAB_SENDER);
      expect(res.success).toBe(false);
      expect(res.error).toBe(`Action '${action}' is restricted to extension UI.`);
    }
  });

  it('allows privileged extension UI to invoke management actions', async () => {
    const res = await router({ action: 'GET_SETTINGS' }, PRIVILEGED_UI_SENDER);
    expect(res).toHaveProperty('apiBase');
  });

  it('rejects absent/empty sender attempting privileged actions (fail closed)', async () => {
    const res = await router({ action: 'CLEAR_RECORDING' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toBe("Action 'CLEAR_RECORDING' is restricted to extension UI.");
  });
});

describe('REC-SEC: Sanitized Content Script Status & State Isolation', () => {
  let router;
  const mockPatches = {
    getPatch: () => ({ id: 'generic', name: 'Generic', postProcess: (e) => e }),
    hasPatch: (id) => id === 'generic',
    listPatches: () => [{ id: 'generic', name: 'Generic' }],
  };

  beforeEach(async () => {
    installMockChrome(EXTENSION_ID);
    await session.clear();
    router = createRouter(mockPatches);

    // Populate active session with sensitive recorded data
    const s = session.get();
    s.isRecording = true;
    s.isPaused = false;
    s.patchId = 'generic';
    s.activeTabId = ACTIVE_TAB_ID;
    s.sourceUrl = 'https://erp.example.com/page';
    s.events = [
      { type: 'click', label: 'Submit Button', selector: '#submit' },
      { type: 'fill', label: 'Password', value: 'secret123' },
    ];
    s.steps = [{ name: 'Fill Password', action: 'fill' }];
    s.actions = [{ kind: 'click' }];
    s.generatedCode = 'await page.fill("#pass", "secret");';
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('sanitizes GET_STATUS for active content scripts — returns ONLY minimal reactivation state', async () => {
    const res = await router({ action: 'GET_STATUS' }, AUTHORIZED_ACTIVE_TAB_SENDER);

    expect(res.session).toBeDefined();
    expect(res.session.isRecording).toBe(true);
    expect(res.session.isPaused).toBe(false);
    expect(res.session.patchId).toBe('generic');
    expect(res.session.eventCount).toBe(2);

    // Must NEVER leak full recorded data or code to content scripts
    expect(res.session.events).toBeUndefined();
    expect(res.session.steps).toBeUndefined();
    expect(res.session.actions).toBeUndefined();
    expect(res.session.generatedCode).toBeUndefined();
    expect(res.session.sourceUrl).toBeUndefined();
    expect(res.session.startedAt).toBeUndefined();
  });

  it('provides full session forTransport() to privileged extension UI', async () => {
    const res = await router({ action: 'GET_STATUS' }, PRIVILEGED_UI_SENDER);
    expect(res.session.isRecording).toBe(true);
    expect(res.session.events).toHaveLength(2);
    expect(res.session.steps).toHaveLength(1);
    expect(res.session.actions).toHaveLength(1);
    expect(res.session.generatedCode).toBe('await page.fill("#pass", "secret");');
  });

  it('sanitizes STOP_RECORDING response for content scripts — no code or steps leaked', async () => {
    const res = await router({ action: 'STOP_RECORDING' }, AUTHORIZED_ACTIVE_TAB_SENDER);

    expect(res.success).toBe(true);
    expect(res.eventCount).toBe(2);

    // Generated code and steps MUST NOT be returned to the content script
    expect(res.generatedCode).toBeUndefined();
    expect(res.steps).toBeUndefined();
    expect(res.actions).toBeUndefined();
  });

  it('returns full compiled code and steps to privileged extension UI on STOP_RECORDING', async () => {
    session.get().isRecording = true;
    const res = await router({ action: 'STOP_RECORDING' }, PRIVILEGED_UI_SENDER);

    expect(res.success).toBe(true);
    expect(res.eventCount).toBe(2);
    expect(res.generatedCode).toBeDefined();
    expect(res.steps).toBeDefined();
  });
});

describe('REC-SEC: Stopped-State Query Scoping & Tab Authorization', () => {
  let router;
  const mockPatches = {
    getPatch: () => ({ id: 'oracle', name: 'Oracle Fusion', postProcess: (e) => e }),
    hasPatch: (id) => id === 'oracle',
    listPatches: () => [{ id: 'oracle', name: 'Oracle Fusion' }],
  };

  beforeEach(async () => {
    installMockChrome(EXTENSION_ID);
    await session.clear();
    router = createRouter(mockPatches);

    // Session has been stopped, but previous recording residue exists
    const s = session.get();
    s.isRecording = false;
    s.isPaused = false;
    s.patchId = 'oracle';
    s.activeTabId = ACTIVE_TAB_ID;
    s.events = [{ type: 'click', label: 'E1' }, { type: 'click', label: 'E2' }];
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('denies prior session information to unauthorized/unregistered tabs after recording is stopped', async () => {
    const untrustedSender = {
      id: EXTENSION_ID,
      tab: { id: UNREGISTERED_TAB_ID },
      url: 'https://attacker.example.com',
    };

    const statusResp = await router({ action: 'GET_STATUS' }, untrustedSender);
    expect(statusResp.session.isRecording).toBe(false);
    expect(statusResp.session.patchId).toBeNull();
    expect(statusResp.session.eventCount).toBe(0);

    const captureResp = await router({ action: 'GET_CAPTURE_ACTIVE' }, untrustedSender);
    expect(captureResp.session.isRecording).toBe(false);
    expect(captureResp.session.patchId).toBeNull();
    expect(captureResp.session.eventCount).toBe(0);
  });

  it('provides full transport to privileged UI even after stop', async () => {
    const statusResp = await router({ action: 'GET_STATUS' }, PRIVILEGED_UI_SENDER);
    expect(statusResp.session.isRecording).toBe(false);
    expect(statusResp.session.events).toHaveLength(2);
    expect(statusResp.session.patchId).toBe('oracle');
  });
});

describe('REC-SEC: Comprehensive Sender Matrix Fail-Closed Enforcement', () => {
  let router;
  const mockPatches = {
    getPatch: () => ({ id: 'generic', name: 'Generic', postProcess: (e) => e }),
    hasPatch: (id) => id === 'generic',
    listPatches: () => [{ id: 'generic', name: 'Generic' }],
  };

  const INVALID_SENDERS = [
    { label: 'undefined', sender: undefined },
    { label: 'null', sender: null },
    { label: 'empty object {}', sender: {} },
    { label: 'foreign extension ID', sender: { id: 'foreignidforeignidforeignidfore' } },
    { label: 'external web URL', sender: { url: 'https://attacker.example.com' } },
    { label: 'external origin', sender: { origin: 'https://attacker.example.com' } },
    { label: 'null tab', sender: { id: EXTENSION_ID, tab: null } },
    { label: 'empty tab {}', sender: { id: EXTENSION_ID, tab: {} } },
    { label: 'non-numeric tab id', sender: { id: EXTENSION_ID, tab: { id: '42' } } },
    { label: 'unregistered tab 999', sender: { id: EXTENSION_ID, tab: { id: UNREGISTERED_TAB_ID } } },
  ];

  beforeEach(async () => {
    installMockChrome(EXTENSION_ID);
    await session.clear();
    router = createRouter(mockPatches);

    const s = session.get();
    s.isRecording = true;
    s.isPaused = false;
    s.patchId = 'generic';
    s.activeTabId = ACTIVE_TAB_ID;
    s.events = [{ type: 'click', label: 'E1' }];
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  for (const { label, sender } of INVALID_SENDERS) {
    it(`rejects PAUSE_RECORDING and prevents state mutation for: ${label}`, async () => {
      const resp = await router({ action: 'PAUSE_RECORDING' }, sender);
      expect(resp.success).toBe(false);
      expect(session.get().isPaused).toBe(false);
    });

    it(`rejects RESUME_RECORDING and prevents state mutation for: ${label}`, async () => {
      session.get().isPaused = true;
      const resp = await router({ action: 'RESUME_RECORDING' }, sender);
      expect(resp.success).toBe(false);
      expect(session.get().isPaused).toBe(true);
    });

    it(`rejects STOP_RECORDING and prevents stopping for: ${label}`, async () => {
      const resp = await router({ action: 'STOP_RECORDING' }, sender);
      expect(resp.success).toBe(false);
      expect(session.get().isRecording).toBe(true);
    });

    it(`rejects RECORD_EVENT and prevents event append for: ${label}`, async () => {
      const resp = await router({ action: 'RECORD_EVENT', event: { type: 'click', label: 'Bad' } }, sender);
      expect(resp.accepted).toBe(false);
      expect(session.get().events).toHaveLength(1);
    });

    it(`rejects PATCH_CONTEXT_UPDATE and prevents mutation for: ${label}`, async () => {
      const resp = await router({ action: 'PATCH_CONTEXT_UPDATE', context: { poisoned: true } }, sender);
      expect(resp.ok).toBe(false);
      expect(session.get().patchContext?.poisoned).toBeUndefined();
    });

    it(`denies live status on GET_STATUS and returns zero count for: ${label}`, async () => {
      const resp = await router({ action: 'GET_STATUS' }, sender);
      expect(resp.session.isRecording).toBe(false);
      expect(resp.session.eventCount).toBe(0);
      expect(resp.session.events).toBeUndefined();
    });

    it(`denies live status on GET_CAPTURE_ACTIVE for: ${label}`, async () => {
      const resp = await router({ action: 'GET_CAPTURE_ACTIVE' }, sender);
      expect(resp.session.isRecording).toBe(false);
      expect(resp.session.eventCount).toBe(0);
    });

    it(`denies live status on PING for: ${label}`, async () => {
      const resp = await router({ action: 'PING' }, sender);
      expect(resp.ok).toBe(false);
    });
  }
});

describe('REC-SEC: Dual Content Script Entrypoints & Bridge Relay Elimination', () => {
  beforeEach(() => {
    vi.resetModules();
    installMockChrome(EXTENSION_ID);
    window.__flowtraceRecorderLoaded = false;
  });

  afterEach(() => {
    delete globalThis.chrome;
    delete window.__flowtraceRecorderLoaded;
  });

  it('eliminates launch relay in apps/extension entrypoint and rejects hostile action overrides', async () => {
    await import('../src/core/content/index.js');

    window.postMessage({
      type: '__FLOWTRACE_PLATFORM_LAUNCH__',
      payload: { action: 'CLEAR_RECORDING', targetUrl: 'https://attacker.example.com' },
    }, '*');

    await new Promise((r) => setTimeout(r, 50));

    const calls = chrome.runtime.sendMessage.mock.calls;
    expect(calls.filter((a) => a[0]?.action === 'PLATFORM_LAUNCH_SESSION')).toHaveLength(0);
    expect(calls.filter((a) => a[0]?.action === 'CLEAR_RECORDING')).toHaveLength(0);
  });

  it('eliminates launch relay in packages/recorder-core entrypoint', async () => {
    await import('@flowtrace/recorder-core');

    window.postMessage({
      type: '__FLOWTRACE_PLATFORM_LAUNCH__',
      payload: { action: 'START_RECORDING', targetUrl: 'https://attacker.example.com' },
    }, '*');

    await new Promise((r) => setTimeout(r, 50));

    const calls = chrome.runtime.sendMessage.mock.calls;
    expect(calls.filter((a) => a[0]?.action === 'PLATFORM_LAUNCH_SESSION')).toHaveLength(0);
    expect(calls.filter((a) => a[0]?.action === 'START_RECORDING')).toHaveLength(0);
  });

  it('retains harmless presence detection ping/pong across window bridge', async () => {
    await import('../src/core/content/index.js');

    const receivedMessages = [];
    const listener = (event) => {
      if (event.data?.type === '__FLOWTRACE_PLATFORM_PONG__') {
        receivedMessages.push(event.data);
      }
    };
    window.addEventListener('message', listener);

    window.postMessage({ type: '__FLOWTRACE_PLATFORM_PING__' }, '*');

    await new Promise((r) => setTimeout(r, 50));
    window.removeEventListener('message', listener);

    expect(receivedMessages.length).toBeGreaterThan(0);
    expect(receivedMessages[0].installed).toBe(true);
    expect(receivedMessages[0].version).toBe('1.0.0');
    expect(receivedMessages[0].recording).toBe(false);
  });
});

describe('REC-SEC: Behavioral Built-Bundle Verification (dist/content.js & dist/background.js)', () => {
  it('dist/content.js executed behaviorally in JSDOM ignores __FLOWTRACE_PLATFORM_LAUNCH__', async () => {
    installMockChrome(EXTENSION_ID);
    window.__flowtraceRecorderLoaded = false;

    // Load and execute the actual built dist/content.js in current window
    const contentDistPath = resolve(__dirname, '../dist/content.js');
    const contentBundleCode = readFileSync(contentDistPath, 'utf8');

    // Execute in current JSDOM environment
    const evalScript = new Function(contentBundleCode);
    evalScript();

    // Dispatch hostile launch payload via window.postMessage
    window.postMessage({
      type: '__FLOWTRACE_PLATFORM_LAUNCH__',
      payload: { action: 'START_RECORDING', targetUrl: 'https://malicious.example.com' },
    }, '*');

    await new Promise((r) => setTimeout(r, 50));

    // Verify built bundle made zero sendMessage calls for launch or start
    const calls = chrome.runtime.sendMessage.mock.calls;
    expect(calls.filter((a) => a[0]?.action === 'PLATFORM_LAUNCH_SESSION')).toHaveLength(0);
    expect(calls.filter((a) => a[0]?.action === 'START_RECORDING')).toHaveLength(0);
  });

  it('dist/content.js executed behaviorally in JSDOM answers presence ping', async () => {
    installMockChrome(EXTENSION_ID);
    window.__flowtraceRecorderLoaded = false;

    const contentDistPath = resolve(__dirname, '../dist/content.js');
    const contentBundleCode = readFileSync(contentDistPath, 'utf8');
    new Function(contentBundleCode)();

    const receivedMessages = [];
    const listener = (event) => {
      if (event.data?.type === '__FLOWTRACE_PLATFORM_PONG__') {
        receivedMessages.push(event.data);
      }
    };
    window.addEventListener('message', listener);

    window.postMessage({ type: '__FLOWTRACE_PLATFORM_PING__' }, '*');

    await new Promise((r) => setTimeout(r, 50));
    window.removeEventListener('message', listener);

    expect(receivedMessages.length).toBeGreaterThan(0);
    expect(receivedMessages[0].installed).toBe(true);
  });

  it('dist/content.js static audit: contains zero occurrences of __FLOWTRACE_PLATFORM_LAUNCH__', () => {
    const contentDistPath = resolve(__dirname, '../dist/content.js');
    const contentCode = readFileSync(contentDistPath, 'utf8');

    expect(contentCode).not.toContain('__FLOWTRACE_PLATFORM_LAUNCH__');
    expect(contentCode).toContain('__FLOWTRACE_PLATFORM_PING__');
    expect(contentCode).toContain('__FLOWTRACE_PLATFORM_PONG__');
  });

  it('dist/background.js static audit: includes fail-closed sender check and allowlist', () => {
    const bgDistPath = resolve(__dirname, '../dist/background.js');
    const bgCode = readFileSync(bgDistPath, 'utf8');

    expect(bgCode).toContain('restricted to extension UI');
    expect(bgCode).toContain('RECORD_EVENT');
    expect(bgCode).toContain('GET_CAPTURE_ACTIVE');
  });
});

describe('REC-SEC: End-to-End Navigation Reactivation Lifecycle', () => {
  let router;
  const mockPatches = {
    getPatch: () => ({ id: 'oracle', name: 'Oracle Fusion', postProcess: (e) => e }),
    hasPatch: (id) => id === 'oracle',
    listPatches: () => [{ id: 'oracle', name: 'Oracle Fusion' }],
  };

  beforeEach(async () => {
    installMockChrome(EXTENSION_ID);
    await session.clear();
    router = createRouter(mockPatches);

    // Active recording with 5 recorded events on active tab 42
    const s = session.get();
    s.isRecording = true;
    s.isPaused = false;
    s.patchId = 'oracle';
    s.activeTabId = ACTIVE_TAB_ID;
    s.events = [
      { type: 'click', label: 'E1' },
      { type: 'click', label: 'E2' },
      { type: 'click', label: 'E3' },
      { type: 'click', label: 'E4' },
      { type: 'click', label: 'E5' },
    ];
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('preserves session continuity across navigation on active tab and resumes event counter', async () => {
    // 1. Navigation occurs on active tab 42: content script asks for status
    const navSender = { id: EXTENSION_ID, tab: { id: ACTIVE_TAB_ID }, url: 'https://erp.example.com/po/step2' };
    const statusResp = await router({ action: 'GET_STATUS' }, navSender);

    expect(statusResp.session.isRecording).toBe(true);
    expect(statusResp.session.eventCount).toBe(5);
    expect(statusResp.session.patchId).toBe('oracle');

    // 2. Resume session counter in bus with received count
    const epoch = bus.resumeSession(statusResp.session.eventCount);
    expect(bus.isRecording()).toBe(true);
    expect(epoch).toBeGreaterThan(0);

    // 3. New user interaction on the navigated page emits 6th event
    const newEvent = { type: 'fill', label: 'Quantity', value: '10' };
    const recordResp = await router({ action: 'RECORD_EVENT', event: newEvent }, navSender);

    expect(recordResp.accepted).toBe(true);
    expect(recordResp.totalEvents).toBe(6);
    expect(session.get().events).toHaveLength(6);
  });

  it('prevents foreign tabs from reactivating capture during an ongoing recording', async () => {
    const foreignSender = { id: EXTENSION_ID, tab: { id: UNREGISTERED_TAB_ID }, url: 'https://news.example.com' };
    const statusResp = await router({ action: 'GET_STATUS' }, foreignSender);

    expect(statusResp.session.isRecording).toBe(false);
    expect(statusResp.session.eventCount).toBe(0);

    // Recording on active tab remains undisturbed
    expect(session.get().events).toHaveLength(5);
  });
});
