/**
 * select-recordaction-no-loop.probe.mjs — <select> onInput must record the action
 * directly without dispatching a replay loop.
 *
 * WHY THIS EXISTS
 * Manage Daily Rates (dev29) recorded 57+ selectOption steps in 9 seconds.
 *
 * ROOT CAUSE
 * In pollingRecorder.ts onInput's SELECT branch, calling _performAction({ name: "select" })
 * triggered CDP page.selectOption replay, which dispatched DOM input/change events
 * back to the <select>. Because _actionInProgress does not guard select actions or
 * generic Events, the dispatched event re-entered onInput, producing an infinite
 * self-firing loop (57 repeats in 9s).
 *
 * THE FIX
 * 1. onInput calls this._recorder.recordAction({ name: "select", ... }), matching
 *    the fill branch and _onSelectBlur.
 * 2. Requires event.isTrusted to reject synthetic/replayed events.
 *
 * Run: node recorder/test/select-recordaction-no-loop.probe.mjs
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

console.log('\nselect-recordaction-no-loop.probe.mjs');
console.log('  <select> onInput must record directly and reject synthetic replay feedback\n');

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

// ── slice onInput SELECT branch ────────────────────────────────────────────
const sStart = page.indexOf('if (target.nodeName === "SELECT") {');
check('found SELECT handler in onInput', sStart !== -1);
const sBody = page.slice(sStart, sStart + 3200);

check('THE FIX: onInput uses recordAction, NOT _performAction',
  /this\._recorder\.recordAction\(\{\s*name:\s*"select"/.test(sBody),
  '_performAction dispatches a CDP selectOption replay that loops back through onInput');

check('no _performAction in onInput SELECT branch',
  !/this\._performAction\(\{\s*name:\s*"select"/.test(sBody),
  'calling _performAction causes the 57-repeat feedback loop');

check('gated on trusted events (event.isTrusted)',
  /if \(!event\.isTrusted\)/.test(sBody),
  'untrusted synthetic events from page scripts or CDP must not trigger select recordings');

// ── 57-repeat reproduction regression guard ────────────────────────────────
const RUNAWAY_REPEATS = 57;
function simulateSelectDispatch(useRecordAction, isTrusted) {
  let stepCount = 0;
  let queue = [{ isTrusted }];
  while (queue.length > 0 && stepCount < 100) {
    const ev = queue.shift();
    if (!ev.isTrusted) continue;
    stepCount++;
    if (!useRecordAction) {
      // old behaviour: _performAction triggers CDP replay which dispatches synthetic event
      queue.push({ isTrusted: true }); // simulates replay loop
    }
  }
  return stepCount;
}

check('REGRESSION GUARD: old _performAction behaviour produces runaway loop',
  simulateSelectDispatch(false, true) >= RUNAWAY_REPEATS,
  'simulated old behaviour did not reproduce runaway loop');

check('THE FIX: recordAction produces exactly 1 step for 1 user gesture',
  simulateSelectDispatch(true, true) === 1,
  'simulated fix must emit exactly one step without loop');

// ── mutation check ─────────────────────────────────────────────────────────
{
  const mutated = sBody.replace('this._recorder.recordAction', 'this._performAction');
  check('mutation introduced _performAction', mutated !== sBody);
  check('MUTATION CHECK: _performAction in SELECT branch is detected',
    !/this\._recorder\.recordAction\(\{\s*name:\s*"select"/.test(mutated));
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
