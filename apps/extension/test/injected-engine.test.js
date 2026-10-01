/**
 * injected-engine.test.js — proof that the vendored Playwright engine runs
 * standalone.
 *
 * This test deliberately does NOT assert that the recorder uses the engine —
 * it does not yet. What it pins down is the one thing the vendoring decision
 * rests on:
 *
 *   the injected script is a self-contained in-page module. Given a `module`
 *   binding and a window, it instantiates and generates selectors. No CDP, no
 *   browser process, no `chrome.debugger`.
 *
 * If that ever stops being true — a future Playwright reaching for an API jsdom
 * or a content script cannot provide — this test is where it surfaces, before
 * the engine is load-bearing rather than after.
 *
 * The engine needs exactly one thing jsdom lacks: `CSS.escape`, which
 * test/setup.js already polyfills for the existing selector tests.
 * `getComputedStyle(el, '::before')` is called and jsdom logs "Not implemented"
 * to stderr, but it returns an empty style rather than throwing, so text
 * extraction degrades to ignoring pseudo-element content instead of failing.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { CORE_FIXTURES, ORACLE_FIXTURES, mount } from './fixtures.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_JS = resolve(root, 'vendor/playwright/injected-script.js');
const VENDOR_VERSION = resolve(root, 'vendor/playwright/VERSION');

/**
 * The same bootstrap dist/selector-engine.js uses, minus the global. Keeping it
 * here in full rather than importing a shared helper is intentional: this file
 * is the executable documentation of how the engine is instantiated.
 */
function instantiate() {
  const source = readFileSync(VENDOR_JS, 'utf8');
  const module = { exports: {} };
  // The vendored artifact is a CommonJS bundle. `new Function` rather than
  // `eval` so the bundle's top-level declarations land in their own scope.
  new Function('module', 'exports', source)(module, module.exports);

  // esbuild's __toCommonJS makes this a lazy getter that returns a thunk, so it
  // is called twice: once for the thunk, once for the class.
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

/** @type {any} */
let injected;

beforeAll(() => {
  injected = instantiate();
});

describe('vendored artifact', () => {
  it('records the playwright-core version it came from', () => {
    const version = readFileSync(VENDOR_VERSION, 'utf8').trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);

    const installed = JSON.parse(
      readFileSync(resolve(root, 'node_modules/playwright-core/package.json'), 'utf8'),
    ).version;
    expect(version).toBe(installed);
  });

  it('is the selector engine and not a fragment of something else', () => {
    const source = readFileSync(VENDOR_JS, 'utf8');
    expect(source).toContain('generateSelectorSimple');
    expect(Buffer.byteLength(source, 'utf8')).toBeGreaterThan(200 * 1024);
  });
});

describe('instantiation under jsdom', () => {
  it('constructs with no CDP session and no browser process', () => {
    expect(injected).toBeTruthy();
    expect(typeof injected.generateSelectorSimple).toBe('function');
    expect(typeof injected.parseSelector).toBe('function');
    expect(typeof injected.querySelectorAll).toBe('function');
    expect(typeof injected.utils.asLocator).toBe('function');
  });

  it('needs CSS.escape, which jsdom does not provide on its own', () => {
    // Not a tautology: it asserts that the polyfill in test/setup.js is load
    // bearing for this engine, so nobody deletes it as legacy scaffolding.
    expect(typeof globalThis.CSS.escape).toBe('function');
    expect(readFileSync(VENDOR_JS, 'utf8')).toContain('CSS.escape');
  });
});

/**
 * Playwright's selectors are not CSS — `internal:role=textbox[name="X"i]` means
 * nothing to querySelectorAll. They are resolved with the engine's own query
 * implementation, which is the honest round trip: the thing that generated the
 * selector is the thing that has to find the element again.
 */
function resolves(selector, el) {
  const parsed = injected.parseSelector(selector);
  return injected.querySelectorAll(parsed, el.ownerDocument).includes(el);
}

function run(suite, fixtures) {
  describe(suite, () => {
    for (const fixture of fixtures) {
      it(fixture.name, () => {
        const el = mount(document, fixture);

        const selector = injected.generateSelectorSimple(el);
        expect(typeof selector, `fixture "${fixture.name}"`).toBe('string');
        expect(selector.length).toBeGreaterThan(0);

        // The property that makes this engine worth having: it does not return
        // a candidate it has not verified against the live DOM.
        expect(resolves(selector, el), `selector did not resolve: ${selector}`).toBe(true);

        // And it renders to a locator expression the compiler can emit.
        const locator = injected.utils.asLocator('javascript', selector);
        expect(typeof locator).toBe('string');
        expect(locator.length).toBeGreaterThan(0);
      });
    }
  });
}

run('generates a resolving selector for every core fixture', CORE_FIXTURES);
run('generates a resolving selector for every Oracle ADF fixture', ORACLE_FIXTURES);

describe('the scoring difference that motivated the migration', () => {
  it('prefers an accessible name over an author-written id', () => {
    // Our ladder returns #submit-order. Playwright scores a CSS id at 500 and
    // role+name at 100, so it takes the name.
    const el = mount(document, {
      name: 'plain author-written id',
      html: '<button id="submit-order">Place order</button>',
      target: 'button',
    });
    expect(injected.utils.asLocator('javascript', injected.generateSelectorSimple(el)))
      .toBe("getByRole('button', { name: 'Place order' })");
  });

  it('rejects an ADF component-tree id in favour of the associated label', () => {
    const el = mount(document, {
      name: 'ADF label[for] with the ::content suffix',
      html: '<label for="pt1:r1:0:it10">Transaction Number</label>' +
            '<input id="pt1:r1:0:it10::content" type="text">',
      target: 'input',
    });
    const selector = injected.generateSelectorSimple(el);
    expect(selector).not.toContain('pt1:r1:0:it10');
    expect(resolves(selector, el)).toBe(true);
  });
});
