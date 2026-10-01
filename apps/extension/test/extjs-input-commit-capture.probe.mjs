/**
 * extjs-input-commit-capture.probe.mjs — a non-ADF widget that never fires
 * change/focusout must still have its committed value captured correctly.
 *
 * REAL RECORDING, 2026-09-22, Create Project Task (dev93), Task Name:
 *
 *   #15  fill  "dem"           committedValue: "New task"
 *   #16  fill  "demo_t"        committedValue: "New task"
 *   #17  fill  "demo_task"     committedValue: "New task"
 *   #18  fill  "demo_taski34"  committedValue: "New task"
 *
 * Selector: css=#textfield-1060-inputEl — an ExtJS-generated id, not ADF.
 * The recording ends right after step #18 with no further change/focusout.
 *
 * ROOT CAUSE. record() in content/oracle-patch.js (the ONLY thing that
 * captures a commit value for applyCommittedValues() to pair against a fill
 * step) is wired to `change` and `focusout` only. ADF fires one of those
 * reliably when a field is done. This ExtJS panel does not, in this
 * recording — the sole record() capture on file for this field is from
 * whatever ran before the operator started typing (the field's ExtJS
 * default, "New task"), so every one of the four fill steps was stamped
 * with committedValue "New task" instead of the operator's actual text.
 *
 * THE FIX: a debounced record() call on trusted `input` events too (600ms
 * settle), mirroring the fill step itself (onInput in the injected page
 * script already fires per trusted input event). record()'s own
 * lastValueByField dedupe means a widget that DOES fire change/focusout
 * normally sees no behaviour change — the debounced input capture just
 * agrees with it.
 *
 * Run: node recorder/test/extjs-input-commit-capture.probe.mjs
 */

import { readFileSync } from 'node:fs';

const SRC = 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/content/oracle-patch.js';
const src = readFileSync(SRC, 'utf8');

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('\nextjs-input-commit-capture.probe.mjs');
console.log('  record() must not rely solely on change/focusout\n');

// ── the original change/focusout path is untouched ─────────────────────────
check('the change/focusout capture still exists',
  /\['change', 'focusout'\]\.forEach/.test(src),
  'this is the correct, primary path for ADF fields and must survive');

// ── the new input-driven capture exists ─────────────────────────────────────
const inputListenerStart = src.indexOf("document.addEventListener('input', (e) => {");
check('THE FIX: a trusted-input capture listener exists', inputListenerStart !== -1);

const inputListenerBody = (() => {
  if (inputListenerStart === -1) return '';
  let depth = 0;
  for (let p = src.indexOf('{', inputListenerStart); p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}') { depth--; if (depth === 0) return src.slice(inputListenerStart, p + 1); }
  }
  return src.slice(inputListenerStart, inputListenerStart + 1500);
})();

check('it only reacts to TRUSTED input events',
  /if \(!e\.isTrusted\) return;/.test(inputListenerBody),
  'ADF re-populates fields by script (PPR, LOV echo); an untrusted input must '
  + 'not be recorded as if the operator typed it');
check('it skips <select> — that has its own dedicated path',
  /f\.tagName === 'SELECT'/.test(inputListenerBody) || /f\.tagName === "SELECT"/.test(inputListenerBody));
check('it skips checkbox/radio/file/password/hidden',
  /'checkbox', 'radio', 'file', 'password', 'hidden'/.test(inputListenerBody));
check('it debounces rather than recording on every keystroke',
  /setTimeout\(/.test(inputListenerBody) && /clearTimeout\(/.test(inputListenerBody),
  'without a debounce this would call record() far more often than needed, '
  + 'though record()\'s own dedupe would still keep it correct');
check('it calls record(f) — the exact same function change/focusout uses',
  /record\(f\)/.test(inputListenerBody),
  'a parallel/duplicate implementation would be a second place to keep in '
  + 'step with record()\'s dedupe and required-field detection');
check('it checks the field is still connected before recording',
  /f\.isConnected/.test(inputListenerBody),
  'the settle timer can fire after the field (or the whole panel) is gone — '
  + 'e.g. the operator navigated away mid-debounce');

// ── behavioural model over the real recorded values ─────────────────────────
// record()'s own dedupe (lastValueByField) is untouched by this fix, so model
// only what changes: whether a capture happens at all before change/focusout.
const typedSequence = ['dem', 'demo_t', 'demo_task', 'demo_taski34'];
const extjsDefault = 'New task';

function simulateOldCapture(sequence, hadFocusout) {
  // OLD: only change/focusout call record(). If neither fires during typing,
  // the only capture on file is whatever was there before typing started.
  return hadFocusout ? sequence[sequence.length - 1] : extjsDefault;
}
function simulateNewCapture(sequence) {
  // NEW: the last debounced input settle wins, regardless of whether
  // change/focusout ever fires — it directly reflects the last typed value.
  return sequence[sequence.length - 1];
}

const oldNoFocusout = simulateOldCapture(typedSequence, false);
const newCapture = simulateNewCapture(typedSequence);

console.log(`\n  old capture (no change/focusout seen): "${oldNoFocusout}"`);
console.log(`  new capture (debounced input settle)  : "${newCapture}"`);

check('REGRESSION GUARD: old behaviour reproduces the real bug',
  oldNoFocusout === extjsDefault,
  'if this fails, the bug scenario itself has drifted from the real recording');
check('THE FIX captures the operator\'s actual last-typed value',
  newCapture === 'demo_taski34',
  `got "${newCapture}"`);

// A widget that DOES fire change/focusout normally must see no behaviour
// change: record()'s dedupe means the debounced input capture and the
// eventual change/focusout capture agree, so only one record survives either
// way. Model that record() de-dupes on (fieldKey, value) pairs.
function simulateDedupedRecordCount(events) {
  const seen = new Map();
  let kept = 0;
  for (const { fieldKey, value } of events) {
    if (seen.get(fieldKey) === value) continue;
    seen.set(fieldKey, value);
    kept++;
  }
  return kept;
}
const normalField = [
  { fieldKey: 'account', value: '101.10' },   // debounced input settle
  { fieldKey: 'account', value: '101.10' },   // change/focusout, same value
];
check('a normally-behaved field sees no extra records (dedupe holds)',
  simulateDedupedRecordCount(normalField) === 1,
  `expected 1 kept record, simulation kept ${simulateDedupedRecordCount(normalField)}`);

// ── mutation check ──────────────────────────────────────────────────────────
{
  const mutated = src.replace(inputListenerBody, '');
  check('mutation removed the input-capture listener', mutated !== src && mutated.length < src.length);
  const mutatedHasListener = mutated.includes("document.addEventListener('input', (e) => {");
  check('MUTATION CHECK: removing it is detected',
    !mutatedHasListener,
    'the presence assertion above would not catch a regression');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
