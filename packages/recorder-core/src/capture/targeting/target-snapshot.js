/**
 * target-snapshot.js — captures immutable observational snapshot of target element.
 *
 * Captures tagName, role, label, values, geometry, and attributes immediately
 * upon interaction so subsequent DOM mutations, async operations, or removals
 * do not lose provenance.
 *
 * Invariants:
 * 1. True immutability: Contains no live DOM Element references.
 * 2. Credential safety: Never reads value for sensitive / password fields.
 */

import { roleOf, resolveLabel, cleanText } from '../../content/dom.js';
import { generateSelector } from '../../content/selector.js';
import { buildLocatorObject } from '../../content/locator-object.js';
import { GeometryCapture } from '../../evidence/geometry.js';
import { isSensitiveField } from '../../shared/sensitive.js';
import { detectRequired } from '../../content/required.js';

const geometryCapture = new GeometryCapture();

/**
 * @typedef {Object} TargetSnapshot
 * @property {string} targetId
 * @property {string} tagName
 * @property {string|null} inputType
 * @property {string|null} role
 * @property {string|null} label
 * @property {string|null} text
 * @property {string|null} value
 * @property {boolean|null} checked
 * @property {Object} selector
 * @property {Object|null} locatorObject
 * @property {Object|null} geometry
 * @property {Object} meta
 */

/**
 * Take an immutable snapshot of a target element.
 * @param {Element|null} el
 * @param {Object} [options]
 * @param {Function} [options.resolveLabel]
 * @param {Object} [options.extraMeta]
 * @returns {TargetSnapshot|null}
 */
export function takeTargetSnapshot(el, options = {}) {
  if (!el) return null;

  const labelResolver = options.resolveLabel;
  const selector = generateSelector(el, labelResolver ? { resolveLabel: labelResolver } : {});
  const label = labelResolver ? labelResolver(el) : resolveLabel(el);

  const meta = {
    ...(options.extraMeta || {}),
    ...selector.raw,
  };

  const isSensitive = isSensitiveField(el) || meta.sensitive === true;
  if (isSensitive) {
    meta.sensitive = true;
  }

  const reqVerdict = detectRequired(el);
  if (reqVerdict && reqVerdict.required !== null) {
    meta.required = reqVerdict.required;
    meta.requiredSource = reqVerdict.source;
    meta.requiredScope = reqVerdict.scope;
  }

  const locatorObject = buildLocatorObject(el, {
    resolveLabel: labelResolver,
    selector,
    meta,
  });

  const geometry = geometryCapture.capture(el);

  const tagName = el.tagName ? el.tagName.toLowerCase() : 'unknown';
  const inputType = el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : null;

  // Credential safety invariant: NEVER read or store raw value for sensitive fields!
  let value = null;
  if (!isSensitive && 'value' in el && typeof el.value === 'string') {
    value = el.value;
  }

  let checked = null;
  if ('checked' in el && typeof el.checked === 'boolean') {
    checked = el.checked;
  }

  return {
    targetId: selector.selector,
    tagName,
    inputType,
    role: roleOf(el),
    label,
    text: cleanText(el.textContent),
    value,
    checked,
    selector: {
      selector: selector.selector,
      locator: selector.locator,
    },
    locatorObject,
    geometry,
    meta,
  };
}
