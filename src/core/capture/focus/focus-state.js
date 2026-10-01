/**
 * focus-state.js — observational active target tracking without step noise.
 *
 * Tracks the currently active/focused element and boundary transitions across focusin/focusout.
 * Focus changes do NOT emit noisy focus/blur recorded steps into the workflow, but supply
 * provenance for subsequent input, keyboard, and file interactions and trigger clean fill flushes.
 */

export class FocusState {
  /**
   * @param {Object} [options]
   * @param {Function} [options.onFocusChange]  callback(newActive, oldActive)
   * @param {Function} [options.flushPendingFills] callback to flush pending input
   */
  constructor(options = {}) {
    this._activeElement = null;
    this._previousElement = null;
    this._lastFocusTime = 0;
    this._onFocusChange = options.onFocusChange || (() => {});
    this._flushPendingFills = options.flushPendingFills || (() => {});
  }

  /**
   * Handle focusin.
   * @param {FocusEvent} event
   */
  onFocusIn(event) {
    const target = event.target;
    if (!target || !(target instanceof Element)) return;

    if (this._activeElement !== target) {
      const oldActive = this._activeElement;
      this._previousElement = oldActive;
      this._activeElement = target;
      this._lastFocusTime = Date.now();

      // If moving away from an editable input, flush any pending fills
      if (oldActive && (oldActive.tagName === 'INPUT' || oldActive.tagName === 'TEXTAREA' || oldActive.isContentEditable)) {
        this._flushPendingFills(target);
      }

      this._onFocusChange(this._activeElement, oldActive);
    }
  }

  /**
   * Handle focusout.
   * @param {FocusEvent} event
   */
  onFocusOut(event) {
    const target = event.target;
    if (this._activeElement === target) {
      // Defer clearing activeElement slightly in case focus shifts to another element within same tick
      setTimeout(() => {
        if (this._activeElement === target) {
          this._previousElement = target;
          this._activeElement = null;
          this._flushPendingFills();
        }
      }, 0);
    }
  }

  /**
   * @returns {Element|null}
   */
  getActiveElement() {
    return this._activeElement || (typeof document !== 'undefined' ? document.activeElement : null);
  }

  /**
   * @returns {Element|null}
   */
  getPreviousElement() {
    return this._previousElement;
  }

  /**
   * @returns {number}
   */
  getLastFocusTime() {
    return this._lastFocusTime;
  }

  /**
   * Reset focus state.
   */
  reset() {
    this._activeElement = null;
    this._previousElement = null;
    this._lastFocusTime = 0;
  }
}
