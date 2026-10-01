/**
 * capture.js — turns DOM interactions into RecordedEvents.
 *
 * Listeners are registered in the CAPTURING phase so they run before the
 * application's own handlers, which on component frameworks routinely call
 * stopPropagation and would otherwise swallow the interaction entirely.
 *
 * Synthetic events are deliberately NOT filtered on `isTrusted`. React, Vue,
 * Angular and ADF all dispatch untrusted clicks as part of their normal event
 * systems; excluding them would drop most interactions on a modern application.
 */

import { safeInvoke } from '../shared/patch-api.js';
import { isSensitiveField, maskedFields, maskEvent } from '../shared/sensitive.js';
import { makeNavigateEvent } from '../shared/types.js';
import { cleanLabel, cleanText, isVisible, resolveLabel, retargetToInteractive, roleOf } from './dom.js';
import { buildLocatorObject } from './locator-object.js';
import { generateSelector } from './selector.js';
import { frameInfo } from './frames.js';
import { GeometryCapture } from '../evidence/geometry.js';
import { FileCapture } from '../bridge/file-capture.js';
import { isWidgetNode } from './widget.js';
import { detectRequired } from './required.js';
import * as bus from './bus.js';

import { resolveInteractiveTarget } from '../capture/targeting/target-resolver.js';
import { ClickCorrelator } from '../capture/pointer/click-correlator.js';
import { KeyboardCapture } from '../capture/keyboard/keyboard-capture.js';
import { FocusState } from '../capture/focus/focus-state.js';

const FILL_DEBOUNCE_MS = 600;
const CHECKBOX_REEMIT_MS = 500;

let patch = null;
let ctx = null;
let listeners = [];
let fileCapture = null;
let clickCorrelator = null;
let keyboardCapture = null;
let focusState = null;
const geometryCapture = new GeometryCapture();
const fillTimers = new Map();
const lastCheckboxEmit = new WeakMap();

/**
 * @param {Object} activePatch  already run through normalisePatch()
 */
export function startCapture(activePatch) {
  stopCapture();
  patch = activePatch;
  ctx = buildContext();

  safeInvoke(`${patch.id}.start`, patch.capture.start, undefined, ctx);

  clickCorrelator = new ClickCorrelator({
    emit: (ev) => send(ev),
    delayMs: 200,
  });

  keyboardCapture = new KeyboardCapture({
    emit: (ev) => send(ev),
    makeEvent,
    isRecording: () => bus.isRecording(),
    flushPendingFills: (exclude) => flushPendingFills(exclude),
  });

  focusState = new FocusState({
    flushPendingFills: (exclude) => flushPendingFills(exclude),
  });

  // Install detached file upload interceptor
  fileCapture = new FileCapture({
    onFileSelected: (uploadEvent) => {
      const initiator = uploadEvent.initiatorElement || uploadEvent.initiator || (document.body ? document.body : null);
      const ev = makeEvent('upload', initiator, {
        files: uploadEvent.files,
        value: uploadEvent.files.map((f) => f.name).join(', '),
        meta: {
          isDetached: uploadEvent.isDetached,
          fileCount: uploadEvent.fileCount,
        },
      });
      ctx.emit(ev);
    },
  });
  fileCapture.install();

  on(document, 'click', onClick, true);
  on(document, 'dblclick', onDoubleClick, true);
  on(document, 'contextmenu', onContextMenu, true);
  on(document, 'keydown', onKeyDown, true);
  on(document, 'focusin', onFocusIn, true);
  on(document, 'focusout', onFocusOut, true);
  on(document, 'input', onInput, true);
  on(document, 'change', onChange, true);
  installNavigationHooks();
}

/** @returns {Object} final patch context snapshot to merge before postProcess */
export function stopCapture() {
  let snapshot = {};
  if (patch && ctx) {
    snapshot = safeInvoke(`${patch.id}.stop`, patch.capture.stop, {}, ctx) || {};
  }
  if (fileCapture) {
    fileCapture.uninstall();
    fileCapture = null;
  }
  for (const off of listeners) off();
  listeners = [];
  if (clickCorrelator) {
    clickCorrelator.flush();
    clickCorrelator = null;
  }
  if (focusState) {
    focusState.reset();
    focusState = null;
  }
  keyboardCapture = null;
  flushPendingFills();
  patch = null;
  ctx = null;
  return snapshot;
}

function flushPendingFills(excludeTarget = null) {
  for (const [key, entry] of fillTimers.entries()) {
    if (excludeTarget && (entry.target === excludeTarget || entry.target.contains(excludeTarget))) {
      continue;
    }
    clearTimeout(entry.timer);
    fillTimers.delete(key);
    entry.flush();
  }
}

// ── event construction ──────────────────────────────────────────────────────

/**
 * Build a normalised event without emitting it.
 * @param {string} type
 * @param {Element|null} el
 * @param {Object} [extra]  merged last, so it can override any field
 */
export function makeEvent(type, el, extra = {}) {
  const labelResolver = patch?.resolve?.label;
  const selector = generateSelector(el, labelResolver ? { resolveLabel: labelResolver } : {});
  const label = el ? (labelResolver ? labelResolver(el) : resolveLabel(el)) : null;

  // Patch annotations go in first so the selector generator's attribute bag
  // wins on collision — a patch may add to meta, not rewrite it.
  const patchMeta = el && patch?.resolve?.meta
    ? safeInvoke(`${patch.id}.resolve.meta`, patch.resolve.meta, {}, el)
    : null;

  // Core detection is merged after the selector bag rather than before the
  // patch one, because `sensitive` is the single annotation that must not be
  // overridable: a patch may add it, nothing may take it away.
  const meta = { ...patchMeta, ...selector.raw };
  if (el && isSensitiveField(el)) meta.sensitive = true;

  const reqVerdict = el ? detectRequired(el) : null;
  if (reqVerdict && reqVerdict.required !== null) {
    meta.required = reqVerdict.required;
    meta.requiredSource = reqVerdict.source;
    meta.requiredScope = reqVerdict.scope;
  }

  // The structured locator, built ONCE here while the element is still in the
  // page. Every field of it is a fallback the replayer can try when the primary
  // selector has drifted; none of them can be recovered from the event list
  // afterwards. It travels alongside the `locator` EXPRESSION rather than
  // replacing it, because the generated Playwright script still needs the
  // string form.
  const locatorObject = el
    ? buildLocatorObject(el, { resolveLabel: labelResolver, selector, meta })
    : null;

  const geometry = el ? geometryCapture.capture(el) : null;

  return {
    type,
    timestamp: Date.now(),
    ...frameInfo(),
    url: window.location.href,
    selector: selector.selector,
    locator: selector.locator,
    locatorObject,
    geometry,
    tagName: el ? el.tagName.toLowerCase() : null,
    inputType: el && el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text') : null,
    value: null,
    checked: null,
    text: el ? cleanText(el.textContent) : null,
    label,
    role: el ? roleOf(el) : null,
    ...(reqVerdict && reqVerdict.required !== null
      ? {
        required: reqVerdict.required,
        requiredSource: reqVerdict.source,
        requiredScope: reqVerdict.scope,
      }
      : {}),
    meta,
    ...extra,
  };
}

/**
 * Emit an event, with any credential in it replaced by the mask.
 *
 * The masking happens in the page, at the last moment before the message hop,
 * so a real password never crosses a process boundary — the service worker,
 * storage and the network only ever see the mask. The core fill path below
 * never builds the value at all; this is the backstop for events a patch
 * constructed itself and handed to `ctx.emit`.
 */
function send(event) {
  bus.sendEvent(maskEvent(event));
}

/**
 * Whether this field's value must never be read.
 *
 * Asked BEFORE the event is built, which is why it duplicates the `resolve.meta`
 * call that makeEvent will also make: knowing after the fact that a field was
 * sensitive is too late to avoid having read it. The cost is one extra hook
 * call per debounced fill, not per keystroke.
 *
 * @param {Element} el
 */
function isCredentialField(el) {
  if (isSensitiveField(el)) return true;
  if (!patch?.resolve?.meta) return false;
  const patchMeta = safeInvoke(`${patch.id}.resolve.meta`, patch.resolve.meta, {}, el);
  return !!(patchMeta && patchMeta.sensitive);
}

/** Services handed to patch hooks. Patches never touch chrome.* directly. */
function buildContext() {
  return {
    patchId: patch.id,
    makeEvent,
    emit: (event) => send(event),
    updateContext: (partial) => bus.sendPatchContext(partial),
    selectorFor: (el) => generateSelector(el, patch?.resolve?.label
      ? { resolveLabel: patch.resolve.label }
      : {}),
    labelFor: (el) => (patch?.resolve?.label ? patch.resolve.label(el) : resolveLabel(el)),
    guard: bus.guard,
    log: (...args) => console.log(`[recorder:${patch.id}]`, ...args),
  };
}

// ── handlers ────────────────────────────────────────────────────────────────

function onClick(e) {
  if (!bus.isRecording()) return;
  const target = resolveInteractiveTarget(e) || e.target;
  if (!target || !target.closest) return;
  if (isWidgetNode(target)) return;

  // Flush any pending debounced fills so that a fill preceding this click is
  // emitted BEFORE the click, preserving chronological user interaction order.
  flushPendingFills(target);

  if (fileCapture) fileCapture.recordInitiator(target);

  // The patch gets first refusal. Returning true means it has already emitted
  // something more accurate than a generic click — an LOV row selection, a date
  // fill — and the core must not also emit.
  const claimed = safeInvoke(`${patch.id}.onClick`, patch.capture.onClick, false, target, e, ctx);
  if (claimed === true) {
    if (clickCorrelator) clickCorrelator.cancel();
    return;
  }

  if (isCheckboxLike(target)) {
    if (clickCorrelator) clickCorrelator.flush();
    emitCheckbox(target, e);
    return;
  }

  if (target.querySelectorAll) {
    const boxes = target.querySelectorAll('input[type="checkbox"], input[type="radio"]');
    if (boxes.length === 1 && isVisible(boxes[0])) {
      emitCheckbox(boxes[0], e);
      return;
    }
  }

  // <select> is handled on 'change', where the chosen option is known.
  if (target.tagName === 'SELECT') return;

  const interactive = retargetToInteractive(target);
  const el = interactive || target;
  if (clickCorrelator) {
    clickCorrelator.onClick(el, e, makeEvent);
  } else {
    send(makeEvent('click', el));
  }
}

function onDoubleClick(e) {
  if (!bus.isRecording()) return;
  const target = resolveInteractiveTarget(e) || e.target;
  if (!target || !target.closest) return;
  if (isWidgetNode(target)) return;

  flushPendingFills(target);

  const claimed = safeInvoke(`${patch.id}.onDoubleClick`, patch.capture.onDoubleClick, false, target, e, ctx);
  if (claimed === true) {
    if (clickCorrelator) clickCorrelator.cancel();
    return;
  }

  if (isCheckboxLike(target) || target.tagName === 'SELECT') return;

  const interactive = retargetToInteractive(target);
  const el = interactive || target;
  if (clickCorrelator) {
    clickCorrelator.onDoubleClick(el, e, makeEvent);
  } else {
    send(makeEvent('dblclick', el, { clickCount: 2 }));
  }
}

function onContextMenu(e) {
  if (!bus.isRecording()) return;
  const target = resolveInteractiveTarget(e) || e.target;
  if (!target || !target.closest) return;
  if (isWidgetNode(target)) return;

  flushPendingFills(target);

  const claimed = safeInvoke(`${patch.id}.onContextMenu`, patch.capture.onContextMenu, false, target, e, ctx);
  if (claimed === true) {
    if (clickCorrelator) clickCorrelator.cancel();
    return;
  }

  const interactive = retargetToInteractive(target);
  const el = interactive || target;
  if (clickCorrelator) {
    clickCorrelator.onContextMenu(el, e, makeEvent);
  } else {
    send(makeEvent('click', el, { button: 'right', clickCount: 1 }));
  }
}

function onKeyDown(e) {
  if (keyboardCapture) {
    keyboardCapture.onKeyDown(e);
  }
}

function onFocusIn(e) {
  if (focusState) {
    focusState.onFocusIn(e);
  }
}

function onFocusOut(e) {
  if (focusState) {
    focusState.onFocusOut(e);
  }
}

function onInput(e) {
  if (!bus.isRecording()) return;
  const target = e.target;
  if (!target) return;
  const tag = target.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;
  const type = (target.getAttribute('type') || '').toLowerCase();
  if (type === 'checkbox' || type === 'radio' || type === 'file') return;

  safeInvoke(`${patch.id}.onInput`, patch.capture.onInput, undefined, target, e, ctx);

  // Emit one fill per pause rather than one per keystroke.
  const key = generateSelector(target).selector;
  const existing = fillTimers.get(key);
  if (existing) clearTimeout(existing.timer);
  const stillOurs = bus.guard();
  const flush = () => {
    if (!stillOurs()) return;
    // `target.value` is never read for a credential field. The mask is passed
    // in place of it rather than written over it afterwards, so the secret is
    // never a property of an object anything else could reach.
    send(makeEvent('fill', target, isCredentialField(target)
      ? maskedFields()
      : { value: target.value }));
  };
  const timer = setTimeout(() => {
    fillTimers.delete(key);
    flush();
  }, FILL_DEBOUNCE_MS);
  fillTimers.set(key, { timer, flush, target });
}

function onChange(e) {
  if (!bus.isRecording()) return;
  const target = e.target;
  if (!target) return;

  const key = generateSelector(target)?.selector;
  if (key && fillTimers.has(key)) {
    const entry = fillTimers.get(key);
    clearTimeout(entry.timer);
    fillTimers.delete(key);
    entry.flush();
  }

  safeInvoke(`${patch.id}.onChange`, patch.capture.onChange, undefined, target, e, ctx);

  if (target.tagName === 'SELECT') {
    const option = target.options[target.selectedIndex];
    if (!option) return;
    send(makeEvent('select', target, {
      value: option.value,
      meta: { optionLabel: (option.text || '').trim(), optionValue: option.value },
    }));
    return;
  }

  if (target.tagName === 'INPUT' && (target.getAttribute('type') || '').toLowerCase() === 'file') {
    const fileList = target.files;
    const files = [];
    if (fileList) {
      for (let i = 0; i < fileList.length; i++) {
        files.push(fileList[i].name);
      }
    }
    const fileName = files[0] || (target.value ? target.value.split(/[\\/]/).pop() : 'upload.dat');
    send(makeEvent('setInputFiles', target, {
      files: files.length > 0 ? files : [fileName],
      value: files.join(', ') || fileName,
    }));
    return;
  }

  if (target.tagName === 'INPUT' && (target.getAttribute('type') || '').toLowerCase() === 'checkbox') {
    emitCheckbox(target, null);
  }
}

// ── checkboxes ──────────────────────────────────────────────────────────────

function isCheckboxLike(el) {
  if (!el) return false;
  if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'checkbox') return true;
  return el.getAttribute('role') === 'checkbox';
}

/**
 * A checkbox produces both a click and a change, and either can arrive first
 * depending on how the control is implemented. Emit once per toggle.
 *
 * @param {Element} box
 * @param {MouseEvent|null} clickEvent  null when called from 'change'
 */
function emitCheckbox(box, clickEvent) {
  const last = lastCheckboxEmit.get(box);
  if (last && Date.now() - last < CHECKBOX_REEMIT_MS) return;
  lastCheckboxEmit.set(box, Date.now());

  const label = resolveCheckboxLabel(box, clickEvent && clickEvent.target);
  if (!label) return;

  // On click the state has not flipped yet; on change it has.
  const current = box.tagName === 'INPUT'
    ? !!box.checked
    : box.getAttribute('aria-checked') === 'true';
  const checked = clickEvent ? !current : current;

  send(makeEvent('check', box, {
    checked,
    label: cleanLabel(label),
    value: checked ? 'true' : 'false',
  }));
}

/**
 * Checkboxes in data grids frequently have no label at all, so this falls back
 * to the row's first text-bearing cell — which is what identifies the row to a
 * human reading the generated script.
 */
function resolveCheckboxLabel(box, clickTarget) {
  if (clickTarget && clickTarget.tagName === 'LABEL') return clickTarget.textContent.trim();

  const direct = resolveLabel(box);
  if (direct) return direct;

  const row = box.closest('tr');
  if (row) {
    for (const cell of row.querySelectorAll('td, th')) {
      if (cell.contains(box)) continue;
      const text = (cell.textContent || '').trim();
      if (text && text.length < 60) return text;
    }
  }
  return '';
}

// ── navigation ──────────────────────────────────────────────────────────────

let lastUrl = window.location.href;

function handleNavigation(url) {
  if (!bus.isRecording()) return;
  if (url === lastUrl) return;
  lastUrl = url;
  bus.sendEvent(makeNavigateEvent(url, frameInfo()));
}

/**
 * Single-page navigations do not fire a load event, so history is patched.
 * The originals are captured once at module scope; re-wrapping on every
 * start/stop cycle would nest wrappers and fire duplicates.
 */
const originalPushState = history.pushState.bind(history);
const originalReplaceState = history.replaceState.bind(history);
let navigationHooksInstalled = false;

function installNavigationHooks() {
  if (navigationHooksInstalled) return;
  navigationHooksInstalled = true;

  history.pushState = function pushState(...args) {
    originalPushState(...args);
    handleNavigation(window.location.href);
  };
  history.replaceState = function replaceState(...args) {
    originalReplaceState(...args);
    handleNavigation(window.location.href);
  };
  window.addEventListener('popstate', () => handleNavigation(window.location.href));
  document.addEventListener('DOMContentLoaded', () => handleNavigation(window.location.href));
}

function on(target, type, handler, capture) {
  target.addEventListener(type, handler, capture);
  listeners.push(() => target.removeEventListener(type, handler, capture));
}
