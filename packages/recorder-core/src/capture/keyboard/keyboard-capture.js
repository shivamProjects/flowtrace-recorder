/**
 * keyboard-capture.js — captures semantic keyboard interactions.
 *
 * Emits clean `press` actions for navigation, function keys, and keyboard shortcuts,
 * while directing typing and text edits to the fill pipeline and spacebar to checkbox toggling.
 */

import { classifyKey } from './key-classifier.js';
import { isWidgetNode } from '../../content/widget.js';
import { isRecordableEvent } from '../provenance/event-provenance.js';

export class KeyboardCapture {
  /**
   * @param {Object} options
   * @param {Function} options.emit
   * @param {Function} options.makeEvent
   * @param {Function} options.isRecording
   * @param {Function} [options.flushPendingFills]
   */
  constructor({ emit, makeEvent, isRecording, flushPendingFills }) {
    this._emit = emit;
    this._makeEvent = makeEvent;
    this._isRecording = isRecording;
    this._flushPendingFills = flushPendingFills || (() => {});
  }

  /**
   * Handle keydown event.
   * @param {KeyboardEvent} event
   */
  onKeyDown(event) {
    if (!this._isRecording()) return;
    if (!isRecordableEvent(event)) return;

    const target = event.target;
    if (!target || !(target instanceof Element)) return;
    if (isWidgetNode(target)) return;

    const classification = classifyKey(event, target);

    if (classification.type === 'ignore') {
      return;
    }

    if (classification.type === 'fill') {
      // Text mutation: flush pending fills on other elements if focus shifted
      this._flushPendingFills(target);
      return;
    }

    if (classification.type === 'check') {
      this._flushPendingFills(target);
      // For native input checkboxes/radios, the browser will synthesize native click/change events
      // upon key release, which capture.js captures with the updated checked state.
      // Emitting here would race with the native event and invert state.
      const isNativeInput = target.tagName === 'INPUT' && (target.type === 'checkbox' || target.type === 'radio');
      if (!isNativeInput) {
        const isChecked = target.getAttribute?.('aria-checked') !== 'true';
        const ev = this._makeEvent('check', target, {
          checked: isChecked,
          meta: { source: 'keyboard-space' },
        });
        this._emit(ev);
      }
      return;
    }

    if (classification.type === 'press') {
      // A navigation or command key commits any preceding typed text first
      this._flushPendingFills(target);

      const ev = this._makeEvent('press', target, {
        key: classification.key,
        modifiers: classification.modifiers,
        meta: {
          key: classification.key,
          modifiers: classification.modifiers,
        },
      });
      this._emit(ev);
    }
  }
}
