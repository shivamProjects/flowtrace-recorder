/**
 * locator-object.js — element → RecordedLocator.
 *
 * The replayer does not execute a locator EXPRESSION; it builds a list of
 * candidate locators and tries them strongest-first (see engine/locators.ts,
 * `candidatesFor`). Every field it can read is a fallback that survives a
 * re-render the primary selector does not, so this module deliberately
 * populates as many fields as the element supports rather than picking one
 * winner and discarding the rest:
 *
 *   id → attrSelector → selector → role+name → label → placeholder → title → text
 *
 * Quoting engine/types.ts: "Reducing all of that to a single `selector` string
 * throws away every fallback the recorder went to the trouble of capturing."
 *
 * Application-specific fields (componentId, containerRole, hasLovIcon) are NOT
 * derived here. They arrive already computed on the meta bag, put there by a
 * patch's `resolve.meta` hook — core must stay ignorant of ADF.
 *
 * "As many fields as the element supports" means the ones in
 * `shared/schema.js`'s allow-list and no others. Populating a field nothing
 * reads is not free: the excluded set was 26% of every locator object in a
 * 9,010-step corpus, on a payload that crosses a customer VPN.
 */

import { pruneLocator } from '../shared/schema.js';
import { attributeSelector } from './escape.js';
import { cleanText, cleanLabel, resolveLabel, roleOf } from './dom.js';
import { generateSelector } from './selector.js';

/** Attributes that can stand alone as a CSS attribute selector, best first. */
const ATTR_SELECTOR_ORDER = [
  'data-testid', 'data-test', 'data-qa', 'data-cy',
  'title', 'aria-label', 'name', 'placeholder',
];

/** How far up to look for the labelled field an element sits inside. */
const PARENT_HOPS = 8;

/** Longest accessible name we will derive from visible text. */
const NAME_MAX = 80;

/**
 * Build the structured locator the replayer consumes.
 *
 * @param {Element|null} el
 * @param {Object} [opts]
 * @param {(el: Element) => string} [opts.resolveLabel]  patch label resolver
 * @param {{selector: string, raw: Object}} [opts.selector]
 *   An already-computed generateSelector() result. Passed in by capture.js so
 *   the generator runs once per event rather than twice.
 * @param {Object} [opts.meta]
 *   The event's meta bag. Read only for the fields a patch contributes.
 * @returns {Object} RecordedLocator
 */
export function buildLocatorObject(el, opts = {}) {
  if (!el || !el.tagName) return {};

  const labelResolver = opts.resolveLabel || resolveLabel;
  const selector = opts.selector || generateSelector(el, { resolveLabel: labelResolver });
  const meta = opts.meta || {};

  const label = cleanLabel(safe(() => labelResolver(el)) || '');
  const rawText = safe(() => el.textContent) || '';
  const text = cleanText(rawText);
  const title = attr(el, 'title');
  const placeholder = attr(el, 'placeholder');

  // The ACCESSIBLE name, not the `name` attribute — engine/normalize.ts reads
  // `loc.name ?? loc.label ?? loc.title` into accessibleName, which is what
  // getByRole(role, { name }) is built from. Putting a form field's `name`
  // attribute here would send the replayer looking for a control whose visible
  // name is "InvoiceNum1".
  const { name, exact } = accessibleName(el, { label, text, title, placeholder });

  const locator = {
    id: el.id || undefined,
    role: roleOf(el) || undefined,
    name: name || undefined,
    label: label || undefined,
    title: title || undefined,
    text: text || undefined,
    selector: selector.selector || undefined,
    attrSelector: attrSelector(el) || undefined,
    placeholder: placeholder || undefined,
    sourceTag: el.tagName.toLowerCase(),
    exact,
    parent: parentField(el, labelResolver, label),

    // Patch territory. Present only when a patch's resolve.meta supplied them.
    componentId: meta.componentId || undefined,
    containerRole: meta.containerRole || undefined,
    hasLovIcon: meta.hasLovIcon === true ? true : undefined,
  };

  return pruneLocator(locator);
}

/**
 * The name a person would use for this control, and whether it is the WHOLE of
 * that name.
 *
 * `exact` matters because the replayer tries an exact role+name match before a
 * fuzzy one, and Playwright's default is a case-insensitive SUBSTRING — under
 * which a recorded "Save" also matches "Save and Close", which sits first in
 * DOM order on the Oracle toolbar. So `exact` is claimed only for names taken
 * verbatim from an attribute or a label, never for text that `cleanText` may
 * have truncated.
 */
function accessibleName(el, { label, text, title, placeholder }) {
  if (label) return { name: label, exact: true };

  const raw = (safe(() => el.textContent) || '').replace(/\s+/g, ' ').trim();
  if (text && text.length <= NAME_MAX) return { name: text, exact: text === raw };

  if (title) return { name: title, exact: true };
  if (placeholder) return { name: placeholder, exact: true };
  return { name: '', exact: undefined };
}

/**
 * A ready-made CSS attribute selector, e.g. `[title="Search: Supplier"]`.
 *
 * Deliberately NOT an id selector: `id` travels in its own field and the
 * replayer already builds `[id="…"]` from it, so spending this slot on the id
 * would cost a fallback rather than add one.
 *
 * Escaping is the existing audited helper — an unquoted `Search: Supplier` or
 * an apostrophe in a value is a CSS parse error, which throws before the page
 * is ever queried.
 */
function attrSelector(el) {
  for (const name of ATTR_SELECTOR_ORDER) {
    const value = attr(el, name);
    // Anchors name a fragment target rather than an identity.
    if (name === 'name' && el.tagName === 'A') continue;
    if (value) return attributeSelector(name, value);
  }
  return '';
}

/**
 * The labelled field this element sits inside.
 *
 * A grid cell, an LOV row and a magnifier icon all have no name of their own;
 * what identifies them is the field they belong to. engine/actions.ts names a
 * copy output `locator.parent.name` for exactly this reason.
 */
function parentField(el, labelResolver, ownLabel) {
  let node = el.parentElement;
  for (let hops = 0; node && hops < PARENT_HOPS; hops += 1, node = node.parentElement) {
    const label = cleanLabel(safe(() => labelResolver(node)) || '');
    if (!label || label === ownLabel) continue;
    if (label.length > 60) continue;
    return { name: label, label };
  }
  return undefined;
}

function attr(el, name) {
  const value = safe(() => el.getAttribute(name));
  return value ? String(value).trim() : '';
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
