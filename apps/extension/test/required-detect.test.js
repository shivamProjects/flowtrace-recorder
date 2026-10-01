/**
 * required-detect.test.js — the tri-state, and the two ADF traps.
 *
 * The point of the detector is that "no" and "don't know" are different
 * answers, so each of the three verdicts gets a case of its own. The two ADF
 * traps are the reason a marker's PRESENCE cannot be the test: ADF renders an
 * empty `p_rqi` span and an `AFRequiredIconAbsence` spacer on OPTIONAL fields,
 * and a detector that counts either marks the whole form.
 *
 * jsdom, not a browser, so two of the detector's rules are unobservable here
 * and are NOT claimed by any assertion below:
 *   - `::before` / `::after` asterisks (jsdom has no pseudo-element styles)
 *   - zero-size boxes (jsdom has no layout; getBoundingClientRect is all zeros)
 * Everything asserted here is decided by text, class, attribute, or an explicit
 * `display:none` — all of which jsdom computes for real.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { detectRequired, isRequired, __internals } from '../src/core/content/required.js';

/** @param {string} html */
function load(html) {
  document.body.innerHTML = html;
  return (id) => document.getElementById(id);
}

/** A field that is unambiguously required, so a form counts as "uses markers". */
const CALIBRATOR = `
  <div class="field">
    <label for="cal">Business Unit *</label>
    <input id="cal">
  </div>`;

describe('required detection — tri-state', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('reports true for a field whose label carries a rendered marker', () => {
    const $ = load(`<form>
      <div class="field">
        <label for="a">Supplier</label><span class="AFRequiredIcon">*</span>
        <input id="a">
      </div>
      ${CALIBRATOR}
    </form>`);
    expect(detectRequired($('a')).required).toBe(true);
  });

  it('reports false — not null — for an unmarked field on a form that marks others', () => {
    const $ = load(`<form>
      ${CALIBRATOR}
      <div class="field"><label for="b">Description</label><input id="b"></div>
    </form>`);
    const verdict = detectRequired($('b'));
    expect(verdict.required).toBe(false);
    expect(verdict.source).toBe('calibrated');
  });

  it('reports null — not false — when the form marks nothing at all', () => {
    const $ = load(`<form>
      <div class="field"><label for="c">First Name</label><input id="c"></div>
      <div class="field"><label for="d">Last Name</label><input id="d"></div>
    </form>`);
    const verdict = detectRequired($('c'));
    expect(verdict.required).toBeNull();
    expect(verdict.source).toBe('unmarked-form');
    // The whole point: "don't know" must not be spelled the same way as "no".
    expect(verdict.required).not.toBe(false);
  });

  it('reports null for a detached or non-element argument rather than guessing', () => {
    expect(isRequired(null)).toBeNull();
    expect(isRequired({})).toBeNull();
  });
});

describe('required detection — the ADF traps', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('does not report required for an AFRequiredIconAbsence spacer', () => {
    // ADF emits this on OPTIONAL fields to keep the marker column aligned. It
    // is a marker class that means the opposite, and it can render.
    const $ = load(`<form>
      ${CALIBRATOR}
      <div class="field">
        <label for="e">Comments</label><span class="AFRequiredIconAbsence">*</span>
        <input id="e">
      </div>
    </form>`);
    expect(detectRequired($('e')).required).toBe(false);
  });

  it('does not report required for an empty p_rqi span', () => {
    // The class is on required AND optional fields; only the content differs.
    const $ = load(`<form>
      ${CALIBRATOR}
      <div class="field">
        <label for="f">Reference</label><span class="p_rqi"></span>
        <input id="f">
      </div>
    </form>`);
    expect(detectRequired($('f')).required).toBe(false);
  });

  it('does not report required for an asterisk the page has hidden', () => {
    const $ = load(`<style>.gone { display: none; }</style>
    <form>
      ${CALIBRATOR}
      <div class="field">
        <label for="g">Notes</label><span class="star gone">*</span>
        <input id="g">
      </div>
    </form>`);
    expect(detectRequired($('g')).required).toBe(false);
  });
});

describe('required detection — knowledge kept from the ADF-only scan', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('accepts a double asterisk as a marker node, not only a single one', () => {
    const $ = load(`<form>
      ${CALIBRATOR}
      <div class="field">
        <label for="h">Amount</label><span class="starcell">**</span>
        <input id="h">
      </div>
    </form>`);
    expect(detectRequired($('h')).required).toBe(true);
  });

  it('recognises ADF camelCase marker classes, which have no token boundary', () => {
    // Isolated from the asterisk rule on purpose: the glyph here is NOT one
    // STAR_TEXT accepts, so the only thing that can make this a marker is the
    // class name — which is spelled AFRequiredIcon, with nothing separating
    // "Required" from its neighbours.
    const $ = load('<span id="m" class="AFRequiredIcon">●</span>');
    expect(__internals.isMarkerNode($('m'))).toBe(true);
  });

  it('honours a bare required attribute on a non-control element', () => {
    const $ = load('<oj-input-text id="n" required></oj-input-text>');
    expect(detectRequired($('n')).required).toBe(true);
  });
});
