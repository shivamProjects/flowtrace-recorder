/**
 * The recorder's structured output, tested against the replayer's own reader.
 *
 * The acceptance test at the bottom imports `normalizeAction` from
 * ../../replayer/engine/normalize.ts — the real one, not a copy — because the
 * only property worth asserting is that what we emit survives the trip. A
 * hand-written expectation of "what the replayer probably wants" is exactly the
 * kind of test that stayed green while the two sides drifted apart: the engine
 * used to read only `selector` off the locator object and silently drop id,
 * attrSelector, label, title, text and placeholder, and nothing failed.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { compileActions, compileSteps } from '../src/core/background/compiler.js';
import { ACTION_VERBS, LOCATOR_FIELDS, validateActions } from '../src/core/shared/schema.js';
import { buildLocatorObject } from '../src/core/content/locator-object.js';
import { metaFor, resolveAdfLabel } from '@flowtrace/recorder-core';

const only = (events) => compileActions(events)[0];

const clickEvent = (extra = {}) => ({
  type: 'click',
  url: 'https://example.test/',
  label: 'Save and Close',
  role: 'button',
  text: 'Save and Close',
  tagName: 'button',
  meta: { ariaLabel: 'Save and Close' },
  ...extra,
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('compileActions — action names', () => {
  it('spells every name the way the verb enum spells it', () => {
    const names = compileActions([
      { type: 'navigate', url: 'https://example.test/a' },
      clickEvent(),
      { type: 'fill', meta: { ariaLabel: 'Amount' }, value: '100' },
      { type: 'select', meta: { ariaLabel: 'Unit' }, value: 'US1' },
      { type: 'select', meta: { ariaLabel: 'Unit', selectByClick: true }, value: 'US1' },
      { type: 'check', meta: { ariaLabel: 'Taxable' }, checked: true },
      { type: 'check', meta: { ariaLabel: 'Taxable' }, checked: false },
      { type: 'radio', meta: { ariaLabel: 'Cash' } },
      { type: 'press', meta: { ariaLabel: 'Amount' }, value: 'Tab' },
    ]).map((a) => a.action);

    expect(names).toEqual([
      'navigate', 'click', 'fill',
      // selectOption is the <select>; lovSelect is a row pick from an already
      // open list, which the replayer performs as a click. The bare verb
      // `select` meant both and is retired.
      'selectOption', 'lovSelect',
      'check', 'uncheck', 'check', 'press',
    ]);
  });

  it('never emits the retired verb `select`', () => {
    expect(ACTION_VERBS).not.toContain('select');
    const emitted = compileActions([
      { type: 'select', meta: { optionLabel: 'A' }, value: 'A' },
      { type: 'select', meta: { selectByClick: true }, value: 'A' },
    ]).map((a) => a.action);
    expect(emitted).toEqual(['selectOption', 'lovSelect']);
  });

  it('states a wait as a number of milliseconds, not as text', () => {
    // `text` used to carry the duration; the replayer read it as a string, got
    // NaN and paused for nothing.
    const action = only([{ type: 'wait', meta: {}, durationMs: 2500 }]);
    expect(action.durationMs).toBe(2500);
    expect(action.value).toBeUndefined();
    expect(action.locator).toBeUndefined();
  });

  it('gives a scroll its deltas and no locator', () => {
    const action = only([{ type: 'scroll', meta: {}, deltaX: 0, deltaY: 480 }]);
    expect(action).toMatchObject({ action: 'scroll', deltaY: 480 });
    expect(action.locator).toBeUndefined();
  });

  it('drops patch-private bookkeeping rather than inventing an action', () => {
    // The replayer refuses an action it does not handle, so guessing here would
    // fail the whole run at replay time.
    expect(compileActions([{ type: 'meta_nav_tile', meta: { tileId: 'x' } }])).toEqual([]);
  });

  it('drops a navigation that repeats the previous URL', () => {
    const urls = compileActions([
      { type: 'navigate', url: 'https://example.test/a' },
      { type: 'navigate', url: 'https://example.test/a' },
      { type: 'navigate', url: 'https://example.test/b' },
    ]).map((a) => a.url);
    expect(urls).toEqual(['https://example.test/a', 'https://example.test/b']);
  });

  it('carries the key on a press, which is where the replayer reads it', () => {
    expect(only([{ type: 'press', meta: {}, value: 'Tab' }]).key).toBe('Tab');
  });

  it('fills with the value the application committed, and keeps the typed one', () => {
    const action = only([{
      type: 'fill', meta: { ariaLabel: 'Bill-to Name' },
      value: 'ADF USA', committedValue: 'ADF USA, Inc.',
    }]);
    expect(action.value).toBe('ADF USA, Inc.');
    expect(action.committedValue).toBe('ADF USA, Inc.');
  });

  it('keeps the recorded option index as a fallback for a renamed option', () => {
    const action = only([{
      type: 'select',
      meta: { ariaLabel: 'Unit', optionLabel: 'US1 Business Unit', optionIndex: 3 },
      value: 'US1',
    }]);
    expect(action.value).toBe('US1 Business Unit');
    expect(action.optionIndex).toBe(3);
  });
});

describe('compileActions — locator objects', () => {
  it('passes the content script locator through whole', () => {
    document.body.innerHTML = `
      <div>
        <label for="amount">Amount</label>
        <input id="amount" title="Amount" placeholder="0.00">
      </div>`;
    const locatorObject = buildLocatorObject(document.querySelector('#amount'));

    const action = only([{ type: 'fill', locatorObject, value: '100', meta: {} }]);
    expect(action.locator).toMatchObject({
      id: 'amount',
      label: 'Amount',
      title: 'Amount',
      placeholder: '0.00',
      attrSelector: '[title="Amount"]',
      sourceTag: 'input',
    });
  });

  it('rebuilds a usable locator for an event postProcess synthesised', () => {
    // Events created in the service worker never saw an element, so there is no
    // locator object to carry — the flat fields are all there is.
    const action = only([clickEvent({
      locatorObject: undefined,
      selector: '[aria-label="Save and Close"]',
      meta: { ariaLabel: 'Save and Close', id: 'save-btn' },
    })]);
    expect(action.locator).toMatchObject({
      id: 'save-btn',
      role: 'button',
      name: 'Save and Close',
      selector: '[aria-label="Save and Close"]',
      attrSelector: '[aria-label="Save and Close"]',
    });
  });

  it('emits no locator at all for a navigation', () => {
    expect(only([{ type: 'navigate', url: 'https://example.test/a' }]).locator).toBeUndefined();
  });

  it('marks every action with skipInReport so the PDF filter has a boolean', () => {
    expect(only([clickEvent()]).skipInReport).toBe(false);
    expect(only([clickEvent({ skipInReport: true })]).skipInReport).toBe(true);
  });
});

describe('compileSteps', () => {
  it('labels a step "code", not "playwright-code"', () => {
    const [step] = compileSteps([clickEvent()]);
    expect(step.type).toBe('code');
    expect(step.code).toBe(`page.getByLabel('Save and Close').click()`);
  });
});

// ── The acceptance test ─────────────────────────────────────────────────────

describe('round trip through the replayer', () => {
  /** Build the event the content script would produce for `selector` in `html`. */
  function recorded(type, html, selector, extra = {}) {
    document.body.innerHTML = html;
    const el = document.querySelector(selector);
    return {
      type,
      url: 'https://example.test/',
      tagName: el.tagName.toLowerCase(),
      label: resolveAdfLabel(el),
      role: el.getAttribute('role') || null,
      text: (el.textContent || '').trim(),
      meta: metaFor(el),
      locatorObject: buildLocatorObject(el, {
        resolveLabel: resolveAdfLabel,
        meta: metaFor(el),
      }),
      ...extra,
    };
  }

  it('compiles with every locator field intact and schema valid', () => {
    const event = recorded('fill', `
      <table><tbody><tr><td class="af_inputListOfValues">
        <label for="pt1:r1:0:it2">Supplier</label>
        <input id="pt1:r1:0:it2::content" role="combobox" title="Supplier"
               placeholder="Search suppliers" name="SupplierName">
        <a id="pt1:r1:0:it2::lovIconId" title="Search: Supplier"></a>
      </td></tr></tbody></table>
    `, 'input', { value: 'ACME', committedValue: 'ACME Corporation' });

    const [emitted] = compileActions([event]);

    // The action itself.
    expect(emitted.action).toBe('fill');
    expect(emitted.value).toBe('ACME Corporation');
    expect(emitted.committedValue).toBe('ACME Corporation');
    expect(emitted.skipInReport).toBe(false);

    // Everything locators build a candidate from, still present.
    expect(emitted.locator.id).toBe('pt1:r1:0:it2::content');
    expect(emitted.locator.attrSelector).toBe('[title="Supplier"]');
    expect(emitted.locator.label).toBe('Supplier');
    expect(emitted.locator.title).toBe('Supplier');
    expect(emitted.locator.placeholder).toBe('Search suppliers');
    expect(emitted.locator.selector).toBeTruthy();
    expect(emitted.locator.sourceTag).toBe('input');
    expect(emitted.locator.hasLovIcon).toBe(true);
    expect(validateActions([emitted])).toEqual([]);
  });

  it('gives a click the role and exact name the schema expects', () => {
    const event = recorded('click', `<button id="save">Save</button>`, 'button');
    const emitted = compileActions([event])[0];

    expect(emitted.action).toBe('click');
    expect(emitted.locator.role).toBe('button');
    expect(emitted.locator.name).toBe('Save');
    expect(emitted.locator.exact).toBe(true);
    expect(emitted.locator.id).toBe('save');
    expect(validateActions([emitted])).toEqual([]);
  });

  it('compiles a navigation to a replayable url', () => {
    const emitted = compileActions([{ type: 'navigate', url: 'https://example.test/start' }])[0];
    expect(emitted.action).toBe('navigate');
    expect(emitted.url).toBe('https://example.test/start');
    expect(validateActions([emitted])).toEqual([]);
  });

  it('keeps a <select> distinguishable from an open-list row pick', () => {
    const dropdown = only([{
      type: 'select', meta: { ariaLabel: 'Unit', optionLabel: 'US1' }, value: 'US1',
    }]);
    const rowPick = only([{
      type: 'select', meta: { ariaLabel: 'Unit', selectByClick: true }, value: 'US1',
    }]);

    expect(dropdown.action).toBe('selectOption');
    expect(rowPick.action).toBe('lovSelect');
    expect(dropdown.value).toBe('US1');
  });

  it('emits only action verbs allowed by the canonical schema', () => {
    const everything = compileActions(everyKindOfEvent());

    expect(everything.length).toBe(17);
    for (const action of everything) {
      expect(ACTION_VERBS).toContain(action.action);
    }
  });

  it('names a copy output correctly', () => {
    const emitted = only([{
      type: 'copy', meta: {}, outputName: 'invoiceNumber',
    }]);
    expect(emitted.outputName).toBe('invoiceNumber');
    expect(validateActions([emitted])).toEqual([]);
  });
});

// ── Schema conformance ──────────────────────────────────────────────────────
//
// The point of these is to FAIL when someone adds a field without adding it to
// src/core/shared/schema.js. A field nothing reads is not harmless: the
// excluded set was 26% of every locator object in the 9,010-step corpus this
// format was measured against, on a payload that crosses a customer VPN.

/** One event of every kind the recorder and its patches can produce. */
function everyKindOfEvent() {
  return [
    { type: 'navigate', url: 'https://example.test/a' },
    clickEvent(),
    { type: 'dblclick', meta: { ariaLabel: 'Row' } },
    { type: 'fill', meta: { ariaLabel: 'Amount' }, value: 'x' },
    { type: 'fill', meta: { ariaLabel: 'Password' }, value: '********', sensitive: true },
    { type: 'select', meta: { optionLabel: 'A', optionIndex: 2 }, value: 'A' },
    { type: 'select', meta: { selectByClick: true }, value: 'A' },
    { type: 'check', meta: {}, checked: true },
    { type: 'check', meta: {}, checked: false },
    { type: 'radio', meta: {} },
    { type: 'press', meta: {}, value: 'Enter' },
    { type: 'hover', meta: {} },
    { type: 'scroll', meta: {}, deltaX: 0, deltaY: 300 },
    { type: 'wait', meta: {}, durationMs: 750 },
    { type: 'copy', meta: {}, outputName: 'invoiceNumber' },
    { type: 'lovSelect', meta: {}, value: 'ACME' },
    { type: 'assertText', meta: { ariaLabel: 'Status' }, value: 'Complete' },
    // Patch-private bookkeeping, which must produce no action at all.
    { type: 'meta_nav_tile', meta: {} },
  ];
}

describe('schema v1 conformance', () => {
  it('emits only verbs in the enum and only locator keys in the allow-list', () => {
    const actions = compileActions(everyKindOfEvent());

    // Reported as one list so a compiler that broke three rules does not need
    // three runs to say so.
    expect(validateActions(actions)).toEqual([]);

    for (const action of actions) {
      expect(ACTION_VERBS, action.action).toContain(action.action);
      for (const key of Object.keys(action.locator || {})) {
        expect(LOCATOR_FIELDS, `${action.action}.locator.${key}`).toContain(key);
      }
    }
  });

  it('holds for a locator built against a real element, fields and all', () => {
    document.body.innerHTML = `
      <table><tbody><tr><td class="af_inputListOfValues">
        <label for="pt1:r1:0:it2">Supplier</label>
        <input id="pt1:r1:0:it2::content" role="combobox" title="Supplier"
               placeholder="Search suppliers" name="SupplierName">
        <a id="pt1:r1:0:it2::lovIconId" title="Search: Supplier"></a>
      </td></tr></tbody></table>`;
    const el = document.querySelector('input');
    const locatorObject = buildLocatorObject(el, {
      resolveLabel: resolveAdfLabel,
      meta: metaFor(el),
    });

    // The content script's own output, before the compiler ever sees it.
    for (const key of Object.keys(locatorObject)) {
      expect(LOCATOR_FIELDS, key).toContain(key);
    }
    expect(validateActions(compileActions([
      { type: 'fill', meta: metaFor(el), locatorObject, value: 'ACME' },
    ]))).toEqual([]);
  });

  it('rejects a field that was added without updating the schema', () => {
    // The guard itself, proved to bite rather than assumed to.
    expect(validateActions([
      { action: 'click', skipInReport: false, locator: { xpath: '//button[1]' } },
    ])).toContain('action 1 (click): locator."xpath" is not in the locator allow-list');

    expect(validateActions([{ action: 'select', skipInReport: false }]))
      .toContain('action 1: "select" is not in the verb enum');
  });

  it('drops scratch fields and string booleans a patch left on a locator', () => {
    const action = only([{
      type: 'click',
      meta: {},
      // `_target` is a live DOM node a patch hangs off the object mid-flight;
      // stored, it is both meaningless and enormous. "false" is truthy, so the
      // replayer's `if (loc.exact)` took the wrong branch on it.
      locatorObject: { id: 'save', _target: {}, _injected: true, exact: 'false', role: '' },
    }]);

    expect(action.locator).toEqual({ id: 'save', exact: false });
  });

  it('marks every action with skipInReport as a real boolean', () => {
    for (const action of compileActions(everyKindOfEvent())) {
      expect(typeof action.skipInReport, action.action).toBe('boolean');
    }
  });
});
