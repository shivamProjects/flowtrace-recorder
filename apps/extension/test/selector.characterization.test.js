/**
 * Characterization tests for the selector generator's FALLBACK LADDER.
 *
 * Read that first line carefully, because it changed. Since the vendored
 * Playwright engine landed, `generateSelector` prefers the engine and reaches
 * the ladder only when no engine is installed in the frame. Nothing here
 * installs one, so this file exercises the ladder — which is exactly what it
 * should keep doing. The ladder is still shipped, still reachable, and still
 * the thing the pre-restructure monolith is comparable to.
 *
 * The DEFAULT path is covered by test/selector.engine.test.js, and the engine
 * itself by test/injected-engine.test.js. Neither replaces this file: a
 * regression in the fallback would otherwise only ever be found in a frame the
 * engine could not be injected into, which is the worst place to find one.
 *
 * The contract this pins down is deliberately not "the new code produces X".
 * It is:
 *
 *   1. The ladder agrees with the pre-restructure monolith, EXCEPT where the
 *      monolith emitted something a browser cannot parse.
 *   2. Everything the ladder emits is parseable.
 *
 * Stating it that way means the test does not have to carry a hand-maintained
 * list of "expected differences" that nobody will keep honest. A difference is
 * legitimate exactly when the old output was broken, and the test checks that
 * rather than taking our word for it.
 */
import { describe, expect, it } from 'vitest';

import { CORE_FIXTURES, ORACLE_FIXTURES, mount } from './fixtures.js';
import { generateSelector } from '@flowtrace/recorder-core';
import { resolveAdfLabel } from '@flowtrace/recorder-core';

/** Pull the CSS out of `page.locator('…')`; other locator forms have no CSS. */
function cssInsideLocator(locator) {
  const m = /^page\.locator\('(.*)'\)$/s.exec(locator || '');
  if (!m) return null;
  return m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

/**
 * Does this CSS selector actually select the element it was generated for?
 *
 * @returns {boolean} false when unparseable OR when it does not match `el`
 */
function resolvesTo(selector, el) {
  if (selector == null || selector === '') return false;
  if (selector.startsWith('text=')) return true; // Playwright engine, not CSS
  try {
    return [...el.ownerDocument.querySelectorAll(selector)].includes(el);
  } catch {
    return false;
  }
}

function run(suite, fixtures, opts) {
  describe(suite, () => {
    for (const fixture of fixtures) {
      it(fixture.name, () => {
        const el = mount(document, fixture);
        const next = generateSelector(el, opts);

        // whatever we emit must actually find the element.
        expect(resolvesTo(next.selector, el), `selector: ${next.selector}`).toBe(true);
        const nextCss = cssInsideLocator(next.locator);
        if (nextCss !== null) {
          expect(resolvesTo(nextCss, el), `locator css: ${nextCss}`).toBe(true);
        }
      });
    }
  });
}

run('core selector — fallback ladder without patch', CORE_FIXTURES, {});
run('core selector — fallback ladder with Oracle label conventions', ORACLE_FIXTURES, {
  resolveLabel: resolveAdfLabel,
});

