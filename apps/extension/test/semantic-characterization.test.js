/**
 * semantic-characterization.test.js — Exhaustive Semantic Capture Characterization Suite
 *
 * Validates observational capture invariants across @flowtrace/recorder-core:
 * 1. ClickCorrelator: single click debounce, dblclick cancellation, right-click contextmenu, inter-target flushing.
 * 2. KeyboardClassifier & KeyboardCapture: typing debouncing, backspace/delete mutations, navigation presses (Tab, Escape, Enter, Arrows), modifier chords, Spacebar checkbox toggle.
 * 3. FocusState: active target provenance, blur settlement, zero-noise focus transitions.
 * 4. NativeSelectCapture: single/multi-select, same-value re-selection on blur, passive focus rejection.
 * 5. ContentEditableCapture: nested element root resolution, text extraction, debouncing.
 * 6. RangeCapture: continuous drag debounce, change settlement.
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ClickCorrelator,
  KeyboardCapture,
  classifyKey,
  FocusState,
  NativeSelectCapture,
  ContentEditableCapture,
  RangeCapture,
  resolveContentEditableRoot,
  extractContentEditableText,
} from '@flowtrace/recorder-core';

describe('TRACE-65: Phase 1 — Recorder Semantic Completeness & Characterization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // 1. Click vs Double-Click Correlation
  // ==========================================================================
  describe('1. Click vs Double-Click Correlation', () => {
    it('debounces single click and emits after correlation window', () => {
      const emitted = [];
      const correlator = new ClickCorrelator({
        emit: (ev) => emitted.push(ev),
        delayMs: 200,
      });

      const btn = document.createElement('button');
      btn.id = 'save-btn';
      document.body.appendChild(btn);

      const makeEvent = (type, el, extra) => ({ type, targetId: el.id, ...extra });

      correlator.onClick(btn, { button: 0, clientX: 100, clientY: 50 }, makeEvent);
      expect(emitted.length).toBe(0);

      // Advance clock past correlation window
      vi.advanceTimersByTime(200);
      expect(emitted.length).toBe(1);
      expect(emitted[0].type).toBe('click');
      expect(emitted[0].clickCount).toBe(1);
      expect(emitted[0].targetId).toBe('save-btn');
    });

    it('cancels pending single click on dblclick and emits exactly 1 dblclick (clickCount: 2)', () => {
      const emitted = [];
      const correlator = new ClickCorrelator({
        emit: (ev) => emitted.push(ev),
        delayMs: 200,
      });

      const row = document.createElement('tr');
      row.id = 'grid-row-1';
      document.body.appendChild(row);

      const makeEvent = (type, el, extra) => ({ type, targetId: el.id, ...extra });

      // First click
      correlator.onClick(row, { button: 0, clientX: 50, clientY: 20 }, makeEvent);
      expect(emitted.length).toBe(0);

      // 80ms later: second click triggers double click
      vi.advanceTimersByTime(80);
      correlator.onDoubleClick(row, { button: 0, clientX: 50, clientY: 20 }, makeEvent);

      // Should immediately emit dblclick and cancel single click
      expect(emitted.length).toBe(1);
      expect(emitted[0].type).toBe('dblclick');
      expect(emitted[0].clickCount).toBe(2);
      expect(emitted[0].targetId).toBe('grid-row-1');

      // Advancing past window produces NO second click
      vi.advanceTimersByTime(300);
      expect(emitted.length).toBe(1);
    });

    it('flushes pending click on element A when user clicks element B', () => {
      const emitted = [];
      const correlator = new ClickCorrelator({
        emit: (ev) => emitted.push(ev),
        delayMs: 200,
      });

      const btnA = document.createElement('button');
      btnA.id = 'btn-a';
      const btnB = document.createElement('button');
      btnB.id = 'btn-b';
      document.body.appendChild(btnA);
      document.body.appendChild(btnB);

      const makeEvent = (type, el, extra) => ({ type, targetId: el.id, ...extra });

      correlator.onClick(btnA, { button: 0 }, makeEvent);
      expect(emitted.length).toBe(0);

      // Clicking B immediately flushes A
      correlator.onClick(btnB, { button: 0 }, makeEvent);
      expect(emitted.length).toBe(1);
      expect(emitted[0].targetId).toBe('btn-a');

      vi.advanceTimersByTime(200);
      expect(emitted.length).toBe(2);
      expect(emitted[1].targetId).toBe('btn-b');
    });

    it('emits right-click contextmenu immediately with button: right', () => {
      const emitted = [];
      const correlator = new ClickCorrelator({
        emit: (ev) => emitted.push(ev),
        delayMs: 200,
      });

      const card = document.createElement('div');
      card.id = 'item-card';
      document.body.appendChild(card);

      const makeEvent = (type, el, extra) => ({ type, targetId: el.id, ...extra });

      correlator.onContextMenu(card, { button: 2, clientX: 120, clientY: 80 }, makeEvent);
      expect(emitted.length).toBe(1);
      expect(emitted[0].type).toBe('click');
      expect(emitted[0].button).toBe('right');
    });
  });

  // ==========================================================================
  // 2. Keyboard Classification & Navigation Keys
  // ==========================================================================
  describe('2. Keyboard Classification & Navigation Keys', () => {
    it('classifies printable characters, backspace, and delete as fill mutations', () => {
      const input = document.createElement('input');
      input.type = 'text';

      expect(classifyKey({ key: 'a' }, input).type).toBe('fill');
      expect(classifyKey({ key: 'Z' }, input).type).toBe('fill');
      expect(classifyKey({ key: '9' }, input).type).toBe('fill');
      expect(classifyKey({ key: 'Backspace' }, input).type).toBe('fill');
      expect(classifyKey({ key: 'Delete' }, input).type).toBe('fill');
    });

    it('ignores standalone modifier key presses', () => {
      const input = document.createElement('input');
      expect(classifyKey({ key: 'Shift' }, input).type).toBe('ignore');
      expect(classifyKey({ key: 'Control' }, input).type).toBe('ignore');
      expect(classifyKey({ key: 'Alt' }, input).type).toBe('ignore');
      expect(classifyKey({ key: 'Meta' }, input).type).toBe('ignore');
      expect(classifyKey({ key: 'CapsLock' }, input).type).toBe('ignore');
    });

    it('classifies navigation keys as press actions with modifier state', () => {
      const input = document.createElement('input');

      const tabClass = classifyKey({ key: 'Tab', shiftKey: true }, input);
      expect(tabClass.type).toBe('press');
      expect(tabClass.key).toBe('Tab');
      expect(tabClass.modifiers).toEqual({ shift: true });

      const escClass = classifyKey({ key: 'Escape' }, input);
      expect(escClass.type).toBe('press');
      expect(escClass.key).toBe('Escape');

      const downClass = classifyKey({ key: 'ArrowDown', altKey: true }, input);
      expect(downClass.type).toBe('press');
      expect(downClass.key).toBe('ArrowDown');
      expect(downClass.modifiers).toEqual({ alt: true });
    });

    it('classifies Space on checkbox/radio as check toggle, not fill or press', () => {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      expect(classifyKey({ key: ' ' }, checkbox).type).toBe('check');

      const radio = document.createElement('input');
      radio.type = 'radio';
      expect(classifyKey({ key: ' ' }, radio).type).toBe('check');
    });

    it('flushes pending fills before emitting press actions in KeyboardCapture', () => {
      const emitted = [];
      let flushedTarget = null;

      const keyboard = new KeyboardCapture({
        emit: (ev) => emitted.push(ev),
        makeEvent: (type, el, extra) => ({ type, targetId: el.id, ...extra }),
        isRecording: () => true,
        flushPendingFills: (target) => { flushedTarget = target; },
      });

      const input = document.createElement('input');
      input.id = 'txt-name';
      document.body.appendChild(input);

      // Pressing Tab inside text field
      keyboard.onKeyDown({
        target: input,
        key: 'Tab',
        shiftKey: false,
      });

      expect(flushedTarget).toBe(input);
      expect(emitted.length).toBe(1);
      expect(emitted[0].type).toBe('press');
      expect(emitted[0].key).toBe('Tab');
    });
  });

  // ==========================================================================
  // 3. Focus State & Active Target Provenance
  // ==========================================================================
  describe('3. Focus State & Active Target Provenance', () => {
    it('tracks active target snapshot and triggers fill flush on boundary transition', () => {
      let flushedTarget = null;
      let focusChanges = [];

      const focusState = new FocusState({
        flushPendingFills: (target) => { flushedTarget = target; },
        onFocusChange: (newSnap, oldSnap) => focusChanges.push({ newSnap, oldSnap }),
      });

      const input1 = document.createElement('input');
      input1.id = 'field-1';
      const input2 = document.createElement('input');
      input2.id = 'field-2';
      document.body.appendChild(input1);
      document.body.appendChild(input2);

      // Focus in on input1
      focusState.onFocusIn({ target: input1 });
      expect(focusState.getActiveElement()).toBe(input1);
      expect(focusState.getActiveSnapshot().meta.id).toBe('field-1');

      // Shift focus to input2
      focusState.onFocusIn({ target: input2 });
      expect(focusState.getActiveElement()).toBe(input2);
      expect(focusState.getActiveSnapshot().meta.id).toBe('field-2');
      expect(flushedTarget).toBe(input2); // Target being moved to
      expect(focusChanges.length).toBe(2);
    });

    it('flushes pending fill on blur without emitting noisy focus actions', () => {
      let flushed = false;
      const focusState = new FocusState({
        flushPendingFills: () => { flushed = true; },
      });

      const input = document.createElement('input');
      input.id = 'field-main';
      document.body.appendChild(input);

      focusState.onFocusIn({ target: input });
      focusState.onFocusOut({ target: input });

      vi.advanceTimersByTime(10);
      expect(flushed).toBe(true);
      expect(focusState.getActiveElement()).toBeNull();
    });
  });

  // ==========================================================================
  // 4. Native Select Capture & Same-Value Blur Intent
  // ==========================================================================
  describe('4. Native Select Capture & Same-Value Intent', () => {
    it('captures standard change event on native <select>', () => {
      const emitted = [];
      const selectCapture = new NativeSelectCapture({
        emit: (ev) => emitted.push(ev),
        makeEvent: (type, el, extra) => ({ type, id: el.id, ...extra }),
      });

      const select = document.createElement('select');
      select.id = 'currency-select';
      const opt1 = new Option('USD - US Dollar', 'USD');
      const opt2 = new Option('EUR - Euro', 'EUR');
      select.add(opt1);
      select.add(opt2);
      document.body.appendChild(select);

      select.value = 'EUR';
      selectCapture.onChange(select, { type: 'change' });

      expect(emitted.length).toBe(1);
      expect(emitted[0].type).toBe('select');
      expect(emitted[0].value).toBe('EUR');
      expect(emitted[0].meta.optionLabel).toBe('EUR - Euro');
    });

    it('captures deliberate same-value re-selection on blur when touched', () => {
      const emitted = [];
      const selectCapture = new NativeSelectCapture({
        emit: (ev) => emitted.push(ev),
        makeEvent: (type, el, extra) => ({ type, id: el.id, ...extra }),
      });

      const select = document.createElement('select');
      select.id = 'org-select';
      const opt1 = new Option('Default Org', 'DEF', true, true);
      const opt2 = new Option('Secondary Org', 'SEC');
      select.add(opt1);
      select.add(opt2);
      document.body.appendChild(select);

      // 1. User clicks the select (arms onTouch)
      selectCapture.onTouch(select, { type: 'pointerdown' });

      // 2. User re-selects the default option (no browser change event fired)
      // 3. User blurs out of select
      selectCapture.onBlur(select, { type: 'blur' });

      expect(emitted.length).toBe(1);
      expect(emitted[0].type).toBe('select');
      expect(emitted[0].value).toBe('DEF');
      expect(emitted[0].meta.optionLabel).toBe('Default Org');
      expect(emitted[0].meta.sameValueSelect).toBe(true);
    });

    it('does NOT arm same-value capture on passive tab/focus navigation', () => {
      const emitted = [];
      const selectCapture = new NativeSelectCapture({
        emit: (ev) => emitted.push(ev),
      });

      const select = document.createElement('select');
      select.id = 'passive-select';
      select.add(new Option('Option A', 'A', true, true));
      document.body.appendChild(select);

      // Passive focus navigation
      selectCapture.onTouch(select, { type: 'focus' });
      selectCapture.onBlur(select, { type: 'blur' });

      expect(emitted.length).toBe(0);
    });
  });

  // ==========================================================================
  // 5. ContentEditable Rich-Text Capture
  // ==========================================================================
  describe('5. ContentEditable Rich-Text Capture', () => {
    it('resolves root container across nested paragraphs and spans', () => {
      const editor = document.createElement('div');
      editor.setAttribute('contenteditable', 'true');
      editor.id = 'rich-editor';

      const p = document.createElement('p');
      const span = document.createElement('span');
      span.textContent = 'Rich formatted message';
      p.appendChild(span);
      editor.appendChild(p);
      document.body.appendChild(editor);

      const resolved = resolveContentEditableRoot(span);
      expect(resolved).toBe(editor);
      expect(extractContentEditableText(editor)).toBe('Rich formatted message');
    });

    it('debounces continuous typing in contenteditable into single fill action', () => {
      const emitted = [];
      const ceCapture = new ContentEditableCapture({
        emit: (ev) => emitted.push(ev),
        makeEvent: (type, el, extra) => ({ type, id: el.id, ...extra }),
        debounceMs: 250,
      });

      const editor = document.createElement('div');
      editor.setAttribute('contenteditable', 'true');
      editor.id = 'notes-box';
      document.body.appendChild(editor);

      editor.textContent = 'Note line 1';
      ceCapture.onInput(editor, { type: 'input' }, '#notes-box');

      vi.advanceTimersByTime(100);
      editor.textContent = 'Note line 1: approved by lead';
      ceCapture.onInput(editor, { type: 'input' }, '#notes-box');

      expect(emitted.length).toBe(0);

      vi.advanceTimersByTime(250);
      expect(emitted.length).toBe(1);
      expect(emitted[0].type).toBe('fill');
      expect(emitted[0].value).toBe('Note line 1: approved by lead');
      expect(emitted[0].meta.isContentEditable).toBe(true);
    });
  });

  // ==========================================================================
  // 6. Range Slider Capture
  // ==========================================================================
  describe('6. Range Slider Capture', () => {
    it('debounces drag inputs and commits final value on change with range metadata', () => {
      const emitted = [];
      const rangeCapture = new RangeCapture({
        emit: (ev) => emitted.push(ev),
        makeEvent: (type, el, extra) => ({ type, id: el.id, ...extra }),
        debounceMs: 200,
      });

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.id = 'volume-slider';
      slider.min = '0';
      slider.max = '100';
      slider.step = '5';
      slider.value = '20';
      document.body.appendChild(slider);

      // Dragging events
      slider.value = '35';
      rangeCapture.onInput(slider, { type: 'input' }, '#volume-slider');

      slider.value = '60';
      rangeCapture.onInput(slider, { type: 'input' }, '#volume-slider');

      slider.value = '75';
      rangeCapture.onChange(slider, { type: 'change' });

      // Change event commits immediately
      expect(emitted.length).toBe(1);
      expect(emitted[0].type).toBe('fill');
      expect(emitted[0].value).toBe('75');
      expect(emitted[0].meta.isRange).toBe(true);
      expect(emitted[0].meta.min).toBe('0');
      expect(emitted[0].meta.max).toBe('100');
      expect(emitted[0].meta.step).toBe('5');
    });
  });

  // ==========================================================================
  // 7. Event Provenance Model (isTrusted & Synthetic Classification)
  // ==========================================================================
  describe('7. Event Provenance Model', () => {
    it('correctly classifies human-primary, framework-derived, and flowtrace-generated events', async () => {
      const { classifyEventProvenance, isRecordableEvent, ProvenanceCategory } = await import('@flowtrace/recorder-core');

      // Human trusted event
      const trustedEvent = { isTrusted: true, type: 'click' };
      expect(classifyEventProvenance(trustedEvent)).toBe(ProvenanceCategory.HUMAN_PRIMARY);
      expect(isRecordableEvent(trustedEvent)).toBe(true);

      // Framework synthetic event (e.g. React / Oracle JET)
      const frameworkEvent = { isTrusted: false, type: 'ojRowAction' };
      expect(classifyEventProvenance(frameworkEvent)).toBe(ProvenanceCategory.FRAMEWORK_DERIVED);
      expect(isRecordableEvent(frameworkEvent)).toBe(true);

      // FlowTrace internal event
      const internalEvent = { isTrusted: false, __flowtrace_internal__: true, type: 'input' };
      expect(classifyEventProvenance(internalEvent)).toBe(ProvenanceCategory.FLOWTRACE_GENERATED);
      expect(isRecordableEvent(internalEvent)).toBe(false);

      // Autofill dispatch mode
      window.__FLOWTRACE_DISPATCHING_AUTOFILL__ = true;
      const autofillEvent = { isTrusted: false, type: 'input' };
      expect(classifyEventProvenance(autofillEvent)).toBe(ProvenanceCategory.FLOWTRACE_GENERATED);
      expect(isRecordableEvent(autofillEvent)).toBe(false);
      delete window.__FLOWTRACE_DISPATCHING_AUTOFILL__;
    });
  });

  // ==========================================================================
  // 8. Spacebar Checkbox Ordering & ARIA Checkbox
  // ==========================================================================
  describe('8. Spacebar Checkbox Ordering & ARIA Checkbox', () => {
    it('defers native input checkbox to native change cycle to prevent duplicate/inverted state', () => {
      const emitted = [];
      const keyboard = new KeyboardCapture({
        emit: (ev) => emitted.push(ev),
        makeEvent: (type, el, extra) => ({ type, id: el.id, ...extra }),
        isRecording: () => true,
      });

      const nativeCheckbox = document.createElement('input');
      nativeCheckbox.type = 'checkbox';
      nativeCheckbox.id = 'native-chk';
      nativeCheckbox.checked = false;
      document.body.appendChild(nativeCheckbox);

      // Space on native checkbox must not emit immediately in keydown
      keyboard.onKeyDown({ target: nativeCheckbox, key: ' ' });
      expect(emitted.length).toBe(0);
    });

    it('emits check action with inverted aria-checked state for custom role="checkbox"', () => {
      const emitted = [];
      const keyboard = new KeyboardCapture({
        emit: (ev) => emitted.push(ev),
        makeEvent: (type, el, extra) => ({ type, id: el.id, ...extra }),
        isRecording: () => true,
      });

      const customCheckbox = document.createElement('div');
      customCheckbox.setAttribute('role', 'checkbox');
      customCheckbox.setAttribute('aria-checked', 'false');
      customCheckbox.id = 'custom-chk';
      document.body.appendChild(customCheckbox);

      // Space on custom ARIA checkbox
      keyboard.onKeyDown({ target: customCheckbox, key: ' ' });
      expect(emitted.length).toBe(1);
      expect(emitted[0].type).toBe('check');
      expect(emitted[0].checked).toBe(true);
    });
  });

  // ==========================================================================
  // 9. Zero-Drop Invariant: Legacy Boolean Hook & Empty Claim Fallback (TRACE-71)
  // ==========================================================================
  describe('9. Zero-Drop Invariant: Legacy Boolean Hook & Empty Claim Fallback (TRACE-71)', () => {
    it('does not drop generic click when adapter returns pass or empty claim', () => {
      const emitted = [];
      const correlator = new ClickCorrelator({
        emit: (ev) => emitted.push(ev),
        delayMs: 200,
      });

      const btn = document.createElement('button');
      btn.id = 'submit-btn';
      document.body.appendChild(btn);

      const makeEvent = (type, el, extra) => ({ type, targetId: el.id, ...extra });

      // When an adapter hook returns true/empty without candidate, evaluateAdapterObservation
      // returns { kind: 'pass' }, so generic ClickCorrelator captures the click without suppression.
      correlator.onClick(btn, { button: 0, clientX: 10, clientY: 10 }, makeEvent, {});
      vi.advanceTimersByTime(200);

      expect(emitted.length).toBe(1);
      expect(emitted[0].type).toBe('click');
      expect(emitted[0].targetId).toBe('submit-btn');
    });
  });
});

