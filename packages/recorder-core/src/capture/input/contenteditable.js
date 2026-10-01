/**
 * contenteditable.js — capture module for rich-text & contenteditable elements.
 *
 * Implements:
 * 1. Root editable resolution across child tags (<p>, <span>, <b>, <br>) and Shadow DOM.
 * 2. Clean text content extraction.
 * 3. Debounced fill action construction with credential masking support.
 */

import { cleanText } from '../../content/dom.js';

/**
 * Traverses upwards to find the root container with contenteditable="true" or isContentEditable.
 * @param {Node|Element} node
 * @returns {Element|null}
 */
export function resolveContentEditableRoot(node) {
  if (!node) return null;
  let curr = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;

  let root = null;
  while (curr && curr !== document.body && curr !== document.documentElement) {
    if (curr.isContentEditable || curr.getAttribute?.('contenteditable') === 'true' || curr.getAttribute?.('contenteditable') === '') {
      root = curr;
    } else if (root) {
      // Reached an ancestor that is no longer editable, so `root` is the boundary.
      break;
    }
    curr = curr.parentElement || (curr.getRootNode?.() instanceof ShadowRoot ? curr.getRootNode().host : null);
  }

  return root || (node.isContentEditable ? node : null);
}

/**
 * Extracts clean plain-text value from a contenteditable container.
 * @param {Element} root
 * @returns {string}
 */
export function extractContentEditableText(root) {
  if (!root) return '';
  // innerText preserves line breaks (<br>, <div>, <p>), textContent flattens them.
  const raw = root.innerText !== undefined ? root.innerText : root.textContent;
  return cleanText(raw || '');
}

export class ContentEditableCapture {
  constructor(options = {}) {
    this._emit = options.emit || (() => {});
    this._makeEvent = options.makeEvent || ((type, el, extra) => ({ type, ...extra }));
    this._isCredentialField = options.isCredentialField || (() => false);
    this._maskedFields = options.maskedFields || (() => ({ value: '••••••••', masked: true }));
    this._timers = new Map();
    this._debounceMs = options.debounceMs || 600;
  }

  /**
   * Checks if an element is or is inside a contenteditable root.
   * @param {Node|Element} el
   * @returns {boolean}
   */
  isEditable(el) {
    return !!resolveContentEditableRoot(el);
  }

  /**
   * Called on 'input' event inside a contenteditable element.
   * @param {Element} target
   * @param {Event} event
   * @param {string} selectorKey
   * @param {Function} [stillOursGuard]
   */
  onInput(target, event, selectorKey, stillOursGuard = () => true) {
    const root = resolveContentEditableRoot(target);
    if (!root) return false;

    const key = selectorKey || root.tagName + (root.id ? `#${root.id}` : '');
    const existing = this._timers.get(key);
    if (existing) clearTimeout(existing.timer);

    const flush = () => {
      if (!stillOursGuard()) return;
      const isSensitive = this._isCredentialField(root);
      const text = extractContentEditableText(root);

      const ev = this._makeEvent('fill', root, isSensitive
        ? this._maskedFields()
        : {
          value: text,
          meta: {
            isContentEditable: true,
          },
        });
      this._emit(ev);
    };

    const timer = setTimeout(() => {
      this._timers.delete(key);
      flush();
    }, this._debounceMs);

    this._timers.set(key, { timer, flush, target: root });
    return true;
  }

  /**
   * Flushes pending debounced fills for all or other targets.
   * @param {Element|null} [excludeTarget]
   */
  flushPending(excludeTarget = null) {
    for (const [key, entry] of this._timers.entries()) {
      if (excludeTarget && (entry.target === excludeTarget || entry.target.contains?.(excludeTarget))) {
        continue;
      }
      clearTimeout(entry.timer);
      this._timers.delete(key);
      entry.flush();
    }
  }

  reset() {
    for (const entry of this._timers.values()) {
      clearTimeout(entry.timer);
    }
    this._timers.clear();
  }
}
