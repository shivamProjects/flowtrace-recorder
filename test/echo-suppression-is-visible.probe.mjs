/**
 * echo-suppression-is-visible.probe.mjs — the echo guard removes a click the
 * operator may have meant, so it must (a) only ever remove ONE, and (b) say so.
 *
 * WHY THIS EXISTS
 * The retention window is a heuristic. It cannot distinguish a replay echo from
 * a genuine repeat click on the same element within the same interval — the
 * dev29 "Select Period" case is exactly that shape, and survives only because
 * an unrelated action completed in between.
 *
 * The failure is asymmetric:
 *   an EXTRA step is visible in the recording and can be deleted
 *   a SUPPRESSED step leaves no trace and breaks the flow on replay
 *
 * So two properties matter more than the window value itself:
 *
 *   1. One entry suppresses at most ONE click. A second genuine repeat still
 *      records, which bounds the blast radius of a wrong window to a single
 *      click rather than a burst.
 *   2. The drop is logged UNCONDITIONALLY. The previous log sat behind
 *      __SF_DEBUG, which ships off, so in production a lost click was
 *      undiagnosable — "my click went missing" could not be answered without
 *      reproducing under a debug build.
 *
 * Run: node recorder/test/echo-suppression-is-visible.probe.mjs
 */

import { readFileSync } from 'node:fs';

const BG = 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/background.js';

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('\necho-suppression-is-visible.probe.mjs');
console.log('  suppressing a click must be bounded and audible\n');

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

// ── the guard region ───────────────────────────────────────────────────────
const gStart = page.indexOf('var __sfRecent = this._recorder.__sfRecentEcho;');
check('found the echo guard', gStart !== -1);
const guard = page.slice(gStart, gStart + 1600);

// ── 1. one entry suppresses at most one click ──────────────────────────────
check('THE BOUND: the entry is removed when it fires',
  /if \(__sfHit\) \{[\s\S]{0,400}?__sfRecent\.splice\(__sfJ, 1\);[\s\S]{0,80}?return true;/.test(guard),
  'without consuming the entry, every click on that element inside the window '
  + 'would be dropped - one wrong window would eat a burst, not a single click');

// Order matters: splice must precede the return, or it never runs.
const hitIdx = guard.indexOf('if (__sfHit)');
const spliceIdx = guard.indexOf('__sfRecent.splice(__sfJ, 1);', hitIdx);
const returnIdx = guard.indexOf('return true;', hitIdx);
check('the entry is consumed BEFORE returning',
  spliceIdx !== -1 && returnIdx !== -1 && spliceIdx < returnIdx,
  `splice@${spliceIdx} return@${returnIdx}`);

// ── 2. the drop is audible in a normal build ───────────────────────────────
const logLine = guard.slice(hitIdx, returnIdx);
check('THE AUDIT: the drop is logged',
  /console\.log\(/.test(logLine));
check('the log is NOT gated behind __SF_DEBUG',
  !/__SF_DEBUG[\s\S]{0,40}console\.log\("\[SyntraFlow:echo\]/.test(logLine)
  && /console\.log\("\[SyntraFlow:echo\]/.test(logLine),
  'gated behind a flag that ships off, a suppressed click is undiagnosable');
check('the log says the click was NOT recorded',
  /was NOT recorded/.test(logLine),
  'the message has to be readable by whoever lost the step, not just by us');
check('the log reports the actual interval',
  /ms after the replay released/.test(logLine),
  'the measured echoes land 505-816ms after the click; a drop reported well '
  + 'outside that band is a signal the window is wrong for that control');

// ── the interval needs an arm-time stamp to exist ──────────────────────────
check('retention entries carry the time they were armed',
  /__sfRec\.push\(\{ el: action\.__sfEchoEl, at: __sfNow, until:/.test(page),
  'without `at` the log cannot report how long after the replay the click came');

// ── the guard must stay identity-based ─────────────────────────────────────
check('suppression still requires an identity match, not just timing',
  /__sfT === __sfEntry\.el/.test(guard),
  'a selector+elapsed-time rule would drop the dev29 Select Period re-click');

// ── mutation checks ────────────────────────────────────────────────────────
{
  const noSplice = guard.replace(/__sfRecent\.splice\(__sfJ, 1\);\s*\n\s*return true;/, 'return true;');
  check('mutation removed the consume', noSplice !== guard);
  check('MUTATION CHECK: without consuming, the bound is gone',
    !/if \(__sfHit\) \{[\s\S]{0,400}?__sfRecent\.splice\(__sfJ, 1\);[\s\S]{0,80}?return true;/.test(noSplice),
    'the bound assertion would not catch a regression');

  const gated = logLine.replace('console.log("[SyntraFlow:echo]', 'if (globalThis.__SF_DEBUG === true) console.log("[SyntraFlow:echo]');
  check('MUTATION CHECK: re-gating the log is detected',
    /__SF_DEBUG[\s\S]{0,40}console\.log\("\[SyntraFlow:echo\]/.test(gated));
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
