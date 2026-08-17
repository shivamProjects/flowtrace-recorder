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

import { loadLegacy } from './legacy-harness.js';
import { CORE_FIXTURES, ORACLE_FIXTURES, mount } from './fixtures.js';
import { generateSelector } from '../src/core/content/selector.js';
import { resolveAdfLabel } from '../src/patches/oracle/labels.js';

const legacy = loadLegacy();

/** Pull the CSS out of `page.locator('…')`; other locator forms have no CSS. */
function cssInsideLocator(locator) {
  const m = /^page\.locator\('(.*)'\)$/s.exec(locator || '');
  if (!m) return null;
  return m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

/**
 * Does this CSS selector actually select the element it was generated for?
 *
 * This is a stricter question than "does it parse", and the right one. A
 * selector can be syntactically valid and still be wrong: `[name="DOMAIN\user"]`
 * parses fine and matches "DOMAINuser", and `#bu::content` parses as an id plus
 * an unknown pseudo-element and matches nothing at all. Both would ship as a
 * green test under a parse-only check, then fail on replay.
 *
 * Test-environment note: happy-dom's CSS parser is more permissive than
 * Chrome's and does not throw on either of the above, which is precisely why
 * the weaker check was not good enough.
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

/** True when the legacy result would not have found the element it described. */
function legacyWasBroken(result, el) {
  if (!resolvesTo(result.selector, el)) return true;
  const css = cssInsideLocator(result.locator);
  return css !== null && !resolvesTo(css, el);
}

function run(suite, fixtures, opts) {
  describe(suite, () => {
    for (const fixture of fixtures) {
      it(fixture.name, () => {
        // Both generators query the document while they work, so each gets a
        // freshly mounted copy. Each result is judged while its own element is
        // still attached — mounting replaces document.body wholesale.
        const legacyEl = mount(document, fixture);
        const prev = legacy.buildSelectorMeta(legacyEl);
        const prevBroken = legacyWasBroken(prev, legacyEl);

        const el = mount(document, fixture);
        const next = generateSelector(el, opts);

        // (2) whatever we emit must actually find the element.
        expect(resolvesTo(next.selector, el), `selector: ${next.selector}`).toBe(true);
        const nextCss = cssInsideLocator(next.locator);
        if (nextCss !== null) {
          expect(resolvesTo(nextCss, el), `locator css: ${nextCss}`).toBe(true);
        }

        // (1) agree with the monolith unless the monolith was broken.
        if (prevBroken) {
          expect(
            next.selector === prev.selector && next.locator === prev.locator,
            `expected a divergence — legacy emitted unparseable output:\n` +
              `  legacy selector: ${prev.selector}\n` +
              `  legacy locator : ${prev.locator}\n` +
              `  new    selector: ${next.selector}\n` +
              `  new    locator : ${next.locator}`,
          ).toBe(false);
        } else {
          expect(next.selector).toBe(prev.selector);
          expect(next.locator).toBe(prev.locator);
        }
      });
    }
  });
}

run('core selector — no patch', CORE_FIXTURES, {});
run('core selector — Oracle label conventions', ORACLE_FIXTURES, {
  resolveLabel: resolveAdfLabel,
});
