/**
 * selector.engine.test.js — generateSelector() when the injected engine IS
 * present.
 *
 * The rest of the suite exercises the fallback ladder, because jsdom carries no
 * engine global unless a test installs one. That is a real code path — frames
 * the engine could not be injected into — but it is no longer the default one,
 * so it cannot be the only one under test.
 *
 * What matters here is not "which string comes out" for its own sake. It is
 * that the two properties the migration was made for actually hold:
 *
 *   • the score table is the right way round, so an accessible name beats an id
 *   • a patch-resolved ADF label overrides the engine, but only once verified
 *
 * The engine is installed on `window` exactly as dist/selector-engine.js does
 * it, so this test fails if that contract changes.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { generateSelector } from '@flowtrace/recorder-core';
import { ORACLE_FIXTURES, mount } from './fixtures.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_JS = resolve(root, 'vendor/playwright/injected-script.js');

const ENGINE_GLOBAL = '__flowtracePwInjected';

function instantiate() {
  const source = readFileSync(VENDOR_JS, 'utf8');
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

const byName = (name) => ORACLE_FIXTURES.find((f) => f.name === name);

beforeAll(() => {
  globalThis[ENGINE_GLOBAL] = instantiate();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('generateSelector with the engine installed', () => {
  it('prefers an accessible name over an author-written id', () => {
    // The ladder returns `#submit-order` here. Playwright scores a CSS id at
    // 500 against 100 for role+name, which is the whole reason for the swap.
    document.body.innerHTML = '<button id="submit-order">Place order</button>';
    const { selector, locator } = generateSelector(document.querySelector('button'));

    expect(selector).toContain('internal:role=button');
    expect(selector).toContain('Place order');
    expect(locator).toBe("page.getByRole('button', { name: 'Place order' })");
    expect(selector).not.toContain('#submit-order');
  });

  it('emits a selector the replayer can parse', () => {
    // engine/locators.ts parseSegment understands internal:role / text / label
    // / attr and `nth=`. An `internal:` string is only useful to us because of
    // that; a dialect the replayer cannot read would be a regression.
    document.body.innerHTML = '<button id="submit-order">Place order</button>';
    const { selector } = generateSelector(document.querySelector('button'));

    expect(selector).toMatch(/^internal:(role|label|text|attr|testid)=/);
  });

  it('rejects an ADF generated id rather than shipping it', () => {
    const fixture = byName('ADF generated name on a text input');
    const { selector } = generateSelector(mount(document, fixture));

    // `pt1:_FOr1:1:…` fails isGuidLike. The ladder emitted it as first choice.
    expect(selector).not.toContain('pt1:_FOr1');
  });

  it('refuses an ADF ::content label as a selector, because it cannot resolve', () => {
    // The case the migration had to think hardest about. ADF writes
    // label[for="pt1:r1:0:it10"] against an input whose id is
    // `pt1:r1:0:it10::content`, so there is no spec-compliant association — and
    // `getByLabel('Transaction Number')` therefore matches NOTHING. The old
    // ladder emitted exactly that locator, and it could never have resolved.
    //
    // Verifying before accepting is what catches it: the label is offered, it
    // fails to resolve, and the engine's own answer stands.
    const fixture = byName('ADF label[for] with the ::content suffix');
    const el = mount(document, fixture);

    const withPatch = generateSelector(el, { resolveLabel: () => 'Transaction Number' });
    expect(withPatch.locator).toBe("page.getByRole('textbox')");
    expect(withPatch.selector).not.toContain('internal:label');

    // The label is not lost — it travels to the replayer as `locator.label` and
    // `locator.name`, which buildLocatorObject resolves independently of this
    // function. `raw.resolvedLabel` carries it for the compiler.
    expect(withPatch.raw.resolvedLabel).toBe('Transaction Number');
  });

  it('needs no label override, because a resolvable label is already the name', () => {
    // Why selector.js has no "prefer the patch label" branch: when the
    // association is well formed, the engine has ALREADY taken the label as the
    // accessible name. An override could only ever be a no-op here, or a
    // non-resolving locator in the ::content case above.
    document.body.innerHTML =
      '<label for="amt2">Invoice Amount</label><input id="amt2" type="text">'
      + '<input id="other" type="text" aria-label="Other">';
    const el = document.querySelector('#amt2');

    const { selector } = generateSelector(el, { resolveLabel: () => 'Invoice Amount' });
    expect(selector).toBe('internal:role=textbox[name="Invoice Amount"i]');
  });

  it('never emits a selector that resolves to more than one element', () => {
    // The property the whole swap rests on, and the reason a bare
    // `internal:role=textbox` is safe as the dedup key: the engine only emits
    // one when it is unique in the document.
    document.body.innerHTML =
      '<input type="text" id="a::content"><input type="text" id="b::content">';
    const engine = globalThis[ENGINE_GLOBAL];

    for (const el of document.querySelectorAll('input')) {
      const { selector } = generateSelector(el);
      const found = engine.querySelectorAll(engine.parseSelector(selector), document);
      expect(found).toHaveLength(1);
      expect(found[0]).toBe(el);
    }
  });

  it('ignores a patch label that does not actually find the element', () => {
    // An unverified label would reintroduce exactly the silent ambiguity the
    // engine was adopted to remove.
    const fixture = byName('ADF label[for] with the ::content suffix');
    const el = mount(document, fixture);

    const { locator } = generateSelector(el, { resolveLabel: () => 'Not On This Page' });
    expect(locator).toBe("page.getByRole('textbox')");
  });

  it('does not override when the engine already encodes the label', () => {
    const fixture = byName('ADF required marker is stripped from the label');
    const el = mount(document, fixture);

    const { selector } = generateSelector(el, { resolveLabel: () => 'Amount' });
    // The engine found the name itself; there is nothing for the patch to add.
    expect(selector).toContain('internal:role=textbox');
  });

  it('falls back to the ladder when the engine is absent', () => {
    const saved = globalThis[ENGINE_GLOBAL];
    delete globalThis[ENGINE_GLOBAL];
    try {
      document.body.innerHTML = '<button id="submit-order">Place order</button>';
      const { selector } = generateSelector(document.querySelector('button'));
      // The ladder's first priority, unchanged.
      expect(selector).toBe('#submit-order');
    } finally {
      globalThis[ENGINE_GLOBAL] = saved;
    }
  });

  it('falls back to the ladder when the engine throws', () => {
    const saved = globalThis[ENGINE_GLOBAL];
    globalThis[ENGINE_GLOBAL] = {
      generateSelectorSimple() { throw new Error('engine exploded'); },
    };
    try {
      document.body.innerHTML = '<button id="submit-order">Place order</button>';
      expect(generateSelector(document.querySelector('button')).selector)
        .toBe('#submit-order');
    } finally {
      globalThis[ENGINE_GLOBAL] = saved;
    }
  });
});
