/**
 * surface-registry.js — Multi-tab and popup surface management for FlowTrace Recorder.
 *
 * In zero-CDP FlowTrace recording, browser tabs and popups are tracked as logical "Surfaces".
 * A recording session owns one or more surfaces (e.g. main page + popup authentication window).
 *
 * Each Surface maintains:
 * - surfaceId: unique stable identifier within the recording session
 * - sessionId: parent recording session ID
 * - tabId: Chrome tab ID
 * - windowId: Chrome window ID
 * - openerSurfaceId: surface that spawned this popup (if any)
 * - kind: 'page' | 'popup'
 * - url: current surface URL
 * - state: 'active' | 'navigating' | 'closed'
 * - createdAt: timestamp
 */

export class SurfaceRegistry {
  /**
   * @param {Object} [options]
   * @param {string} [options.sessionId]
   * @param {Function} [options.onSurfaceAdded]
   * @param {Function} [options.onSurfaceRemoved]
   * @param {Function} [options.onSurfaceUpdated]
   */
  constructor(options = {}) {
    this.sessionId = options.sessionId || 'default';
    this.onSurfaceAdded = options.onSurfaceAdded || (() => {});
    this.onSurfaceRemoved = options.onSurfaceRemoved || (() => {});
    this.onSurfaceUpdated = options.onSurfaceUpdated || (() => {});

    /** @type {Map<string, Object>} surfaceId -> SurfaceContext */
    this._surfaces = new Map();
    /** @type {Map<number, string>} tabId -> surfaceId */
    this._tabToSurface = new Map();
    this._nextSurfaceIndex = 1;
  }

  /**
   * Derive a clean namespace prefix for this session.
   * @private
   */
  _prefix() {
    const clean = String(this.sessionId || 'default').replace(/[^a-zA-Z0-9]/g, '');
    return `surf_${clean.slice(-8)}`;
  }

  /**
   * Set or update the active recording session ID.
   * @param {string} sessionId
   */
  setSessionId(sessionId) {
    this.sessionId = sessionId || 'default';
  }

  /**
   * Register or acquire a primary root surface for a tab.
   * @param {number} tabId
   * @param {Object} [details]
   * @param {string} [details.url]
   * @param {number} [details.windowId]
   * @returns {Object} SurfaceContext
   */
  registerPrimary(tabId, details = {}) {
    const existingId = this._tabToSurface.get(tabId);
    if (existingId && this._surfaces.has(existingId)) {
      const surface = this._surfaces.get(existingId);
      if (details.url) surface.url = details.url;
      if (details.windowId) surface.windowId = details.windowId;
      return surface;
    }

    const surfaceId = `${this._prefix()}_main_${tabId}`;
    const surface = {
      surfaceId,
      sessionId: this.sessionId,
      tabId,
      windowId: details.windowId || null,
      openerSurfaceId: null,
      kind: 'page',
      url: details.url || '',
      createdAt: Date.now(),
      state: 'active',
    };

    this._surfaces.set(surfaceId, surface);
    this._tabToSurface.set(tabId, surfaceId);
    this.onSurfaceAdded(surface);
    return surface;
  }

  /**
   * Register a newly opened popup tab spawned from an opener tab.
   * @param {number} tabId
   * @param {number|null} openerTabId
   * @param {Object} [details]
   * @returns {Object} SurfaceContext
   */
  registerPopup(tabId, openerTabId = null, details = {}) {
    const existingId = this._tabToSurface.get(tabId);
    if (existingId && this._surfaces.has(existingId)) {
      return this._surfaces.get(existingId);
    }

    const openerSurfaceId = openerTabId ? this._tabToSurface.get(openerTabId) || null : null;
    const surfaceIndex = this._nextSurfaceIndex++;
    const surfaceId = `${this._prefix()}_popup_${surfaceIndex}_${tabId}`;

    const surface = {
      surfaceId,
      sessionId: this.sessionId,
      tabId,
      windowId: details.windowId || null,
      openerSurfaceId,
      kind: 'popup',
      url: details.url || '',
      createdAt: Date.now(),
      state: 'active',
    };

    this._surfaces.set(surfaceId, surface);
    this._tabToSurface.set(tabId, surfaceId);
    this.onSurfaceAdded(surface);
    return surface;
  }

  /**
   * Update surface URL / state upon navigation.
   * @param {number} tabId
   * @param {string} url
   * @param {string} [state='active']
   * @returns {Object|null}
   */
  updateNavigation(tabId, url, state = 'active') {
    const surfaceId = this._tabToSurface.get(tabId);
    if (!surfaceId || !this._surfaces.has(surfaceId)) return null;

    const surface = this._surfaces.get(surfaceId);
    surface.url = url;
    surface.state = state;
    this.onSurfaceUpdated(surface);
    return surface;
  }

  /**
   * Mark a surface as closed when its tab is removed.
   * @param {number} tabId
   * @returns {Object|null}
   */
  removeTab(tabId) {
    const surfaceId = this._tabToSurface.get(tabId);
    if (!surfaceId || !this._surfaces.has(surfaceId)) return null;

    const surface = this._surfaces.get(surfaceId);
    surface.state = 'closed';
    this._tabToSurface.delete(tabId);
    this._surfaces.delete(surfaceId);
    this.onSurfaceRemoved(surface);
    return surface;
  }

  /**
   * Get surface by tab ID.
   * @param {number} tabId
   * @returns {Object|null}
   */
  getByTabId(tabId) {
    const surfaceId = this._tabToSurface.get(tabId);
    return surfaceId ? this._surfaces.get(surfaceId) || null : null;
  }

  /**
   * Get surface by surface ID.
   * @param {string} surfaceId
   * @returns {Object|null}
   */
  getById(surfaceId) {
    return this._surfaces.get(surfaceId) || null;
  }

  /**
   * Check if a tab belongs to this recording session.
   * @param {number} tabId
   * @returns {boolean}
   */
  hasTab(tabId) {
    return this._tabToSurface.has(tabId);
  }

  /**
   * Get all active surfaces.
   * @returns {Array<Object>}
   */
  getAll() {
    return Array.from(this._surfaces.values());
  }

  /**
   * Clear all surfaces and reset state.
   */
  clear() {
    this._surfaces.clear();
    this._tabToSurface.clear();
    this._nextSurfaceIndex = 1;
  }

  /**
   * Export JSON snapshot for persistence across service worker lifecycle.
   * @returns {Object}
   */
  toJSON() {
    return {
      sessionId: this.sessionId,
      surfaces: Array.from(this._surfaces.entries()),
      tabToSurface: Array.from(this._tabToSurface.entries()),
      nextSurfaceIndex: this._nextSurfaceIndex,
    };
  }

  /**
   * Restore from persisted JSON state.
   * @param {Object} json
   */
  fromJSON(json) {
    if (!json) return;
    this.clear();
    if (json.sessionId) {
      this.sessionId = json.sessionId;
    }
    if (Array.isArray(json.surfaces)) {
      this._surfaces = new Map(json.surfaces);
    }
    if (Array.isArray(json.tabToSurface)) {
      this._tabToSurface = new Map(json.tabToSurface);
    }
    if (typeof json.nextSurfaceIndex === 'number') {
      this._nextSurfaceIndex = json.nextSurfaceIndex;
    }
  }
}
