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

const STORAGE_KEY = 'recorderSession';
const PREFERENCE_KEY = 'preferredPatchId';

/** @returns {Object} a fresh session */
export function blankSession(patchId = DEFAULT_PATCH_ID) {
  return {
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
    /**
     * Free-form bag the active patch streams into during recording and reads
     * in postProcess. The core never inspects its contents — it only merges.
     */
    patchContext: {},
  };
}

let session = blankSession();
let loaded = false;

export function get() {
  return session;
}

export function set(next) {
  session = next;
}

export async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY, PREFERENCE_KEY]);
    if (stored[STORAGE_KEY]) {
      session = { ...blankSession(), ...stored[STORAGE_KEY] };
      session.patchContext = stored[STORAGE_KEY].patchContext || {};
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
    await chrome.storage.local.set({ [STORAGE_KEY]: session });
  } catch (err) {
    console.warn('[recorder] could not persist session:', err.message);
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
