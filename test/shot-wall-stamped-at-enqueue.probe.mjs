/**
 * shot-wall-stamped-at-enqueue.probe.mjs — is a shot's epoch timestamp taken
 * when the user ACTED, or when the capture happened to finish?
 *
 * THE DEFECT (found 2026-09-21, from the scattered gaps in proof PDF
 * 904_proof_20260920_060936.pdf: steps 44, 49, 56, 63, 72 missing while their
 * neighbours were fine)
 *
 * onCaptureStep() took the monotonic stamp at enqueue, with a comment saying
 * exactly why:
 *
 *     // Stamp at enqueue time, not when the capture actually runs, so the shot
 *     // lines up with the moment the user acted.
 *     const mt = performance.now();
 *
 * ...but `wall`, the EPOCH stamp that attachImages() actually matches on, was
 * taken later, inside doCapture(), AFTER capture() and drawHighlight() resolved:
 *
 *     const shot = { mt, wall: Date.now(), dataUrl, key: nextShotKey() };
 *
 * So the careful enqueue-time stamp was computed and then effectively discarded.
 * On ADF, capture can take seconds (PPR round trips of 6-25s were measured
 * earlier in this project), pushing `wall` outside MATCH_WINDOW_MS of the step
 * that caused it. The image is captured and held in the buffer, but can never be
 * attached to its step.
 *
 * WHY THE SHAPE IDENTIFIES IT
 * Front-eviction loses a LEADING RUN (steps 1..22). A queue burst or a matcher
 * cascade loses CONSECUTIVE steps. Only a per-step timing failure loses ISOLATED
 * SINGLES, which is what the PDF shows. MAX_QUEUE was modelled and lost 0 steps
 * at 150/400/900ms per frame, so it is not the cause.
 *
 * WHY NOT JUST WIDEN THE WINDOW
 * Modelled at several sizes against a 99-step timeline where 35% of steps are
 * fills (whose `change` fires on BLUR, 0.8-4.3s after the action): widening
 * recovers missing images but steadily INCREASES mis-attachment — 17 wrong at
 * 2000ms, 24 wrong at 5000ms. A wrong screenshot in a proof document is worse
 * than a missing one, so the fix is to stamp correctly, not to widen.
 *
 * Run: node recorder/test/shot-wall-stamped-at-enqueue.probe.mjs [path]
 */

import { readFileSync } from 'node:fs';

const SRC = process.argv[2]
  || 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/lib/step-image-processing.js';
const src = readFileSync(SRC, 'utf8');

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('\nshot-wall-stamped-at-enqueue.probe.mjs');
console.log('  against ' + SRC + '\n');

// ── 1. anchors ─────────────────────────────────────────────────────────────
if (!/function onCaptureStep\(msg, sender\)/.test(src))
  throw new Error('anchor moved: onCaptureStep not found');
if (!/async function doCapture\(/.test(src))
  throw new Error('anchor moved: doCapture not found');

// ── 2. BOTH clocks are read at enqueue ─────────────────────────────────────
const enqueue = src.slice(src.indexOf('function onCaptureStep'),
  src.indexOf('function onCaptureStep') + 2400);

check('the monotonic stamp is taken at enqueue',
  /const mt = performance\.now\(\);/.test(enqueue));

check('the EPOCH stamp is also taken at enqueue',
  /const wall = Date\.now\(\);/.test(enqueue),
  'this is the one attachImages() matches on; taking it later is the defect');

// ── 3. it is passed down, not re-derived ───────────────────────────────────
check('both stamps are passed to doCapture',
  /doCapture\(msg, tabId, sender\.tab\.windowId, mt, wall\)/.test(src),
  'the enqueue-time value has to reach the shot literal to matter');

check('doCapture accepts the epoch stamp as a parameter',
  /async function doCapture\(msg, tabId, windowId, mt, wall\) \{/.test(src));

// ── 4. the shot uses the PASSED stamp, never a fresh clock read ────────────
const shotLiteral = src.match(/const shot = \{[^}]*\};/);
check('the shot literal exists', !!shotLiteral);

if (shotLiteral) {
  check('the shot uses the passed `wall`',
    /const shot = \{ mt, wall, dataUrl/.test(shotLiteral[0]),
    `found: ${shotLiteral[0]}`);

  check('the shot does NOT re-read the clock',
    !/wall: Date\.now\(\)/.test(shotLiteral[0]),
    'Date.now() here is post-capture — seconds late on a slow ADF round trip');
}

// ── 5. the window was NOT widened to paper over it ─────────────────────────
const win = src.match(/const MATCH_WINDOW_MS = (\d+);/);
check('MATCH_WINDOW_MS is still a tight tolerance',
  win && Number(win[1]) <= 3000,
  `MATCH_WINDOW_MS=${win ? win[1] : '?'}. Widening trades missing images for `
  + `MIS-ATTACHED ones (modelled: 17 wrong at 2000ms, 24 at 5000ms), and a wrong `
  + `screenshot in a proof document is worse than a blank.`);

// ── 6. behavioural model ───────────────────────────────────────────────────
// A step acts at t=0; its capture takes 6s (a realistic ADF PPR round trip).
{
  const WINDOW = win ? Number(win[1]) : 2000;
  const stepAt = 1_700_000_000_000;
  const captureMs = 6000;

  const wallAtEnqueue = stepAt + 40;              // fixed behaviour
  const wallAtCapture = stepAt + 40 + captureMs;  // old behaviour

  check('enqueue-stamped: the slow step still matches',
    Math.abs(wallAtEnqueue - stepAt) <= WINDOW,
    `delta ${wallAtEnqueue - stepAt}ms vs window ${WINDOW}ms`);

  check('MUTATION CHECK — capture-stamped: the same step is UNMATCHABLE',
    Math.abs(wallAtCapture - stepAt) > WINDOW,
    'if this passes, the model no longer distinguishes the two stampings');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
