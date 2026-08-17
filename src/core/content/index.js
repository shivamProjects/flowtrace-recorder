/**
 * index.js — content script entry point.
 *
 * This is one of the two places allowed to know that patches exist. Core
 * modules receive the active patch as a parameter and never import the
 * registry, so `core/` stays buildable and testable with no patches present.
 */

import { getPatch } from '../../patches/index.js';
import { startCapture, stopCapture } from './capture.js';
import { isTopFrame } from './frames.js';
import { mountWidget, setWidgetCount, unmountWidget } from './widget.js';
import * as bus from './bus.js';

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
      onStop: () => bus.requestStop(),
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
