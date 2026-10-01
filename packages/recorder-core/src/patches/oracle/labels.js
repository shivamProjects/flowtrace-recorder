/**
 * labels.js — how ADF associates a label with a control.
 *
 * ADF does not use the plain `label[for=id]` relationship the HTML spec
 * describes. It renders the interactive element with a `::content` suffix on
 * the id while pointing the label at the bare id, and in panelFormLayout it
 * often does not emit a `for` attribute at all, relying on table-cell adjacency
 * instead. Neither is discoverable from the markup without knowing ADF.
 *
 * This is a faithful port of the resolver that lived in the monolith. The one
 * deliberate difference is that the `label[for=…]` lookup quotes the id
 * properly — the original interpolated it raw, so an id containing a quote
 * threw a DOMException out of the click handler and lost the interaction.
 */

import { cleanLabel } from '../../content/dom.js';
import { cssAttributeValue } from '../../content/escape.js';
import { FIELD_WRAPPER } from './selectors.js';

/**
 * @param {Element} el
 * @returns {string} label text, or '' when nothing could be resolved
 */
export function resolveAdfLabel(el) {
  if (!el) return '';
  const doc = el.ownerDocument;

  // 1 — explicit ARIA label.
  const aria = el.getAttribute('aria-label');
  if (aria) return cleanLabel(aria);

  // 2 — ARIA label reference.
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const ref = doc.getElementById(labelledBy);
    if (ref) return cleanLabel(ref.textContent);
  }

  // 3 — label[for], tried both with and without ADF's ::content suffix. The
  //     name attribute is accepted as an id source because ADF populates both
  //     and some components omit the id.
  const base = (el.id || el.getAttribute('name') || '').replace(/::content$/, '');
  if (base) {
    const lbl = doc.querySelector(
      `label[for=${cssAttributeValue(base)}], label[for=${cssAttributeValue(`${base}::content`)}]`,
    );
    if (lbl) return cleanLabel(lbl.textContent);
  }

  // 4 — panelFormLayout renders the label in the row's first cell with no
  //     `for` attribute. The length cap keeps a data-heavy first column from
  //     being mistaken for a label.
  const row = el.closest('tr');
  if (row) {
    const cell = row.querySelector('td:first-child');
    if (cell) {
      const text = cleanLabel((cell.querySelector('label') || cell).textContent);
      if (text && text.length < 60) return text;
    }
  }

  // 5 — any label inside the component's own ADF wrapper.
  const wrapper = el.closest(FIELD_WRAPPER);
  if (wrapper) {
    const lbl = wrapper.querySelector('label');
    if (lbl) return cleanLabel(lbl.textContent);
  }

  // 6 — title, which ADF uses for icon-only controls.
  const title = el.getAttribute('title');
  if (title) return cleanLabel(title);

  return '';
}
