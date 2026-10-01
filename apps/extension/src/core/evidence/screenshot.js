/**
 * screenshot.js — Zero DOM-mutation evidence screenshot manager for extension service worker.
 *
 * Captures visible tab screenshots via `chrome.tabs.captureVisibleTab` and produces
 * highlight bounds as metadata overlays without injecting or mutating elements in the page.
 */

export class ScreenshotManager {
  /**
   * @param {Object} [options]
   * @param {number} [options.debounceMs=400]
   * @param {Object} [options.captureProvider] Custom capture provider for test environments
   */
  constructor(options = {}) {
    this.debounceMs = options.debounceMs || 400;
    this.captureProvider = options.captureProvider || null;

    this._pendingCaptures = new Map(); // windowId/tabId -> { timer, resolve, reject }
    this._cache = new Map(); // stepId -> screenshot payload
  }

  /**
   * Capture visible tab screenshot for a given window/tab.
   *
   * @param {Object} params
   * @param {number} [params.windowId]
   * @param {number} [params.tabId]
   * @param {Object} [params.geometry] Element bounding box geometry
   * @param {string} [params.format='png'] 'png' or 'jpeg'
   * @param {number} [params.quality=80]
   * @returns {Promise<Object>} Screenshot evidence payload
   */
  async captureTab(params = {}) {
    const { windowId, tabId, geometry, format = 'png', quality = 80 } = params;
    const targetKey = `${windowId ?? 0}_${tabId ?? 0}`;

    if (this.captureProvider) {
      const dataUrl = await this.captureProvider.captureVisibleTab(windowId, { format, quality });
      return this._formatEvidence(dataUrl, geometry, format);
    }

    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.captureVisibleTab) {
      return new Promise((resolve, reject) => {
        // Debounce if multiple capture requests arrive in rapid succession
        if (this._pendingCaptures.has(targetKey)) {
          clearTimeout(this._pendingCaptures.get(targetKey).timer);
        }

        const timer = setTimeout(() => {
          this._pendingCaptures.delete(targetKey);
          chrome.tabs.captureVisibleTab(windowId, { format, quality }, (dataUrl) => {
            if (chrome.runtime?.lastError) {
              return reject(new Error(chrome.runtime.lastError.message));
            }
            if (!dataUrl) {
              return reject(new Error('captureVisibleTab returned empty dataUrl'));
            }
            resolve(this._formatEvidence(dataUrl, geometry, format));
          });
        }, this.debounceMs);

        this._pendingCaptures.set(targetKey, { timer, resolve, reject });
      });
    }

    throw new Error('Screenshot capture provider is not available');
  }

  /**
   * Format evidence record containing image data and highlight coordinates.
   * @private
   */
  _formatEvidence(dataUrl, geometry, format) {
    return {
      type: 'screenshot',
      mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      dataUrl,
      highlight: geometry?.viewportBox ? {
        x: geometry.viewportBox.x,
        y: geometry.viewportBox.y,
        width: geometry.viewportBox.width,
        height: geometry.viewportBox.height,
      } : null,
      viewport: geometry?.viewport || null,
      capturedAt: Date.now(),
    };
  }

  /**
   * Clear pending timers and cached evidence.
   */
  clear() {
    for (const [, pending] of this._pendingCaptures) {
      clearTimeout(pending.timer);
    }
    this._pendingCaptures.clear();
    this._cache.clear();
  }
}
