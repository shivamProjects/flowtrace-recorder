/**
 * page-runtime.js — Dedicated Host-Neutral Browser Runtime for FlowTrace Recorder.
 *
 * Runs inside the browser context (e.g. Playwright / Desktop Chromium / WebView).
 * Bridges DOM interactions captured by PageRecorder to the host sink (window.__flowtrace_host_send__).
 * Zero dependency on chrome.* or any browser extension API.
 */

import { PageRecorder } from './page/page-recorder.js';
import { getPatch } from './patches/index.js';

(() => {
  if (typeof window === 'undefined') return;
  if (window.__flowtrace_page_recorder__) return; // Prevent double initialization

  const patchId = window.__flowtrace_patch_id__ || 'oracle';

  const onEvent = (event) => {
    if (typeof window.__flowtrace_host_send__ === 'function') {
      try {
        window.__flowtrace_host_send__({
          action: 'RECORD_EVENT',
          event,
        });
      } catch (err) {
        console.warn('[flowtrace-page-runtime] failed to send event to host:', err);
      }
    }
  };

  const recorder = new PageRecorder({
    window,
    document: window.document,
    patchId,
    onEvent,
  });

  window.__flowtrace_page_recorder__ = recorder;

  // Auto-start capture if host requested active recording
  if (window.__FLOWTRACE_DESKTOP_HOST__) {
    recorder.start(patchId);
  }
})();
