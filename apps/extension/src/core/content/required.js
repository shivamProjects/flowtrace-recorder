/**
 * required.js — is this field mandatory? Framework-independent detection.
 *
 * WHY THIS FILE EXISTS
 * The Oracle patch used to ask a LAYOUT question — "what sits in the <td>
 * before mine?" — plus a handful of ADF-shaped selector sweeps. That is only
 * ever true of Oracle's panelFormLayout, so every div-based form (Bootstrap,
 * Material, Ant, Lightning, plain HTML5, and the newer Fusion pages that no
 * longer use layout tables) fell through to a flat `false`. Worse, that
 * `false` was indistinguishable from "the page says optional", so nothing
 * downstream could tell a real answer from a miss.
 *
 * THE GENERIC MODEL
 * Two independent questions, and only the second one is framework-specific:
 *
 *   1. labelRegionOf(el)  — which nodes DESCRIBE this field?
 *   2. markerIn(region)   — do those nodes carry a rendered required marker?
 *
 * (1) is answered semantically first (aria-labelledby, label[for], wrapping
 * <label>) and only falls back to structure when a form associates nothing —
 * which is where the old <td> rule now lives as ONE case of a general
 * "field group" walk, not as the whole algorithm.
 *
 * (2) is a vocabulary: a literal asterisk, a title/aria-label saying
 * "required", a class token every CSS framework spells slightly differently,
 * and — the case no textContent scan can ever see — an asterisk injected by
 * CSS ::before or ::after, which is how Ant Design and Angular Material render
 * theirs.
 *
 * RENDERED IS THE LOAD-BEARING WORD
 * ADF emits <span class="p_rqi"></span> on OPTIONAL fields: the marker class is
 * always present and only the CONTENT distinguishes the two. So a marker counts
 * only when it actually renders something. That one rule generalises: a
 * display:none asterisk left in a template is not a requirement either.
 *
 * TRI-STATE, BECAUSE "NO" AND "DON'T KNOW" ARE DIFFERENT ANSWERS
 * detect() returns true / false / null. `false` is only ever returned when the
 * page gives us grounds for it — see calibration below. Otherwise: null.
 *
 * CALIBRATION
 * "No marker" only means "optional" on a form that marks its required fields at
 * all. So before answering `false` we check whether ANY sibling control on the
 * same form carries a marker. If none does, the form simply does not use them
 * and the honest answer is null.
 *
 * WHAT THIS FILE KNOWS THAT THE GENERIC MODEL DID NOT
 * Three pieces of Oracle-specific knowledge were carried over from the ADF-only
 * scan this replaced, because they are true and the generic vocabulary missed
 * them. They are marked `ADF:` below:
 *   - `AFRequiredIconAbsence` is a marker class that means the OPPOSITE.
 *   - ADF spells its classes in camelCase (`AFRequiredIcon`), which a
 *     token-boundary class regex does not match.
 *   - `**` — two asterisks — is a marker ADF uses as well as `*`.
 *
 * Nothing here may reach for an extension API: this runs in the page, is used
 * by the Oracle patch, and must stay usable by any other patch and by tests.
 */

/** Controls we can be asked about. */
const CONTROL_SEL = 'input, textarea, select';

/** Anything that can carry a field's visible name. */
const LABEL_SEL = 'label, .label, [class*="label"], legend, th, abbr, dt';

/** How far to climb looking for the enclosing "field group". */
const GROUP_CLIMB = 5;

/** How far to climb past the field's own group for a COMPOSITE marker. */
const COMPOSITE_CLIMB = 4;

/** Depth of the marker search inside a region. Layout cells nest deeply. */
const MARKER_DEPTH = 4;

/** Controls sampled when calibrating a form. Enough to be sure, cheap enough. */
const CALIBRATION_SAMPLE = 40;

/** Calibration is re-derived after this long — SPAs swap whole forms in. */
const CALIBRATION_TTL_MS = 5_000;

/** compareDocumentPosition bits, spelled out so no global `Node` is needed. */
const DOCUMENT_POSITION_FOLLOWING = 0x04;
const DOCUMENT_POSITION_CONTAINED_BY = 0x10;

/**
 * Every asterisk a form has ever used to mean "mandatory", plus the words.
 * Kept deliberately tight: an asterisk as the WHOLE text of a node, never as a
 * substring, or every footnote and wildcard hint on the page becomes a marker.
 *
 * ADF: one OR two — ADF's panelFormLayout renders `**` on some components, and
 * the scan this replaced matched `^\*{1,2}$` for exactly that reason.
 */
const STAR_TEXT = /^[*٭⁎∗✱＊※]{1,2}$/;

/** Marker text spelled as words: "Required", "(required)", "* Required". */
const REQUIRED_WORD = /^[\s*(\[]*required(\s+field)?[\s*)\]:.]*$/i;

/**
 * An asterisk fused into the label's OWN text — "Company Name *", "* Email".
 * Anchored to the ends on purpose: a star loose in the middle of a sentence is
 * prose, and a star trailing a node that is not the label is a footnote.
 */
const LABEL_EDGE_STAR = /^\s*[*٭⁎∗✱＊]{1,2}\s*\S|\S\s*[*٭⁎∗✱＊]{1,2}\s*$/;

/** A title/aria-label ANNOUNCING requiredness, e.g. Lightning's <abbr>. */
const REQUIRED_ANNOUNCE = /^\s*[*(\[]*\s*required\b/i;

/**
 * Class tokens, as each framework spells them:
 *   Oracle ADF  p_rqi, AFRequiredIcon
 *   Bootstrap   required / form-required
 *   Ant Design  ant-form-item-required
 *   Angular Mat mat-mdc-form-field-required-marker
 *   Lightning   slds-required
 *   generic     mandatory, reqd, is-required, asterisk
 *
 * ADF: the second alternative is the camelCase spelling. `AFRequiredIcon` has
 * no `-`/`_`/space around "Required", so the token-boundary form alone does not
 * see it — and that class is the single most reliable ADF marker there is.
 */
const CLASS_TOKEN =
  /(?:^|[-_\s])(?:p_rqi|required|mandatory|reqd?|asterisk)(?:[-_\s]|$)|(?:^|[A-Za-z0-9])(?:Required|Mandatory)(?:[A-Z]|[-_\s]|$)/;

/**
 * ...but these SAY required while meaning the opposite, or meaning nothing.
 *
 * ADF: `absen[ct]` is the `:not([class*="Absence"])` the ADF selector carried.
 * `AFRequiredIconAbsence` is the placeholder ADF renders on an OPTIONAL field so
 * the columns line up; taking it for a marker marks every field on the form.
 */
const CLASS_ANTI =
  /absen[ct]|(?:not|non|un|no|optional|never|hide|hidden|error|message|msg|tip|hint|help|legend|note|footer|disclaimer)[-_]?(?:required|mandatory)|(?:required|mandatory)[-_]?(?:message|msg|error|text|hint|help|tip|note|label|legend|explanation|false|off|no)/i;

/* ------------------------------------------------------------------- utils */

function attr(el, name) {
  try { return el?.getAttribute ? el.getAttribute(name) : null; } catch { return null; }
}

function textOf(node) {
  try { return String(node.textContent || '').trim(); } catch { return ''; }
}

function styleOf(el, pseudo) {
  try {
    const view = el.ownerDocument?.defaultView || globalThis;
    return view.getComputedStyle(el, pseudo || null);
  } catch { return null; }
}

/**
 * The asterisk that exists only in CSS. Invisible to every textContent scan.
 *
 * jsdom does not implement pseudo-element computed styles: it hands back the
 * element's OWN style and logs "Not implemented" every time, which would bury
 * a unit test's output under one line per node walked. It cannot be probed by
 * inspecting the result — the object it returns is indistinguishable from a
 * real one — so it is identified by name, once, and skipped. No other engine
 * this runs in is affected.
 */
let pseudoSupported = null;

function pseudoSupportedIn(el) {
  if (pseudoSupported === null) {
    let ua = '';
    try { ua = String(el.ownerDocument?.defaultView?.navigator?.userAgent || ''); } catch { /* none */ }
    pseudoSupported = !/jsdom/i.test(ua);
  }
  return pseudoSupported;
}

function pseudoText(el, which) {
  if (!pseudoSupportedIn(el)) return '';
  const cs = styleOf(el, which);
  if (!cs) return '';
  const c = cs.content;
  if (!c || c === 'none' || c === 'normal') return '';
  return String(c).replace(/^attr\(.*\)$/, '').replace(/^["']|["']$/g, '').trim();
}

/**
 * textContent minus anything the user cannot see. Needed because an asterisk
 * left in the markup but styled away — a template that renders the marker for
 * every field and hides it on the optional ones — is not a requirement, and
 * textContent cannot tell the two apart.
 */
function visibleTextOf(el, depth = 0) {
  if (!el) return '';
  let out = '';
  try {
    for (const n of el.childNodes || []) {
      if (n.nodeType === 3) { out += n.nodeValue || ''; continue; }
      if (n.nodeType !== 1) continue;
      const cs = styleOf(n);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden' ||
                 cs.visibility === 'collapse' || cs.opacity === '0')) continue;
      if (depth < MARKER_DEPTH) out += visibleTextOf(n, depth + 1);
    }
  } catch { /* detached or exotic node */ }
  return out.trim();
}

/**
 * Does this node put ANYTHING on screen? Text, a pseudo-element, or a box.
 * The p_rqi discriminator, and the reason a templated-but-hidden asterisk never
 * counts.
 */
function isRendered(el) {
  const cs = styleOf(el);
  if (cs) {
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (cs.opacity === '0') return false;
  }
  if (textOf(el)) return true;
  if (pseudoText(el, '::before') || pseudoText(el, '::after')) return true;
  // jsdom and detached nodes have no layout; treat "no text, no pseudo" as not
  // rendered rather than trusting a zero rect we cannot measure.
  try {
    const r = el.getBoundingClientRect && el.getBoundingClientRect();
    if (r && (r.width > 0 || r.height > 0)) return true;
  } catch { /* no layout */ }
  return false;
}

function classOf(el) {
  // SVG elements carry SVGAnimatedString, not a string.
  const c = el && el.className;
  if (typeof c === 'string') return c;
  if (typeof c?.baseVal === 'string') return c.baseVal;
  return String(attr(el, 'class') || '');
}

function isControl(el) {
  try {
    return !!(el && el.matches && el.matches(CONTROL_SEL) && el.type !== 'hidden');
  } catch { return false; }
}

/** Controls inside `node`, ignoring hidden ones — they are markup, not fields. */
function controlsIn(node) {
  const out = [];
  try {
    for (const el of node.querySelectorAll ? node.querySelectorAll(CONTROL_SEL) : []) {
      if (el.type !== 'hidden') out.push(el);
    }
  } catch { /* exotic node */ }
  return out;
}

/* ------------------------------------------------------- (2) the vocabulary */

/**
 * Is THIS node a required marker? Text, announcement, class token or CSS
 * pseudo — any one is enough, but it must render.
 */
function isMarkerNode(el) {
  if (!el || el.nodeType !== 1) return false;

  const cls = classOf(el);
  if (cls && CLASS_ANTI.test(cls)) return false;

  const own = visibleTextOf(el);
  const pseudo = pseudoText(el, '::before') + pseudoText(el, '::after');

  // A literal asterisk, as the node's whole text or injected by CSS.
  const starred = STAR_TEXT.test(own) || REQUIRED_WORD.test(own) ||
                  STAR_TEXT.test(pseudo.trim()) || /[*∗＊]/.test(pseudo);

  // Announced rather than drawn: <abbr title="required">, aria-label="Required".
  const announced = REQUIRED_ANNOUNCE.test(String(attr(el, 'title') || '')) ||
                    REQUIRED_ANNOUNCE.test(String(attr(el, 'aria-label') || ''));

  // Named by class. Alone this is NOT enough — p_rqi is present on optional
  // fields too — so it must come with something rendered.
  const named = CLASS_TOKEN.test(cls) || String(attr(el, 'data-required') || '') === 'true';

  if (!starred && !announced && !named) return false;
  return isRendered(el);
}

/**
 * Walk a region looking for a marker. `beforeNode`, when given, additionally
 * demands the marker PRECEDE it — an asterisk after the label text is a
 * footnote, not a requirement.
 */
function markerIn(scope, beforeNode) {
  if (!scope || scope.nodeType !== 1) return null;
  try {
    // The region node may itself be the marker: <label class="ant-form-item-required">.
    if (isMarkerNode(scope)) return scope;

    const precedes = (m) => {
      if (!beforeNode) return true;
      const pos = m.compareDocumentPosition(beforeNode);
      return !!(pos & DOCUMENT_POSITION_FOLLOWING) && !(pos & DOCUMENT_POSITION_CONTAINED_BY);
    };

    const walk = (node, depth) => {
      for (const n of node.children || []) {
        // Never read a marker out of another field's subtree.
        if (isControl(n)) continue;
        if (isMarkerNode(n) && precedes(n)) return n;
        if (depth < MARKER_DEPTH) {
          const deeper = walk(n, depth + 1);
          if (deeper) return deeper;
        }
      }
      return null;
    };
    return walk(scope, 1);
  } catch { /* exotic DOM */ }
  return null;
}

/* ----------------------------------------------------- (1) the label region */

/** Same root as the field, so shadow-DOM forms resolve their own labels. */
function rootOf(el) {
  try {
    const r = el.getRootNode ? el.getRootNode() : null;
    if (r && r.querySelectorAll) return r;
  } catch { /* detached */ }
  return el.ownerDocument || globalThis.document;
}

function byId(el, id) {
  try {
    const r = rootOf(el);
    return r.getElementById ? r.getElementById(id) : r.querySelector(`[id="${id}"]`);
  } catch { return null; }
}

/**
 * The nodes that semantically DESCRIBE this field, most authoritative first.
 * Empty when the form associates nothing — the structural fallback then runs.
 */
function semanticLabels(el) {
  const out = [];

  const labelledBy = String(attr(el, 'aria-labelledby') || '').trim();
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const n = byId(el, id);
      if (n) out.push(n);
    }
  }

  if (el.id) {
    try {
      for (const lab of rootOf(el).querySelectorAll('label[for]')) {
        // htmlFor is unavailable on a detached label in some engines.
        const f = lab.htmlFor || attr(lab, 'for');
        if (f === el.id && !out.includes(lab)) out.push(lab);
      }
    } catch { /* no root query */ }
  }

  try {
    const wrapping = el.closest && el.closest('label');
    if (wrapping && !out.includes(wrapping)) out.push(wrapping);
  } catch { /* detached */ }

  return out;
}

/**
 * The smallest ancestor that holds this field AND something labelish, but no
 * OTHER control. This is the generic form of the old closest('td'): it lands on
 * a <td> in an ADF table, a .form-group in Bootstrap, a <mat-form-field> in
 * Angular, and a bare <div> in hand-rolled markup — without naming any of them.
 */
function fieldGroup(el) {
  let node = el.parentElement;
  for (let up = 0; node && up < GROUP_CLIMB; up++, node = node.parentElement) {
    if (controlsIn(node).length > 1) return null;   // shared container; ambiguous
    try {
      if (node.querySelector && node.querySelector(LABEL_SEL)) return node;
    } catch { /* exotic node */ }
  }
  return null;
}

/**
 * One meaningful level up — the enclosing CELL or group, not the next DOM node.
 * A composite widget buries its field under span/tr/tbody/table before the
 * layout says anything, so climbing raw parentElements burns the budget on
 * plumbing: Oracle's Amount field sits 9 elements below the cell whose sibling
 * holds its asterisk, but only 3 CELLS below it.
 */
function nextContainerUp(node) {
  if (!node || !node.parentElement) return null;
  try {
    const cell = node.parentElement.closest('td, th, fieldset, [role="group"]');
    if (cell) return cell;
  } catch { /* no closest */ }
  return node.parentElement;
}

/**
 * A node that LABELS a field rather than holding one: it names something and
 * owns no control of its own. Used to qualify a preceding sibling as this
 * field's label cell — the ADF panelFormLayout shape, stated generically.
 */
function isLabelOnly(node) {
  if (!node || node.nodeType !== 1) return false;
  if (controlsIn(node).length) return false;
  try {
    if (node.matches && node.matches(LABEL_SEL)) return true;
    return !!(node.querySelector && node.querySelector(LABEL_SEL));
  } catch { return false; }
}

/**
 * Does this label belong to somebody else? A label carrying `for` names its
 * field explicitly, so a multi-column row — [label A*][field A][label B][field
 * B] — cannot leak A's asterisk onto B.
 */
function ownedByOther(labelish, el) {
  try {
    const owner = labelish.matches && labelish.matches('label[for]')
      ? labelish
      : (labelish.querySelector && labelish.querySelector('label[for]'));
    if (!owner) return false;                    // unowned: takeable
    const f = owner.htmlFor || attr(owner, 'for');
    return !!f && f !== el.id;
  } catch { return false; }
}

/* ------------------------------------------------------------- the searches */

/** Marker on the field's own semantic label, or the label's marker sibling. */
function fromSemanticLabel(el) {
  for (const lab of semanticLabels(el)) {
    const hit = markerIn(lab);
    if (hit) return hit;
    // The asterisk may be a bare text node in the label rather than a node of
    // its own, which markerIn cannot see: <label for="a">Company Name *</label>
    if (LABEL_EDGE_STAR.test(visibleTextOf(lab)) && isRendered(lab)) return lab;
    // Frameworks that put the asterisk BESIDE the label, not inside it:
    // <label>Name</label><span class="text-danger">*</span>
    const sib = lab.nextElementSibling;
    if (sib && !isControl(sib) && isMarkerNode(sib)) return sib;
    const prev = lab.previousElementSibling;
    if (prev && !isControl(prev) && isMarkerNode(prev)) return prev;
  }
  return null;
}

/** Marker anywhere in the field's own group, and in the cell that precedes it. */
function fromFieldGroup(el) {
  const group = fieldGroup(el);
  if (!group) return null;

  // Inside the group. Bound by the field's own label when there is one, so a
  // trailing footnote asterisk cannot be mistaken for a marker.
  let ownLabel = null;
  for (const lab of semanticLabels(el)) {
    try { if (group.contains(lab)) { ownLabel = lab; break; } } catch { /* detached */ }
  }
  const hit = markerIn(group, ownLabel);
  if (hit) return hit;

  // Beside the group: the label sits in the PREVIOUS sibling — ADF's
  // panelFormLayout, and every "label column / field column" grid. Climbed,
  // because a composite widget nests its field in tables of its own.
  let node = group;
  for (let up = 0; node && up < GROUP_CLIMB; up++) {
    const prev = node.previousElementSibling;
    if (prev && isLabelOnly(prev) && !ownedByOther(prev, el)) {
      const side = markerIn(prev);
      if (side) return side;
    }
    node = nextContainerUp(node);
    if (!node || controlsIn(node).length > 1) break;   // left our own field
  }
  return null;
}

/**
 * A marker on the enclosing COMPOSITE — Oracle's panelLabelAndMessage
 * ("Amount" = a currency <select> plus an amount <input> under one asterisk), a
 * fieldset with a required <legend>, a radio group. The marker is real but it
 * describes the GROUP, so the caller is told which via `scope`.
 */
function fromComposite(el) {
  let node = el.parentElement;
  let seenOthers = false;
  for (let up = 0; node && up < COMPOSITE_CLIMB; up++, node = nextContainerUp(node)) {
    const controls = controlsIn(node);
    if (controls.length > 1) seenOthers = true;
    if (!seenOthers) continue;              // still inside our own field
    if (controls.length > 6) break;         // a whole form, not a composite

    const prev = node.previousElementSibling;
    if (prev && isLabelOnly(prev) && !ownedByOther(prev, el)) {
      const side = markerIn(prev);
      if (side) return side;
    }
    try {
      if (node.matches && node.matches('fieldset')) {
        const legend = node.querySelector('legend');
        if (legend) {
          const lh = markerIn(legend);
          if (lh) return lh;
        }
      }
    } catch { /* exotic node */ }
  }
  return null;
}

/* ------------------------------------------------------------- calibration */

const calCache = typeof WeakMap === 'function' ? new WeakMap() : null;

/** The form, else the nearest thing acting as one. */
function formOf(el) {
  try {
    if (el.form) return el.form;
    const f = el.closest && el.closest('form, [role="form"]');
    if (f) return f;
  } catch { /* detached */ }
  return el.ownerDocument?.body || null;
}

/**
 * Does this form mark its mandatory fields at all? Without this, a form that
 * simply never draws asterisks would have every field reported as explicitly
 * optional — a confident lie. Sampled and cached; forms do not change shape
 * between two keystrokes.
 */
function usesMarkers(el, now) {
  const form = formOf(el);
  if (!form) return false;

  if (calCache) {
    const hit = calCache.get(form);
    if (hit && (now - hit.at) < CALIBRATION_TTL_MS) return hit.value;
  }

  let value = false;
  const controls = controlsIn(form);
  const n = Math.min(controls.length, CALIBRATION_SAMPLE);
  for (let i = 0; i < n; i++) {
    const c = controls[i];
    if (c.required === true || attr(c, 'aria-required') === 'true') { value = true; break; }
    if (fromSemanticLabel(c) || fromFieldGroup(c)) { value = true; break; }
  }

  if (calCache) calCache.set(form, { at: now, value });
  return value;
}

/* ------------------------------------------------------------------- public */

/**
 * @typedef {Object} RequiredVerdict
 * @property {boolean|null} required true / false / null ("no grounds to say")
 * @property {string} source which rule decided, for debugging a misread page
 * @property {'field'|'group'} scope 'group' when the marker describes a composite
 */

/**
 * @param {Element} el
 * @returns {RequiredVerdict}
 */
export function detectRequired(el) {
  const out = { required: null, source: 'none', scope: 'field' };
  if (!el || !el.tagName) return out;

  try {
    // --- authoritative: the field states it itself ---------------------------
    // ADF: the ATTRIBUTE as well as the property — the scan this replaced used
    // `[required]`, which also catches a custom element that is not a control.
    if (el.required === true || attr(el, 'required') !== null) {
      return { required: true, source: 'attr:required', scope: 'field' };
    }

    const ariaReq = attr(el, 'aria-required');
    if (ariaReq === 'true') return { required: true, source: 'attr:aria-required', scope: 'field' };
    if (ariaReq === 'false') return { required: false, source: 'attr:aria-required', scope: 'field' };

    if (String(attr(el, 'data-required') || '') === 'true') {
      return { required: true, source: 'attr:data-required', scope: 'field' };
    }

    // --- the field's own label ----------------------------------------------
    if (fromSemanticLabel(el)) return { required: true, source: 'label', scope: 'field' };

    // --- the field's group, and the label cell beside it ---------------------
    if (fromFieldGroup(el)) return { required: true, source: 'group', scope: 'field' };

    // --- an enclosing composite ---------------------------------------------
    if (fromComposite(el)) return { required: true, source: 'composite', scope: 'group' };

    // --- nothing found: is that an answer, or an absence of evidence? --------
    if (usesMarkers(el, Date.now())) {
      return { required: false, source: 'calibrated', scope: 'field' };
    }
    return { required: null, source: 'unmarked-form', scope: 'field' };
  } catch { /* a malformed DOM must not stop recording */ }
  return out;
}

/**
 * Convenience for callers that only want the flag.
 * @returns {boolean|null}
 */
export function isRequired(el) {
  return detectRequired(el).required;
}

/** Exposed for tests and for debugging a misread page from the console. */
export const __internals = {
  isMarkerNode, markerIn, semanticLabels, fieldGroup, usesMarkers,
};
