/**
 * focus-state.js — observational active target tracking with snapshot provenance.
 *
 * Tracks the currently active/focused element and boundary transitions across focusin/focusout.
 * Focus changes do NOT emit noisy focus/blur recorded steps into the workflow, but supply
 * provenance snapshots for subsequent input, keyboard, and file interactions and trigger clean fill flushes.
 */

import { takeTargetSnapshot } from '../targeting/target-snapshot.js';

export class FocusState {
  /**
   * @param {Object} [options]
   * @param {Function} [options.onFocusChange]  callback(newSnapshot, oldSnapshot)
   * @param {Function} [options.flushPendingFills] callback to flush pending input
   */
  constructor(options = {}) {
    this._activeElement = null;
    this._previousElement = null;
    this._activeSnapshot = null;
    this._previousSnapshot = null;
    this._generation = 0;
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
      const oldSnapshot = this._activeSnapshot;

      this._previousElement = oldActive;
      this._previousSnapshot = oldSnapshot;
      this._activeElement = target;
      this._activeSnapshot = takeTargetSnapshot(target);
      this._generation++;
      this._lastFocusTime = Date.now();

      // If moving away from an editable input, flush any pending fills
      if (oldActive && (oldActive.tagName === 'INPUT' || oldActive.tagName === 'TEXTAREA' || oldActive.isContentEditable)) {
        this._flushPendingFills(target);
      }

      this._onFocusChange(this._activeSnapshot, oldSnapshot);
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
          this._previousSnapshot = this._activeSnapshot;
          this._activeElement = null;
          this._activeSnapshot = null;
          this._flushPendingFills();
        }
      }, 0);
    }
  }

  /**
   * @returns {import('../targeting/target-snapshot.js').TargetSnapshot|null}
   */
  getActiveSnapshot() {
    return this._activeSnapshot;
  }

  /**
   * @returns {import('../targeting/target-snapshot.js').TargetSnapshot|null}
   */
  getPreviousSnapshot() {
    return this._previousSnapshot;
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
  getGeneration() {
    return this._generation;
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
    this._activeSnapshot = null;
    this._previousSnapshot = null;
    this._generation = 0;
    this._lastFocusTime = 0;
  }
}
