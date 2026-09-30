/**
 * trace-41-hardening.test.js — Verification tests for TRACE-41 Zero-CDP transport hardening.
 *
 * Covers:
 * 1. MV3 Worker Recovery: LifecycleObservers re-arms on ensureLoaded() when recording.
 * 2. Popup activation broadcast: popup tabs receive __flowtrace_activate__ immediately.
 * 3. Durable Effect Mutability: RECORD_EVENT references mutate the durable session event.
 * 4. Compiler & Schema Durability: surfaceId, effects, and frame hierarchy pass validation and compilation.
 * 5. Hierarchical Frame Scoping: nested iframe chains generate chained frameLocator calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as session from '../src/core/background/session.js';
import { createRouter } from '../src/core/background/router.js';
import { compileActions, compileSteps, compileScript } from '../src/core/background/compiler.js';
import { validateActions } from '../src/core/shared/schema.js';
import { LifecycleObservers } from '../src/core/background/observers.js';

function installChrome() {
  const store = {};
  const listeners = {
    tabsOnCreated: [],
    tabsOnRemoved: [],
    tabsOnUpdated: [],
  };

  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys) => {
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of wanted) if (key in store) out[key] = store[key];
          return out;
        }),
        set: vi.fn(async (items) => { Object.assign(store, items); }),
        remove: vi.fn(async (key) => { delete store[key]; }),
      },
    },
    scripting: {
      executeScript: vi.fn(async () => []),
    },
    tabs: {
      sendMessage: vi.fn(async () => ({})),
      onCreated: {
        addListener: vi.fn((fn) => listeners.tabsOnCreated.push(fn)),
        removeListener: vi.fn((fn) => {
          const idx = listeners.tabsOnCreated.indexOf(fn);
          if (idx >= 0) listeners.tabsOnCreated.splice(idx, 1);
        }),
      },
      onRemoved: {
        addListener: vi.fn((fn) => listeners.tabsOnRemoved.push(fn)),
        removeListener: vi.fn((fn) => {
          const idx = listeners.tabsOnRemoved.indexOf(fn);
          if (idx >= 0) listeners.tabsOnRemoved.splice(idx, 1);
        }),
      },
      onUpdated: {
        addListener: vi.fn((fn) => listeners.tabsOnUpdated.push(fn)),
        removeListener: vi.fn((fn) => {
          const idx = listeners.tabsOnUpdated.indexOf(fn);
          if (idx >= 0) listeners.tabsOnUpdated.splice(idx, 1);
        }),
      },
    },
  };
  return { store, listeners };
}

describe('TRACE-41: Zero-CDP Transport Hardening', () => {
  let mockEnv;

  beforeEach(async () => {
    mockEnv = installChrome();
    await session.clear();
  });

  afterEach(async () => {
    await session.clear();
  });

  it('re-arms LifecycleObservers on ensureLoaded() when active recording is restored', async () => {
    // 1. Setup mock storage with an active recording session
    mockEnv.store.recorderSession = {
      recordingSessionId: 'session_test_recovery',
      isRecording: true,
      isPaused: false,
      activeTabId: 42,
      events: [],
      patchId: 'generic',
      surfaceState: {
        sessionId: 'session_test_recovery',
        surfaces: {
          surf_1: {
            surfaceId: 'surf_1',
            tabId: 42,
            kind: 'page',
            url: 'https://oracle.example.com',
          },
        },
      },
    };

    // Call ensureLoaded() simulating service worker restart
    await session.ensureLoaded();

    const restoredSession = session.get();
    expect(restoredSession.isRecording).toBe(true);
    expect(restoredSession.activeTabId).toBe(42);

    const observers = session.getLifecycleObservers();
    expect(observers).not.toBeNull();
    expect(observers.isActive()).toBe(true);

    observers.stop();
  });

  it('broadcasts __flowtrace_activate__ to popup on creation', async () => {
    const injectedTabs = [];
    const broadcastEvents = [];

    const mockInject = async (tabId) => {
      injectedTabs.push(tabId);
    };

    const mockBroadcast = async (tabId, eventName, detail) => {
      broadcastEvents.push({ tabId, eventName, detail });
    };

    const registry = session.getSurfaceRegistry();
    registry.registerPrimary(100, { url: 'https://example.com' });

    const observers = new LifecycleObservers({
      surfaceRegistry: registry,
      correlator: session.getEffectCorrelator(),
      injectContentScript: mockInject,
      broadcast: mockBroadcast,
      getPatchId: () => 'oracle',
    });

    observers.start();

    // Trigger tab onCreated listener
    const onCreatedListener = mockEnv.listeners.tabsOnCreated[0];
    expect(onCreatedListener).toBeDefined();

    await onCreatedListener({
      id: 200,
      openerTabId: 100,
      url: 'https://example.com/popup',
      windowId: 1,
    });

    expect(injectedTabs).toContain(200);
    expect(broadcastEvents).toEqual([
      { tabId: 200, eventName: '__flowtrace_activate__', detail: { patchId: 'oracle' } },
    ]);

    observers.stop();
  });

  it('ensures correlated effects mutate the exact durable session event in RECORD_EVENT', async () => {
    const dummyPatch = {
      id: 'generic',
      name: 'Generic',
      version: '1.0.0',
      postProcess: (events) => events,
    };
    const patches = {
      getPatch: () => dummyPatch,
      hasPatch: () => true,
      listPatches: () => [dummyPatch],
    };

    const router = createRouter(patches);

    // Set active recording
    const s = session.get();
    s.isRecording = true;
    s.activeTabId = 50;

    session.getSurfaceRegistry().registerPrimary(50, { url: 'https://example.com/form' });

    // Send RECORD_EVENT for a button click
    const clickEvent = {
      type: 'click',
      selector: '#save-button',
      tagName: 'BUTTON',
      text: 'Save',
      timestamp: Date.now(),
    };

    const recordResult = await router({
      action: 'RECORD_EVENT',
      event: clickEvent,
    }, { tab: { id: 50 } });

    expect(recordResult.accepted).toBe(true);
    expect(s.events).toHaveLength(1);

    const storedEvent = s.events[0];
    expect(storedEvent.surfaceId).toBeDefined();

    // Correlate a navigation effect
    const navEffect = {
      kind: 'navigation',
      surfaceId: storedEvent.surfaceId,
      url: 'https://example.com/success',
      timestamp: Date.now() + 50,
    };

    session.getEffectCorrelator().correlateEffect(navEffect);

    // Verify the durable event in s.events itself was directly mutated with the correlated effect
    expect(storedEvent.effects).toBeDefined();
    expect(storedEvent.effects).toHaveLength(1);
    expect(storedEvent.effects[0].kind).toBe('navigation');
  });

  it('compiles actions and steps with surfaceId, effects, and hierarchical framePath', () => {
    const events = [
      {
        type: 'click',
        selector: 'button#nested-submit',
        text: 'Submit In Nested Frame',
        surfaceId: 'surf_main_tab_1',
        isTopFrame: false,
        frameUrl: 'https://example.com/frames/child.html',
        frameName: 'childFrame',
        frameSelector: 'iframe#child',
        framePath: ['iframe#parent', 'iframe#child'],
        effects: [
          {
            kind: 'popup',
            surfaceId: 'surf_popup_2',
            url: 'https://example.com/details',
          },
        ],
      },
    ];

    const actions = compileActions(events);
    expect(actions).toHaveLength(1);

    const action = actions[0];
    expect(action.action).toBe('click');
    expect(action.surfaceId).toBe('surf_main_tab_1');
    expect(action.effects).toHaveLength(1);
    expect(action.effects[0].kind).toBe('popup');
    expect(action.frame).toEqual({
      url: 'https://example.com/frames/child.html',
      name: 'childFrame',
      selector: 'iframe#child',
      path: ['iframe#parent', 'iframe#child'],
    });

    // Validate against canonical schema v1
    const validationProblems = validateActions(actions);
    expect(validationProblems).toEqual([]);

    // Check steps compilation
    const steps = compileSteps(events);
    expect(steps).toHaveLength(1);
    expect(steps[0].surfaceId).toBe('surf_main_tab_1');
    expect(steps[0].effects).toHaveLength(1);
    expect(steps[0].frame.path).toEqual(['iframe#parent', 'iframe#child']);

    // Check script compilation with chained frameLocator
    const script = compileScript(events, { events: [events[0]], sourceUrl: 'https://example.com' }, { id: 'generic', name: 'Generic', version: '1.0' });
    expect(script).toContain("page.frameLocator('iframe#parent').frameLocator('iframe#child').locator('button#nested-submit')");
  });
});
