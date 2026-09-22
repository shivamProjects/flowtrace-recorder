/**
 * echo-window-covers-nav.probe.mjs — the echo-retention window must outlast a
 * replayed navigation click, without swallowing a genuine repeat press.
 *
 * WHY THIS EXISTS
 * A live Period Close recording (dev93) contained four nav clicks recorded
 * TWICE, identical selectors:
 *
 *   Period Close     1790074417288 -> 1790074417820   gap 532ms
 *   General Ledger   1790074423658 -> 1790074424474   gap 816ms
 *   Open Period      1790074438012 -> 1790074438547   gap 535ms
 *   Done             1790074445151 -> 1790074445706   gap 555ms
 *
 * __SF_ECHO_RETAIN_MS was 500, so every one of them landed just PAST the
 * window and was recorded as a second step. The guard itself is correct — the
 * identity test and the sweep both work — it simply expired too early for a
 * click that navigates.
 *
 * The same recording bounds the other side. The operator really did press
 * #clusters-right-nav three times to page through the cluster nav, and those
 * gaps are 2115ms and 2145ms. Those MUST still record: suppressing a genuine
 * repeat is worse than an extra step, because the flow then cannot be replayed.
 *
 * So the window has to sit strictly between 816ms and 2115ms.
 *
 * Run: node recorder/test/echo-window-covers-nav.probe.mjs
 */

import { readFileSync } from 'node:fs';

const BG = 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/background.js';

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('\necho-window-covers-nav.probe.mjs');
console.log('  retention must outlast a replayed nav click, not a real repeat\n');

// ── decode the page script ─────────────────────────────────────────────────
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
const page = eval("'" + src.slice(start, j) + "'");

// ── the constant ───────────────────────────────────────────────────────────
const m = page.match(/var __SF_ECHO_RETAIN_MS = (\d+);/);
check('__SF_ECHO_RETAIN_MS is declared in the page script', !!m);
const RETAIN = Number(m[1]);

// ── the measured evidence ──────────────────────────────────────────────────
const ECHO_GAPS = [
  ['Period Close', 532], ['General Ledger', 816],
  ['Open Period', 535], ['Done', 555],
];
const REAL_REPEATS = [['clusters-right-nav 1->2', 2115], ['clusters-right-nav 2->3', 2145]];

const worstEcho = Math.max(...ECHO_GAPS.map(([, g]) => g));
const closestReal = Math.min(...REAL_REPEATS.map(([, g]) => g));

check('the window covers EVERY observed echo', RETAIN > worstEcho,
  `RETAIN=${RETAIN}ms but the worst echo was ${worstEcho}ms (General Ledger)`);
for (const [name, gap] of ECHO_GAPS) {
  check(`  ${name} (${gap}ms) is inside the window`, gap <= RETAIN);
}

check('the window does NOT reach a genuine repeat press', RETAIN < closestReal,
  `RETAIN=${RETAIN}ms would swallow a real repeat at ${closestReal}ms — `
  + 'suppressing a real click is worse than an extra step, because the flow '
  + 'then cannot be replayed');
for (const [name, gap] of REAL_REPEATS) {
  check(`  ${name} (${gap}ms) still records`, gap > RETAIN);
}

check('there is real margin on both sides',
  RETAIN - worstEcho >= 200 && closestReal - RETAIN >= 200,
  `echo margin ${RETAIN - worstEcho}ms, repeat margin ${closestReal - RETAIN}ms`);

// ── the guard around it must still be intact ───────────────────────────────
check('retention entries are still swept when they expire',
  /if \(__sfEntry\.until <= __sfNowG\) \{ __sfRecent\.splice\(__sfJ, 1\); continue; \}/.test(page),
  'a longer window makes the sweep matter more, not less');
check('the echo test is still identity-based, not selector-based',
  /__sfT === __sfEntry\.el/.test(page) && /__sfEntry\.el\.contains/.test(page),
  'matching by selector would suppress a different element with the same name');
check('entries are only armed for a remembered element',
  /if \(action\.__sfEchoEl\)/.test(page),
  'no remembered element must still mean no entry');

// ── mutation check ─────────────────────────────────────────────────────────
{
  const BROKEN = 500;
  check('mutation uses the value that shipped', BROKEN !== RETAIN);
  check('MUTATION CHECK: 500ms lets every observed echo through',
    ECHO_GAPS.every(([, gap]) => gap > BROKEN),
    'if some gap were under 500 the old value would have caught it and this '
    + 'probe would not be testing the real defect');
  // ...and the old value was never in danger of eating a real repeat, which is
  // why the defect looked like "duplicates" rather than "missing clicks".
  check('MUTATION CHECK: 500ms was safe for real repeats (why it looked one-sided)',
    REAL_REPEATS.every(([, gap]) => gap > BROKEN));
}

console.log(`\n  window ${RETAIN}ms  (worst echo ${worstEcho}ms, closest real repeat ${closestReal}ms)`);
console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
