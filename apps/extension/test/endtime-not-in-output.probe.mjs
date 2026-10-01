/**
 * endtime-not-in-output.probe.mjs — is `endTime` invisible to the saved script?
 *
 * WHY THIS EXISTS
 * Playwright's recorder replays every action through CDP before recording it,
 * blocking user input for 0.3-2s per action on ADF pages. That is the recording
 * lag on Create Invoice / Create Transaction Lines grids.
 *
 * The replay contributes exactly ONE field to the recorded action:
 *
 *     this._actions.push(actionInContext);   // the step, already saved
 *     await callback();                      // the CDP replay, 0.3-2s
 *     actionInContext.endTime = monotonicTime();   // <- the only addition
 *
 * So skipping or de-blocking the replay is output-neutral IF AND ONLY IF nothing
 * that builds a saved step reads `endTime`. This asserts that, against the real
 * source, so the claim cannot silently rot: if someone later starts consuming
 * `endTime`, this fails and the optimisation must be re-argued.
 *
 * Run: node recorder/test/endtime-not-in-output.probe.mjs
 */

import { readFileSync, existsSync } from 'node:fs';

const ROOT = 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder';

/**
 * The layer that turns recorded actions into the saved script. `background.js`
 * is deliberately NOT here: it contains bundled Playwright, which legitimately
 * uses endTime for tracing and call metadata. What matters is whether the
 * SyntraFlow step-building layer reads it.
 */
const STEP_BUILDING_LAYER = [
  'popup/popup.js',
  'content/oracle-patch.js',
  'content/id-capture.js',
  'handler/lov-handler.js',
];

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('\n######## endTime is invisible to the saved script ########\n');

// ── 1. No file in the step-building layer mentions endTime at all ────────────
for (const rel of STEP_BUILDING_LAYER) {
  const path = `${ROOT}/${rel}`;
  if (!existsSync(path)) {
    check(`${rel} exists`, false, 'file missing — the layer moved, so this probe is testing nothing');
    continue;
  }
  const src = readFileSync(path, 'utf8');
  const hits = [...src.matchAll(/endTime/g)].length;
  check(`${rel} does not read endTime`, hits === 0, `${hits} occurrence(s) found`);
}

// ── 2. In background.js, the ONLY writer on a recorded action is _addAction ──
const bg = readFileSync(`${ROOT}/background.js`, 'utf8');

// The trailing params are matched loosely: `retractOnFailure` was added by the
// failed-replay retraction fix (see failed-replay-retraction.probe.mjs) and more
// may follow. What this anchor must pin is that the entry point is still named
// _addAction and still takes (actionInContext, callback) in that order.
const addActionAt = bg.search(/async _addAction\(actionInContext, callback[^)]*\) \{/);
check('_addAction() found in background.js', addActionAt !== -1,
  'the recording entry point was renamed — re-verify by hand before trusting this probe');

if (addActionAt !== -1) {
  const body = bg.slice(addActionAt, addActionAt + 1200);
  const push = body.lastIndexOf('this._actions.push(actionInContext)');
  const awaitCb = body.indexOf('await (callback');
  const endT = body.indexOf('endTime = monotonicTime()');

  check('the step is pushed BEFORE the replay is awaited',
    push !== -1 && awaitCb !== -1 && push < awaitCb,
    `push@${push} awaitCallback@${awaitCb} — if this inverts, the replay DOES gate the recording`);

  check('endTime is set AFTER the replay, i.e. it is the replay\'s only contribution',
    endT !== -1 && awaitCb !== -1 && endT > awaitCb,
    `awaitCallback@${awaitCb} endTime@${endT}`);
}

// ── 3. The code generator does not read endTime ──────────────────────────────
const genAt = bg.indexOf('generateAction(actionInContext)');
check('generateAction() found', genAt !== -1,
  'code generator renamed — re-verify by hand');
if (genAt !== -1) {
  const gen = bg.slice(genAt, genAt + 1200);
  check('generateAction() does not read endTime', !/endTime/.test(gen));
}

// ── 4. Mutation check — this probe must be able to FAIL ─────────────────────
// A test that cannot fail proves nothing. Prove the §1 check is real by running
// it against a source that DOES read endTime.
{
  const poisoned = 'function build(a) { return { t: a.endTime }; }';
  const wouldCatch = [...poisoned.matchAll(/endTime/g)].length > 0;
  check('mutation: the endTime scan detects a reader when one exists', wouldCatch);
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
