/**
 * popup-router.test.js — Tests for router pause/resume, step deletion,
 * and popup data serialization.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createRouter } from '../src/core/background/router.js';
import * as session from '../src/core/background/session.js';

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

describe('Router & Session Flow Enhancements', () => {
  let router;
  const mockPatches = {
    getPatch: () => ({ id: 'generic', name: 'Generic', capture: {}, resolve: {}, postProcess: (evts) => evts }),
    hasPatch: (id) => id === 'generic' || id === 'oracle',
    listPatches: () => [{ id: 'generic', name: 'Generic' }],
  };

  beforeEach(async () => {
    installChrome();
    await session.clear();
    router = createRouter(mockPatches);
  });

  it('handles PAUSE_RECORDING and RESUME_RECORDING state transitions', async () => {
    // When not recording, returns error
    const errResp = await router({ action: 'PAUSE_RECORDING' });
    expect(errResp.success).toBe(false);

    // Simulate active recording
    session.get().isRecording = true;
    session.get().isPaused = false;

    const pauseResp = await router({ action: 'PAUSE_RECORDING' });
    expect(pauseResp.success).toBe(true);
    expect(pauseResp.isPaused).toBe(true);
    expect(session.get().isPaused).toBe(true);

    const resumeResp = await router({ action: 'RESUME_RECORDING' });
    expect(resumeResp.success).toBe(true);
    expect(resumeResp.isPaused).toBe(false);
    expect(session.get().isPaused).toBe(false);
  });

  it('DELETE_STEP removes the targeted event by index', async () => {
    session.get().events = [
      { type: 'click', label: 'Step 1' },
      { type: 'fill', label: 'Step 2', value: 'Hello' },
      { type: 'click', label: 'Step 3' },
    ];

    // Delete middle step (index 1)
    const delResp = await router({ action: 'DELETE_STEP', index: 1 });
    expect(delResp.success).toBe(true);
    expect(delResp.eventCount).toBe(2);
    expect(delResp.events[0].label).toBe('Step 1');
    expect(delResp.events[1].label).toBe('Step 3');
  });

  it('forTransport includes isPaused and events array', () => {
    session.get().isRecording = true;
    session.get().isPaused = true;
    session.get().events = [{ type: 'click', label: 'Save' }];

    const transport = session.forTransport();
    expect(transport.isRecording).toBe(true);
    expect(transport.isPaused).toBe(true);
    expect(transport.events.length).toBe(1);
    expect(transport.eventCount).toBe(1);
  });
});
