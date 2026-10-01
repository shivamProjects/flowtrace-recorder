/**
 * frame-registry.js — Zero-CDP frame hierarchy and tab management.
 *
 * Tracks iframe nesting, frame locators, and cross-frame geometry translations
 * for accurate evidence capture and Playwright-compatible nested frame locators.
 */

export class FrameRegistry {
  /**
   * @param {Object} [options]
   * @param {number} [options.tabId=1]
   */
  constructor(options = {}) {
    this.tabId = options.tabId || 1;
    this.frames = new Map(); // frameId -> FrameInfo
    this.rootFrameId = 0;
  }

  /**
   * Determine if current execution context is the top-level window.
   * @param {Window} [win=globalThis.window]
   * @returns {boolean}
   */
  isTopFrame(win = typeof window !== 'undefined' ? window : null) {
    if (!win) return true;
    try {
      return win.self === win.top;
    } catch {
      // Cross-origin access failure implies iframe
      return false;
    }
  }

  /**
   * Register or update a frame in the registry.
   * @param {Object} frameInfo
   * @param {number} frameInfo.frameId
   * @param {number} [frameInfo.parentFrameId=null]
   * @param {string} [frameInfo.url='']
   * @param {string} [frameInfo.name='']
   * @param {string} [frameInfo.selector='']
   * @returns {Object} registered FrameInfo
   */
  registerFrame(frameInfo) {
    if (!frameInfo || typeof frameInfo.frameId !== 'number') {
      throw new Error('frameId is required');
    }

    const existing = this.frames.get(frameInfo.frameId) || {};
    const updated = {
      tabId: this.tabId,
      frameId: frameInfo.frameId,
      parentFrameId: frameInfo.parentFrameId !== undefined ? frameInfo.parentFrameId : (existing.parentFrameId ?? null),
      url: frameInfo.url || existing.url || '',
      name: frameInfo.name || existing.name || '',
      selector: frameInfo.selector || existing.selector || '',
      updatedAt: Date.now(),
    };

    this.frames.set(frameInfo.frameId, updated);
    return updated;
  }

  /**
   * Unregister a frame.
   * @param {number} frameId
   */
  unregisterFrame(frameId) {
    this.frames.delete(frameId);
  }

  /**
   * Get the chain of parent frames leading to the specified frameId.
   * Root frame (0) is first, target frame is last.
   *
   * @param {number} frameId
   * @returns {Array<Object>}
   */
  getFrameChain(frameId) {
    const chain = [];
    let currentId = frameId;
    const visited = new Set();

    while (currentId !== null && currentId !== undefined) {
      if (visited.has(currentId)) break; // Cycle guard
      visited.add(currentId);

      const frame = this.frames.get(currentId);
      if (!frame) break;

      chain.unshift(frame);
      currentId = frame.parentFrameId;
    }

    return chain;
  }

  /**
   * Generate Playwright-compatible frame locator expression.
   * Returns array of frame selector strings for nesting.
   *
   * @param {number} frameId
   * @returns {Array<string>}
   */
  getFrameLocators(frameId) {
    if (!frameId || frameId === 0) return [];

    const chain = this.getFrameChain(frameId);
    // Ignore top-level frame (frameId 0)
    const subFrames = chain.filter((f) => f.frameId !== 0);

    return subFrames.map((f) => {
      if (f.selector) return f.selector;
      if (f.name) return `iframe[name="${f.name}"]`;
      if (f.url && f.url !== 'about:blank') {
        try {
          const parsed = new URL(f.url);
          return `iframe[src*="${parsed.pathname}"]`;
        } catch {
          return `iframe[src="${f.url}"]`;
        }
      }
      return 'iframe';
    });
  }

  /**
   * Resolve an iframe element's selector within its parent document.
   * @param {HTMLIFrameElement} iframeEl
   * @returns {string}
   */
  deriveIframeSelector(iframeEl) {
    if (!iframeEl) return 'iframe';

    if (iframeEl.id) {
      return `iframe#${CSS.escape(iframeEl.id)}`;
    }
    if (iframeEl.name) {
      return `iframe[name="${CSS.escape(iframeEl.name)}"]`;
    }
    const src = iframeEl.getAttribute('src');
    if (src && src !== 'about:blank') {
      return `iframe[src="${src}"]`;
    }
    if (iframeEl.title) {
      return `iframe[title="${CSS.escape(iframeEl.title)}"]`;
    }
    return 'iframe';
  }

  /**
   * Compute absolute viewport coordinates for an element, accounting for iframe offsets.
   *
   * @param {DOMRect|Object} clientRect - getBoundingClientRect() of target element
   * @param {Array<{x: number, y: number}>} [frameOffsets=[]] - accumulated iframe offsets
   * @returns {{x: number, y: number, width: number, height: number, top: number, left: number, right: number, bottom: number}}
   */
  translateToAbsolute(clientRect, frameOffsets = []) {
    let totalOffsetX = 0;
    let totalOffsetY = 0;

    for (const offset of frameOffsets) {
      totalOffsetX += offset.x || 0;
      totalOffsetY += offset.y || 0;
    }

    const x = (clientRect.x ?? clientRect.left ?? 0) + totalOffsetX;
    const y = (clientRect.y ?? clientRect.top ?? 0) + totalOffsetY;
    const width = clientRect.width ?? 0;
    const height = clientRect.height ?? 0;

    return {
      x,
      y,
      top: y,
      left: x,
      width,
      height,
      right: x + width,
      bottom: y + height,
    };
  }
}
