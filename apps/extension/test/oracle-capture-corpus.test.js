/**
 * The capture corpus — every captured DOM, every known-good outcome.
 *
 * WHY THIS EXISTS
 *
 * Each capture bug so far was found on one page, fixed, and verified on that
 * same page. Nothing re-checked the earlier pages, so a later fix could
 * silently undo an earlier one and nobody would know until a recording failed
 * in production. `td, th` in the Oracle patch's `closest()` is the clearest
 * example: it fixed ADF grid cells and changed what every other table-shaped
 * widget resolved to at the same time.
 *
 * So every case here runs against every build.
 *
 * ADDING A CASE — no code, just a file
 *
 * Cases live in `capture-cases/<widget>.cases.json`, one file per widget, and
 * are discovered automatically. Nothing in this file changes when a case is
 * added; that is the point. One file per widget rather than one giant list, so
 * two people adding cases for different widgets never touch the same file.
 *
 *   {
 *     "fixture": "checkbox.html",              // under replayer/checks/pages/
 *     "source":  "where and when it was captured",
 *     "widget":  "ADF selectManyCheckbox",
 *     "cases": [{
 *       "name":   "what it pins, phrased as the defect",
 *       "click":  "<expression evaluated IN THE PAGE>",
 *       "expect": { "type": "check", "label": "Ordering" },
 *       "because": "the failure this guards against"
 *     }]
 *   }
 *
 *   1. Capture the real DOM (see pages/README.md — never hand-write it).
 *   2. Add or extend a .cases.json.
 *   3. Run it against the CURRENT build first. Passing = a regression guard
 *      from now on. Failing = the bug you are about to fix; leave it red until
 *      the fix lands.
 *
 * `expect` pins only what the bug is about. An over-specified case fails on
 * unrelated changes, gets deleted as noise, and the guard is lost with it.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { captureOne, clickExpr, PAGES } from './capture-harness.js';

const CASES_DIR = resolve(import.meta.dirname, 'capture-cases');

/** Every *.cases.json, loaded and validated up front. */
function loadSuites() {
  return readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.cases.json'))
    .sort()
    .map((file) => {
      const path = join(CASES_DIR, file);
      let suite;
      try {
        suite = JSON.parse(readFileSync(path, 'utf8'));
      } catch (err) {
        throw new Error(`${file} is not valid JSON: ${err.message}`);
      }
      if (!suite.fixture) throw new Error(`${file} has no "fixture"`);
      if (!Array.isArray(suite.cases)) throw new Error(`${file} has no "cases" array`);
      return { ...suite, file: basename(file, '.cases.json') };
    });
}

const SUITES = loadSuites();

describe('capture corpus', () => {
  // A corpus that silently loaded nothing would report all-green while testing
  // nothing at all — the one failure mode a regression guard cannot have.
  it('discovers at least one case file', () => {
    expect(SUITES.length).toBeGreaterThan(0);
    expect(SUITES.flatMap((s) => s.cases).length).toBeGreaterThan(0);
  });

  for (const suite of SUITES) {
    describe(`${suite.file} — ${suite.widget || suite.fixture}`, () => {
      it('its fixture exists', () => {
        expect(
          existsSync(join(PAGES, suite.fixture)),
          `${suite.file}.cases.json names "${suite.fixture}", which is not in pages/`
        ).toBe(true);
      });

      for (const c of suite.cases) {
        it(c.name, async () => {
          const ev = await captureOne({ page: suite.fixture, act: clickExpr(c.click) });
          expect(ev, `nothing was recorded for "${c.name}"`).toBeTruthy();
          for (const [field, want] of Object.entries(c.expect)) {
            // `because` rides on the assertion so a red test a year from now
            // says WHY the case exists, not just which value differed.
            expect(ev[field], c.because ? `${field}: ${c.because}` : field).toBe(want);
          }
        }, 60_000);
      }
    });
  }
});
