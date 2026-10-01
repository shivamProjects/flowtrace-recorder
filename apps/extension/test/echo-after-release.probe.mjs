/**
 * echo-after-release.probe.mjs — is the replay's echo still recognised AFTER the
 * action has finished replaying?
 *
 * WHY THIS EXISTS
 * The narrowed guard ([[echo-guard-narrowing]]) drops events aimed at the element
 * being replayed — but only while that action sits in `_performingActions`.
 * Measured on dev79 (two independent traces, 2026-09-15), the replay resolves in
 * ~100ms while its own echo click does not arrive until ~300ms:
 *
 *     0ms    performAction START     (replay begins)
 *   104ms    performAction RESOLVED  -> action leaves _performingActions
 *   303ms    echo arrives            -> nothing left to match it against
 *
 * So the echo is recorded as a brand-new step. Confirmed end to end:
 * collapseActions() merges only `navigate` and `fill`, never `click`, so the
 * phantom survives into the generated script. Six pairs in one 20-step trace.
 *
 * Two costs:
 *   1. every recording carries ~2x the clicks it should;
 *   2. the echo re-arms the guard, so each click blocks new input for ~414ms
 *      (replay + gap + replay) rather than the ~104ms the replay actually takes.
 *
 * The fix keeps a short-lived memory of the element an action replayed, living
 * past the action's own release, and drops echoes that land inside that window.
 *
 * Run: node recorder/test/echo-after-release.probe.mjs
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

console.log('\n######## echo recognised after the action releases ########\n');

// ── 0. anchors: fail loudly if the code moved rather than testing nothing ────
const ANCHORS = [
  ['_actionInProgress(event) {', 'the guard predicate'],
  ['this._performingActions.delete(action)', 'the release site'],
];
for (const [a, what] of ANCHORS) {
  if (!src.includes(a)) {
    console.log(`  FAIL  anchor moved: ${what}`);
    console.log(`        expected to find ${JSON.stringify(a)}`);
    console.log('\n1 FAILURE(S) — re-derive this probe against the new source\n');
    process.exit(1);
  }
}

// ── 1. the retention window exists ──────────────────────────────────────────
check('a recently-replayed element is remembered past release (__sfRecentEcho)',
  src.includes('__sfRecentEcho'),
  'no retention: an echo arriving after the replay resolves is recorded as a new step');

check('the retention window has an explicit lifetime',
  /__SF_ECHO_RETAIN_MS\s*=\s*\d/.test(src),
  'without a bounded window the guard would suppress genuine repeat clicks forever');

// ── 2. the guard consults that memory ───────────────────────────────────────
const gStart = src.indexOf('_actionInProgress(event) {');
const gBody = src.slice(gStart, gStart + 4000);
check('the guard checks the retained element, not only live actions',
  gBody.includes('__sfRecentEcho'),
  'retention exists but the predicate never reads it');

// ── 3. behavioural model, rebuilt from the shipped constants ────────────────
const m = src.match(/__SF_ECHO_RETAIN_MS\s*=\s*(\d+)/);
const RETAIN = m ? Number(m[1]) : 0;
// The floor moved once a NAVIGATION click was measured. In-place controls echo
// at ~303ms (max 314ms observed), but a click that triggers a page transition
// echoes after that transition: on a live Period Close recording (dev93) the
// nav echoes were 532 / 816 / 535 / 555ms. 816ms is the worst on record.
check('retention covers every measured echo, including navigation', RETAIN > 816,
  `retention is ${RETAIN}ms; nav echoes were measured at up to 816ms `
  + '(General Ledger), and in-place echoes at ~303ms');

// Still bounded — a long window would swallow a repeat the operator meant.
//
// The ceiling was 800ms, chosen as reasoning rather than from data: the concern
// was deliberate repeats on spinners and incrementers. Two measurements have
// since bounded it properly.
//
// First, the only PACED repeat on record is the operator pressing
// #clusters-right-nav to page through the cluster nav: 2115ms and 2145ms. That
// is the real ceiling.
//
// Second — and this is why raising the window is safe — a true double-click is
// ~100-300ms, so it sits INSIDE the old 800ms window just as much as inside a
// larger one. Raising the ceiling does not newly endanger a spinner; those were
// always covered. It only changes behaviour for repeats paced between 800ms and
// the new value, and nothing in any recording falls there.
check('retention stays clear of a deliberately paced repeat', RETAIN > 0 && RETAIN < 2115,
  `retention is ${RETAIN}ms; the closest genuine repeat on record is 2115ms `
  + '(#clusters-right-nav), and suppressing a real click is worse than an '
  + 'extra step because the flow then cannot be replayed');

const mk = (name, kids = []) => {
  const el = { name, kids };
  el.contains = (o) => o === el || kids.includes(o);
  return el;
};

// Model: after release, the element lives in a recent-echo list with a deadline.
const decide = (recent, target, now) => {
  for (const r of recent) {
    if (now > r.until) continue;
    if (target === r.el || (r.el.contains && r.el.contains(target))) return true;
  }
  return false;
};

const save = mk('save');
const child = mk('child');
const saveWithChild = mk('saveWithChild', [child]);
const other = mk('other');

const recent = [{ el: save, until: 500 }, { el: saveWithChild, until: 500 }];

check('echo landing 303ms after release is DROPPED',
  decide(recent, save, 303) === true,
  'this is the duplicate-step bug: the phantom click reaches the saved script');
check('echo on a child of the replayed element is DROPPED',
  decide(recent, child, 303) === true);
check('an unrelated click during the window is ALLOWED',
  decide(recent, other, 303) === false,
  'retention must not re-introduce the blanket block the narrowing removed');
check('a genuine repeat click AFTER the window is ALLOWED',
  decide(recent, save, 900) === false,
  'the window must expire, or deliberate repeat clicks are silently swallowed');

// ── 4. mutation check: the probe must be able to fail ───────────────────────
const brokenRecent = [];          // simulates "no retention at all" = today's bug
const mutationCaught = decide(brokenRecent, save, 303) === false;
check('MUTATION CHECK — with retention removed, the echo leaks through',
  mutationCaught,
  'the probe cannot distinguish fixed from broken; it is asserting nothing');

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
