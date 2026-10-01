/**
 * lov.js — Oracle ADF & Redwood List-of-Values classification and locator shaping.
 *
 * Origin:
 *   Ported and refactored from SyntraFlow lov-handler.js into FlowTrace Oracle patch.
 *
 * WHY THIS MODULE EXISTS
 * Oracle renders three different LOV widgets in classic ADF:
 *   1. inline dropdown (pre-rendered list in ::dropdownPopup)
 *   2. SearchInputSelect / autosuggest (input has no role; ::sgstnCntnr / ::cntStmp)
 *   3. modal search-and-select (lovPopupId / ::lovIconId)
 *
 * Playwright records whatever the operator physically clicked (a transient suggestion row,
 * a magnifier icon, an unstable session id). Replay fails because transient rows disappear.
 *
 * This module classifies the LOV kind from live DOM evidence and targets the stable
 * `<base>::content` input element, preserving label/name fallbacks.
 */

/** ADF id suffixes. The component base is `<base>`; everything hangs off it. */
export const SUFFIX = {
  CONTENT:   '::content',       // the focusable input
  LOV_ICON:  '::lovIconId',     // magnifier that opens modal dialog
  DROPDOWN:  '::dropdownPopup', // inline list, rows pre-rendered but hidden
  LOV_POPUP: 'lovPopupId',      // modal search-and-select
  SUGGEST:   '::sgstnCntnr',    // SearchInputSelect suggestion container
  TEMPLATE:  '::cntStmp'        // SearchInputSelect row template
};

/** Three widgets, three interaction sequences. */
export const LOV_KIND = {
  INLINE: 'inline',
  SUGGEST: 'suggest',
  MODAL: 'modal'
};

export function baseOf(id) {
  return String(id || '').replace(/::content$/, '');
}

export function contentIdOf(base) {
  return base ? base + SUFFIX.CONTENT : '';
}

/**
 * Classify a DOM element as an Oracle LOV, or return null if it is an ordinary field.
 *
 * @param {Element} el Live DOM element
 * @returns {{ base: string, kind: string, contentId: string } | null}
 */
export function detectLov(el) {
  if (!el || el.tagName !== 'INPUT' || el.disabled) return null;

  const input = el;
  if (!input.id) return null;
  const base = baseOf(input.id);
  const doc = el.ownerDocument || document;
  const has = (suffix) => !!doc.getElementById(base + suffix);

  // SearchInputSelect first — its input has no role, so role check would reject it
  if (has(SUFFIX.SUGGEST) || has(SUFFIX.TEMPLATE)) {
    return { base, kind: LOV_KIND.SUGGEST, contentId: contentIdOf(base) };
  }

  if (input.getAttribute('role') !== 'combobox') return null;

  if (has(SUFFIX.DROPDOWN)) {
    return { base, kind: LOV_KIND.INLINE, contentId: contentIdOf(base) };
  }

  if (has(SUFFIX.LOV_POPUP)) {
    return { base, kind: LOV_KIND.MODAL, contentId: contentIdOf(base) };
  }

  return null;
}

/**
 * Extract LOV field metadata for enrichment in content script.
 *
 * @param {Element} el
 * @returns {{ lovKind?: string, lovBase?: string, lovContentId?: string }}
 */
export function getLovMetadata(el) {
  const hit = detectLov(el);
  if (!hit) return {};
  return { lovKind: hit.kind, lovBase: hit.base, lovContentId: hit.contentId };
}

/**
 * Check whether a captured event/record represents an Oracle LOV.
 */
export function isLovRecord(rec) {
  if (!rec) return false;
  if (rec.lovKind) return true;
  const meta = rec.meta || {};
  return !!(rec.lovKind || meta.lovKind || meta.hasLovIcon || meta.hasDropdownPopup || meta.hasLovPopup || meta.hasSuggestContainer);
}

/**
 * Build the stable selector targeting the LOV's input element.
 */
export function stableLovSelector(rec) {
  if (!rec) return '';
  const id = rec.lovContentId ||
             (rec.id ? contentIdOf(baseOf(rec.id)) : '') ||
             (rec.componentId ? contentIdOf(rec.componentId) : '');
  return id ? `[id="${id}"]` : '';
}

/**
 * Shape a recorded step to target the LOV input rather than a transient sub-element.
 *
 * @param {Object} step
 * @param {Object} rec
 * @returns {boolean} True if step was reshaped
 */
export function shapeLovStep(step, rec) {
  if (!step || !isLovRecord(rec)) return false;
  const selector = stableLovSelector(rec);
  if (!selector) return false;

  step.locator = step.locator || {};
  step.locator.selector = selector;
  if (rec.lovContentId || rec.id) step.locator.id = rec.lovContentId || rec.id;
  if (rec.componentId) step.locator.componentId = rec.componentId;
  if (rec.label) {
    step.locator.label = rec.label;
    step.locator.name = step.locator.name || rec.label;
  }
  if (rec.lovKind) step.locator.lovKind = rec.lovKind;
  step.isLov = true;
  return true;
}
