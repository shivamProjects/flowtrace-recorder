/**
 * selector.js — element → Playwright locator.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Selector generation is Playwright's, vendored. See vendor/playwright/.
 *
 * The engine is preferred over the priority ladder below for two reasons the
 * ladder cannot be patched into having:
 *
 *   1. It VERIFIES. Playwright builds every candidate with a score, sorts, then
 *      queries the DOM and takes the first that resolves uniquely to the
 *      target. The ladder returns on first match and never checks, so ambiguous
 *      locators shipped silently and failed on replay.
 *
 *   2. Its score table is the right way round. A CSS id scores 500 against 100
 *      for role+name and 140 for a label, and ids failing `isGuidLike` are
 *      rejected outright. The ladder ranks `#id` first — which on ADF, where
 *      ids look like `pt1:r1:0:AP1:i1:r2:0:it10::content`, made our first
 *      choice Playwright's last resort.
 *
 * The ladder REMAINS as the fallback, for the frames the engine could not be
 * injected into. It is not dead code and must keep working.
 *
 * What the engine cannot do is ADF's label conventions: it sees
 * `label[for="pt1:r1:0:it10"]` pointing at an id that is not the input's
 * (`…::content`), concludes there is no accessible name, and emits a bare
 * `getByRole('textbox')` — unique in a fixture, not on a real page. So a
 * patch-resolved label wins when it verifies. The engine operates alongside
 * ADF label resolution knowledge.
 *
 * Everything outside this file talks to `generateSelector(el)` and nothing else.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { attributeSelector, cssIdentifier, idSelector, jsString } from './escape.js';
import { cleanText, inferRole, resolveLabel } from './dom.js';

const TEST_ID_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy'];

/** Where the injected engine parks itself. Set by dist/selector-engine.js. */
const ENGINE_GLOBAL = '__flowtracePwInjected';

/**
 * @typedef {Object} SelectorResult
 * @property {string} selector  selector string, for page.locator()
 * @property {string} locator   full Playwright expression, e.g. page.getByLabel('X')
 * @property {Object} raw       attribute bag the compiler and patches read
 */

/**
 * @param {Element} el
 * @param {Object} [opts]
 * @param {(el: Element) => string} [opts.resolveLabel]
 *   Label resolver. Defaults to the core one, which implements only the ARIA
 *   and HTML mechanisms. A patch supplies its own when the application labels
 *   controls by a convention the spec does not describe — ADF's
 *   `label[for="…::content"]` and its table-cell layout being the reason this
 *   parameter exists at all.
 * @returns {SelectorResult}
 */
export function generateSelector(el, opts = {}) {
  if (!el) return { selector: '', locator: '', raw: {} };

  const labelResolver = opts.resolveLabel || resolveLabel;
  const raw = collectAttributes(el);

  const fromEngine = engineSelector(el, raw, labelResolver);
  if (fromEngine) return fromEngine;

  return ladderSelector(el, raw, labelResolver);
}

/**
 * The engine instance for this element's window.
 *
 * Read off the element's own document rather than this module's `globalThis`:
 * both are injected per frame, but a patch may hand us an element from a
 * same-origin child document, and that document's engine is the one whose
 * `querySelectorAll` can see it.
 */
function engineFor(el) {
  try {
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    return (view && view[ENGINE_GLOBAL]) || globalThis[ENGINE_GLOBAL] || null;
  } catch {
    return null; // cross-origin document access threw
  }
}

/**
 * Playwright's answer.
 *
 * Returns null when the engine is absent or throws, allowing the heuristic
 * ladder to provide fallback locator resolution.
 *
 * `buildLocatorObject` resolves ADF labels independently into `locator.label`
 * and `locator.name`, while the engine provides standard accessible names and
 * attributes. The replayer's candidate ladder evaluates these alongside
 * `locator.id`, providing multiple resolution paths for the target element.
 */
function engineSelector(el, raw, labelResolver) {
  const engine = engineFor(el);
  if (!engine) return null;

  let selector;
  try {
    selector = engine.generateSelectorSimple(el);
  } catch {
    return null;
  }
  if (!selector) return null;

  // Still resolved, because the compiler and the patches read `raw`.
  const labelText = safeLabel(labelResolver, el);

  return {
    selector,
    locator: `page.${asLocator(engine, selector)}`,
    raw: labelText ? { ...raw, resolvedLabel: labelText } : raw,
  };
}

function safeLabel(labelResolver, el) {
  try {
    return labelResolver(el) || '';
  } catch {
    return '';
  }
}

/**
 * Playwright's own expression for a selector, e.g.
 * `getByRole('textbox', { name: 'Amount' })`. Falls back to `locator('…')`,
 * which is always valid, if the utility is not exposed on this build.
 */
function asLocator(engine, selector) {
  try {
    const expr = engine.utils && engine.utils.asLocator('javascript', selector);
    if (expr) return expr;
  } catch { /* fall through */ }
  return `locator(${jsString(selector)})`;
}

/**
 * The original priority ladder — the fallback when the engine is unavailable.
 *
 * Behaviour is deliberately unchanged from before the engine landed, so the
 * fallback path stays the known quantity it was.
 */
function ladderSelector(el, raw, labelResolver) {
  // 1 — id, when it looks author-written rather than generated.
  if (raw.id && isStableId(raw.id)) {
    const sel = idSelector(raw.id);
    return { selector: sel, locator: `page.locator(${jsString(sel)})`, raw };
  }

  // 2 — explicit test hooks.
  for (const attr of TEST_ID_ATTRS) {
    if (raw[attr]) {
      const sel = attributeSelector(attr, raw[attr]);
      return { selector: sel, locator: `page.locator(${jsString(sel)})`, raw };
    }
  }

  // 3 — name attribute. Anchors are excluded because their name is a fragment
  //     target, not an identity.
  if (raw.name && el.tagName !== 'A') {
    const sel = attributeSelector('name', raw.name);
    return { selector: sel, locator: `page.locator(${jsString(sel)})`, raw };
  }

  // 4 — aria-label.
  if (raw.ariaLabel) {
    return {
      selector: attributeSelector('aria-label', raw.ariaLabel),
      locator: `page.getByLabel(${jsString(raw.ariaLabel)})`,
      raw,
    };
  }

  // 5 — associated <label>.
  const labelText = labelResolver(el);
  if (labelText) {
    return {
      selector: raw.id ? idSelector(raw.id) : attributeSelector('aria-label', labelText),
      locator: `page.getByLabel(${jsString(labelText)})`,
      raw: { ...raw, resolvedLabel: labelText },
    };
  }

  // 6 — placeholder.
  if (raw.placeholder) {
    return {
      selector: attributeSelector('placeholder', raw.placeholder),
      locator: `page.getByPlaceholder(${jsString(raw.placeholder)})`,
      raw,
    };
  }

  // 7 — role plus accessible text.
  const role = raw.role || inferRole(el);
  const text = cleanText(el.textContent);
  if (role && text && text.length < 80) {
    return {
      // The locator is the useful half here. The `selector` field must still be
      // something that resolves, because it is the dedup and debounce key — and
      // `[role="link"]` matches nothing at all when the role was INFERRED from
      // the tag rather than written as an attribute. The monolith emitted the
      // attribute form either way, so every getByRole event it produced carried
      // a selector that could not find its own element.
      selector: raw.role ? attributeSelector('role', raw.role) : buildCssFallback(el),
      locator: `page.getByRole(${jsString(role)}, { name: ${jsString(text)} })`,
      raw: { ...raw, resolvedRole: role, resolvedText: text },
    };
  }

  // 8 — unique visible text. Unlike the priorities above, this one verifies.
  if (text && text.length >= 3 && text.length <= 60) {
    try {
      const sameTag = el.ownerDocument.querySelectorAll(el.tagName.toLowerCase());
      const matches = [...sameTag].filter(
        (e) => e.textContent.replace(/\s+/g, ' ').trim() === text,
      );
      if (matches.length <= 2) {
        return {
          selector: `text=${text}`,
          locator: `page.getByText(${JSON.stringify(text)}, { exact: true })`,
          raw: { ...raw, resolvedText: text },
        };
      }
    } catch { /* invalid tag name — fall through */ }
  }

  // 9 — CSS fallback.
  const css = buildCssFallback(el);
  return { selector: css, locator: `page.locator(${jsString(css)})`, raw };
}

/** Attributes every downstream consumer expects on `event.meta`. */
function collectAttributes(el) {
  const raw = {
    id: el.id || null,
    name: el.getAttribute('name') || null,
    ariaLabel: el.getAttribute('aria-label') || null,
    placeholder: el.getAttribute('placeholder') || null,
    role: el.getAttribute('role') || null,
    title: el.getAttribute('title') || null,
  };
  for (const attr of TEST_ID_ATTRS) raw[attr] = el.getAttribute(attr) || null;
  return raw;
}

/**
 * Tag plus the least-generic classes available, verified unique where possible.
 * Utility-framework classes are excluded because they are shared by design and
 * make for selectors that match half the page.
 */
function buildCssFallback(el) {
  const tag = el.tagName.toLowerCase();
  const doc = el.ownerDocument;

  const meaningful = [...el.classList]
    .filter((c) => !STATE_CLASS.test(c))
    .filter((c) => !isUtilityClass(c))
    .slice(0, 3)
    .map((c) => `.${cssIdentifier(c)}`)
    .join('');

  const candidate = `${tag}${meaningful}`;
  if (isUnique(doc, candidate)) return candidate;

  // Nothing survived the utility filter — try the full class list before
  // resorting to positional matching.
  if (!meaningful) {
    const all = [...el.classList]
      .filter((c) => !STATE_CLASS.test(c))
      .slice(0, 4)
      .map((c) => `.${cssIdentifier(c)}`)
      .join('');
    if (all && isUnique(doc, `${tag}${all}`)) return `${tag}${all}`;
  }

  const parent = el.parentElement;
  if (parent) {
    const siblings = [...parent.children].filter((c) => c.tagName === el.tagName);
    const idx = siblings.indexOf(el);
    if (idx >= 0 && siblings.length > 1) return `${candidate}:nth-of-type(${idx + 1})`;
  }
  return candidate;
}

function isUnique(doc, selector) {
  try {
    return doc.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

const STATE_CLASS = /^(active|hover|focus|selected|open|visible|hidden)$/i;

/**
 * An id is usable when it looks like something a developer typed. Ids carrying
 * several colon-separated segments are component-tree paths and shift whenever
 * the tree does.
 */
export function isStableId(id) {
  if (!id) return false;
  if (id.split(':').length > 3) return false;
  if (/^\d+$/.test(id)) return false;
  return true;
}

const UTILITY_PREFIXES = [
  'flex', 'grid', 'col', 'row', 'gap', 'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr',
  'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr', 'w', 'h', 'min', 'max', 'size',
  'text', 'bg', 'border', 'rounded', 'shadow', 'ring', 'outline',
  'font', 'leading', 'tracking', 'antialiased',
  'uppercase', 'lowercase', 'capitalize', 'normal-case',
  'truncate', 'overflow', 'whitespace', 'break', 'indent',
  'block', 'inline', 'hidden', 'visible', 'contents', 'flow',
  'relative', 'absolute', 'fixed', 'sticky', 'static',
  'z', 'opacity', 'cursor', 'pointer', 'select', 'touch', 'scroll',
  'float', 'clear', 'list', 'table', 'caption', 'align', 'object',
  'space', 'divide', 'place', 'items', 'justify', 'content', 'self', 'order',
  'sr', 'not', 'grow', 'shrink', 'basis', 'aspect',
  'transition', 'duration', 'ease', 'delay', 'animate',
  'scale', 'rotate', 'translate', 'skew', 'transform', 'origin',
  'fill', 'stroke', 'accent', 'caret', 'decoration',
];

/** Arbitrary values (`text-[9px]`) and variants (`hover:`, `sm:`) are never stable. */
function isUtilityClass(cls) {
  if (!cls) return false;
  if (/[:[\]]/.test(cls)) return true;
  return UTILITY_PREFIXES.some((p) => cls === p || cls.startsWith(`${p}-`));
}
