/**
 * click-correlator.js — correlates single click, double-click, and right-click interaction episodes.
 *
 * Prevents rapid double clicks from emitting two spurious single-click actions.
 * A single click is delayed for a short observational window (~200ms). If a `dblclick`
 * event arrives on the same target within this window, the pending single click is
 * cancelled and a single `dblclick` action is emitted.
 */

function extractModifiers(event) {
  if (!event) return undefined;
  const mods = {};
  if (event.altKey) mods.alt = true;
  if (event.ctrlKey) mods.control = true;
  if (event.metaKey) mods.meta = true;
  if (event.shiftKey) mods.shift = true;
  return Object.keys(mods).length > 0 ? mods : undefined;
}

function extractPosition(event) {
  if (!event || typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return undefined;
  return { x: Math.round(event.clientX), y: Math.round(event.clientY) };
}

function resolveButton(event) {
  if (!event || typeof event.button !== 'number') return undefined;
  if (event.button === 2) return 'right';
  if (event.button === 1) return 'middle';
  return 'left';
}

export class ClickCorrelator {
  /**
   * @param {Object} options
   * @param {Function} options.emit  callback receiving the compiled event to send
   * @param {number} [options.delayMs=200]  correlation window duration in ms
   */
  constructor({ emit, delayMs = 200 }) {
    if (typeof emit !== 'function') {
      throw new Error('ClickCorrelator requires an emit callback');
    }
    this._emit = emit;
    this._delayMs = delayMs;
    this._pendingClick = null;
  }

  /**
   * Handle single click.
   * @param {Element} target
   * @param {MouseEvent} event
   * @param {Function} makeEventFn
   * @param {Object} [extraPayload]
   */
  onClick(target, event, makeEventFn, extraPayload = {}) {
    const modifiers = extractModifiers(event);
    const position = extractPosition(event);
    const button = resolveButton(event);

    // If a right-click or middle-click triggered this, emit immediately with button
    if (button === 'right' || button === 'middle') {
      this.flush();
      const ev = makeEventFn('click', target, {
        button,
        clickCount: 1,
        ...(modifiers ? { modifiers } : {}),
        ...(position ? { position } : {}),
        ...extraPayload,
      });
      this._emit(ev);
      return;
    }

    // Flush any earlier pending click on a different element
    if (this._pendingClick && this._pendingClick.target !== target) {
      this.flush();
    }

    // Cancel existing timer on same element if double click is being formed
    if (this._pendingClick) {
      clearTimeout(this._pendingClick.timer);
    }

    const timer = setTimeout(() => {
      if (this._pendingClick && this._pendingClick.timer === timer) {
        const payload = this._pendingClick.eventPayload;
        this._pendingClick = null;
        this._emit(payload);
      }
    }, this._delayMs);

    const eventPayload = makeEventFn('click', target, {
      clickCount: 1,
      ...(button && button !== 'left' ? { button } : {}),
      ...(modifiers ? { modifiers } : {}),
      ...(position ? { position } : {}),
      ...extraPayload,
    });

    this._pendingClick = {
      target,
      timer,
      eventPayload,
    };
  }

  /**
   * Handle double click.
   * @param {Element} target
   * @param {MouseEvent} event
   * @param {Function} makeEventFn
   * @param {Object} [extraPayload]
   */
  onDoubleClick(target, event, makeEventFn, extraPayload = {}) {
    // Cancel the pending single click!
    if (this._pendingClick) {
      clearTimeout(this._pendingClick.timer);
      this._pendingClick = null;
    }

    const modifiers = extractModifiers(event);
    const position = extractPosition(event);
    const button = resolveButton(event);

    const ev = makeEventFn('dblclick', target, {
      clickCount: 2,
      ...(button && button !== 'left' ? { button } : {}),
      ...(modifiers ? { modifiers } : {}),
      ...(position ? { position } : {}),
      ...extraPayload,
    });
    this._emit(ev);
  }

  /**
   * Handle contextmenu (right-click).
   * @param {Element} target
   * @param {MouseEvent} event
   * @param {Function} makeEventFn
   * @param {Object} [extraPayload]
   */
  onContextMenu(target, event, makeEventFn, extraPayload = {}) {
    this.flush();
    const modifiers = extractModifiers(event);
    const position = extractPosition(event);

    const ev = makeEventFn('click', target, {
      button: 'right',
      clickCount: 1,
      ...(modifiers ? { modifiers } : {}),
      ...(position ? { position } : {}),
      ...extraPayload,
    });
    this._emit(ev);
  }

  /**
   * Immediately flush and emit any pending single click.
   */
  flush() {
    if (this._pendingClick) {
      clearTimeout(this._pendingClick.timer);
      const payload = this._pendingClick.eventPayload;
      this._pendingClick = null;
      this._emit(payload);
    }
  }

  /**
   * Cancel any pending single click without emitting.
   */
  cancel() {
    if (this._pendingClick) {
      clearTimeout(this._pendingClick.timer);
      this._pendingClick = null;
    }
  }

  /**
   * @returns {boolean}
   */
  hasPending() {
    return this._pendingClick !== null;
  }
}
