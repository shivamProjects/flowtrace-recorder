/**
 * file-capture.js — Detached file input interceptor for modern SPAs and Oracle Redwood.
 *
 * In Redwood/JET and modern React/Vue applications, file upload triggers
 * (like dropzones or "Attach" buttons) frequently instantiate a detached
 * `<input type="file">` dynamically in memory, invoke `.click()`, and never
 * mount it to the DOM.
 *
 * This module hooks `HTMLInputElement.prototype.click` and `showPicker` to detect
 * detached file dialogs and binds the resulting file selection to the visible initiator.
 */

export class FileCapture {
  /**
   * @param {Object} [options]
   * @param {Function} [options.onFileSelected] Callback when files are selected: (uploadEvent) => void
   * @param {number} [options.initiatorWindowMs=2500] Time window to associate user click with detached input
   */
  constructor(options = {}) {
    this.onFileSelected = options.onFileSelected || (() => {});
    this.initiatorWindowMs = options.initiatorWindowMs || 2500;

    this._lastInitiator = null;
    this._lastInitiatorTime = 0;
    this._originalClick = null;
    this._originalShowPicker = null;
    this._installed = false;
    this._trackedInputs = new WeakSet();
    this._inputMetadata = new WeakMap();
  }

  /**
   * Record an element as a candidate upload initiator (e.g. from pointerdown/click).
   * @param {Element} el
   */
  recordInitiator(el) {
    if (!el || el.tagName === 'INPUT' && el.type === 'file') return;
    this._lastInitiator = el;
    this._lastInitiatorTime = Date.now();
  }

  /**
   * Get the active initiator if within the valid time window.
   * @returns {Element|null}
   */
  getActiveInitiator() {
    if (!this._lastInitiator) return null;
    if (Date.now() - this._lastInitiatorTime > this.initiatorWindowMs) {
      this._lastInitiator = null;
      return null;
    }
    return this._lastInitiator;
  }

  /**
   * Install prototype hooks into the current window.
   * @param {Window} [win=globalThis.window]
   */
  install(win = typeof window !== 'undefined' ? window : null) {
    if (!win || this._installed) return;

    const inputProto = win.HTMLInputElement?.prototype;
    if (!inputProto) return;

    const self = this;
    this._originalClick = inputProto.click;
    this._originalShowPicker = inputProto.showPicker;

    inputProto.click = function () {
      if (this.type === 'file') {
        self._interceptFileInput(this);
      }
      return self._originalClick.apply(this, arguments);
    };

    if (inputProto.showPicker) {
      inputProto.showPicker = function () {
        if (this.type === 'file') {
          self._interceptFileInput(this);
        }
        return self._originalShowPicker.apply(this, arguments);
      };
    }

    this._installed = true;
  }

  /**
   * Uninstall prototype hooks and restore originals.
   * @param {Window} [win=globalThis.window]
   */
  uninstall(win = typeof window !== 'undefined' ? window : null) {
    if (!this._installed) return;
    const inputProto = (win || (typeof window !== 'undefined' ? window : null))?.HTMLInputElement?.prototype;
    if (inputProto) {
      if (this._originalClick) inputProto.click = this._originalClick;
      if (this._originalShowPicker) inputProto.showPicker = this._originalShowPicker;
    }
    this._installed = false;
    this._originalClick = null;
    this._originalShowPicker = null;
    this._lastInitiator = null;
  }

  /**
   * Attach change listener to file input and associate with initiator.
   * @private
   */
  _interceptFileInput(inputEl) {
    const initiator = this.getActiveInitiator();
    const isDetached = !inputEl.isConnected;

    // Update active initiator metadata even if the input element is reused
    this._inputMetadata.set(inputEl, {
      initiator,
      isDetached,
      timestamp: Date.now(),
    });

    if (this._trackedInputs.has(inputEl)) return;
    this._trackedInputs.add(inputEl);

    const handleChange = () => {
      const meta = this._inputMetadata.get(inputEl) || {
        initiator: null,
        isDetached: !inputEl.isConnected,
      };

      const fileList = inputEl.files;
      const files = [];

      if (fileList) {
        for (let i = 0; i < fileList.length; i++) {
          const f = fileList[i];
          files.push({
            name: f.name,
            size: f.size,
            type: f.type,
            lastModified: f.lastModified,
          });
        }
      }

      if (files.length > 0) {
        this.onFileSelected({
          type: 'file-upload',
          isDetached: meta.isDetached,
          inputElement: inputEl,
          initiatorElement: meta.initiator,
          files,
          timestamp: Date.now(),
        });
      }

      inputEl.removeEventListener('change', handleChange);
      this._trackedInputs.delete(inputEl);
      this._inputMetadata.delete(inputEl);
    };

    inputEl.addEventListener('change', handleChange, { once: true });
  }
}
