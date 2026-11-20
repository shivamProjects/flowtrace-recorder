/**
 * security-bridge.test.js — REC-SEC: Content Bridge Security Hardening regression suite.
 *
 * Verifies:
 * 1. isPrivilegedExtensionSender strictly scopes extension UI to chrome.runtime.id.
 * 2. Content scripts cannot invoke privileged UI actions (Allowlist enforcement).
 * 3. GET_STATUS returns sanitized forContentScript() to content scripts (no events, steps, code).
 * 4. Tab scoping rejects RECORD_EVENT, PATCH_CONTEXT_UPDATE, PAUSE, RESUME, and STOP from unregistered tabs.
 * 5. Window message __FLOWTRACE_PLATFORM_LAUNCH__ relay is eliminated from content scripts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createRouter,
  isPrivilegedExtensionSender,
  CONTENT_SCRIPT_ALLOWED_ACTIONS,
} from '../src/core/background/router.js';
import * as session from '../src/core/background/session.js';

const EXTENSION_ID = 'ijbehkijmihjnhbmbdmoglbbajbkadbd';
const ACTIVE_TAB_ID = 42;
const UNREGISTERED_TAB_ID = 999;

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

describe('REC-SEC: Extension Sender Privileges & Scoping', () => {
  beforeEach(() => {
    installMockChrome(EXTENSION_ID);
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('recognizes internal background or test callers (empty sender) as privileged', () => {
    expect(isPrivilegedExtensionSender(undefined)).toBe(true);
    expect(isPrivilegedExtensionSender(null)).toBe(true);
    expect(isPrivilegedExtensionSender({})).toBe(true);
  });

  it('recognizes UI sender matching THIS extension ID as privileged', () => {
    expect(isPrivilegedExtensionSender({
      url: `chrome-extension://${EXTENSION_ID}/popup.html`,
    })).toBe(true);
    expect(isPrivilegedExtensionSender({
      origin: `chrome-extension://${EXTENSION_ID}`,
    })).toBe(true);
  });

  it('rejects sender with a DIFFERENT extension ID as unprivileged', () => {
    const hostileExtId = 'fakeextensionidfakeextensionidfa';
    expect(isPrivilegedExtensionSender({
      url: `chrome-extension://${hostileExtId}/exploit.html`,
    })).toBe(false);
    expect(isPrivilegedExtensionSender({
      origin: `chrome-extension://${hostileExtId}`,
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

  it('rejects external web origins as unprivileged', () => {
    expect(isPrivilegedExtensionSender({
      url: 'https://attacker.example.com/login',
    })).toBe(false);
    expect(isPrivilegedExtensionSender({
      origin: 'https://attacker.example.com',
    })).toBe(false);
  });
});

describe('REC-SEC: Content Script Allowlist & Privileged UI Boundary', () => {
  let router;
  const mockPatches = {
    getPatch: () => ({ id: 'generic', name: 'Generic', postProcess: (e) => e }),
    hasPatch: (id) => id === 'generic',
    listPatches: () => [{ id: 'generic', name: 'Generic' }],
  };

  const contentSender = {
    tab: { id: ACTIVE_TAB_ID },
    url: 'https://erp.example.com/page',
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
      const res = await router({ action }, contentSender);
      expect(res.success).toBe(false);
      expect(res.error).toBe(`Action '${action}' is restricted to extension UI.`);
    }
  });

  it('allows privileged extension UI to invoke management actions', async () => {
    const privilegedSender = {
      url: `chrome-extension://${EXTENSION_ID}/popup.html`,
    };

    const res = await router({ action: 'GET_SETTINGS' }, privilegedSender);
    expect(res).toHaveProperty('apiBase');
  });
});

describe('REC-SEC: Sanitized Content Script Status & State Isolation', () => {
  let router;
  const mockPatches = {
    getPatch: () => ({ id: 'generic', name: 'Generic', postProcess: (e) => e }),
    hasPatch: (id) => id === 'generic',
    listPatches: () => [{ id: 'generic', name: 'Generic' }],
  };

  const contentSender = {
    tab: { id: ACTIVE_TAB_ID },
    url: 'https://erp.example.com/page',
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

  it('sanitizes GET_STATUS for content scripts — returns ONLY minimal reactivation state', async () => {
    const res = await router({ action: 'GET_STATUS' }, contentSender);

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
    const privilegedSender = {
      url: `chrome-extension://${EXTENSION_ID}/popup.html`,
    };

    const res = await router({ action: 'GET_STATUS' }, privilegedSender);
    expect(res.session.isRecording).toBe(true);
    expect(res.session.events).toHaveLength(2);
    expect(res.session.steps).toHaveLength(1);
    expect(res.session.actions).toHaveLength(1);
    expect(res.session.generatedCode).toBe('await page.fill("#pass", "secret");');
  });

  it('GET_CAPTURE_ACTIVE returns minimal sanitized state to content scripts', async () => {
    const res = await router({ action: 'GET_CAPTURE_ACTIVE' }, contentSender);
    expect(res.session.isRecording).toBe(true);
    expect(res.session.eventCount).toBe(2);
    expect(res.session.events).toBeUndefined();
    expect(res.session.generatedCode).toBeUndefined();
  });
});

describe('REC-SEC: Tab Scoping & Unregistered Tab Rejection', () => {
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

    const s = session.get();
    s.isRecording = true;
    s.isPaused = false;
    s.patchId = 'generic';
    s.activeTabId = ACTIVE_TAB_ID;
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('accepts RECORD_EVENT and PATCH_CONTEXT_UPDATE from the active recording tab', async () => {
    const activeSender = {
      tab: { id: ACTIVE_TAB_ID },
      url: 'https://erp.example.com/page',
    };

    const evtRes = await router({
      action: 'RECORD_EVENT',
      event: { type: 'click', label: 'Primary Nav' },
    }, activeSender);
    expect(evtRes.accepted).toBe(true);
    expect(evtRes.totalEvents).toBe(1);

    const patchRes = await router({
      action: 'PATCH_CONTEXT_UPDATE',
      context: { appState: 'ready' },
    }, activeSender);
    expect(patchRes.ok).toBe(true);
  });

  it('rejects RECORD_EVENT and PATCH_CONTEXT_UPDATE from an unregistered tab', async () => {
    const untrustedSender = {
      tab: { id: UNREGISTERED_TAB_ID },
      url: 'https://attacker.example.com/exploit',
    };

    const evtRes = await router({
      action: 'RECORD_EVENT',
      event: { type: 'click', label: 'Attacker Click' },
    }, untrustedSender);
    expect(evtRes.accepted).toBe(false);
    expect(evtRes.reason).toBe('unrecognized_surface');

    const patchRes = await router({
      action: 'PATCH_CONTEXT_UPDATE',
      context: { fake: true },
    }, untrustedSender);
    expect(patchRes.ok).toBe(false);
    expect(patchRes.reason).toBe('unrecognized_surface');
  });

  it('allows pause, resume, and stop controls from active tab surface', async () => {
    const activeSender = {
      tab: { id: ACTIVE_TAB_ID },
      url: 'https://erp.example.com/page',
    };

    const pauseRes = await router({ action: 'PAUSE_RECORDING' }, activeSender);
    expect(pauseRes.success).toBe(true);
    expect(pauseRes.isPaused).toBe(true);

    const resumeRes = await router({ action: 'RESUME_RECORDING' }, activeSender);
    expect(resumeRes.success).toBe(true);
    expect(resumeRes.isPaused).toBe(false);

    const stopRes = await router({ action: 'STOP_RECORDING' }, activeSender);
    expect(stopRes.success).toBe(true);
    expect(session.get().isRecording).toBe(false);
  });

  it('rejects pause, resume, and stop controls from an unregistered tab', async () => {
    const untrustedSender = {
      tab: { id: UNREGISTERED_TAB_ID },
      url: 'https://attacker.example.com/exploit',
    };

    const pauseRes = await router({ action: 'PAUSE_RECORDING' }, untrustedSender);
    expect(pauseRes.success).toBe(false);
    expect(pauseRes.error).toBe('Unrecognized surface.');

    const resumeRes = await router({ action: 'RESUME_RECORDING' }, untrustedSender);
    expect(resumeRes.success).toBe(false);
    expect(resumeRes.error).toBe('Unrecognized surface.');

    const stopRes = await router({ action: 'STOP_RECORDING' }, untrustedSender);
    expect(stopRes.success).toBe(false);
    expect(stopRes.error).toBe('Unrecognized surface.');
  });
});

describe('REC-SEC: In-Page Content Script Bridge Relay Removal', () => {
  beforeEach(() => {
    vi.resetModules();
    installMockChrome(EXTENSION_ID);
    window.__flowtraceRecorderLoaded = false;
  });

  afterEach(() => {
    delete globalThis.chrome;
    delete window.__flowtraceRecorderLoaded;
  });

  it('ignores hostile __FLOWTRACE_PLATFORM_LAUNCH__ window messages completely', async () => {
    // Import content script once
    await import('../src/core/content/index.js');

    // Post hostile launch window message
    window.postMessage({
      type: '__FLOWTRACE_PLATFORM_LAUNCH__',
      payload: {
        targetUrl: 'https://attacker.example.com',
        autoLogin: true,
      },
    }, '*');

    // Wait a tick for event loop
    await new Promise((r) => setTimeout(r, 50));

    // chrome.runtime.sendMessage must NEVER have been called with PLATFORM_LAUNCH_SESSION
    const launchCalls = chrome.runtime.sendMessage.mock.calls.filter(
      (args) => args[0]?.action === 'PLATFORM_LAUNCH_SESSION'
    );
    expect(launchCalls).toHaveLength(0);
  });

  it('retains harmless presence detection ping/pong', async () => {
    await import('../src/core/content/index.js');

    const receivedMessages = [];
    const listener = (event) => {
      if (event.data?.type === '__FLOWTRACE_PLATFORM_PONG__') {
        receivedMessages.push(event.data);
      }
    };
    window.addEventListener('message', listener);

    window.postMessage({ type: '__FLOWTRACE_PLATFORM_PING__' }, '*');

    await new Promise((r) => setTimeout(r, 100));
    window.removeEventListener('message', listener);

    expect(receivedMessages.length).toBeGreaterThan(0);
    expect(receivedMessages[0].installed).toBe(true);
    expect(receivedMessages[0].version).toBe('1.0.0');
  });
});
