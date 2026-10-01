/**
 * echo-near-miss-visible.probe.mjs — a click that falls OUTSIDE the echo
 * retention window on the SAME element must still be logged, unconditionally.
 *
 * WHY THIS EXISTS
 * Before this, an expired retention entry was silently spliced away with no
 * trace (see the expiry branch in _actionInProgress's __sfRecentEcho scan).
 * Every conclusion about the window's correctness up to 2026-09-22 was drawn
 * from step-to-step TIMESTAMPS in saved scripts, never from the release-to-
 * echo interval the window actually measures. Two different clocks, treated
 * as one: see the 1984ms-duplicate vs 1995ms-genuine collision documented in
 * echo-window-covers-nav.probe.mjs, which was itself only findable because
 * this gap was closed and a real recording could finally report intervals.
 *
 * Without this log, the window is tuned blind. With it, every recording is a
 * source of real release-to-echo measurements.
 *
 * Run: node recorder/test/echo-near-miss-visible.probe.mjs
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

console.log('\necho-near-miss-visible.probe.mjs');
console.log('  an expired retention entry must be logged before it is discarded\n');

// ── decode the injected page script out of the bundle literal ──────────────
const MARK = "const source$2 = '";
const start = src.indexOf(MARK);
check('found the source$2 literal', start !== -1);
const litStart = start + MARK.length;
let j = litStart;
while (j < src.length) {
  if (src[j] === '\\') { j += 2; continue; }
  if (src[j] === "'") break;
  j++;
}
const decoded = eval("'" + src.slice(litStart, j) + "'");

// round-trip sanity: this file must still be the single-quoted literal shape
// every other probe in this suite assumes.
const reenc = (x) => x
  .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  .replace(/\n/g, '\\n').replace(/\r/g, '\\r');
check('the literal round-trips byte-identical (decode/encode sanity)',
  reenc(decoded) === src.slice(litStart, j),
  'if this fails, some other probe in the suite that decodes this literal is '
  + 'also reading corrupted content');

// ── the expiry branch exists and now does more than splice-and-continue ────
const expiryAt = decoded.indexOf('__sfEntry.until <= __sfNowG');
check('found the expiry check', expiryAt !== -1);
const expiryRegion = decoded.slice(expiryAt, expiryAt + 900);

check('THE FIX: a near-miss identity check runs before discarding the entry',
  /__sfNearMiss/.test(expiryRegion),
  'without this, an expired entry is spliced with no record of whether the '
  + 'event actually matched it — the window is tuned with zero real data');
check('the near-miss check uses the SAME identity test as the real drop '
  + '(target === el, or containment either direction)',
  /__sfEntry\.el\.contains/.test(expiryRegion) || /__sfEntry\.el && __sfEntry\.el\.contains/.test(expiryRegion),
  'a weaker or different match here would report intervals for the wrong '
  + 'population of clicks');
check('the log is NOT gated behind __SF_DEBUG',
  !/__SF_DEBUG === true\)\s*console\.log\("\[SyntraFlow:echo\] click on/.test(expiryRegion),
  '__SF_DEBUG ships off; a gated log here would never fire in the field, '
  + 'which is exactly the visibility gap this closes');
check('the log reports the interval since release',
  /__sfNowG - __sfEntry\.at/.test(expiryRegion));
check('the log reports the configured window, so a reader can see the margin',
  /__SF_ECHO_RETAIN_MS/.test(expiryRegion));
check('the log says the click WAS recorded (distinguishing it from a drop)',
  /RECORDED as a real step/.test(expiryRegion));
check('the entry is still removed either way (no behaviour change to retention itself)',
  /__sfRecent\.splice\(__sfJ, 1\);\s*continue;/.test(expiryRegion.replace(/\s+/g, ' ').length ? expiryRegion : expiryRegion),
  'the fix must be observability-only — it must not change which clicks are '
  + 'dropped, only what is reported about the ones that are not');

// ── mutation check ──────────────────────────────────────────────────────────
{
  const nearMissStart = expiryRegion.indexOf('var __sfNearMiss');
  check('located the near-miss block for mutation', nearMissStart !== -1);
  const ifStart = expiryRegion.indexOf('if (__sfNearMiss)', nearMissStart);
  let depth = 0, ifEnd = -1;
  for (let p = expiryRegion.indexOf('{', ifStart); p < expiryRegion.length; p++) {
    if (expiryRegion[p] === '{') depth++;
    else if (expiryRegion[p] === '}') { depth--; if (depth === 0) { ifEnd = p + 1; break; } }
  }
  const mutated = nearMissStart !== -1 && ifEnd !== -1
    ? expiryRegion.slice(0, nearMissStart) + expiryRegion.slice(ifEnd)
    : expiryRegion;
  check('mutation removed the near-miss log block', mutated !== expiryRegion);
  check('MUTATION CHECK: removing it is detected',
    !/RECORDED as a real step/.test(mutated),
    'the presence assertion above would not catch a regression');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
