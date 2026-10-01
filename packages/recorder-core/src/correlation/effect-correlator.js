/**
 * effect-correlator.js — Correlates asynchronous effects (popups, navigation, downloads, dialogs)
 * back to initiating user interaction actions across both Extension and Desktop hosts.
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
   * Rehydrate recent action candidates upon MV3 service worker resurrection or session reload.
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
