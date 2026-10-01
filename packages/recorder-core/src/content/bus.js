/**
 * bus.js — everything the content script sends to the host runtime.
 *
 * Pluggable transport: ExtensionHost uses chrome.runtime, DesktopHost uses IPC/postMessage,
 * unit tests use local mock sink.
 */

let recording = false;
let epoch = 0;
let eventCount = 0;
let onCountChanged = () => {};

let transport = {
  send: (message) => {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage && chrome?.runtime?.id) {
      try {
        chrome.runtime.sendMessage(message, () => {
          void chrome.runtime?.lastError;
        });
      } catch {}
    } else if (typeof window !== 'undefined' && window.__flowtrace_host_send__) {
      window.__flowtrace_host_send__(message);
    }
  },
  sendWithResponse: (message, callback) => {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage && chrome?.runtime?.id) {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          void chrome.runtime?.lastError;
          callback?.(resp);
        });
      } catch {
        callback?.(null);
      }
    } else if (typeof window !== 'undefined' && window.__flowtrace_host_request__) {
      window.__flowtrace_host_request__(message, callback);
    } else {
      callback?.(null);
    }
  }
};

export function setTransport(t) {
  if (t) transport = t;
}

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
  transport.send({ action: 'RECORD_EVENT', event });
}

/**
 * Stream a partial patch-context object to the background, where it is merged
 * into session.patchContext.
 */
export function sendPatchContext(partial) {
  if (!recording || !partial) return;
  transport.send({ action: 'PATCH_CONTEXT_UPDATE', context: partial });
}

/** Ask the background whether a recording is already in progress. */
export function requestStatus(callback) {
  transport.sendWithResponse({ action: 'GET_STATUS' }, callback);
}

export function requestStop(callback) {
  transport.sendWithResponse({ action: 'STOP_RECORDING' }, callback);
}

export function requestPause(callback) {
  transport.sendWithResponse({ action: 'PAUSE_RECORDING' }, callback);
}

export function requestResume(callback) {
  transport.sendWithResponse({ action: 'RESUME_RECORDING' }, callback);
}
