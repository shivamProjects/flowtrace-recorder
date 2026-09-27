/**
 * shot-eviction-drops-oldest.probe.mjs — SUPERSEDED, 2026-09-21.
 *
 * This probe pinned the PRE-FIX behaviour (MAX_SHOTS=120, front-eviction). That
 * behaviour has since been diagnosed as the cause of the reported defect and
 * replaced. The live checks now live in:
 *
 *     recorder/test/shot-retention-keeps-oldest.probe.mjs
 *
 * which also carries the measurement that identified the cause (the proof PDF
 * has 72 images for a 99-step recording; 142 captured frames - 120 cap = 22
 * evicted; first surviving step 23) and the refutation of the two rival
 * hypotheses (chrome.storage eviction, MAX_QUEUE).
 *
 * Kept, not deleted, because its NOTE at §3 is the observation that unlocked
 * the diagnosis: "80 steps is BELOW the cap". The resolution is that the cap is
 * a FRAME budget, not a step budget, and frames arrive at ~1.434 per step -- so
 * loss actually begins at 120/1.434 = 83.7 steps, which is the user's reported
 * ~70-80 threshold. Comparing a step count against a frame budget is what made
 * the ring buffer look innocent.
 *
 * It is deliberately NOT run as part of the suite any more; running it against
 * the current source will fail at §2, which is correct and expected.
 *
 * --- original header follows ---
 *
 * shot-eviction-drops-oldest.probe.mjs — when a recording exceeds MAX_SHOTS,
 * WHICH screenshots are lost?
 *
 * THE REPORT (2026-09-20, proof PDF 904_proof_20260920_060936.pdf)
 * "the recording is passing 80+ steps, then the recorder is dropping the images
 * which were captured at the START of the recording -- starting 25+ screenshots
 * are missing."
 *
 * THE MECHANISM
 * `shots` is a ring buffer capped at MAX_SHOTS. On every capture:
 *
 *     const evicted = shots.length > MAX_SHOTS
 *       ? shots.splice(0, shots.length - MAX_SHOTS)   // <- splice(0, ...)
 *       : [];
 *
 * `splice(0, n)` removes from the FRONT, i.e. the OLDEST shots. So a long
 * recording keeps its most recent images and silently discards its earliest --
 * exactly the reported symptom, and the worst possible choice for a proof
 * document, where the opening steps establish context.
 *
 * NOT the cause (measured, do not re-test without new evidence):
 *   - chrome.storage.local quota. QUOTA_BYTES reports 10 MB, but the manifest
 *     declares "unlimitedStorage": 120 shot-sized records (250 KB each) all
 *     wrote successfully and storage grew to 29 MB with no failure.
 *   - persistShot() swallowing errors. It does swallow (catch -> log only),
 *     which is worth fixing separately, but it was not reached in that probe.
 *
 * WHAT THIS PROBE PINS
 * The eviction policy and the cap, against the real source, so that whatever
 * the fix turns out to be (raise the cap, evict the middle, downscale old
 * shots, spill to IndexedDB) this file has to be updated deliberately rather
 * than the behaviour changing by accident.
 *
 * Run: node recorder/test/shot-eviction-drops-oldest.probe.mjs
 */

import { readFileSync } from 'node:fs';

// Defaults to the CURRENT source, where §2 now fails by design (the defect it
// pins has been fixed). Pass a path to the pre-fix file to see it pass, e.g.
//   git -C D:/Freelance/FirstCron/syntra-recorder show \
//     HEAD:syntra-flow-recorder/lib/step-image-processing.js > /tmp/prefix.js
//   node recorder/test/shot-eviction-drops-oldest.probe.mjs /tmp/prefix.js
const SRC = process.argv[2]
  || 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/lib/step-image-processing.js';
const src = readFileSync(SRC, 'utf8');

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('\nshot-eviction-drops-oldest.probe.mjs\n');

// ── 1. the anchors still exist ─────────────────────────────────────────────
const capMatch = src.match(/const MAX_SHOTS = (\d+);/);
if (!capMatch) throw new Error('anchor moved: MAX_SHOTS declaration not found');
const MAX_SHOTS = Number(capMatch[1]);
console.log(`  (MAX_SHOTS = ${MAX_SHOTS})\n`);

const evictLine = src.match(/const evicted = shots\.length > MAX_SHOTS \? shots\.splice\(([^)]*)\) : \[\];/);
if (!evictLine) {
  console.log('  SUPERSEDED — the front-eviction line is gone from this source.');
  console.log('  That is the FIX, not a regression: see');
  console.log('    recorder/test/shot-retention-keeps-oldest.probe.mjs');
  console.log('  Pass the pre-fix file as argv[2] to run this probe as written.\n');
  process.exit(0);
}

// ── 2. the defect itself ───────────────────────────────────────────────────
check('eviction removes from the FRONT (drops the OLDEST shots)',
  /shots\.splice\(0, shots\.length - MAX_SHOTS\)/.test(src),
  'if this changed, the reported "first 25+ screenshots missing" may already be fixed — '
  + 'update this probe deliberately');

check('the cap is documented as a ring-buffer ceiling',
  /MAX_SHOTS = \d+;\s*\/\/.*ring buffer/i.test(src));

// ── 3. the reported recording exceeded the cap ─────────────────────────────
// 80+ steps is under 120, so the cap ALONE does not explain the report unless
// more shots than steps were captured. Record that tension rather than hide it.
check('NOTE: 80 steps is BELOW the cap — eviction alone does not explain it',
  MAX_SHOTS > 80,
  `MAX_SHOTS=${MAX_SHOTS}. Either more shots than steps were captured (re-renders, `
  + `retries, wrong-tab frames), or a second mechanism is also losing images. `
  + `See the persist/hydrate path.`);

// ── 4. the silent-failure paths that could compound it ─────────────────────
check('persistShot swallows write failures (logs only)',
  /catch \(e\) \{\s*log\('persist failed:'/.test(src),
  'a failed write leaves the shot in memory but not in storage; after an MV3 '
  + 'worker restart it is gone, with no error surfaced to the user');

check('hydrate swallows ALL errors silently',
  /\}\)\(\);/.test(src) && /catch \(_\) \{\}\s*\}\)\(\);/.test(src),
  'a partial restore looks identical to a full one');

check('a shot with no dataUrl is dropped on restore without counting it',
  /if \(s && s\.dataUrl\) shots\.push\(s\);/.test(src),
  'entries in the index that failed to persist vanish here silently — the '
  + '"restored N shot(s)" log reports the survivors, not the expected count');

// ── 5. matching can also lose an image that WAS captured ───────────────────
const windowMatch = src.match(/const MATCH_WINDOW_MS = (\d+);/);
const MATCH_WINDOW_MS = windowMatch ? Number(windowMatch[1]) : null;
check('attachImages only attaches within MATCH_WINDOW_MS of the step',
  MATCH_WINDOW_MS !== null && /bestDelta <= MATCH_WINDOW_MS/.test(src),
  `MATCH_WINDOW_MS=${MATCH_WINDOW_MS}. On ADF, a step whose replay ran long can `
  + `sit further than this from its shot, so a captured image is held but never attached.`);

check('each shot is consumed at most once',
  /used\.add\(best\)/.test(src) && /if \(used\.has\(i\)\) continue;/.test(src),
  'without this, consecutive steps would share one image');

// ── 6. behavioural model of the eviction ───────────────────────────────────
function ringPush(list, shot, cap) {
  list.push(shot);
  const evicted = list.length > cap ? list.splice(0, list.length - cap) : [];
  return evicted;
}
{
  const shots = [];
  const allEvicted = [];
  for (let i = 1; i <= 145; i++) allEvicted.push(...ringPush(shots, i, MAX_SHOTS));

  check('a 145-shot recording keeps the LAST MAX_SHOTS',
    shots.length === MAX_SHOTS && shots[0] === 145 - MAX_SHOTS + 1 && shots[shots.length - 1] === 145,
    `held ${shots[0]}..${shots[shots.length - 1]}`);
  check('and the evicted ones are the EARLIEST',
    allEvicted.length === 145 - MAX_SHOTS && allEvicted[0] === 1,
    `evicted ${allEvicted.length}: ${allEvicted.slice(0, 5).join(',')}...`);
}

// ── 7. mutation check: the probe must be able to fail ──────────────────────
{
  // If eviction took from the END instead, the oldest would survive.
  const shots = [];
  for (let i = 1; i <= 145; i++) {
    shots.push(i);
    if (shots.length > MAX_SHOTS) shots.splice(-(shots.length - MAX_SHOTS));
  }
  check('MUTATION CHECK — evicting from the END would keep shot #1',
    shots[0] === 1,
    'the probe cannot distinguish front-eviction from back-eviction');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
