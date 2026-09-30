/**
 * observers.js — Zero-CDP browser-level lifecycle observers and effect correlators.
 *
 * Replaces CDP's Target.attachedToTarget, Page.frameNavigated, and Page.downloadWillBegin
 * using standard, robust Chrome extension APIs:
 *   1. PopupObserver: captures popups, tracks openerTabId, auto-injects content script.
 *   2. NavigationObserver: tracks URL changes, webNavigation lifecycle, and SPA transitions.
 *   3. DownloadObserver: tracks file downloads triggered by user interactions.
 *   4. EffectCorrelator: correlates asynchronous browser effects back to initiating actions.
 */

export class EffectCorrelator {
  /**
   * @param {Object} [options]
   * @param {number} [options.correlationWindowMs=5000]
   */
  constructor(options = {}) {
    this.correlationWindowMs = options.correlationWindowMs || 5000;
    this._recentActions = [];
    this._pendingEffects = [];
  }

  /**
   * Record a user interaction that might cause a downstream browser effect.
   * @param {Object} action Recorded user action
   */
  recordAction(action) {
    const now = Date.now();
    this._cleanOld(now);
    this._recentActions.push({
      action,
      timestamp: now,
    });
  }

  /**
   * Correlate an observed browser effect to the most recent relevant user action.
   * @param {Object} effect Observed effect (popup, navigation, download)
   * @returns {Object|null} Correlated action or null
   */
  correlateEffect(effect) {
    const now = Date.now();
    this._cleanOld(now);

    // Search backwards for the most recent compatible action
    for (let i = this._recentActions.length - 1; i >= 0; i--) {
      const candidate = this._recentActions[i];
      if (now - candidate.timestamp <= this.correlationWindowMs) {
        // If surface matches or effect was spawned by this surface
        if (!effect.surfaceId || candidate.action.surfaceId === effect.surfaceId || candidate.action.surfaceId === effect.openerSurfaceId) {
          candidate.action.effects = candidate.action.effects || [];
          candidate.action.effects.push(effect);
          return candidate.action;
        }
      }
    }

    this._pendingEffects.push({ effect, timestamp: now });
    return null;
  }

  _cleanOld(now) {
    this._recentActions = this._recentActions.filter((a) => (now - a.timestamp) <= this.correlationWindowMs);
    this._pendingEffects = this._pendingEffects.filter((e) => (now - e.timestamp) <= this.correlationWindowMs);
  }

  clear() {
    this._recentActions = [];
    this._pendingEffects = [];
  }
}

export class LifecycleObservers {
  /**
   * @param {Object} options
   * @param {SurfaceRegistry} options.surfaceRegistry
   * @param {EffectCorrelator} options.correlator
   * @param {Function} options.onEffectCaptured
   * @param {Function} options.injectContentScript
   */
  constructor(options) {
    this.surfaceRegistry = options.surfaceRegistry;
    this.correlator = options.correlator;
    this.onEffectCaptured = options.onEffectCaptured || (() => {});
    this.injectContentScript = options.injectContentScript || (async () => {});

    this._listeners = [];
    this._active = false;
  }

  /**
   * Start observing browser lifecycle events across all extension APIs.
   */
  start() {
    if (this._active) return;
    this._active = true;

    // 1. Popup / Tab creation observer
    if (typeof chrome !== 'undefined' && chrome.tabs?.onCreated) {
      const onTabCreated = async (tab) => {
        if (!this._active) return;
        const openerTabId = tab.openerTabId || null;

        // Only track tabs opened from a known surface or within our session
        if (openerTabId && this.surfaceRegistry.hasTab(openerTabId)) {
          const surface = this.surfaceRegistry.registerPopup(tab.id, openerTabId, {
            url: tab.url || tab.pendingUrl || '',
            windowId: tab.windowId,
          });

          const effect = {
            kind: 'popup',
            surfaceId: surface.surfaceId,
            openerSurfaceId: surface.openerSurfaceId,
            tabId: tab.id,
            openerTabId,
            url: surface.url,
            timestamp: Date.now(),
          };

          this.correlator.correlateEffect(effect);
          this.onEffectCaptured(effect);

          // Auto-inject content script into the new popup tab
          try {
            await this.injectContentScript(tab.id);
          } catch (err) {
            console.warn('[observers] failed to inject script in popup:', err);
          }
        }
      };

      chrome.tabs.onCreated.addListener(onTabCreated);
      this._listeners.push(() => chrome.tabs.onCreated.removeListener(onTabCreated));
    }

    // 2. Tab removal / close observer
    if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
      const onTabRemoved = (tabId) => {
        if (!this._active) return;
        if (this.surfaceRegistry.hasTab(tabId)) {
          const surface = this.surfaceRegistry.getByTabId(tabId);
          this.surfaceRegistry.removeTab(tabId);

          const effect = {
            kind: 'surface_closed',
            surfaceId: surface?.surfaceId,
            tabId,
            timestamp: Date.now(),
          };

          this.correlator.correlateEffect(effect);
          this.onEffectCaptured(effect);
        }
      };

      chrome.tabs.onRemoved.addListener(onTabRemoved);
      this._listeners.push(() => chrome.tabs.onRemoved.removeListener(onTabRemoved));
    }

    // 3. Navigation observer (webNavigation or tabs.onUpdated fallback)
    if (typeof chrome !== 'undefined' && chrome.webNavigation?.onCommitted) {
      const onNavCommitted = (details) => {
        if (!this._active || details.frameId !== 0) return; // Top frame only
        if (this.surfaceRegistry.hasTab(details.tabId)) {
          const surface = this.surfaceRegistry.updateNavigation(details.tabId, details.url);
          const effect = {
            kind: 'navigation',
            surfaceId: surface?.surfaceId,
            tabId: details.tabId,
            url: details.url,
            transitionType: details.transitionType,
            timestamp: Date.now(),
          };

          this.correlator.correlateEffect(effect);
          this.onEffectCaptured(effect);
        }
      };

      chrome.webNavigation.onCommitted.addListener(onNavCommitted);
      this._listeners.push(() => chrome.webNavigation.onCommitted.removeListener(onNavCommitted));
    } else if (typeof chrome !== 'undefined' && chrome.tabs?.onUpdated) {
      const onTabUpdated = (tabId, changeInfo) => {
        if (!this._active || !changeInfo.url) return;
        if (this.surfaceRegistry.hasTab(tabId)) {
          const surface = this.surfaceRegistry.updateNavigation(tabId, changeInfo.url);
          const effect = {
            kind: 'navigation',
            surfaceId: surface?.surfaceId,
            tabId,
            url: changeInfo.url,
            timestamp: Date.now(),
          };

          this.correlator.correlateEffect(effect);
          this.onEffectCaptured(effect);
        }
      };

      chrome.tabs.onUpdated.addListener(onTabUpdated);
      this._listeners.push(() => chrome.tabs.onUpdated.removeListener(onTabUpdated));
    }

    // 4. Download observer
    if (typeof chrome !== 'undefined' && chrome.downloads?.onCreated) {
      const onDownloadCreated = (downloadItem) => {
        if (!this._active) return;
        const effect = {
          kind: 'download',
          downloadId: downloadItem.id,
          url: downloadItem.url,
          filename: downloadItem.filename,
          mime: downloadItem.mime,
          fileSize: downloadItem.fileSize,
          timestamp: Date.now(),
        };

        this.correlator.correlateEffect(effect);
        this.onEffectCaptured(effect);
      };

      chrome.downloads.onCreated.addListener(onDownloadCreated);
      this._listeners.push(() => chrome.downloads.onCreated.removeListener(onDownloadCreated));
    }
  }

  /**
   * Stop all observers and clean up listeners.
   */
  stop() {
    this._active = false;
    for (const dispose of this._listeners) {
      try {
        dispose();
      } catch {}
    }
    this._listeners = [];
  }
}
