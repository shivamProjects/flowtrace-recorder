/**
 * select-same-value-live-dom.probe.mjs — run the SHIPPED recorder code against
 * the REAL dev29 Invoice Header markup.
 *
 * WHY THIS EXISTS
 * The same-value <select> fix was verified three ways: source inspection, a
 * behavioural model, and a hand-written reimplementation driven on the live
 * tenant. None of those runs the code that actually ships. The recorder only
 * injects while a recording session is active, and that is started from the
 * extension popup, which Playwright cannot click -- so an end-to-end test in a
 * real browser is not available (see tools/live-probes/README.md, which
 * documents a past false negative from exactly this).
 *
 * This closes the gap the cheap way: slice the real _shouldIgnoreMouseEvent
 * SELECT branch and _onSelectBlur out of background.js, evaluate them against
 * the captured DOM in jsdom, and assert a step is produced.
 *
 * Fixture: replayer/checks/pages/adf-invoice-header-dev29.html (verbatim).
 *
 * Run: node recorder/test/select-same-value-live-dom.probe.mjs
 */

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const BG = 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/background.js';
const FIXTURE = 'D:/WorkingProjects/flowtrace/replayer/checks/pages/adf-invoice-header-dev29.html';

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('\nselect-same-value-live-dom.probe.mjs');
console.log('  shipped recorder logic vs verbatim dev29 Invoice Header\n');

// ── decode the injected page script ────────────────────────────────────────
const src = readFileSync(BG, 'utf8');
const MARK = "const source$2 = '";
const i0 = src.indexOf(MARK);
if (i0 === -1) throw new Error('anchor moved: source$2 literal not found');
const start = i0 + MARK.length;
let j = start;
while (j < src.length) {
  if (src[j] === '\\') { j += 2; continue; }
  if (src[j] === "'") break;
  j++;
}
// eslint-disable-next-line no-eval
const page = eval("'" + src.slice(start, j) + "'");

// ── slice the two regions under test, verbatim ─────────────────────────────
const armStart = page.indexOf('if (nodeName === "SELECT" || nodeName === "OPTION") {');
if (armStart === -1) throw new Error('anchor moved: SELECT/OPTION arming branch not found');
const armEnd = page.indexOf('return true;', armStart) + 'return true;'.length;
const armSrc = page.slice(armStart, armEnd);

const blurStart = page.indexOf('_onSelectBlur(event) {');
if (blurStart === -1) throw new Error('anchor moved: _onSelectBlur not found');
let depth = 0, k = page.indexOf('{', blurStart), blurEnd = -1;
for (let p = k; p < page.length; p++) {
  if (page[p] === '{') depth++;
  else if (page[p] === '}') { depth--; if (depth === 0) { blurEnd = p + 1; break; } }
}
const blurSrc = page.slice(blurStart, blurEnd);

check('sliced the arming branch from the shipped bundle', armSrc.length > 200);
check('sliced _onSelectBlur from the shipped bundle', blurSrc.length > 400);
check('arming carries the isTrusted loop guard',
  /if \(event\.isTrusted\)/.test(armSrc));
check('arming does not gate on _performingActions.size (see select-blur-arm-race.probe.mjs)',
  !/event\.isTrusted && !this\._performingActions\.size/.test(armSrc),
  'that combined guard silently blocked arming during any unrelated in-flight replay');
check('blur handler emits via recordAction, not _performAction',
  /this\.recordAction\(\{/.test(blurSrc) && !/_performAction\(\{/.test(blurSrc));

// ── build a DOM from the captured markup ───────────────────────────────────
const dom = new JSDOM(readFileSync(FIXTURE, 'utf8'), { pretendToBeVisual: true });
const { window } = dom;
const document = window.document;

const TYPE_ID = 'pt1:_FOr1:1:_FONSr2:0:MAnt2:1:pm1:r1:0:ap1:r2:0:so1::content';
const typeSel = document.getElementById(TYPE_ID);
check('the fixture contains the Type select', !!typeSel, TYPE_ID);
check('its default value is Standard',
  typeSel && typeSel.value === '0' && typeSel.options[0].text.trim() === 'Standard');

// ── run the SHIPPED logic ──────────────────────────────────────────────────
// A minimal host supplying only what the sliced code touches.
const recorded = [];
const host = {
  _performingActions: new Set(),
  __sfSelectTouched: null,
  recordAction: (a) => recorded.push(a),
  injectedScript: { generateSelector: () => ({ selector: 'css=#' + TYPE_ID }) },
  state: { testIdAttributeName: 'data-testid' },
};
host._currentTool = host;                    // _onSelectBlur reads this._currentTool

// Globals the sliced code references.
const ctx = {
  globalThis: { __SF_DEBUG: false },
  document,
  CSS: { escape: (s) => s },
  _sfPreferStableId: (_el, gen) => gen,
  _sfFinalizeSelector: (_is, _el, gen) => gen,
  _sfExplicitRole: () => null,
};

const armFn = new Function('target', 'event', 'nodeName', 'globalThis', 'document',
  'return (function () { ' + armSrc.replace(/^if \(nodeName[^{]*\{/, '') .replace(/return true;$/, '') + ' }).call(this);');

const blurFn = new Function('globalThis', 'document', 'CSS',
  '_sfPreferStableId', '_sfFinalizeSelector',
  'return function ' + blurSrc + ';');

const boundBlur = blurFn(ctx.globalThis, document, ctx.CSS,
  ctx._sfPreferStableId, ctx._sfFinalizeSelector);

// 1. arm, as a trusted mousedown on the select would
armFn.call(host, typeSel, { isTrusted: true, target: typeSel }, 'SELECT',
  ctx.globalThis, document);
check('a trusted click ARMS the marker',
  !!host.__sfSelectTouched && host.__sfSelectTouched.el === typeSel,
  'without this nothing can commit on blur');
check('the armed value is the current one', host.__sfSelectTouched?.value === '0');

// 2. an UNTRUSTED event must not arm (the runaway-loop guard)
host.__sfSelectTouched = null;
armFn.call(host, typeSel, { isTrusted: false, target: typeSel }, 'SELECT',
  ctx.globalThis, document);
check('an UNTRUSTED event does NOT arm', host.__sfSelectTouched === null,
  'this guard is what stops the replay re-arming itself into a loop');

// 3. re-arm, then blur without the value moving -> a step must be recorded
armFn.call(host, typeSel, { isTrusted: true, target: typeSel }, 'SELECT',
  ctx.globalThis, document);
boundBlur.call(host, { target: typeSel });

check('THE FIX: a same-value re-pick produces a select step',
  recorded.length === 1 && recorded[0].name === 'select',
  `recorded ${recorded.length} action(s): ${JSON.stringify(recorded)}`);
check('the step carries the current option value',
  recorded[0] && Array.isArray(recorded[0].options) && recorded[0].options[0] === '0',
  JSON.stringify(recorded[0]));

// 4. if the value DID move, blur must stay silent (onInput owns that case)
recorded.length = 0;
armFn.call(host, typeSel, { isTrusted: true, target: typeSel }, 'SELECT',
  ctx.globalThis, document);
typeSel.value = '2';                          // Debit memo
boundBlur.call(host, { target: typeSel });
check('a CHANGED value is left to the normal onInput path',
  recorded.length === 0,
  `blur should not double-record; got ${JSON.stringify(recorded)}`);

// 5. a blur on a different element must not fire
typeSel.value = '0';
recorded.length = 0;
armFn.call(host, typeSel, { isTrusted: true, target: typeSel }, 'SELECT',
  ctx.globalThis, document);
boundBlur.call(host, { target: document.getElementById(
  'pt1:_FOr1:1:_FONSr2:0:MAnt2:1:pm1:r1:0:ap1:r2:0:i2::content') });
check('a blur on a DIFFERENT field records nothing', recorded.length === 0);

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
