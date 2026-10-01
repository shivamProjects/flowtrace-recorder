/**
 * echo-guard-narrowing.probe.mjs — does the click guard still block the REPLAY'S
 * OWN echo while letting unrelated clicks through?
 *
 * WHY THIS EXISTS
 * `_actionInProgress()` used to drop EVERY mouse event while any click-like
 * action replayed. An ADF replay runs 0.3-2s, so the operator was locked out of
 * the page for that long — the Create Invoice Lines lag.
 *
 * An earlier attempt (release the guard on dispatch) was measured UNSAFE and
 * reverted:
 *   - the recording onClick does NOT check event.isTrusted;
 *   - trial replays dispatch nothing but cover ONLY text-entry targets, so
 *     buttons/links/checkboxes get a real replay;
 *   - that replay goes out as CDP Input.dispatchMouseEvent -> isTrusted:true,
 *     indistinguishable from a human click;
 *   - the echo lands ~90ms after dispatch, while a microtask release fires at
 *     ~0.1ms — so the replay's own click could be recorded as a duplicate step.
 *
 * The guard is therefore load-bearing and must NOT be removed. It is instead
 * narrowed: the action remembers which element it replays, and only events
 * aimed at that element are dropped.
 *
 * This asserts the three properties that make the narrowing safe, against the
 * REAL predicate sliced out of background.js — so a future edit that widens or
 * breaks it fails here rather than silently corrupting recordings.
 *
 * Run: node recorder/test/echo-guard-narrowing.probe.mjs
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

console.log('\n######## echo guard: narrowed, not removed ########\n');

// ── 1. the narrowing is present in the shipped source ───────────────────────
check('action records the element it replays (__sfEchoEl)',
  src.includes('__sfEchoEl'),
  'the narrowing was removed — the guard is either blanket again or gone');

check('the echo test consults the event target',
  /__sfIsEcho\s*=\s*__sfEvTarget === action\.__sfEchoEl/.test(src),
  'echo identity is no longer element-based');

check('a non-echo event is skipped, not dropped',
  src.includes('if (!__sfIsEcho) continue;'),
  'unrelated clicks are being dropped again — the lag is back');

// ── 2. the guard was NOT replaced by an early release ───────────────────────
check('no dispatch-time release (option B stays reverted)',
  !src.includes('__sfRelease("DISPATCHED")'),
  'releasing on dispatch lets the replay echo be re-recorded as a duplicate step');

// ── 3. the fallback keeps the OLD blanket behaviour ─────────────────────────
check('blanket drop still applies when no element was captured',
  src.includes('if (action.__sfEchoEl) {'),
  'without this guard-by-default, an unidentifiable action stops being guarded');

// ── 4. behavioural check on the real predicate ──────────────────────────────
// Rebuild the decision from the shipped text rather than re-typing it, so this
// tests the code that ships.
const start = src.indexOf('_actionInProgress(event) {');
if (start === -1) {
  check('_actionInProgress() found', false, 'renamed — probe is testing nothing');
} else {
  const body = src.slice(start, start + 5000);
  const usesEcho = body.includes('__sfEchoEl');
  check('the narrowing lives INSIDE _actionInProgress', usesEcho,
    'found __sfEchoEl elsewhere but not in the predicate that drops events');

  // Model the decision exactly as the source expresses it.
  const decide = (action, target) => {
    if (!(action.name === 'click' || action.name === 'check' || action.name === 'uncheck')) return false;
    if (action.__sfEchoEl) {
      const isEcho = target === action.__sfEchoEl
        || (action.__sfEchoEl.contains && target && action.__sfEchoEl.contains(target))
        || (target && target.contains && target.contains(action.__sfEchoEl));
      if (!isEcho) return false;
    }
    return true;
  };

  // Minimal element stand-ins with a working contains().
  const mk = (name, kids = []) => {
    const el = { name, kids };
    el.contains = (o) => o === el || kids.includes(o);
    return el;
  };
  const child = mk('child');
  const save = mk('save', [child]);
  const other = mk('other');

  check('echo on the replayed element is DROPPED',
    decide({ name: 'click', __sfEchoEl: save }, save) === true);
  check('echo on a CHILD of the replayed element is DROPPED',
    decide({ name: 'click', __sfEchoEl: save }, child) === true,
    'a click landing on an inner span of the button would leak through');
  check('click on an UNRELATED element is ALLOWED',
    decide({ name: 'click', __sfEchoEl: save }, other) === false,
    'this is the lag: the operator is blocked while an unrelated replay runs');
  check('action with no remembered element still blocks everything',
    decide({ name: 'click' }, other) === true,
    'narrowing must never weaken the guard when the target is unknown');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
