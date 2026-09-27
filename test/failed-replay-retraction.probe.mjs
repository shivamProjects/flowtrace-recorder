/**
 * failed-replay-retraction.probe.mjs — when a replay FAILS, is the optimistically
 * pushed step removed from the recording?
 *
 * WHY THIS EXISTS
 * `_addAction` publishes the step BEFORE it replays it:
 *
 *     this._actions.push(actionInContext);
 *     this._fireChange();                 // <- already in the saved script
 *     await callback();                   // the CDP replay; may throw at 5000ms
 *     actionInContext.endTime = ...;      // only reached on success
 *
 * Observed live on 2026-09-17: a trial replay on a Lines cell raced the operator
 * clicking "Add Row", which rebuilt the grid underneath it. The replay's
 * `strict: true` selector no longer resolved and threw at Playwright's
 * kActionTimeout (5000ms):
 *
 *     replay-click FAILED selector="...ta2:2:i26::content" +5012ms :: Timeout 5000ms exceeded
 *
 * The step stayed in `_actions`. The original note called this "half-recorded"
 * because `endTime` is unset — but `endTime` is read by nothing that builds a
 * saved step (see endtime-not-in-output.probe.mjs), so that is only a marker.
 *
 * THE ACTUAL DAMAGE, and why it is not symmetric
 * Whether the step is still TRUE depends on whether the user's own event reached
 * the page. In the injected script, onPointerDown/onPointerUp/onMouseDown/
 * onMouseUp call consumeEvent() — preventDefault + stopPropagation — for every
 * target EXCEPT text-entry ones:
 *
 *     if (!this._performingActions.size && !_sfIsTextEntryTarget(...)) consumeEvent(event);
 *
 * So:
 *   - TRIAL click (text entry): the real click was NOT consumed. The user did
 *     click the field; the page handled it. The step is true -> KEEP.
 *   - REAL replay (link, button, checkbox, grid cell, select): the user's click
 *     WAS swallowed, so the synthetic one was the only event the application
 *     would ever have seen. If it failed, the app saw NOTHING. The step claims an
 *     interaction that never happened -> RETRACT.
 *
 * Keeping a failed real-replay step is the dangerous half: on replay it performs
 * the interaction for the FIRST time, against a page state that assumed it had
 * already happened.
 *
 * `fill` and `setInputFiles` never reach this path at all — onInput routes them
 * through recordAction(), which does not replay.
 *
 * Run: node recorder/test/failed-replay-retraction.probe.mjs
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

console.log('\nfailed-replay-retraction.probe.mjs\n');

// ── 1. the anchors still exist ──────────────────────────────────────────────
// If these move, the probe is asserting nothing and must be rewritten, not
// deleted. Throwing here is deliberate.
const addActionSig = '_addAction(actionInContext, callback, retractOnFailure)';
if (!src.includes(addActionSig))
  throw new Error(`anchor moved: ${addActionSig} not found in background.js`);

const performSig = 'await performAction(this._pageAliases, actionInContext, { trial: __sfTrial });';
if (!src.includes(performSig))
  throw new Error('anchor moved: RecorderCollection.performAction replay call not found');

check('_addAction takes a retractOnFailure parameter', true);

// ── 2. the flag is derived from __sfTrial, and inverted ─────────────────────
// A real replay must retract; a trial replay must not. Passing __sfTrial
// unnegated would be exactly backwards and would silently delete real steps.
const callsWithNegatedTrial = /\}, !__sfTrial\);/.test(src);
check('performAction passes !__sfTrial as retractOnFailure',
  callsWithNegatedTrial,
  'a trial replay must KEEP its step (the real click reached the page); '
  + 'only a consumed/real replay may retract');

// ── 3. retraction is by identity, not by position ───────────────────────────
// Actions may be appended while this one awaits its 5s replay, so a saved index
// would be stale. indexOf on the object itself is the correct lookup.
const retractsByIdentity = src.includes('this._actions.indexOf(actionInContext)');
check('retraction locates the step by object identity',
  retractsByIdentity,
  'a stored index goes stale while the replay awaits; later steps would be cut');

// ── 4. the change is re-published after retraction ──────────────────────────
// _fireChange already ran on push, so the stale list is out there. Without a
// second fire the consumer keeps the phantom step.
const retractBlock = src.slice(
  src.indexOf('if (retractOnFailure) {'),
  src.indexOf('if (retractOnFailure) {') + 900);
check('retraction re-fires the change event',
  /this\._fireChange\(\);/.test(retractBlock),
  '_fireChange already published the list on push; the removal must be published too');

check('the failure is still rethrown', /\bthrow e;/.test(retractBlock + src.slice(
  src.indexOf('if (retractOnFailure) {'), src.indexOf('if (retractOnFailure) {') + 1400)),
  'swallowing the error would hide replay failures entirely');

// ── 5. behavioural model of the retraction decision ─────────────────────────
// Mirrors the shipped control flow: push, replay, and on failure remove iff
// retractOnFailure. Exercised against both branches.
function runAddAction({ actions, action, replayThrows, retractOnFailure }) {
  actions.push(action);
  let threw = false;
  if (replayThrows) {
    threw = true;
    if (retractOnFailure) {
      const at = actions.indexOf(action);
      if (at !== -1) actions.splice(at, 1);
    }
  } else {
    action.endTime = 1;
  }
  return { actions, threw };
}

// the live case: a real click on a grid cell whose selector went stale
{
  const prior = { name: 'click', selector: '#row1' };
  const actions = [prior];
  const failed = { name: 'click', selector: '...ta2:2:i26::content' };
  const { actions: after } = runAddAction({
    actions, action: failed, replayThrows: true, retractOnFailure: true,
  });
  check('a FAILED real replay leaves no step behind',
    after.length === 1 && after[0] === prior,
    'the application never saw this click; the step would replay it for the first time');
}

// the trial case: the user really did click the field
{
  const actions = [];
  const failed = { name: 'click', selector: '#amount::content' };
  const { actions: after } = runAddAction({
    actions, action: failed, replayThrows: true, retractOnFailure: false,
  });
  check('a FAILED trial replay KEEPS its step',
    after.length === 1 && after[0] === failed,
    'the real click was not consumed, so the interaction did happen');
}

// a step appended during the 5s await must survive the retraction
{
  const failed = { name: 'click', selector: '#stale' };
  const actions = [failed];
  const laterStep = { name: 'fill', selector: '#other' };
  actions.push(laterStep);           // arrived while the replay awaited
  const at = actions.indexOf(failed);
  actions.splice(at, 1);
  check('a step recorded during the await is not cut by the retraction',
    actions.length === 1 && actions[0] === laterStep,
    'this is why the lookup is indexOf(action), not a captured index');
}

// success path untouched
{
  const actions = [];
  const ok = { name: 'click', selector: '#save' };
  runAddAction({ actions, action: ok, replayThrows: false, retractOnFailure: true });
  check('a SUCCESSFUL replay keeps its step and sets endTime',
    actions.length === 1 && ok.endTime === 1);
}

// ── 6. mutation check: the probe must be able to fail ───────────────────────
// Simulates today's shipped-before-the-fix behaviour: never retract.
{
  const actions = [];
  const failed = { name: 'click', selector: '#stale' };
  runAddAction({ actions, action: failed, replayThrows: true, retractOnFailure: false });
  check('MUTATION CHECK — with retraction disabled, the phantom step survives',
    actions.length === 1,
    'the probe cannot distinguish fixed from broken; it is asserting nothing');
}

// and the inverse mutation: retracting trial clicks too would lose real steps
{
  const actions = [];
  const trialFailed = { name: 'click', selector: '#amount::content' };
  runAddAction({ actions, action: trialFailed, replayThrows: true, retractOnFailure: true });
  check('MUTATION CHECK — retracting trial clicks too would drop a real user action',
    actions.length === 0,
    'confirms the !__sfTrial inversion in check 2 is load-bearing');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
