/**
 * native-select.js — robust capture for native HTML <select> dropdowns.
 *
 * Implements:
 * 1. Single and multi-select change capture with label/value metadata.
 * 2. Same-value selection detection on blur (Oracle ADF / ERP parity):
 *    Opening a dropdown and re-selecting the same/default option does not fire a browser
 *    change event, but represents deliberate user intent. We track touched state and
 *    emit a select action on blur if no change event was fired.
 * 3. Duplicate suppression: change event marks touched as recorded, preventing double emission on blur.
 */

export class NativeSelectCapture {
  constructor(options = {}) {
    this._emit = options.emit || (() => {});
    this._makeEvent = options.makeEvent || ((type, el, extra) => ({ type, ...extra }));
    this._touched = null;
  }

  /**
   * Called when a pointerdown/mousedown/click/touch occurs on a <select> or <option>.
   * @param {Element} target
   * @param {Event} [event]
   */
  onTouch(target, event) {
    if (!target) return;
    // Passive focus navigation (e.g. Tab navigation) must not arm same-value blur emission
    if (event && ['focus', 'focusin'].includes(event.type)) {
      return;
    }
    const select = target.tagName === 'SELECT' ? target : target.closest?.('select');
    if (!select) return;

    this._touched = {
      el: select,
      initialValue: select.value,
      initialSelectedIndex: select.selectedIndex,
      recorded: false,
    };
  }

  /**
   * Called on 'change' event.
   * @param {HTMLSelectElement} select
   * @param {Event} event
   * @param {Function} [customMakeEvent]
   */
  onChange(select, event, customMakeEvent) {
    if (!select || select.tagName !== 'SELECT') return false;

    const makeEv = customMakeEvent || this._makeEvent;
    const isMultiple = select.multiple;

    if (this._touched && this._touched.el === select) {
      this._touched.recorded = true;
    }

    if (isMultiple) {
      const selected = Array.from(select.selectedOptions || []);
      const values = selected.map((o) => o.value);
      const labels = selected.map((o) => (o.text || o.label || '').trim());
      const ev = makeEv('select', select, {
        value: values.join(', '),
        values,
        meta: {
          multiple: true,
          optionValues: values,
          optionLabels: labels,
        },
      });
      this._emit(ev);
      return true;
    }

    const option = select.options[select.selectedIndex];
    if (!option) return false;

    const optionLabel = (option.text || option.label || '').trim();
    const ev = makeEv('select', select, {
      value: option.value,
      meta: {
        optionLabel,
        optionValue: option.value,
        selectedIndex: select.selectedIndex,
      },
    });
    this._emit(ev);
    return true;
  }

  /**
   * Called on 'blur' or 'focusout' event.
   * @param {Element} target
   * @param {Event} event
   * @param {Function} [customMakeEvent]
   */
  onBlur(target, event, customMakeEvent) {
    if (!target || !this._touched) return false;
    const select = target.tagName === 'SELECT' ? target : target.closest?.('select');
    if (!select || this._touched.el !== select) return false;

    const touched = this._touched;
    this._touched = null;

    // If change event already recorded this interaction, do not emit duplicate.
    if (touched.recorded) return false;

    // If the value did not change, emit same-value selection.
    const makeEv = customMakeEvent || this._makeEvent;
    const option = select.options[select.selectedIndex];
    if (!option) return false;

    const optionLabel = (option.text || option.label || '').trim();
    const ev = makeEv('select', select, {
      value: option.value,
      meta: {
        optionLabel,
        optionValue: option.value,
        selectedIndex: select.selectedIndex,
        sameValueSelect: true,
        isSameValueReSelection: true,
      },
    });
    this._emit(ev);
    return true;
  }

  reset() {
    this._touched = null;
  }
}
