/**
 * bus.js — everything the content script sends to the service worker.
 *
 * Two things live here that are easy to get wrong if they are spread across
 * call sites:
 *
 *   1. chrome.runtime.sendMessage can throw SYNCHRONOUSLY once the extension
 *      context is invalidated (a reload during development, an update in the
 *      field). A trailing .catch() does not help. Every send is wrapped.
 *
 *   2. The recording EPOCH. Patches schedule work — ADF's committed value is
 *      only readable 500-1500ms after a dialog closes — and those callbacks can
 *      land after the user pressed Stop. Worse, if a second recording has begun
 *      by then, the stale callback contaminates it. Every send carries the epoch
 *      it was created under and is dropped if the epoch has moved on.
 */

let recording = false;
let epoch = 0;
let eventCount = 0;
let onCountChanged = () => {};

/** Begin a new recording generation. Anything scheduled before this is stale. */
export function beginSession() {
  recording = true;
  epoch += 1;
  eventCount = 0;
  onCountChanged(0);
  return epoch;
}

export function endSession() {
  recording = false;
  epoch += 1; // invalidate in-flight callbacks from the session just ended
}

export function isRecording() {
  return recording;
}

export function currentEpoch() {
  return epoch;
}

/** Restore the counter when a page navigation re-injects the content script. */
export function resumeSession(count) {
  recording = true;
  epoch += 1;
  eventCount = count || 0;
  onCountChanged(eventCount);
  return epoch;
}

export function setCountListener(fn) {
  onCountChanged = fn || (() => {});
}

/**
 * Capture the current epoch so a delayed callback can check whether the session
 * it belongs to is still the live one.
 *
 * @example
 *   const stillOurs = guard();
 *   setTimeout(() => { if (stillOurs()) ctx.updateContext({...}); }, 1000);
 */
export function guard() {
  const mine = epoch;
  return () => recording && epoch === mine;
}

/** Send a recorded event. Ignored when not recording. */
export function sendEvent(event) {
  if (!recording) return;
  eventCount += 1;
  onCountChanged(eventCount);
  send({ action: 'RECORD_EVENT', event });
}

/**
 * Stream a partial patch-context object to the background, where it is merged
 * into session.patchContext. Used for data that must survive the tab being
 * navigated or closed before Stop is pressed.
 */
export function sendPatchContext(partial) {
  if (!recording || !partial) return;
  send({ action: 'PATCH_CONTEXT_UPDATE', context: partial });
}

/** Ask the background whether a recording is already in progress. */
export function requestStatus(callback) {
  try {
    chrome.runtime.sendMessage({ action: 'GET_STATUS' }, (resp) => {
      void chrome.runtime.lastError;
      callback(resp);
    });
  } catch {
    callback(null);
  }
}

export function requestStop(callback) {
  sendWithResponse({ action: 'STOP_RECORDING' }, callback);
}

export function requestPause(callback) {
  sendWithResponse({ action: 'PAUSE_RECORDING' }, callback);
}

export function requestResume(callback) {
  sendWithResponse({ action: 'RESUME_RECORDING' }, callback);
}

function send(message) {
  try {
    if (!chrome?.runtime?.id) return; // context invalidated
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // Extension was reloaded out from under this page. Nothing to do; the
    // content script in the next page load will re-register.
  }
}

function sendWithResponse(message, callback) {
  try {
    if (!chrome?.runtime?.id) {
      callback?.(null);
      return;
    }
    chrome.runtime.sendMessage(message, (resp) => {
      void chrome.runtime.lastError;
      callback?.(resp);
    });
  } catch {
    callback?.(null);
  }
}
