/**
 * key-classifier.js — classifies raw keyboard events into semantic intent categories.
 *
 * Categorises keydown events into:
 *  - 'ignore': Modifier-only keys (Shift, Ctrl, Alt, Meta, CapsLock)
 *  - 'check': Space on checkbox / radio
 *  - 'fill': Printable text typing, Backspace/Delete, Enter in textarea/contenteditable, paste shortcuts
 *  - 'press': Navigation (Tab, Escape, Arrows, Function keys, Command shortcuts, Enter)
 */

const MODIFIER_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'AltGraph',
]);

const NAVIGATION_KEYS = new Set([
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
]);

/**
 * @typedef {Object} KeyClassification
 * @property {'ignore'|'check'|'fill'|'press'} type
 * @property {string} [key]
 * @property {Object} [modifiers]
 */

/**
 * Classifies a KeyboardEvent.
 * @param {KeyboardEvent} event
 * @param {Element|null} target
 * @returns {KeyClassification}
 */
export function classifyKey(event, target) {
  const key = event.key;
  if (!key) return { type: 'ignore' };

  // 1. Modifier-only keys are ignored
  if (MODIFIER_KEYS.has(key)) {
    return { type: 'ignore' };
  }

  const isCtrlOrMeta = event.ctrlKey || event.metaKey;
  const tag = target && target.tagName ? target.tagName.toUpperCase() : '';
  const role = target && target.getAttribute ? (target.getAttribute('role') || '').toLowerCase() : '';
  const inputType = target && target.getAttribute ? (target.getAttribute('type') || '').toLowerCase() : '';
  const isContentEditable = target && target.isContentEditable;

  // 2. Space key on checkbox/radio toggles the check state
  if (
    (key === ' ' || key === 'Spacebar' || key === 'Space') &&
    ((tag === 'INPUT' && (inputType === 'checkbox' || inputType === 'radio')) || role === 'checkbox' || role === 'radio')
  ) {
    return { type: 'check' };
  }

  // 3. Paste shortcut (Ctrl+V / Cmd+V) results in a text mutation/fill, suppress separate press('v')
  if (isCtrlOrMeta && (key === 'v' || key === 'V')) {
    return { type: 'fill' };
  }

  // 4. Enter inside a textarea or contenteditable is a newline insertion (fill), not a navigation press
  if (key === 'Enter' && (tag === 'TEXTAREA' || isContentEditable) && !isCtrlOrMeta) {
    return { type: 'fill' };
  }

  // 5. Backspace / Delete inside text fields is an edit mutation (fill), not a press
  if ((key === 'Backspace' || key === 'Delete') && (tag === 'INPUT' || tag === 'TEXTAREA' || isContentEditable) && !isCtrlOrMeta) {
    return { type: 'fill' };
  }

  // 6. Navigation keys are press actions
  if (NAVIGATION_KEYS.has(key)) {
    return {
      type: 'press',
      key,
      modifiers: extractModifiers(event),
    };
  }

  // 7. Modified command shortcuts (e.g. Ctrl+A, Ctrl+C, Ctrl+Z, Ctrl+Enter) are press actions
  if (isCtrlOrMeta || event.altKey) {
    return {
      type: 'press',
      key,
      modifiers: extractModifiers(event),
    };
  }

  // 8. Enter key on buttons, links, or standard inputs is a press action
  if (key === 'Enter') {
    return {
      type: 'press',
      key: 'Enter',
      modifiers: extractModifiers(event),
    };
  }

  // 9. Single printable characters are typing mutations (fill)
  if (key.length === 1 && !isCtrlOrMeta) {
    return { type: 'fill' };
  }

  // Fallback for any other special keys
  return {
    type: 'press',
    key,
    modifiers: extractModifiers(event),
  };
}

/**
 * Extract active modifier state from a KeyboardEvent.
 * @param {KeyboardEvent} event
 * @returns {Object}
 */
export function extractModifiers(event) {
  if (!event) return undefined;
  const mods = {};
  if (event.ctrlKey) mods.control = true;
  if (event.altKey) mods.alt = true;
  if (event.shiftKey) mods.shift = true;
  if (event.metaKey) mods.meta = true;
  return Object.keys(mods).length > 0 ? mods : undefined;
}
