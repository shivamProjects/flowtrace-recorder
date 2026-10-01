/**
 * page-recorder.js — Pure Page-side Recorder Coordinator.
 *
 * Attaches to any DOM environment (Browser window, iframe, or JSDOM simulation)
 * and dispatches recorded semantic events through a provided sink or bus.
 */

import { getPatch } from '../patches/index.js';
import { startCapture, stopCapture } from '../content/capture.js';
import * as bus from '../content/bus.js';

export class PageRecorder {
  constructor(options = {}) {
    this.window = options.window || (typeof window !== 'undefined' ? window : null);
    this.document = options.document || (this.window ? this.window.document : null);
    this.patchId = options.patchId || 'generic';
    this.onEvent = options.onEvent || null;
    this.isRecording = false;

    if (this.onEvent) {
      bus.setTransport({
        send: (msg) => {
          if (msg.action === 'RECORD_EVENT' && msg.event) {
            this.onEvent(msg.event);
          }
        },
        sendWithResponse: (_msg, cb) => cb?.(null),
      });
    }
  }

  start(patchId) {
    if (patchId) this.patchId = patchId;
    const patch = getPatch(this.patchId);
    this.isRecording = true;
    bus.beginSession();
    startCapture(patch);
  }

  stop() {
    this.isRecording = false;
    const snapshot = stopCapture();
    bus.endSession();
    return snapshot;
  }
}
