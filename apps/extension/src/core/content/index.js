/**
 * index.js — content script entry point.
 *
 * This is one of the two places allowed to know that patches exist. Core
 * modules receive the active patch as a parameter and never import the
 * registry, so `core/` stays buildable and testable with no patches present.
 */

import {
  getPatch,
  autoFillLogin,
  startCapture,
  stopCapture,
  isTopFrame,
  mountWidget,
  setWidgetCount,
  unmountWidget,
  bus,
} from '@flowtrace/recorder-core';

// The manifest injects this script, and START_RECORDING injects it again to
// reach frames that loaded before recording began. Re-running would register a
// second set of listeners and double every event.
if (!window.__flowtraceRecorderLoaded) {
  window.__flowtraceRecorderLoaded = true;
  main();
}

function main() {
  bus.setCountListener(setWidgetCount);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'ACTIVATE_RECORDING') {
      activate(msg.patchId, 0);
      sendResponse({ ok: true });
    } else if (msg.action === 'DEACTIVATE_RECORDING') {
      sendResponse({ ok: true, patchContext: deactivate() });
    } else if (msg.action === 'PING') {
      sendResponse({ alive: true, recording: bus.isRecording() });
    } else if (msg.action === 'AUTO_FILL_LOGIN') {
      // Safety guard: autoFillLogin dispatches synthetic `input` events.
      // capture.js deliberately does not filter isTrusted, so firing while
      // a session is active would push plaintext credentials onto the bus.
      if (bus.isRecording()) {
        sendResponse({ success: false, error: 'Cannot auto-fill while recording is active.' });
        return false;
      }
      autoFillLogin(msg.username, msg.password, { submit: !!msg.submit })
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ success: false, error: String(err.message || err) }));
      return true; // async sendResponse
    }
    return false;
  });

  // tabs.sendMessage only reaches the top frame, so START_RECORDING also
  // broadcasts this custom event into every frame via executeScript.
  window.addEventListener('__flowtrace_activate__', (e) => {
    activate(e.detail && e.detail.patchId, 0);
  });
  window.addEventListener('__flowtrace_deactivate__', () => {
    deactivate();
  });

  // A full page navigation destroys and re-injects this script. Ask the
  // background whether the session it belonged to is still running.
  bus.requestStatus((resp) => {
    if (resp?.session?.isRecording) {
      activate(resp.session.patchId, resp.session.eventCount || 0);
    }
  });

  // Platform Web App Direct Bridge (for platform.shivambhaipatel.com / localhost)
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || typeof event.data !== 'object') return;
    if (event.data.type === '__FLOWTRACE_PLATFORM_PING__') {
      window.postMessage({
        type: '__FLOWTRACE_PLATFORM_PONG__',
        installed: true,
        version: '1.0.0',
        recording: bus.isRecording(),
      }, '*');
    } else if (event.data.type === '__FLOWTRACE_PLATFORM_LAUNCH__') {
      chrome.runtime.sendMessage({
        action: 'PLATFORM_LAUNCH_SESSION',
        ...(event.data.payload || {}),
      }, (res) => {
        window.postMessage({
          type: '__FLOWTRACE_PLATFORM_LAUNCH_RESPONSE__',
          result: res,
        }, '*');
      });
    }
  });

  // Announce recorder presence on load
  try {
    window.postMessage({ type: '__FLOWTRACE_RECORDER_DETECTED__', installed: true, version: '1.0.0' }, '*');
  } catch {}
}


function activate(patchId, eventCount) {
  const patch = getPatch(patchId);

  if (eventCount > 0) bus.resumeSession(eventCount);
  else bus.beginSession();

  startCapture(patch);

  if (isTopFrame()) {
    mountWidget({
      patchId: patch.id,
      patchName: patch.name,
      onStop: () => new Promise(resolve => bus.requestStop(resolve)),
      onPauseToggle: (paused) => {
        if (paused) bus.requestPause();
        else bus.requestResume();
      },
    });
    setWidgetCount(eventCount);
  }
}

/** @returns {Object} the patch's final context snapshot */
function deactivate() {
  const snapshot = stopCapture();
  bus.endSession();
  if (isTopFrame()) unmountWidget();
  return snapshot;
}
