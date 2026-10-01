/**
 * observers.js — Zero-CDP browser-level lifecycle observers and effect correlators.
 *
 * Replaces CDP's Target.attachedToTarget, Page.frameNavigated, and Page.downloadWillBegin
 * using standard Chrome extension APIs:
 *   1. PopupObserver: captures popups, tracks openerTabId, auto-injects content script.
 *   2. NavigationObserver: tracks URL changes, webNavigation lifecycle, and SPA transitions.
 *   3. DownloadObserver: tracks file downloads triggered by user interactions.
 *   4. EffectCorrelator: domain-specific correlation binding asynchronous browser effects
 *      back to initiating actions with distinct temporal windows and trigger criteria.
 */

/** Correlation configuration per effect type. */
const CORRELATION_RULES = {
  popup: {
    maxWindowMs: 3500,
    validTriggerVerbs: new Set(['click', 'submit', 'press']),
    requiresOpenerMatch: true,
  },
  navigation: {
    maxWindowMs: 4000,
    validTriggerVerbs: new Set(['click', 'submit', 'change', 'selectOption', 'press', 'check', 'uncheck']),
    requiresSameSurface: true,
  },
  download: {
    maxWindowMs: 5000,
    validTriggerVerbs: new Set(['click', 'submit', 'press']),
    requiresSameSurface: true,
  },
  dialog: {
    maxWindowMs: 2500,
    validTriggerVerbs: new Set(['click', 'submit', 'press']),
    requiresSameSurface: true,
  },
  adf_ppr: {
    maxWindowMs: 3000,
    validTriggerVerbs: new Set(['selectOption', 'change', 'input', 'click']),
    requiresSameSurface: true,
  },
};

export class EffectCorrelator {
  /**
   * @param {Object} [options]
   */
  constructor(options = {}) {
    this._recentActions = [];
    this._pendingEffects = [];
    this._maxGlobalWindowMs = 6000;
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
      timestamp: action.timestamp || now,
    });
  }

  /**
   * Correlate an observed browser effect to the most recent compatible user action.
   *
   * Uses domain-specific matching rules:
   * - Popup: checks opener surface ID and click/submit verbs.
   * - Navigation: checks same surface ID and navigation-inducing action verbs.
   * - Download: checks same surface ID and trigger verbs.
   *
   * @param {Object} effect Observed effect (popup, navigation, download, dialog)
   * @returns {Object|null} Correlated action or null
   */
  correlateEffect(effect) {
    const now = effect.timestamp || Date.now();
    this._cleanOld(now);

    const rule = CORRELATION_RULES[effect.kind] || {
      maxWindowMs: 4000,
      validTriggerVerbs: null,
      requiresSameSurface: false,
    };

    // Search backwards for the most recent valid initiating action
    for (let i = this._recentActions.length - 1; i >= 0; i--) {
      const candidate = this._recentActions[i];
      const delta = now - candidate.timestamp;

      if (delta < 0 || delta > rule.maxWindowMs) {
        continue;
      }

      const action = candidate.action;
      const actionType = action.type || action.action || '';

      // Verb check
      if (rule.validTriggerVerbs && !rule.validTriggerVerbs.has(actionType)) {
        continue;
      }

      // Surface provenance check
      if (rule.requiresOpenerMatch) {
        if (effect.openerSurfaceId && action.surfaceId && action.surfaceId !== effect.openerSurfaceId) {
          continue;
        }
      } else if (rule.requiresSameSurface) {
        if (effect.surfaceId && action.surfaceId && action.surfaceId !== effect.surfaceId) {
          continue;
        }
      }

      // Correlate effect to action
      action.effects = action.effects || [];
      action.effects.push(effect);
      effect.correlatedActionId = action.id || `${action.type}_${action.timestamp}`;
      return action;
    }

    this._pendingEffects.push({ effect, timestamp: now });
    return null;
  }

  _cleanOld(now) {
    this._recentActions = this._recentActions.filter((a) => (now - a.timestamp) <= this._maxGlobalWindowMs);
    this._pendingEffects = this._pendingEffects.filter((e) => (now - e.timestamp) <= this._maxGlobalWindowMs);
  }

  /**
   * Rehydrate recent action candidates upon MV3 service worker resurrection.
   * @param {Array<Object>} actions Persisted session events
   */
  restoreRecentActions(actions = []) {
    if (!Array.isArray(actions)) return;
    const now = Date.now();
    this.clear();
    for (const action of actions) {
      if (!action || typeof action !== 'object') continue;
      const ts = action.timestamp || now;
      if ((now - ts) <= this._maxGlobalWindowMs) {
        this._recentActions.push({ action, timestamp: ts });
      }
    }
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
   * @param {Function} [options.onEffectCaptured]
   * @param {Function} [options.injectContentScript]
   * @param {Function} [options.broadcast]
   * @param {Function} [options.getPatchId]
   * @param {Function} [options.isPaused]
   */
  constructor(options) {
    this.surfaceRegistry = options.surfaceRegistry;
    this.correlator = options.correlator;
    this.onEffectCaptured = options.onEffectCaptured || (() => {});
    this.injectContentScript = options.injectContentScript || (async () => {});
    this.broadcast = options.broadcast || (async () => {});
    this.getPatchId = options.getPatchId || (() => null);
    this.isPaused = options.isPaused || (() => false);

    this._listeners = [];
    this._active = false;
  }

  /**
   * Whether the observers are currently active and listening.
   * @returns {boolean}
   */
  isActive() {
    return this._active && !this.isPaused();
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

          // Auto-inject content script into the new popup tab and activate recording
          try {
            await this.injectContentScript(tab.id);
            await this.broadcast(tab.id, '__flowtrace_activate__', { patchId: this.getPatchId() });
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
