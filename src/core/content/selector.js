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

import {
  attributeSelector, cssAttributeValue, cssIdentifier, idSelector, jsString,
} from './escape.js';
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

  selector = finalizeSelector(engine, el, selector);
  if (!selector) return null; // nothing the engine offered resolves — use the ladder

  // Still resolved, because the compiler and the patches read `raw`.
  const labelText = safeLabel(labelResolver, el);

  return {
    selector,
    locator: `page.${asLocator(engine, selector)}`,
    raw: labelText ? { ...raw, resolvedLabel: labelText } : raw,
  };
}

/**
 * G2 — does `selector` resolve to exactly the element it was generated from?
 *
 * A throw counts as NOT verified: an unparseable selector is precisely the case
 * we want to replace, so failing closed is the safe direction.
 */
function verifyResolves(engine, el, selector) {
  try {
    if (!engine || !el || !el.ownerDocument || !selector) return false;
    const found = engine.querySelectorAll(engine.parseSelector(selector), el.ownerDocument);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

/** Splits `internal:attr=[title="value"i]` into its parts, or null. */
function attrSelectorParts(selector) {
  const m = /^internal:attr=\[([a-zA-Z-]+)="((?:[^"\\]|\\.)*)"([si])\]$/.exec(selector || '');
  if (!m) return null;
  return { attr: m[1], value: m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\') };
}

/**
 * G2 + G3 — the engine's answer, checked and if necessary replaced.
 *
 * Playwright's `generateSelector` optimises for locators a HUMAN enjoys reading,
 * not for locators that survive replay. `buildTextCandidates` trims attribute
 * text at a word boundary and scores the shorter variant BETTER, which is right
 * for text selectors (substring matching) and wrong for `internal:attr`, where
 * matching is exact. Observed live on the client:
 *
 *     title     : "Search: Depreciation Method for Poland"
 *     generated : internal:attr=[title="Search: Depreciation Method"i]
 *     matches   : 0 elements → 90s timeout on replay
 *
 * Rather than predict which heuristic misfires next, verify. Returns the
 * original when it is already sound (the common path: one extra query), a
 * rebuilt selector when one can be built, and null to hand over to the ladder.
 */
function finalizeSelector(engine, el, selector) {
  if (isPositional(selector)) {
    // G3 — never ship a positional selector, even a resolving one. See
    // isPositional for why "resolves right now" is not the question.
    return hardenSelector(engine, el, selector);
  }
  if (verifyResolves(engine, el, selector)) return selector;
  return hardenSelector(engine, el, selector);
}

/**
 * A selector that does resolve to `el`, or null. Cheapest and most readable
 * first.
 */
function hardenSelector(engine, el, selector) {
  // 1 — the attribute value was truncated; put the real one back, marked exact
  //     ("s") so no further normalisation can shorten it again.
  const parts = attrSelectorParts(selector);
  if (parts) {
    const real = safe(() => el.getAttribute(parts.attr));
    if (real && real !== parts.value) {
      const rebuilt = `internal:attr=[${parts.attr}="${escapeAttrValue(real)}"s]`;
      if (verifyResolves(engine, el, rebuilt)) return rebuilt;
    }
  }

  // 2 — the element's own id, but only a stable one. Quoted attribute form, not
  //     `#id`: ADF ids are full of colons, which break CSS id syntax.
  if (el.id && isStableId(el.id)) {
    const byId = `css=[id="${escapeAttrValue(el.id)}"]`;
    if (verifyResolves(engine, el, byId)) return byId;
  }

  // 3 — G4, a grid cell addressed by the stable coordinate id of its child.
  const cell = gridCellSelector(el);
  if (cell && verifyResolves(engine, el, `css=${cell}`)) return `css=${cell}`;

  return null; // let the ladder try
}

function escapeAttrValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
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

  // G4 — a grid cell has no identity of its own, but it CONTAINS one. This is
  // the replacement for the positional selector G3 removed, and the two must
  // ship together: without it, the terminal fallback has nothing behind it.
  const cell = gridCellSelector(el);
  if (cell && isUnique(doc, cell)) return cell;

  // G3 — no `:nth-of-type` tie-breaker. It was the previous last resort and it
  // is worse than the ambiguous selector it replaced: see isPositional.
  return candidate;
}

/**
 * G3 — selectors that describe WHERE an element is, or what state it is in.
 *
 * `nth=`, `:nth-child`, `:nth-of-type`, `:nth-last-*` pin an element to an
 * index in a list that re-renders, and ADF's `p_AF*` classes are RUNTIME STATE:
 *
 *     .p_AFHighlighted > td:nth-child(4)
 *
 * means "the 4th cell of whatever row is highlighted right now". Measured
 * against a captured Journal Lines row on the client: 1 match while that row is
 * highlighted, 0 once the selection moves. Which is why uniqueness at record
 * time is not the test — this selector passes it and still dies on replay.
 */
export function isPositional(selector) {
  if (!selector) return false;
  return /(^|[^a-zA-Z])nth=|:nth-(child|of-type|last-child|last-of-type)\b|\.p_AF/i
    .test(selector);
}

/**
 * G4 — address a bare grid cell by the stable coordinate id of a child.
 *
 * A classic Fusion grid cell is `<td nowrap class="xen">`: no id, no role, no
 * title, and — before the field is filled in — no text either. But a child
 * carries a real table coordinate:
 *
 *     …:jeLineAppTable:_ATp:t3:1:account     (table t3, row 1, column account)
 *
 * `td:has([id="…:t3:1:account"])` addresses the cell by that, giving one match
 * whether or not the row is selected.
 *
 * Narrow on purpose: cells only, stable ids only. `::`-suffixed ids are skipped
 * because `…:account::content` is a sub-part of the component and the shorter
 * component id proper is the one the replayer's own ladder understands.
 */
export function gridCellSelector(el) {
  const tag = String((el && el.tagName) || '').toUpperCase();
  if (tag !== 'TD' && tag !== 'TH') return '';

  const kids = safe(() => el.querySelectorAll('[id]')) || [];
  for (const kid of kids) {
    const id = kid.id;
    if (!id || id.includes('::')) continue;
    // `looksGenerated`, NOT `isStableId`: a coordinate id is exactly the
    // colon-bearing component path isStableId rejects, and here it is the
    // point. What must not appear is a per-load token.
    if (looksGenerated(id)) continue;
    return `${tag.toLowerCase()}:has([id=${cssAttributeValue(id)}])`;
  }
  return '';
}

function isUnique(doc, selector) {
  try {
    return doc.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

/**
 * Classes that describe the element's CURRENT state rather than its identity.
 * `p_AF…` is ADF's runtime state prefix (`p_AFHighlighted`, `p_AFSelected`) —
 * see isPositional; a selector built on one is true only until the user clicks
 * elsewhere.
 */
const STATE_CLASS = /^(active|hover|focus|selected|open|visible|hidden)$|^p_AF/i;

/**
 * Ids the application mints fresh on every page load.
 *
 * Verbatim from the client recorder's `VOLATILE_COMPONENT_ID_RE`
 * (content/oracle-patch.js), which was measured across 493 recordings.
 *
 * UNANCHORED ON PURPOSE. `_oj\d{2,}` has to match *inside*
 * `_oj691_table:1366046988_0`; anchoring it would let that id straight through,
 * which is the bug this exists to close.
 *
 *   frag-[a-z0-9]{5,}   `createObjectsfrag-7jr5g37f7:1368896047_0`
 *   _oj\d{2,}           `_oj691_table:…`, `_oj189_sf_smart-filter`
 *   oj-…-\d+            `oj-searchselect-filter-oj-selectsingle-4`
 *   ui-id-\d+           jQuery UI's per-load counter, `ui-id-104`
 *   [:_-]-?\d{9,}       ADF's millisecond-stamped suffixes
 */
const VOLATILE_ID_RE =
  /frag-[a-z0-9]{5,}|_oj\d{2,}|\boj-[a-z]+(?:-[a-z]+)*-\d+\b|\bui-id-\d+\b|[:_-]-?\d{9,}/i;

/** An ISO timestamp baked into an id is a per-run value by definition. */
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * The entropy heuristic, also from the client (`_sfLooksGeneratedId`).
 *
 * A token that mixes letters and digits, is at least 8 characters, and is NOT
 * the `word123` shape a developer would actually type is a minted token. That
 * `word123` exemption is what keeps `amt2`, `field10`, `submit2` usable while
 * rejecting `iq0fxr850q`.
 *
 * The leading-underscore rule is separate because generated ids conventionally
 * start with `_`, which lowers the bar for the first token: `_iq0fxr850q-input`
 * is caught by length alone even though the token has no uppercase run.
 */
function looksGenerated(id) {
  const s = String(id);
  if (TIMESTAMP_RE.test(s)) return true;
  if (VOLATILE_ID_RE.test(s)) return true;

  if (s.charAt(0) === '_') {
    const first = s.slice(1).split(/[-_:.]/)[0];
    if (first.length >= 10) return true;
    if (first.length >= 6 && /\d/.test(first)) return true;
  }

  for (const token of s.replace(/[-_:.]+/g, ' ').split(' ')) {
    if (token.length < 8) continue;
    if (!/^[A-Za-z0-9]+$/.test(token)) continue;
    if (!/\d/.test(token) || !/[A-Za-z]/.test(token)) continue;
    if (/^[A-Za-z]+\d+$/.test(token)) continue; // `invoiceLine12` — author-written
    return true;
  }
  return false;
}

/**
 * An id is usable when it looks like something a developer typed AND survives a
 * page load. Ids carrying several colon-separated segments are component-tree
 * paths and shift whenever the tree does.
 *
 * The shape tests below were the whole of this function, and they ask the wrong
 * question: they test what an id LOOKS like, not whether it will still be there
 * next run. `ui-id-104`, `_iq0fxr850q-input` and `_oj691_table:1366046988_0`
 * all passed them — and compiler.js:436 then PREFERRED them over role/label,
 * so the step was dead on the next replay. Volatility is checked first because
 * it disqualifies an id whatever its shape.
 */
export function isStableId(id) {
  if (!id) return false;
  if (looksGenerated(id)) return false;
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
