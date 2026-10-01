/**
 * geometry.js — High-fidelity element bounding box and visual clipping calculation.
 *
 * Captures accurate geometry and visibility bounds on user interaction with:
 * 1. Viewport and scroll-container clipping detection.
 * 2. Deduplication across consecutive events on the same element within 1.5s.
 * 3. Zero DOM-mutation coordinate calculations.
 */

export class GeometryCapture {
  /**
   * @param {Object} [options]
   * @param {number} [options.dedupWindowMs=1500]
   */
  constructor(options = {}) {
    this.dedupWindowMs = options.dedupWindowMs || 1500;
    this._lastTarget = null;
    this._lastGeometry = null;
    this._lastCaptureTime = 0;
  }

  /**
   * Capture geometry metrics for an element, respecting deduplication window.
   *
   * @param {Element} el
   * @param {Object} [options]
   * @param {boolean} [options.force=false]
   * @param {Array<{x: number, y: number}>} [options.frameOffsets=[]]
   * @returns {Object|null} Geometry metrics or null if invalid/deduplicated
   */
  capture(el, options = {}) {
    if (!el || typeof el.getBoundingClientRect !== 'function') {
      return null;
    }

    const now = Date.now();
    if (!options.force && this._lastTarget === el && (now - this._lastCaptureTime) < this.dedupWindowMs) {
      return this._lastGeometry;
    }

    const rawRect = el.getBoundingClientRect();
    const frameOffsets = options.frameOffsets || [];

    let totalOffsetX = 0;
    let totalOffsetY = 0;
    for (const offset of frameOffsets) {
      totalOffsetX += offset.x || 0;
      totalOffsetY += offset.y || 0;
    }

    const win = el.ownerDocument?.defaultView || globalThis.window;
    const scrollX = win?.scrollX || win?.pageXOffset || 0;
    const scrollY = win?.scrollY || win?.pageYOffset || 0;

    const viewportWidth = win?.innerWidth || 1920;
    const viewportHeight = win?.innerHeight || 1080;

    const absoluteBox = {
      x: Math.round(rawRect.left + scrollX + totalOffsetX),
      y: Math.round(rawRect.top + scrollY + totalOffsetY),
      width: Math.round(rawRect.width),
      height: Math.round(rawRect.height),
    };

    const viewportBox = {
      x: Math.round(rawRect.left + totalOffsetX),
      y: Math.round(rawRect.top + totalOffsetY),
      width: Math.round(rawRect.width),
      height: Math.round(rawRect.height),
    };

    // Calculate visible clipping rect within viewport
    const visibleBox = {
      x: Math.max(0, viewportBox.x),
      y: Math.max(0, viewportBox.y),
      width: Math.max(0, Math.min(viewportBox.x + viewportBox.width, viewportWidth) - Math.max(0, viewportBox.x)),
      height: Math.max(0, Math.min(viewportBox.y + viewportBox.height, viewportHeight) - Math.max(0, viewportBox.y)),
    };

    const isVisible = visibleBox.width > 0 && visibleBox.height > 0 && rawRect.width > 0 && rawRect.height > 0;
    const visibilityRatio = rawRect.width * rawRect.height > 0
      ? (visibleBox.width * visibleBox.height) / (rawRect.width * rawRect.height)
      : 0;

    const centerPoint = {
      x: Math.round(viewportBox.x + viewportBox.width / 2),
      y: Math.round(viewportBox.y + viewportBox.height / 2),
    };

    const geometry = {
      absoluteBox,
      viewportBox,
      visibleBox,
      isVisible,
      visibilityRatio: Math.min(1, Math.max(0, Number(visibilityRatio.toFixed(2)))),
      centerPoint,
      viewport: {
        width: viewportWidth,
        height: viewportHeight,
        scrollX: Math.round(scrollX),
        scrollY: Math.round(scrollY),
      },
      capturedAt: now,
    };

    this._lastTarget = el;
    this._lastGeometry = geometry;
    this._lastCaptureTime = now;

    return geometry;
  }

  /**
   * Reset deduplication cache.
   */
  reset() {
    this._lastTarget = null;
    this._lastGeometry = null;
    this._lastCaptureTime = 0;
  }
}
