/**
 * range.js — capture module for HTML range slider inputs (<input type="range">).
 *
 * Implements:
 * 1. Debounced dragging capture during rapid 'input' events.
 * 2. Instant value settlement on 'change' event.
 * 3. Range metadata (min, max, step) capture for faithful replay.
 */

export class RangeCapture {
  constructor(options = {}) {
    this._emit = options.emit || (() => {});
    this._makeEvent = options.makeEvent || ((type, el, extra) => ({ type, ...extra }));
    this._debounceMs = options.debounceMs || 300;
    this._timers = new Map();
  }

  isRange(el) {
    return el && el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'range';
  }

  onInput(input, event, selectorKey, stillOursGuard = () => true) {
    if (!this.isRange(input)) return false;

    const key = selectorKey || (input.id ? `#${input.id}` : 'input[type="range"]');
    const existing = this._timers.get(key);
    if (existing) clearTimeout(existing.timer);

    const flush = () => {
      if (!stillOursGuard()) return;
      this._emitValue(input);
    };

    const timer = setTimeout(() => {
      this._timers.delete(key);
      flush();
    }, this._debounceMs);

    this._timers.set(key, { timer, flush, target: input });
    return true;
  }

  onChange(input, event) {
    if (!this.isRange(input)) return false;

    // Clear any pending debounced input timer
    for (const [key, entry] of this._timers.entries()) {
      if (entry.target === input) {
        clearTimeout(entry.timer);
        this._timers.delete(key);
      }
    }

    this._emitValue(input);
    return true;
  }

  _emitValue(input) {
    const val = input.value;
    const min = input.getAttribute('min') || '0';
    const max = input.getAttribute('max') || '100';
    const step = input.getAttribute('step') || '1';

    const ev = this._makeEvent('fill', input, {
      value: val,
      meta: {
        isRange: true,
        min,
        max,
        step,
      },
    });
    this._emit(ev);
  }

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
