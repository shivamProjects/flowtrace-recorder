/**
 * session.js — recording state and its persistence.
 *
 * MV3 service workers are evicted whenever Chrome feels like it, taking every
 * module-level variable with them. Any handler that touches state must call
 * `ensureLoaded()` first; the flag it checks is itself a module global, so it
 * is false again after each restart and the reload happens exactly once per
 * worker lifetime.
 */

import { DEFAULT_PATCH_ID } from '../shared/patch-api.js';
import { SurfaceRegistry } from './surface-registry.js';
import { EffectCorrelator, LifecycleObservers } from './observers.js';

const STORAGE_KEY = 'recorderSession';
const PREFERENCE_KEY = 'preferredPatchId';

/** @returns {Object} a fresh session */
export function blankSession(patchId = DEFAULT_PATCH_ID) {
  const recordingSessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  return {
    recordingSessionId,
    isRecording: false,
    isPaused: false,
    activeTabId: null,
    startedAt: null,
    sourceUrl: null,
    patchId,
    events: [],
    processedEvents: [],
    generatedCode: '',
    steps: [],
    actions: [],
    surfaces: [],
    surfaceState: null,
    /**
     * Free-form bag the active patch streams into during recording and reads
     * in postProcess. The core never inspects its contents — it only merges.
     */
    patchContext: {},
  };
}

let session = blankSession();
let loaded = false;

const surfaceRegistry = new SurfaceRegistry({ sessionId: session.recordingSessionId });
const effectCorrelator = new EffectCorrelator();
let lifecycleObservers = null;

export function getSurfaceRegistry() {
  return surfaceRegistry;
}

export function getEffectCorrelator() {
  return effectCorrelator;
}

export function getLifecycleObservers() {
  return lifecycleObservers;
}

export function initLifecycleObservers(injectFn) {
  if (!lifecycleObservers) {
    lifecycleObservers = new LifecycleObservers({
      surfaceRegistry,
      correlator: effectCorrelator,
      onEffectCaptured: (_effect) => {
        session.surfaces = surfaceRegistry.getAll();
        session.surfaceState = surfaceRegistry.toJSON();
        persistSoon();
      },
      injectContentScript: injectFn,
    });
  }
  return lifecycleObservers;
}

export function get() {
  return session;
}

export function set(next) {
  session = next;
  if (next.recordingSessionId) {
    surfaceRegistry.setSessionId(next.recordingSessionId);
  }
}

export async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY, PREFERENCE_KEY]);
    if (stored[STORAGE_KEY]) {
      session = { ...blankSession(), ...stored[STORAGE_KEY] };
      session.patchContext = stored[STORAGE_KEY].patchContext || {};
      if (session.recordingSessionId) {
        surfaceRegistry.setSessionId(session.recordingSessionId);
      }
      if (session.surfaceState) {
        surfaceRegistry.fromJSON(session.surfaceState);
      }
    }
    if (!session.isRecording && stored[PREFERENCE_KEY]) {
      session.patchId = stored[PREFERENCE_KEY];
    }
  } catch (err) {
    console.warn('[recorder] could not restore session:', err.message);
  }
}

export async function persist() {
  try {
    session.surfaceState = surfaceRegistry.toJSON();
    session.surfaces = surfaceRegistry.getAll();
    await chrome.storage.local.set({ [STORAGE_KEY]: session });
  } catch (err) {
    console.warn('[recorder] could not persist session:', err.message);
  }
}

/* ── Coalesced persistence for the capture hot path ─────────────────────────
 *
 * RECORD_EVENT used to persist only every 5th event, which meant an MV3 service
 * worker eviction lost up to FOUR captured interactions — silently, with no
 * marker in the restored session. The operator sees a recording that looks
 * complete and is not, which is the one thing a recorder must never do.
 *
 * Persisting on every event is the obvious fix and the wrong one: `persist()`
 * writes the WHOLE session, so a fast burst of interactions would queue a
 * full-session write behind each one. The batching was a real optimisation, not
 * a premature one.
 *
 * So: never drop an event, but collapse a burst into one write. Each call marks
 * the session dirty and schedules a flush; calls arriving while a flush is
 * pending are absorbed by it. The longest any event can be unpersisted is
 * COALESCE_MS, not four interactions of unbounded duration.
 *
 * `flush()` exists for the paths that must not defer — stop, pause, upload —
 * where a write that has not landed is a write that may never land.
 */
const COALESCE_MS = 250;
let pendingFlush = null;
let dirty = false;

export function persistSoon() {
  dirty = true;
  if (pendingFlush) return pendingFlush;
  pendingFlush = new Promise((resolve) => {
    setTimeout(async () => {
      pendingFlush = null;
      dirty = false;
      await persist();
      resolve();
    }, COALESCE_MS);
  });
  return pendingFlush;
}

/** Persist now, absorbing any scheduled write. Use before anything terminal. */
export async function flush() {
  if (pendingFlush) await pendingFlush;
  if (dirty) {
    dirty = false;
    await persist();
  }
}

export async function clear() {
  session = blankSession(session.patchId);
  await chrome.storage.local.remove(STORAGE_KEY);
}

export async function rememberPatchPreference(patchId) {
  await chrome.storage.local.set({ [PREFERENCE_KEY]: patchId });
}

/**
 * Deep-merge a partial patch context. Objects merge key-wise and arrays union,
 * which covers everything patches have needed so far without the core having to
 * understand any of the keys.
 */
export function mergePatchContext(partial) {
  if (!partial || typeof partial !== 'object') return;
  const target = session.patchContext;

  for (const [key, value] of Object.entries(partial)) {
    if (Array.isArray(value)) {
      target[key] = [...new Set([...(target[key] || []), ...value])];
    } else if (value && typeof value === 'object') {
      target[key] = { ...(target[key] || {}), ...value };
    } else {
      target[key] = value;
    }
  }
}

/** The subset safe to hand to the popup and content scripts. */
export function forTransport() {
  return {
    isRecording: session.isRecording,
    isPaused: !!session.isPaused,
    activeTabId: session.activeTabId,
    startedAt: session.startedAt,
    sourceUrl: session.sourceUrl,
    patchId: session.patchId,
    eventCount: session.events.length,
    events: session.events,
    processedCount: session.processedEvents.length,
    generatedCode: session.generatedCode,
    steps: session.steps,
    actions: session.actions,
  };
}
