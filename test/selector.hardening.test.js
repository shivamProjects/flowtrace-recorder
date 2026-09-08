/**
 * selector.hardening.test.js — the four selector fixes ported from the client
 * recorder, each pinned to the failure it was measured against.
 *
 * All four attack one class: 57% of 191 production replay failures were
 * "element never appeared", i.e. the recorder emitted a selector that could not
 * find its element on the next run. None of them are style preferences; each
 * has a live case behind it, quoted in the comment on the test.
 *
 * The engine tests here install the vendored injected script exactly as
 * test/selector.engine.test.js does, because verification (G2) is only
 * reachable when the engine is present.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  generateSelector, gridCellSelector, isPositional, isStableId,
} from '../src/core/content/selector.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_GLOBAL = '__flowtracePwInjected';

function instantiate() {
  const source = readFileSync(resolve(root, 'vendor/playwright/injected-script.js'), 'utf8');
  const module = { exports: {} };
  new Function('module', 'exports', source)(module, module.exports);
  const Ctor = module.exports.InjectedScript();
  return new Ctor(globalThis, {
    isUnderTest: false,
    sdkLanguage: 'javascript',
    frameSeq: 0,
    testIdAttributeName: 'data-testid',
    stableRafCount: 1,
    browserName: 'chromium',
    shouldPrependErrorPrefix: false,
    isUtilityWorld: false,
    customEngines: [],
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

// ───────────────────────────────────────────────────────────────────────────
// G1 — volatile-id rejection
// ───────────────────────────────────────────────────────────────────────────

describe('G1 — isStableId rejects ids the app mints per page load', () => {
  // Every one of these is a REAL id from a production recording. The old
  // isStableId accepted all four: none is all-digits and none has more than
  // three colon segments, which was the whole of the test. compiler.js then
  // PREFERRED them over role/label, spending the step's fallback slots on
  // selectors that cannot match.
  const VOLATILE = [
    // 2 colon segments, so the shape test waved it through. `_oj\d{2,}` matches
    // INSIDE it — which is why the regex must stay unanchored.
    ['_oj691_table:1366046988_0', 'JET table, _oj prefix + ms stamp'],
    ['createObjectsfrag-7jr5g37f7:1368896047_0', 'ADF fragment id'],
    ['ui-id-104', 'jQuery UI per-load counter'],
    ['_iq0fxr850q-input', 'high-entropy token behind a leading underscore'],
    ['_oj189_sf_smart-filter', 'JET smart filter'],
    ['oj-searchselect-filter-oj-selectsingle-4', 'JET component counter'],
  ];

  for (const [id, why] of VOLATILE) {
    it(`rejects ${id} (${why})`, () => {
      expect(isStableId(id)).toBe(false);
    });
  }

  // The other half of the contract. A rejection rule that also rejects real ids
  // does not fix anything — it just moves the failure.
  const STABLE = [
    'submit-order',
    'amt2',
    'invoiceLine12',       // `word123` shape: author-written, not minted
    'username',
    'idcs-signin-basic-signin-form-username',
    'pt1:r1:it10',         // 3 colon segments — an ADF path we still accept
  ];

  for (const id of STABLE) {
    it(`still accepts ${id}`, () => {
      expect(isStableId(id)).toBe(true);
    });
  }

  it('keeps the pre-existing shape rules', () => {
    expect(isStableId('12345')).toBe(false);              // all digits
    expect(isStableId('pt1:r1:0:AP1:i1')).toBe(false);    // >3 colon segments
    expect(isStableId('')).toBe(false);
  });

  it('drops a volatile id out of the fallback ladder entirely', () => {
    // The end-to-end effect, with no engine installed: the ladder's priority 1
    // is the id, and it must decline to use this one.
    const saved = globalThis[ENGINE_GLOBAL];
    delete globalThis[ENGINE_GLOBAL];
    try {
      document.body.innerHTML =
        '<button id="ui-id-104" aria-label="Save and Close">Save</button>';
      const { selector } = generateSelector(document.querySelector('button'));
      expect(selector).not.toContain('ui-id-104');
      expect(selector).toBe('[aria-label="Save and Close"]');
    } finally {
      if (saved) globalThis[ENGINE_GLOBAL] = saved;
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// G3 — positional and state-class selectors
// ───────────────────────────────────────────────────────────────────────────

describe('G3 — positional and runtime-state selectors are refused', () => {
  it('recognises every positional form', () => {
    // `.p_AFHighlighted > td:nth-child(4)` is the measured case: one match while
    // the row is highlighted, zero once the selection moves.
    expect(isPositional('.p_AFHighlighted > td:nth-child(4)')).toBe(true);
    expect(isPositional('td:nth-of-type(3)')).toBe(true);
    expect(isPositional('li:nth-last-child(2)')).toBe(true);
    expect(isPositional('li:nth-last-of-type(2)')).toBe(true);
    expect(isPositional("internal:role=button >> nth=2")).toBe(true);
    expect(isPositional('tr.p_AFSelected td')).toBe(true);
  });

  it('does not fire on ordinary selectors', () => {
    expect(isPositional('#submit-order')).toBe(false);
    expect(isPositional('internal:role=button[name="Save"i]')).toBe(false);
    expect(isPositional('td:has([id="t3:1:account"])')).toBe(false);
    // A class that merely CONTAINS "nth" is not positional.
    expect(isPositional('.month-picker')).toBe(false);
  });

  it('the CSS fallback no longer emits an nth-of-type tie-breaker', () => {
    const saved = globalThis[ENGINE_GLOBAL];
    delete globalThis[ENGINE_GLOBAL];
    try {
      document.body.innerHTML =
        '<ul><li class="rowitem"></li><li class="rowitem"></li></ul>';
      const { selector } = generateSelector(document.querySelectorAll('li')[1]);
      expect(isPositional(selector)).toBe(false);
    } finally {
      if (saved) globalThis[ENGINE_GLOBAL] = saved;
    }
  });

  it('never builds on an ADF runtime state class', () => {
    const saved = globalThis[ENGINE_GLOBAL];
    delete globalThis[ENGINE_GLOBAL];
    try {
      document.body.innerHTML =
        '<div class="p_AFHighlighted xen"></div><div class="xen"></div>';
      const { selector } = generateSelector(document.querySelector('.p_AFHighlighted'));
      expect(selector).not.toContain('p_AF');
    } finally {
      if (saved) globalThis[ENGINE_GLOBAL] = saved;
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// G4 — the grid-cell selector G3 falls back to
// ───────────────────────────────────────────────────────────────────────────

describe('G4 — a bare grid cell is addressed by its child coordinate id', () => {
  // A classic Fusion grid cell is `<td nowrap class="xen">`: no id, no role, no
  // title, and before the field is filled in, no text. The identity is one
  // level in: `…:jeLineAppTable:_ATp:t3:1:account` — table t3, row 1, column
  // account.
  const CELL = 'pt1:jeLineAppTable:_ATp:t3:1:account';

  it('builds td:has() from a child coordinate id', () => {
    document.body.innerHTML =
      `<table><tr class="p_AFHighlighted"><td class="xen"></td>`
      + `<td class="xen"><input id="${CELL}"></td></tr></table>`;
    const td = document.querySelectorAll('td')[1];

    expect(gridCellSelector(td)).toBe(`td:has([id="${CELL}"])`);
    // And it selects the cell whether or not the row is highlighted, which the
    // positional form did not.
    expect([...document.querySelectorAll(gridCellSelector(td))]).toEqual([td]);
  });

  it('is what the CSS fallback now returns for such a cell', () => {
    const saved = globalThis[ENGINE_GLOBAL];
    delete globalThis[ENGINE_GLOBAL];
    try {
      document.body.innerHTML =
        `<table><tr class="p_AFHighlighted"><td class="xen"></td>`
        + `<td class="xen"><input id="${CELL}"></td></tr></table>`;
      const td = document.querySelectorAll('td')[1];
      const { selector } = generateSelector(td);

      expect(selector).toBe(`td:has([id="${CELL}"])`);
      expect([...document.querySelectorAll(selector)]).toEqual([td]);
    } finally {
      if (saved) globalThis[ENGINE_GLOBAL] = saved;
    }
  });

  it('skips a ::-suffixed id — that is a sub-part, not the component', () => {
    document.body.innerHTML =
      `<table><tr><td><input id="${CELL}::content"></td></tr></table>`;
    expect(gridCellSelector(document.querySelector('td'))).toBe('');
  });

  it('skips a volatile child id', () => {
    document.body.innerHTML =
      '<table><tr><td><input id="_oj691_table:1366046988_0"></td></tr></table>';
    expect(gridCellSelector(document.querySelector('td'))).toBe('');
  });

  it('applies to cells only', () => {
    document.body.innerHTML = `<div><input id="${CELL}"></div>`;
    expect(gridCellSelector(document.querySelector('div'))).toBe('');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// G2 — every generated selector is re-queried before it ships
// ───────────────────────────────────────────────────────────────────────────

describe('G2 — the engine\'s answer is verified, not trusted', () => {
  beforeAll(() => {
    globalThis[ENGINE_GLOBAL] = instantiate();
  });

  it('replaces a trimmed attribute value that no longer identifies one element', () => {
    // The client's live case: Playwright TRIMS a long attribute value at a word
    // boundary for readability (`suitableTextAlternatives`, 30 and 80 chars) and
    // scores the SHORTER variant better. There, internal:attr matching was
    // EXACT, so the trimmed selector matched 0 elements and replay died on a
    // 90s timeout.
    //
    // MEASURED DIFFERENCE, and the reason this test is not the client's: in the
    // Playwright vendored here, createAttributeMatcher (injected-script.js:8159)
    // matches a non-caseSensitive value by `includes`, i.e. SUBSTRING. So the
    // trimmed form does not match zero — it matches too MANY. Same fix, other
    // end of the failure: verification demands exactly one.
    document.body.innerHTML =
      '<div title="Search: Depreciation Method for Poland" id="depm"></div>'
      + '<div title="Search: Depreciation Method for Spain" id="deps"></div>';
    const el = document.querySelector('#depm');

    const real = globalThis[ENGINE_GLOBAL];
    const trimmed = 'internal:attr=[title="Search: Depreciation Method"i]';
    // Confirm the premise rather than assuming it: the trimmed selector really
    // is ambiguous against this DOM.
    expect(real.querySelectorAll(real.parseSelector(trimmed), document)).toHaveLength(2);

    globalThis[ENGINE_GLOBAL] = Object.create(real, {
      generateSelectorSimple: { value: () => trimmed },
    });
    try {
      const { selector } = generateSelector(el);
      expect(selector).not.toBe(trimmed);
      // The rebuild puts the real value back, marked exact ("s") so no further
      // normalisation can shorten it again.
      expect(selector)
        .toBe('internal:attr=[title="Search: Depreciation Method for Poland"s]');
      const found = real.querySelectorAll(real.parseSelector(selector), document);
      expect([...found]).toEqual([el]);
    } finally {
      globalThis[ENGINE_GLOBAL] = real;
    }
  });

  it('replaces a selector that matches nothing at all', () => {
    // The generic half of G2: whatever the mechanism, a selector that cannot
    // find its own element is replaced rather than shipped.
    document.body.innerHTML = '<div title="Journal Batch" id="jb">x</div>';
    const el = document.querySelector('#jb');

    const real = globalThis[ENGINE_GLOBAL];
    globalThis[ENGINE_GLOBAL] = Object.create(real, {
      generateSelectorSimple: { value: () => 'internal:attr=[title="Not Present"s]' },
    });
    try {
      const { selector } = generateSelector(el);
      expect(selector).toBe('internal:attr=[title="Journal Batch"s]');
      const found = real.querySelectorAll(real.parseSelector(selector), document);
      expect([...found]).toEqual([el]);
    } finally {
      globalThis[ENGINE_GLOBAL] = real;
    }
  });

  it('falls back to a stable id when the attribute cannot be rebuilt', () => {
    document.body.innerHTML = '<div id="depreciation-method">x</div>';
    const el = document.querySelector('#depreciation-method');

    const real = globalThis[ENGINE_GLOBAL];
    globalThis[ENGINE_GLOBAL] = Object.create(real, {
      generateSelectorSimple: { value: () => 'internal:attr=[title="Nope"i]' },
    });
    try {
      const { selector } = generateSelector(el);
      expect(selector).toBe('css=[id="depreciation-method"]');
      const found = real.querySelectorAll(real.parseSelector(selector), document);
      expect([...found]).toEqual([el]);
    } finally {
      globalThis[ENGINE_GLOBAL] = real;
    }
  });

  it('hands over to the ladder when nothing can be rebuilt', () => {
    // No id, no title, nothing to harden with. The ladder must still get its
    // turn rather than a dead selector shipping.
    document.body.innerHTML = '<button aria-label="Post Journal">Post</button>';
    const el = document.querySelector('button');

    const real = globalThis[ENGINE_GLOBAL];
    globalThis[ENGINE_GLOBAL] = Object.create(real, {
      generateSelectorSimple: { value: () => 'internal:attr=[data-nope="x"i]' },
    });
    try {
      const { selector } = generateSelector(el);
      expect(selector).toBe('[aria-label="Post Journal"]');
      expect([...document.querySelectorAll(selector)]).toEqual([el]);
    } finally {
      globalThis[ENGINE_GLOBAL] = real;
    }
  });

  it('leaves a sound selector completely alone', () => {
    // The common path must not change: verification costs one query and
    // nothing else.
    document.body.innerHTML = '<button>Place order</button>';
    const { selector, locator } = generateSelector(document.querySelector('button'));
    expect(selector).toBe('internal:role=button[name="Place order"i]');
    expect(locator).toBe("page.getByRole('button', { name: 'Place order' })");
  });

  it('rejects a positional selector even though it resolves right now', () => {
    // G3 through the engine path. `nth=` matches today; the point is that it
    // will not after a re-render, so uniqueness at record time is not the test.
    const CELL = 'pt1:jeLineAppTable:_ATp:t3:1:account';
    document.body.innerHTML =
      `<table><tr class="p_AFHighlighted"><td class="xen"></td>`
      + `<td class="xen"><input id="${CELL}"></td></tr></table>`;
    const td = document.querySelectorAll('td')[1];

    const real = globalThis[ENGINE_GLOBAL];
    globalThis[ENGINE_GLOBAL] = Object.create(real, {
      generateSelectorSimple: { value: () => 'css=.p_AFHighlighted > td >> nth=1' },
    });
    try {
      const { selector } = generateSelector(td);
      expect(isPositional(selector)).toBe(false);
      // G4 is what caught it — which is why G3 and G4 ship together.
      expect(selector).toBe(`css=td:has([id="${CELL}"])`);
    } finally {
      globalThis[ENGINE_GLOBAL] = real;
    }
  });
});
