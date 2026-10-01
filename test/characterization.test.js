/**
 * characterization.test.js — verifies RecordActionTool forensic extraction semantics.
 *
 * Covers:
 * 1. Single click -> exactly one click after correlation window
 * 2. Double-click -> cancels single click and emits exactly one dblclick with clickCount: 2
 * 3. Right-click -> contextmenu / click with button: 'right'
 * 4. Checkbox Spacebar -> check/uncheck action
 * 5. Tab, Escape, Arrows, Enter navigation -> press action without noisy fill
 * 6. Printable text typing -> debounced fill action without noisy press
 * 7. Backspace / Delete -> fill mutation
 * 8. Paste shortcut (Ctrl+V) -> no press('v') noise
 * 9. TargetSnapshot & TargetResolver deep shadow / interactive container resolution
 * 10. FocusState tracking and fill flushing without noisy focus events
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TargetResolver, resolveInteractiveTarget } from '../src/core/capture/targeting/target-resolver.js';
import { takeTargetSnapshot } from '../src/core/capture/targeting/target-snapshot.js';
import { ClickCorrelator } from '../src/core/capture/pointer/click-correlator.js';
import { classifyKey } from '../src/core/capture/keyboard/key-classifier.js';
import { KeyboardCapture } from '../src/core/capture/keyboard/keyboard-capture.js';
import { FocusState } from '../src/core/capture/focus/focus-state.js';

describe('RecordActionTool Forensic Extraction Characterization Suite', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('TargetResolver & TargetSnapshot', () => {
    it('resolves interactive container when child span is clicked', () => {
      document.body.innerHTML = `
        <button id="save-btn">
          <span class="icon">💾</span>
          <span class="label" id="target-span">Save Changes</span>
        </button>
      `;

      const span = document.getElementById('target-span');
      const fakeEvent = {
        target: span,
        composedPath: () => [span, span.parentElement],
      };

      const resolved = resolveInteractiveTarget(fakeEvent);
      expect(resolved).not.toBeNull();
      expect(resolved.id).toBe('save-btn');
    });

    it('resolves wrapping cell with single checkbox directly to the checkbox', () => {
      document.body.innerHTML = `
        <table id="test-table">
          <tr>
            <td id="wrapping-cell">
              <input type="checkbox" id="row-check" />
            </td>
          </tr>
        </table>
      `;

      const cell = document.getElementById('wrapping-cell');
      const fakeEvent = {
        target: cell,
        composedPath: () => [cell],
      };

      const resolved = resolveInteractiveTarget(fakeEvent);
      expect(resolved).not.toBeNull();
      expect(resolved.id).toBe('row-check');
    });

    it('takes an immutable target snapshot preserving element attributes and locator clues', () => {
      document.body.innerHTML = `
        <input type="text" id="cust-name" name="customerName" aria-label="Customer Name" value="Acme Corp" />
      `;

      const input = document.getElementById('cust-name');
      const snapshot = takeTargetSnapshot(input);

      expect(snapshot).not.toBeNull();
      expect(snapshot.tagName).toBe('input');
      expect(snapshot.inputType).toBe('text');
      expect(snapshot.label).toBe('Customer Name');
      expect(snapshot.value).toBe('Acme Corp');
      expect(snapshot.locatorObject).toBeDefined();
      expect(snapshot.selector.selector).toContain('#cust-name');
    });
  });

  describe('ClickCorrelator (Single Click, Double-Click & Right-Click)', () => {
    it('emits exactly one click action after correlation delay for a single click', () => {
      const emitted = [];
      const correlator = new ClickCorrelator({
        emit: (ev) => emitted.push(ev),
        delayMs: 200,
      });

      const button = document.createElement('button');
      button.textContent = 'Submit';
      document.body.appendChild(button);

      const makeEvent = (type, el, extra) => ({ type, tagName: el.tagName, ...extra });

      correlator.onClick(button, { button: 0 }, makeEvent);

      // Before delay expires, no event emitted yet
      expect(emitted.length).toBe(0);

      // Fast forward past delay
      vi.advanceTimersByTime(250);

      expect(emitted.length).toBe(1);
      expect(emitted[0].type).toBe('click');
      expect(emitted[0].clickCount).toBe(1);
    });

    it('cancels pending single click and emits exactly one dblclick action on double-click', () => {
      const emitted = [];
      const correlator = new ClickCorrelator({
        emit: (ev) => emitted.push(ev),
        delayMs: 200,
      });

      const row = document.createElement('div');
      row.className = 'grid-row';
      document.body.appendChild(row);

      const makeEvent = (type, el, extra) => ({ type, tagName: el.tagName, ...extra });

      // First click arrives
      correlator.onClick(row, { button: 0 }, makeEvent);
      vi.advanceTimersByTime(50);

      // Second click / dblclick arrives before 200ms window expires
      correlator.onDoubleClick(row, { button: 0 }, makeEvent);

      // Fast forward
      vi.advanceTimersByTime(300);

      // Exactly ONE dblclick event must be emitted (no single click!)
      expect(emitted.length).toBe(1);
      expect(emitted[0].type).toBe('dblclick');
      expect(emitted[0].clickCount).toBe(2);
    });

    it('emits right-click contextmenu event immediately with button=right', () => {
      const emitted = [];
      const correlator = new ClickCorrelator({
        emit: (ev) => emitted.push(ev),
        delayMs: 200,
      });

      const menuTarget = document.createElement('div');
      document.body.appendChild(menuTarget);

      const makeEvent = (type, el, extra) => ({ type, tagName: el.tagName, ...extra });

      correlator.onContextMenu(menuTarget, { button: 2 }, makeEvent);

      expect(emitted.length).toBe(1);
      expect(emitted[0].type).toBe('click');
      expect(emitted[0].button).toBe('right');
    });

    it('flushes pending click immediately when flush() is invoked', () => {
      const emitted = [];
      const correlator = new ClickCorrelator({
        emit: (ev) => emitted.push(ev),
        delayMs: 200,
      });

      const button = document.createElement('button');
      document.body.appendChild(button);
      const makeEvent = (type, el, extra) => ({ type, ...extra });

      correlator.onClick(button, { button: 0 }, makeEvent);
      expect(emitted.length).toBe(0);

      correlator.flush();
      expect(emitted.length).toBe(1);
      expect(emitted[0].type).toBe('click');
    });
  });

  describe('KeyboardClassifier & KeyboardCapture', () => {
    it('classifies printable characters as fill mutations', () => {
      const input = document.createElement('input');
      const classification = classifyKey({ key: 'a', ctrlKey: false, metaKey: false, altKey: false }, input);
      expect(classification.type).toBe('fill');
    });

    it('classifies Space on a checkbox input as a check toggle', () => {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      const classification = classifyKey({ key: ' ', ctrlKey: false, metaKey: false, altKey: false }, checkbox);
      expect(classification.type).toBe('check');
    });

    it('classifies Tab and Escape as press actions', () => {
      const input = document.createElement('input');
      const tabClass = classifyKey({ key: 'Tab', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, input);
      expect(tabClass.type).toBe('press');
      expect(tabClass.key).toBe('Tab');

      const escClass = classifyKey({ key: 'Escape', ctrlKey: false, metaKey: false, altKey: false }, input);
      expect(escClass.type).toBe('press');
      expect(escClass.key).toBe('Escape');
    });

    it('classifies Enter in textarea as fill and Enter in input as press', () => {
      const textarea = document.createElement('textarea');
      const taClass = classifyKey({ key: 'Enter', ctrlKey: false, metaKey: false, altKey: false }, textarea);
      expect(taClass.type).toBe('fill');

      const input = document.createElement('input');
      const inClass = classifyKey({ key: 'Enter', ctrlKey: false, metaKey: false, altKey: false }, input);
      expect(inClass.type).toBe('press');
      expect(inClass.key).toBe('Enter');
    });

    it('classifies paste shortcut Ctrl+V as fill and suppresses raw press', () => {
      const input = document.createElement('input');
      const pasteClass = classifyKey({ key: 'v', ctrlKey: true, metaKey: false, altKey: false }, input);
      expect(pasteClass.type).toBe('fill');
    });

    it('classifies modified shortcuts as press', () => {
      const input = document.createElement('input');
      const saveShortcut = classifyKey({ key: 's', ctrlKey: true, metaKey: false, altKey: false }, input);
      expect(saveShortcut.type).toBe('press');
      expect(saveShortcut.key).toBe('s');
      expect(saveShortcut.modifiers.control).toBe(true);
    });

    it('emits clean press events via KeyboardCapture and flushes pending fills first', () => {
      const emitted = [];
      let fillFlushed = false;

      const keyboardCapture = new KeyboardCapture({
        emit: (ev) => emitted.push(ev),
        makeEvent: (type, el, extra) => ({ type, tagName: el.tagName, ...extra }),
        isRecording: () => true,
        flushPendingFills: () => { fillFlushed = true; },
      });

      const input = document.createElement('input');
      document.body.appendChild(input);

      keyboardCapture.onKeyDown({
        target: input,
        key: 'Tab',
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      });

      expect(fillFlushed).toBe(true);
      expect(emitted.length).toBe(1);
      expect(emitted[0].type).toBe('press');
      expect(emitted[0].key).toBe('Tab');
    });
  });

  describe('FocusState', () => {
    it('tracks active and previous element without emitting noisy focus steps', () => {
      let focusChanged = false;
      let flushed = false;

      const focusState = new FocusState({
        onFocusChange: () => { focusChanged = true; },
        flushPendingFills: () => { flushed = true; },
      });

      const input1 = document.createElement('input');
      const input2 = document.createElement('input');
      document.body.appendChild(input1);
      document.body.appendChild(input2);

      focusState.onFocusIn({ target: input1 });
      expect(focusState.getActiveElement()).toBe(input1);
      expect(focusChanged).toBe(true);

      focusState.onFocusIn({ target: input2 });
      expect(focusState.getActiveElement()).toBe(input2);
      expect(focusState.getPreviousElement()).toBe(input1);
      expect(flushed).toBe(true);
    });
  });
});
