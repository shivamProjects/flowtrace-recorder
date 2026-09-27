/**
 * shot-retention-keeps-oldest.probe.mjs — a long recording must keep its
 * EARLIEST screenshots.
 *
 * THE REPORT (2026-09-20, proof PDF 904_proof_20260920_060936.pdf)
 * "the recording is passing 80+ steps, then the recorder is dropping the images
 * which were captured at the START of the recording -- starting 25+ screenshots
 * are missing." Follow-up from the user: it is a reproducible THRESHOLD --
 * under ~70-80 steps nothing is lost, over it the earliest images go.
 *
 * WHAT THE PDF ACTUALLY CONTAINS (measured, by inflating its object streams --
 * the text is not visible to a latin1 scan of the raw file):
 *
 *     "Step N" labels : 72, running 23..99   -> the recording was 99 steps
 *     DCTDecode (JPEG): 72                   -> one image per surviving label
 *     absent entirely : 1..22, plus 44,49,56,63,72
 *     99 - 22 - 5 = 72                       -> closes exactly
 *
 * THE ARITHMETIC THAT IDENTIFIES THE CAUSE
 * 142 frames were captured for 99 steps = 1.434 frames per step, because
 * content/step-image-capture.js sends on pointerdown AND change AND focusin,
 * in every frame (manifest all_frames:true), and its 150ms dedupe only
 * suppresses the SAME element. Then:
 *
 *     142 captured - 120 (old MAX_SHOTS) = 22 evicted from the FRONT
 *     first surviving step = 22 + 1      = 23   <- exactly what the PDF shows
 *
 * and the threshold falls out of the same number:
 *
 *     120 frames / 1.434 frames per step = 83.7 steps
 *
 * which is the user's reported "~70-80 steps", with zero loss below it. The
 * earlier inference "80 steps < MAX_SHOTS 120, so it cannot be the ring buffer"
 * was wrong because it compared a STEP count against a FRAME budget.
 *
 * RULED OUT for the leading 1..22 block:
 *   - chrome.storage.local eviction (the user's hypothesis). Chrome's quota
 *     manager evicts per ORIGIN, all-or-nothing, and has no notion of which of
 *     our keys is older, so it produces SCATTERED losses. Modelled: random
 *     eviction of 22 of 120 keys gives a leading contiguous run of 2. The PDF
 *     shows a leading contiguous run of 22. Front-eviction is the only
 *     mechanism here that is ordered by age.
 *   - MAX_QUEUE=8. It drops only SURPLUS frames; since the surplus are echoes
 *     of a step that already has a frame, every step still gets an image.
 *     Modelled at this multiplier: zero steps lost.
 * STILL OPEN: the 5 scattered gaps (44,49,56,63,72) are NOT explained by
 * front-eviction, which can only produce a leading run. Most likely the
 * match window or wrong-tab frames; not separated by the evidence available.
 *
 * A SECOND, DISTINCT DEFECT found while measuring: attachImages walked the
 * steps IN ORDER and took the nearest unused shot. A step whose action ran long
 * sits nearer the NEXT step's shot, takes it, and every later step shifts by one
 * until the 2s window breaks the chain. On a 6-step case one lagging step put
 * the WRONG image on 3 steps and dropped the last. A wrong image in a proof
 * document is worse than a missing one and is invisible to any count.
 *
 * WHAT THIS PROBE PINS
 *   1. eviction no longer takes from the front by default
 *   2. the frame budget is big enough for a realistic recording
 *   3. matching is best-first, not in-order, so there is no cascade
 *   4. losses are counted and surfaced rather than swallowed
 *
 * Run: node recorder/test/shot-retention-keeps-oldest.probe.mjs
 *      node recorder/test/shot-retention-keeps-oldest.probe.mjs <path-to-old-file>
 * The second form points it at the PRE-FIX source to prove it can fail.
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

console.log('\nshot-retention-keeps-oldest.probe.mjs');
console.log(`  (source: ${SRC})\n`);

// ── the observed facts, from the PDF ───────────────────────────────────────
const PDF_STEPS = 99;
const PDF_IMAGES = 72;
const PDF_FIRST_OK = 23;
const PDF_INSIDE_GAPS = 5;
check('PDF arithmetic closes: 99 steps - 22 leading - 5 scattered = 72 images',
  PDF_STEPS - (PDF_FIRST_OK - 1) - PDF_INSIDE_GAPS === PDF_IMAGES);

// ── 1. anchors ─────────────────────────────────────────────────────────────
const capMatch = src.match(/const MAX_SHOTS = (\d+);/);
if (!capMatch) throw new Error('anchor moved: MAX_SHOTS declaration not found');
const MAX_SHOTS = Number(capMatch[1]);
const winMatch = src.match(/const MATCH_WINDOW_MS = (\d+);/);
if (!winMatch) throw new Error('anchor moved: MATCH_WINDOW_MS declaration not found');
console.log(`  (MAX_SHOTS = ${MAX_SHOTS})\n`);

// ── 2. the frame budget covers a realistic recording ───────────────────────
const FRAMES_PER_STEP = 1.434;   // measured, see header
const stepsCovered = MAX_SHOTS / FRAMES_PER_STEP;
check('the frame budget covers the 99-step recording that was reported',
  stepsCovered >= PDF_STEPS,
  `MAX_SHOTS=${MAX_SHOTS} covers only ${stepsCovered.toFixed(1)} steps at the measured `
  + `${FRAMES_PER_STEP} frames/step. The reported recording was ${PDF_STEPS} steps, so the `
  + `earliest ${Math.round(PDF_STEPS * FRAMES_PER_STEP) - MAX_SHOTS} frames are evicted.`);

check('MAX_SHOTS is documented as a FRAME budget, not a step budget',
  /in FRAMES/.test(src),
  'the cap being a frame budget while the report needs a step budget is the '
  + 'whole reason this under-delivered silently');

// ── 3. eviction no longer removes from the front by default ────────────────
check('eviction does NOT unconditionally splice from the front',
  !/const evicted = shots\.splice\(0, shots\.length - MAX_SHOTS\)/.test(src)
  && !/shots\.splice\(0, shots\.length - MAX_SHOTS\)/.test(src),
  'shots.splice(0, n) removes the OLDEST shots — the exact reported symptom');

check('a redundancy-aware eviction exists',
  /function evictToCap\(/.test(src) && /REDUNDANT_GAP_MS/.test(src),
  'without it the only way to get under the cap is to drop history');

check('dropping the oldest is the LAST resort, and is counted',
  /historyEvicted\+\+/.test(src) && /redundantEvicted\+\+/.test(src),
  'the two kinds of loss must be distinguishable: shedding a duplicate is '
  + 'harmless, losing the oldest is the defect');

check('losing the oldest is logged as a WARNING',
  /WARNING: evicted \$\{lostNow\} of the OLDEST/.test(src),
  'this is the event that produced the report; it must not be silent');

// ── 4. matching is best-first, not in-order ────────────────────────────────
check('attachImages assigns globally-closest pairs first',
  /pairs\.sort\(\(a, b\) => a\.delta - b\.delta\)/.test(src),
  'an in-order walk lets a lagging step steal the next step\'s shot and '
  + 'cascade, putting the WRONG image on later steps');

check('attachImages reports expected-vs-attached and names the missing steps',
  /expected/.test(src) && /missing/.test(src) && /return \{ steps, matched, expected, missing \}/.test(src),
  'a count of what SHOULD have had an image is the thing that makes '
  + '"22 images missing" checkable by a human or a test');

// ── 5. the silent-failure paths are now surfaced ───────────────────────────
check('a partial restore is distinguishable from a full one',
  /restored only \$\{shots\.length\} of \$\{index\.length\}/.test(src),
  'entries in the index whose value vanished used to be dropped silently');

check('hydrate no longer swallows every error',
  !/\} catch \(_\) \{\}\s*\}\)\(\);/.test(src),
  'a total restore failure looked identical to an empty store');

check('persist failures are counted, not just logged',
  /persistFailed\+\+/.test(src),
  'a shot that never reached storage is gone after the next worker restart');

// ── 6. wrong-tab frames stop consuming slots ───────────────────────────────
check('captures are filtered to the recorded tab',
  /function recordedTabId\(/.test(src) && /foreignDropped\+\+/.test(src),
  'the content script matches <all_urls>, so the SyntraFlow web UI reports its '
  + 'own clicks; those frames cannot be photographed but still consumed slots');

check('an unknown recording tab lets the frame THROUGH, not drops it',
  /if \(recorded != null && tabId !== recorded\)/.test(src),
  'treating "can\'t tell" as "drop" would lose real images — the same '
  + 'deliberately permissive line isRecording() already takes');

// ── 7. behavioural model: the fixed policy on the reported recording ───────
// Model the policy THIS SOURCE actually implements, so pointing the probe at
// the pre-fix file exercises the pre-fix behaviour rather than silently
// grading the old file against the new algorithm.
const HAS_REDUNDANCY_EVICTION = /function evictToCap\(/.test(src)
  && /REDUNDANT_GAP_MS/.test(src);
const REDUNDANT_GAP_MS = Number((src.match(/const REDUNDANT_GAP_MS = (\d+);/) || [])[1] || 400);
function evictModel(shots, cap, gapMs) {
  let history = 0;
  if (!HAS_REDUNDANCY_EVICTION) {
    // the pre-fix line: shots.splice(0, shots.length - MAX_SHOTS)
    if (shots.length > cap) {
      const n = shots.length - cap;
      shots.splice(0, n);
      history += n;
    }
    return history;
  }
  while (shots.length > cap) {
    let victim = -1, bestGap = Infinity;
    for (let i = 1; i < shots.length - 1; i++) {
      const gap = shots[i].wall - shots[i - 1].wall;
      if (gap < bestGap) { bestGap = gap; victim = i; }
    }
    if (victim >= 0 && bestGap <= gapMs) shots.splice(victim, 1);
    else { shots.shift(); history++; }
  }
  return history;
}
{
  // the reported recording: 99 steps, ~1.434 frames each
  const shots = [];
  let wall = 1_000_000, history = 0;
  for (let i = 1; i <= PDF_STEPS; i++) {
    wall += 1500;
    shots.push({ wall, step: i, primary: true });
    history += evictModel(shots, MAX_SHOTS, REDUNDANT_GAP_MS);
    if (i % 7 !== 0) {
      shots.push({ wall: wall + 80, step: i, primary: false });
      history += evictModel(shots, MAX_SHOTS, REDUNDANT_GAP_MS);
    }
  }
  const oldestKept = shots.length && shots[0].step === 1;
  check('the reported 99-step recording keeps its FIRST shot',
    oldestKept, `oldest held shot belongs to step ${shots[0]?.step}`);
  check('and loses no history at all',
    history === 0, `${history} oldest shot(s) evicted`);
}
{
  // far past the cap: 350 steps, every one echoed = 700 frames
  const shots = [];
  let wall = 1_000_000;
  for (let i = 1; i <= 350; i++) {
    wall += 1500;
    shots.push({ wall, step: i, primary: true });
    evictModel(shots, MAX_SHOTS, REDUNDANT_GAP_MS);
    shots.push({ wall: wall + 80, step: i, primary: false });
    evictModel(shots, MAX_SHOTS, REDUNDANT_GAP_MS);
  }
  const primaries = shots.filter(s => s.primary).length;
  check('at 2x the cap it sheds ECHOES and keeps every primary frame',
    primaries === 350 && shots[0].step === 1,
    `held ${primaries} primary of 350; oldest is step ${shots[0]?.step}. `
    + `A symmetric "closest neighbour" rule fails here: it kept 349 echoes and `
    + `only 51 primaries, because it cannot tell a primary from its echo.`);
}

// ── 8. the match cascade is gone ───────────────────────────────────────────
const W = Number(winMatch[1]);
function attachInOrder(steps, shots) {
  const used = new Set(); const out = {};
  for (const st of steps) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < shots.length; i++) {
      if (used.has(i)) continue;
      const d = Math.abs(shots[i].wall - st.timestamp);
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0 && bd <= W) { used.add(best); out[st.n] = shots[best].step; } else out[st.n] = null;
  }
  return out;
}
function attachBestFirst(steps, shots) {
  const pairs = [];
  for (let s = 0; s < steps.length; s++)
    for (let i = 0; i < shots.length; i++) {
      const d = Math.abs(shots[i].wall - steps[s].timestamp);
      if (d <= W) pairs.push({ s, i, d });
    }
  pairs.sort((a, b) => a.d - b.d);
  const ts = new Set(), us = new Set(), out = {};
  for (const st of steps) out[st.n] = null;
  for (const p of pairs) {
    if (ts.has(p.s) || us.has(p.i)) continue;
    ts.add(p.s); us.add(p.i); out[steps[p.s].n] = shots[p.i].step;
  }
  return out;
}
{
  const shots = [], steps = [];
  let wall = 0;
  const lag = { 2: 2600 };
  for (let i = 1; i <= 6; i++) {
    wall += 1500;
    shots.push({ wall, step: i });
    steps.push({ n: i, timestamp: wall + (lag[i] || 50) });
  }
  const bad = attachInOrder(steps, shots);
  const badWrong = steps.filter(s => bad[s.n] !== null && bad[s.n] !== s.n).length;
  check('MUTATION CHECK — the OLD in-order walk mis-attaches on a lagging step',
    badWrong > 0,
    'if this stops failing, the cascade case no longer reproduces and the '
    + 'check below proves nothing');

  // Grade the source under test on the matcher it actually ships.
  const BEST_FIRST = /pairs\.sort\(\(a, b\) => a\.delta - b\.delta\)/.test(src);
  const actual = BEST_FIRST ? attachBestFirst(steps, shots) : bad;
  const wrong = steps.filter(s => actual[s.n] !== null && actual[s.n] !== s.n).length;
  const none = steps.filter(s => actual[s.n] === null).length;
  // The bar is "never attaches the WRONG image", not "never leaves one blank".
  // Step 2's action ran 2.6s long, so its own shot is outside the 2s window and
  // one step legitimately ends up without an image. Silently showing a
  // neighbour's screenshot instead is the defect; a blank is honest.
  check('this source never attaches a NEIGHBOUR\'s image',
    wrong === 0,
    `${wrong} step(s) got a neighbour's image (${none} got none). `
    + `This source uses the ${BEST_FIRST ? 'best-first' : 'IN-ORDER'} matcher.`);
  check('and the unavoidable blank is reported, not disguised',
    none <= 1,
    `${none} step(s) unmatched; only the lagging step should be`);
}

// ── 9. mutation check: front-eviction must still be detectable ─────────────
{
  const OLD_CAP = 120;   // the historical cap, fixed on purpose: this models the
                         // OLD algorithm and must not track the current MAX_SHOTS
  const shots = [];
  for (let i = 1; i <= 145; i++) {
    shots.push(i);
    if (shots.length > OLD_CAP) shots.splice(0, shots.length - OLD_CAP);
  }
  // This is a property of the OLD algorithm, modelled here and independent of
  // which source file is under test: front-eviction keeps the LAST 120 and so
  // loses shot #1. It proves the §7 checks above are measuring something real.
  // 145 pushed against a cap of 120 leaves 26..145: the earliest 25 are gone.
  // That is the reported symptom in miniature — "the first ~25 screenshots are
  // missing" — and it is why the old policy could never be right for a proof.
  check('MUTATION CHECK — front-eviction loses the earliest 25 (keeps 26..145)',
    shots[0] === 26 && shots.length === OLD_CAP,
    `front-eviction model held ${shots[0]}..${shots[shots.length - 1]} (${shots.length}); `
    + 'if this stops holding, the eviction model is wrong and §7 proves nothing');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
