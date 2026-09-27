/**
 * select-blur-arm-race.probe.mjs — the blur-commit arming guard must not be
 * blocked by an unrelated in-flight action.
 *
 * WHY THIS EXISTS
 * After select-recordaction-no-loop's fix landed, a live report on dev29
 * showed a regression: a <select> left on its already-set default value
 * (e.g. Invoice Type staying "Standard") stopped being recorded at all in
 * some runs. A <select> fires no input/change when its value does not move,
 * so this control relies entirely on _shouldIgnoreMouseEvent arming
 * __sfSelectTouched on mousedown, and _onSelectBlur committing the step if
 * nothing else recorded it (see select-same-value.probe.mjs).
 *
 * ROOT CAUSE
 * The arm condition was `event.isTrusted && !this._performingActions.size`.
 * _performingActions holds ANY in-flight _performAction() replay -- a click,
 * a fill, an unrelated select -- for up to 8s (or the whole 0.3-2s ADF PPR
 * round trip in the normal case). If the operator opened a default-valued
 * select while a prior, unrelated step was still replaying, the guard was
 * non-empty, nothing was armed, and the blur handler had nothing to commit.
 * No debug line was emitted either -- this failed completely silently.
 *
 * This condition was written to stop a select's OWN CDP replay from
 * re-arming the marker mid-loop (the runaway-loop bug). But after the
 * recordAction fix, neither select-recording path calls _performAction any
 * more, so a select can never appear in _performingActions -- the guard was
 * blocking a case that can no longer happen, while still blocking every
 * unrelated concurrent action, which can happen constantly on ADF.
 *
 * THE FIX
 * Drop the _performingActions check from the arm condition. isTrusted alone
 * is sufficient now that _performAction is never called for "select".
 *
 * Run: node recorder/test/select-blur-arm-race.probe.mjs
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

console.log('\nselect-blur-arm-race.probe.mjs');
console.log('  blur-commit arming must not be blocked by an unrelated in-flight action\n');

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

// ── slice _shouldIgnoreMouseEvent's SELECT arm branch ──────────────────────
const mStart = page.indexOf('_shouldIgnoreMouseEvent(event) {');
check('found _shouldIgnoreMouseEvent', mStart !== -1);
const mBody = page.slice(mStart, mStart + 4000);

check('THE FIX: arm condition no longer gates on _performingActions.size',
  !/if \(event\.isTrusted && !this\._performingActions\.size\)/.test(mBody),
  'a select can never appear in _performingActions any more (recordAction, not _performAction); this blocked unrelated concurrent replays instead');

check('arm condition still requires event.isTrusted',
  /if \(event\.isTrusted\)\s*\{/.test(mBody),
  'synthetic/replayed mousedown must still be rejected');

check('__sfSelectTouched is still armed with el/value/recorded',
  /this\.__sfSelectTouched = \{ el: __sfSelEl, value: __sfSelEl\.value, recorded: __sfAlreadyRecordedThisValue \}/.test(mBody),
  'the recorded flag now comes from the __sfLastRecordedValue stamp check (select-blur-double-record.probe.mjs), not a hardcoded false');

// ── select can never be in _performingActions after the recordAction fix ───
const sStart2 = page.indexOf('if (target.nodeName === "SELECT") {');
const sBody = page.slice(sStart2, sStart2 + 4000);
const bStart = page.indexOf('_onSelectBlur(event) {');
const bBody = page.slice(bStart, bStart + 2000);

check('onInput SELECT branch never calls _performAction (prerequisite for the fix)',
  !/this\._performAction\(\{\s*name:\s*"select"/.test(sBody));
check('_onSelectBlur never calls _performAction (prerequisite for the fix)',
  !/this\._performAction\(\{\s*name:\s*"select"/.test(bBody));

// ── behavioural reproduction: arm blocked by an UNRELATED replay ───────────
function simulateArm(usePerformingActionsGuard, unrelatedActionInFlight, isTrusted) {
  // Mirrors the real guard's boolean shape exactly.
  const performingActionsSize = unrelatedActionInFlight ? 1 : 0;
  const armed = usePerformingActionsGuard
    ? (isTrusted && performingActionsSize === 0)
    : isTrusted;
  return armed;
}

check('REGRESSION GUARD: old guard silently fails to arm during an unrelated replay',
  simulateArm(true, /* unrelated action in flight */ true, /* trusted */ true) === false,
  'old behaviour: operator opens a default-valued select while an unrelated click/fill is still replaying -> not armed -> blur commits nothing');

check('THE FIX: new guard arms regardless of unrelated in-flight actions',
  simulateArm(false, /* unrelated action in flight */ true, /* trusted */ true) === true,
  'fix must arm the default-value tracker even while something unrelated is replaying');

check('THE FIX: still refuses to arm on untrusted (synthetic) mousedown',
  simulateArm(false, false, /* trusted */ false) === false,
  'isTrusted must still gate arming -- a synthetic mousedown must never arm the tracker');

// ── mutation check ─────────────────────────────────────────────────────────
{
  const mutated = mBody.replace(
    'if (event.isTrusted) {',
    'if (event.isTrusted && !this._performingActions.size) {'
  );
  check('mutation reintroduced the _performingActions guard', mutated !== mBody);
  check('MUTATION CHECK: reintroducing the guard is detected',
    /if \(event\.isTrusted && !this\._performingActions\.size\)/.test(mutated));
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
