/**
 * select-blur-double-record.probe.mjs — a select must not be recorded twice
 * for one real value change.
 *
 * WHY THIS EXISTS
 * Live recording (Manage Daily Rates, dev29): "To Currency" recorded
 * "EUR - Euro" TWICE, 1315ms apart. The identical field directly above it
 * ("From Currency") recorded once, on the same page, in the same run.
 *
 *   selectOption To Currency "EUR - Euro"  t=1790161305831
 *   selectOption To Currency "EUR - Euro"  t=1790161307146   <- duplicate
 *
 * ROOT CAUSE
 * _shouldIgnoreMouseEvent arms __sfSelectTouched on EVERY trusted mousedown
 * on a SELECT/OPTION, unconditionally overwriting any prior arm -- with no
 * memory of whether the select's current value was already recorded. A
 * stray second mousedown on the same select AFTER its value had already
 * changed and been recorded (clicking it again before moving to the next
 * field, or a scroll/drag inside the still-open native popup) re-armed the
 * tracker using the NEW (already-recorded) value as the baseline:
 *
 *   touched = { el, value: <already-recorded value>, recorded: false }
 *
 * On blur, _onSelectBlur's guard is `touched.el.value !== touched.value` --
 * true only when the value moved AWAY from what was armed. Since nothing
 * changed between the re-arm and the blur, this reads as a legitimate
 * same-value re-pick (the mechanism select-same-value.probe.mjs exists to
 * protect) and commits a SECOND, duplicate step for a change already
 * recorded once by onInput.
 *
 * THE FIX
 * Stamp `el.__sfLastRecordedValue` on the element itself every time a
 * select step is actually recorded (both onInput's SELECT branch and
 * _onSelectBlur -- they are methods on two different classes with two
 * different `this`, so the marker lives on the DOM element rather than on
 * either instance). Arming checks this stamp: if the select's current value
 * already has a record, arm with `recorded: true` so blur's own
 * `if (touched.recorded) return;` guard suppresses the duplicate. A later,
 * real change away from and back to that value naturally updates the stamp
 * and re-arms normally.
 *
 * Run: node recorder/test/select-blur-double-record.probe.mjs
 */

import { readFileSync } from 'node:fs';

const BG = 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/background.js';
const src = readFileSync(BG, 'utf8');

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('\nselect-blur-double-record.probe.mjs');
console.log('  a select must not be recorded twice for one real value change\n');

// ── decode the page script ─────────────────────────────────────────────────
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
const page = eval("'" + src.slice(start, j) + "'");

// ── slice the arm branch (_shouldIgnoreMouseEvent) ─────────────────────────
const mStart = page.indexOf('_shouldIgnoreMouseEvent(event) {');
check('found _shouldIgnoreMouseEvent', mStart !== -1);
const mBody = page.slice(mStart, mStart + 4000);

check('THE FIX: arming checks __sfLastRecordedValue before re-arming as unrecorded',
  /var __sfAlreadyRecordedThisValue = __sfSelEl\.__sfLastRecordedValue === __sfSelEl\.value;/.test(mBody),
  'without this, every mousedown re-arms recorded:false regardless of prior history');

check('THE FIX: arming uses the already-recorded check to set `recorded`',
  /recorded: __sfAlreadyRecordedThisValue/.test(mBody),
  'the armed marker must start as already-recorded when the value has a stamp match');

// ── slice onInput's SELECT branch (the recordAction call + stamp) ──────────
const sStart = page.indexOf('if (target.nodeName === "SELECT") {');
const sBody = page.slice(sStart, sStart + 4000);

check('THE FIX: onInput stamps __sfLastRecordedValue after recording',
  /selectElement\.__sfLastRecordedValue = selectElement\.value;/.test(sBody),
  'without this stamp, a later stray mousedown cannot know this value was already recorded');

// ── slice _onSelectBlur (the recordAction call + stamp) ─────────────────────
const bStart = page.indexOf('_onSelectBlur(event) {');
check('found _onSelectBlur', bStart !== -1);
const bBody = page.slice(bStart, bStart + 2500);

check('THE FIX: _onSelectBlur also stamps __sfLastRecordedValue after recording',
  /touched\.el\.__sfLastRecordedValue = touched\.el\.value;/.test(bBody),
  'both recording paths must stamp the marker, or one path stays unprotected');

check('blur still refuses to double-record when the CURRENT touched object says recorded',
  /if \(touched\.recorded\) return;/.test(bBody));

// ── behavioural reproduction: the exact live sequence ───────────────────────
function simulateSequence(stampOnRecord) {
  // Mirrors the real state machine: el.__sfLastRecordedValue, __sfSelectTouched.
  let lastRecordedValue = undefined;
  let touched = null;
  const recordedSteps = [];

  function mousedown(currentValue) {
    const alreadyRecorded = stampOnRecord && lastRecordedValue === currentValue;
    touched = { value: currentValue, recorded: alreadyRecorded };
  }
  function valueChangesTo(newValue) {
    // onInput SELECT branch: mark touched.recorded, record, stamp.
    if (touched) touched.recorded = true;
    recordedSteps.push(newValue);
    if (stampOnRecord) lastRecordedValue = newValue;
  }
  function blur(currentValue) {
    if (!touched) return;
    const t = touched;
    touched = null;
    if (t.recorded) return;
    if (currentValue !== t.value) return;
    recordedSteps.push(currentValue); // blur-commit
    if (stampOnRecord) lastRecordedValue = currentValue;
  }

  // The live sequence: open select (old value), pick "EUR - Euro" (records),
  // stray second mousedown on the SAME select (re-arms), then blur (moving
  // to Rate Type) with the value unchanged since the re-arm.
  mousedown('USD - US Dollar');
  valueChangesTo('EUR - Euro');
  mousedown('EUR - Euro');     // the stray second mousedown, already-recorded value
  blur('EUR - Euro');          // moving on to Rate Type

  return recordedSteps;
}

check('REGRESSION GUARD: without the stamp, the live sequence double-records',
  simulateSequence(false).length === 2,
  'reproduces the exact live defect: onInput records once, blur re-records after the stray mousedown');

check('THE FIX: with the stamp, the live sequence records exactly once',
  simulateSequence(true).length === 1,
  'the stray mousedown arms recorded:true because the value already has a stamp match, so blur is a no-op');

check('a GENUINE second change (not a stray re-arm) still records once via onInput, none via blur',
  (() => {
    let lastRecordedValue = undefined;
    let touched = null;
    const steps = [];
    function mousedown(v) { touched = { value: v, recorded: lastRecordedValue === v }; }
    function valueChangesTo(v) { if (touched) touched.recorded = true; steps.push(v); lastRecordedValue = v; }
    function blur(v) { if (!touched) return; const t = touched; touched = null; if (t.recorded) return; if (v !== t.value) return; steps.push(v); lastRecordedValue = v; }
    mousedown('USD - US Dollar');
    valueChangesTo('EUR - Euro');   // first change, recorded once
    mousedown('EUR - Euro');
    valueChangesTo('GBP - Pound');  // a REAL second change -- must also record
    blur('GBP - Pound');
    return steps.length === 2 && steps[0] === 'EUR - Euro' && steps[1] === 'GBP - Pound';
  })(),
  'two genuinely different picks must both be recorded -- the stamp must not suppress real changes');

// ── mutation check ─────────────────────────────────────────────────────────
{
  const mutated = mBody.replace(
    'var __sfAlreadyRecordedThisValue = __sfSelEl.__sfLastRecordedValue === __sfSelEl.value;',
    'var __sfAlreadyRecordedThisValue = false;'
  );
  check('mutation reintroduced the unconditional-false arm', mutated !== mBody);
  check('MUTATION CHECK: reverting to unconditional recorded:false is detected',
    !/var __sfAlreadyRecordedThisValue = __sfSelEl\.__sfLastRecordedValue === __sfSelEl\.value;/.test(mutated));
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
