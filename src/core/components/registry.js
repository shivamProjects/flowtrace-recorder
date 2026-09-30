/**
 * registry.js — Evidence-Scored Component Registry.
 *
 * Architecture:
 *   docs/architecture/FlowTrace_Recorder_Architecture_v2_Master_Plan_Audit_Refined.md
 *
 * The Component Registry is the central hub for component recognition.
 * Instead of hardcoding DOM matching across capture listeners, elements are
 * evaluated against registered adapters with weighted evidence scoring.
 */

export class ComponentRegistry {
  constructor() {
    this.adapters = new Map();
  }

  /**
   * Register a component adapter.
   * @param {Object} adapter
   */
  register(adapter) {
    if (!adapter || !adapter.id) {
      throw new Error('Component adapter must have an id');
    }
    this.adapters.set(adapter.id, adapter);
  }

  /**
   * Get an adapter by ID.
   * @param {string} id
   */
  get(id) {
    return this.adapters.get(id);
  }

  /**
   * Detect and score component identity for a DOM element.
   *
   * Evaluates all registered adapters in priority order (specific framework
   * adapters outrank generic web fallbacks).
   *
   * @param {Element} element
   * @param {Object} context
   * @returns {{ adapter: Object, result: { component: string, confidence: number, evidence: Array } } | null}
   */
  detect(element, context = {}) {
    if (!element) return null;

    let bestMatch = null;
    let highestScore = -1;

    for (const adapter of this.adapters.values()) {
      try {
        const result = adapter.detect(element, context);
        if (result && result.confidence > highestScore) {
          highestScore = result.confidence;
          bestMatch = { adapter, result };
        }
      } catch (err) {
        // Safe isolation: adapter failures must never break capture
      }
    }

    return bestMatch;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Built-in Adapters
// ─────────────────────────────────────────────────────────────────────────────

export const GenericInputAdapter = {
  id: 'web.input.text',
  framework: 'web',
  detect(el) {
    if (!el || el.tagName !== 'INPUT') return null;
    const type = (el.type || 'text').toLowerCase();
    if (['text', 'search', 'tel', 'url', 'email', 'password'].includes(type)) {
      return {
        component: 'web.input.text',
        confidence: 0.5, // Base generic confidence
        evidence: [{ type: 'tag', value: 'INPUT' }, { type: 'type', value: type }]
      };
    }
    return null;
  }
};

export const GenericSelectAdapter = {
  id: 'web.select',
  framework: 'web',
  detect(el) {
    if (!el || el.tagName !== 'SELECT') return null;
    return {
      component: 'web.select',
      confidence: 0.5,
      evidence: [{ type: 'tag', value: 'SELECT' }]
    };
  }
};

export const defaultRegistry = new ComponentRegistry();
defaultRegistry.register(GenericInputAdapter);
defaultRegistry.register(GenericSelectAdapter);
