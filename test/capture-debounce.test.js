import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCapture, stopCapture } from '../src/core/content/capture.js';
import { normalisePatch } from '../src/core/shared/patch-api.js';
import * as bus from '../src/core/content/bus.js';

describe('capture debounce ordering & flush', () => {
  let sent = [];

  beforeEach(() => {
    sent = [];
    vi.useFakeTimers();
    globalThis.chrome = {
      runtime: {
        id: 'test-extension',
        sendMessage: (msg, cb) => {
          if (msg.action === 'RECORD_EVENT') sent.push(msg.event);
          if (cb) cb({ accepted: true });
        },
        lastError: undefined,
      },
    };
    document.body.innerHTML = `
      <label for="supplier">Supplier</label>
      <input id="supplier" name="supplier" type="text" />
      <button id="save" type="button">Save</button>
    `;

    startCapture(normalisePatch({ id: 'generic', name: 'Generic', version: '1.0.0' }));
    bus.beginSession();
  });

  afterEach(() => {
    stopCapture();
    bus.endSession();
    vi.useRealTimers();
    delete globalThis.chrome;
    document.body.innerHTML = '';
  });

  it('flushes pending fill before a click on another element (no re-ordering)', () => {
    const input = document.getElementById('supplier');
    const button = document.getElementById('save');

    // 1. User types in input
    input.value = 'ACME Corp';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // 2. User immediately clicks button before the 600ms debounce expires
    vi.advanceTimersByTime(100);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // 3. Sent events MUST have fill BEFORE click
    expect(sent.length).toBe(2);
    expect(sent[0].type).toBe('fill');
    expect(sent[0].value).toBe('ACME Corp');
    expect(sent[1].type).toBe('click');
    expect(sent[1].tagName).toBe('button');
  });

  it('flushes pending fill when stopCapture is called before debounce timer expires', () => {
    const input = document.getElementById('supplier');

    // 1. User types in input
    input.value = 'Final Value';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // 2. Stop capture immediately after typing (e.g. 50ms)
    vi.advanceTimersByTime(50);
    stopCapture();

    // 3. The typed value MUST NOT be lost
    expect(sent.length).toBe(1);
    expect(sent[0].type).toBe('fill');
    expect(sent[0].value).toBe('Final Value');
  });
});
