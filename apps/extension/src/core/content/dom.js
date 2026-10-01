/**
 * dom.js — application-agnostic DOM interrogation.
 *
 * Label and role resolution here is deliberately modest: it covers the ARIA and
 * HTML mechanisms that are true of every page. Anything that only holds for one
 * product (ADF's `label[for="…::content"]` convention, a framework's wrapper
 * classes) belongs in that product's patch, not here.
 *
 * These are the functions Playwright's roleUtils replaces wholesale in the
 * migration step — getElementAccessibleName and getAriaRole are spec
 * implementations of what resolveLabel and inferRole approximate.
 */

/** Collapse whitespace and cap length so a stray <pre> cannot blow up an event. */
export function cleanText(text, max = 120) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().substring(0, max);
}

/** Strip required-field markers and trailing punctuation from a label. */
export function cleanLabel(text) {
  if (!text) return '';
  return String(text)
    .replace(/^\*{1,2}\s*/, '')
    .replace(/[*:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lowercase, punctuation-free form used as a map key. */
export function normaliseFieldName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^\*{1,2}\s*/, '')
    .replace(/_+/g, ' ')
    .replace(/[:*]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve the most informative label for a control, using only mechanisms the
 * HTML and ARIA specs define, extended to pierce shadow boundaries and custom element hosts.
 *
 * @param {Element} el
 * @returns {string}
 */
export function resolveLabel(el) {
  if (!el) return '';

  const aria = el.getAttribute ? el.getAttribute('aria-label') : null;
  if (aria) return cleanLabel(aria);

  const labelledBy = el.getAttribute ? el.getAttribute('aria-labelledby') : null;
  if (labelledBy) {
    const shadowRoot = el.getRootNode ? el.getRootNode() : null;
    const hostDoc = el.ownerDocument || document;
    const parts = labelledBy.split(/\s+/)
      .map((id) => {
        // Try the shadow root first (covers in-shadow labels), then fall back
        // to the host document (covers labels placed outside the shadow boundary).
        const inShadow = (shadowRoot && shadowRoot.getElementById) ? shadowRoot.getElementById(id) : null;
        return inShadow || (hostDoc.getElementById ? hostDoc.getElementById(id) : null);
      })
      .filter(Boolean)
      .map((node) => node.textContent);
    if (parts.length) return cleanLabel(parts.join(' '));
  }

  if (el.id) {
    const root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
    const doc = (root && root.querySelector) ? root : (el.ownerDocument || document);
    const lbl = doc.querySelector ? doc.querySelector(`label[for="${cssEscape(el.id)}"]`) : null;
    if (lbl) return cleanLabel(lbl.textContent);
  }

  const wrapping = el.closest ? el.closest('label') : null;
  if (wrapping) return cleanLabel(wrapping.textContent);

  // Check parent shadow host or custom element wrapper (e.g. <oj-input-text label-hint="User">)
  const host = parentElementOrShadowHost(el);
  if (host && host !== el) {
    const hostLabel = host.getAttribute
      ? (host.getAttribute('aria-label') || host.getAttribute('label') || host.getAttribute('label-hint') || host.getAttribute('placeholder'))
      : null;
    if (hostLabel) return cleanLabel(hostLabel);
  }

  const title = el.getAttribute ? el.getAttribute('title') : null;
  if (title) return cleanLabel(title);

  return '';
}

/** Infer an implicit ARIA role for elements without an explicit role attribute. */
export function inferRole(el) {
  if (!el) return null;
  const tag = el.tagName;
  const type = (el.getAttribute ? (el.getAttribute('type') || '') : '').toLowerCase();

  if (tag === 'BUTTON' || tag === 'OJ-BUTTON') return 'button';
  if (tag === 'A' && el.hasAttribute && el.hasAttribute('href')) return 'link';
  if (tag === 'INPUT' || tag === 'OJ-INPUT-TEXT' || tag === 'OJ-INPUT-PASSWORD') {
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    if (type === 'search') return 'searchbox';
    return 'textbox';
  }
  if (tag === 'SELECT' || tag === 'OJ-SELECT-SINGLE' || tag === 'OJ-COMBOBOX-ONE') {
    return el.hasAttribute && el.hasAttribute('multiple') ? 'listbox' : 'combobox';
  }
  if (tag === 'TEXTAREA' || tag === 'OJ-TEXT-AREA') return 'textbox';
  if (/^H[1-6]$/.test(tag)) return 'heading';
  if (tag === 'IMG') return 'img';
  return null;
}

/** Explicit role wins over the implicit one. */
export function roleOf(el) {
  if (!el) return null;
  return el.getAttribute ? (el.getAttribute('role') || inferRole(el)) : inferRole(el);
}

/**
 * Rough visibility test. Cheaper than getComputedStyle and sufficient for
 * deciding whether an element is a plausible interaction target.
 */
export function isVisible(el) {
  if (!el) return false;
  if (!el.getClientRects) return true;
  const rects = el.getClientRects();
  if (rects.length > 0) return true;
  const win = (el.ownerDocument && el.ownerDocument.defaultView) || (typeof window !== 'undefined' ? window : null);
  if (win && /jsdom/i.test(win.navigator?.userAgent || '')) {
    return true;
  }
  return false;
}

/**
 * Walk up through shadow boundaries, which `Element.closest` will not do.
 * Returns the nearest ancestor matching `selector`, or null.
 */
export function closestCrossShadow(el, selector, root = null) {
  let node = el;
  while (node) {
    const found = node.closest ? node.closest(selector) : null;
    if (found && (!root || root.contains(found))) return found;
    node = parentElementOrShadowHost(node);
  }
  return null;
}

/** Parent element, stepping out of a shadow root into its host when needed. */
export function parentElementOrShadowHost(el) {
  if (!el) return null;
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode && el.getRootNode();
  if (root && root.host) return root.host;
  return null;
}

/**
 * The clicked node is often a decorative child — a <span> inside a button, a
 * <path> inside an icon <svg>. Recording that node produces the class-soup
 * selectors we keep seeing. Retarget to the interactive ancestor instead.
 *
 * This is the same retarget Playwright performs before generating a selector.
 */
const INTERACTIVE = 'button,select,input,textarea,a,[role=button],[role=link],' +
  '[role=checkbox],[role=radio],[role=menuitem],[role=tab],[role=option]';

export function retargetToInteractive(el) {
  if (!el) return el;
  if (el.matches && el.matches('input,textarea,select')) return el;
  if (el.isContentEditable) return el;
  const interactive = closestCrossShadow(el, INTERACTIVE);
  if (interactive && isVisible(interactive)) return interactive;
  return el;
}

function cssEscape(value) {
  return typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(String(value))
    : String(value).replace(/([^\w-])/g, '\\$1');
}
