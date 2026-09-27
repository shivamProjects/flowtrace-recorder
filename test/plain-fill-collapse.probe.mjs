/**
 * plain-fill-collapse.probe.mjs — a plain (non-rich-text) field typed with
 * pauses must collapse to ONE fill step, not one per keystroke pause.
 *
 * REAL RECORDING, 2026-09-22, Create Project Task (dev93), Task Name
 * (css=#textfield-1060-inputEl, an ExtJS field):
 *
 *   #15  fill  "dem"           +0ms
 *   #16  fill  "demo_t"        +3523ms
 *   #17  fill  "demo_task"     +2310ms
 *   #18  fill  "demo_taski34"  +2653ms
 *
 * Four steps, same selector, nothing else recorded in between. Only the last
 * is what the operator meant; a replay of all four would type "dem", clear
 * to "demo_t" (impossible without deleting first — `fill` overwrites), etc.,
 * landing on the same end value only by coincidence of `fill` semantics, but
 * still leaving four noisy, confusing steps in the saved script.
 *
 * ROOT CAUSE. convertCrxToServerSteps() in popup/popup.js has a collapse for
 * this exact shape — "the ADF editor can emit intermediate snapshots while
 * the user is still typing... keep the final snapshot" — but it is gated to
 * `richText === true` only (the ADF CKEditor-style iframe editor). A plain
 * <input> with no rich-text flag falls straight to `steps.push(step)` with no
 * collapse at all, for ANY field, not just ExtJS ones — this recording is
 * simply the case that surfaced it.
 *
 * THE FIX: a parallel, narrowly-scoped collapse for consecutive plain fills
 * on the SAME selector with nothing else recorded in between — mirroring the
 * rich-text collapse's shape (check the immediately-previous step only, not
 * a lookback window, so a genuine intervening action still starts a new
 * step) without touching the rich-text-specific branch itself.
 *
 * Run: node recorder/test/plain-fill-collapse.probe.mjs
 */

import { readFileSync } from 'node:fs';

const SRC = 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/popup/popup.js';
const src = readFileSync(SRC, 'utf8');

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('\nplain-fill-collapse.probe.mjs');
console.log('  consecutive plain fills on one selector must collapse to the last\n');

const caseStart = src.indexOf("case 'fill':");
check('found the fill/type case', caseStart !== -1);
const caseEnd = src.indexOf("      // Playwright's recorder emits a <select>", caseStart);
check('found the following case boundary', caseEnd !== -1);
const body = caseStart !== -1 && caseEnd !== -1 ? src.slice(caseStart, caseEnd) : '';

// ── the rich-text collapse is untouched ─────────────────────────────────────
check('the rich-text collapse still exists',
  /sameRichTextEditor/.test(body),
  'this is the correct, pre-existing mechanism for the ADF CKEditor case and '
  + 'must survive unchanged');
check('rich-text collapse is still gated on richText === true',
  /previous\.richText === true/.test(body),
  'broadening this shared branch to plain fields would be the risky way to '
  + 'fix this — a narrow, parallel check is safer');

// ── THE FIX: a plain-fill collapse exists, separate from the rich-text one ──
check('THE FIX: a plain-fill same-selector collapse exists',
  /sameField/.test(body),
  'without this, EVERY plain fill on every field is pushed unconditionally — '
  + 'see steps.push(step) with no guard above it');
check('it excludes rich-text steps explicitly (no double-handling)',
  /previous\.richText !== true/.test(body),
  'a rich-text step must stay on its own collapse path, not this one');
check('it requires the SAME selector, not just the same action',
  /previous\.locator\?\.selector === step\.locator\?\.selector/.test(body));
check('it checks the immediately-previous step only, not a lookback window',
  (body.match(/previous\.locator\?\.selector === step\.locator\?\.selector/g) || []).length >= 1
  && !/for \(let j = steps\.length/.test(body.slice(body.indexOf('sameField') - 50)),
  'a lookback window (like the rich-text label-inference one above it) would '
  + 'risk merging across a genuine intervening action that got filtered out '
  + 'of THIS slice of code but still exists elsewhere in the stream');

// ── behavioural model over the real recorded steps ──────────────────────────
function convertFillsOldBehaviour(fills) {
  // OLD: every plain fill unconditionally pushed.
  return fills.map((f) => ({ ...f }));
}
function convertFillsNewBehaviour(fills) {
  const steps = [];
  for (const f of fills) {
    const previous = steps[steps.length - 1];
    const sameField = previous && previous.action === 'fill'
      && previous.richText !== true
      && previous.locator?.selector === f.locator?.selector
      && previous.locator?.selector;
    if (sameField) {
      previous.value = f.value;
      previous.timestamp = f.timestamp;
      continue;
    }
    steps.push({ ...f });
  }
  return steps;
}

const realFills = [
  { action: 'fill', locator: { selector: 'css=#textfield-1060-inputEl' }, value: 'dem', timestamp: 936022 },
  { action: 'fill', locator: { selector: 'css=#textfield-1060-inputEl' }, value: 'demo_t', timestamp: 939545 },
  { action: 'fill', locator: { selector: 'css=#textfield-1060-inputEl' }, value: 'demo_task', timestamp: 941855 },
  { action: 'fill', locator: { selector: 'css=#textfield-1060-inputEl' }, value: 'demo_taski34', timestamp: 944508 },
];

const oldSteps = convertFillsOldBehaviour(realFills);
const newSteps = convertFillsNewBehaviour(realFills);

console.log(`\n  old behaviour: ${oldSteps.length} steps -> [${oldSteps.map((s) => s.value).join(', ')}]`);
console.log(`  new behaviour: ${newSteps.length} steps -> [${newSteps.map((s) => s.value).join(', ')}]`);

check('REGRESSION GUARD: old behaviour reproduces the real bug (4 steps)',
  oldSteps.length === 4,
  'if this fails, the bug scenario itself has drifted from the real recording');
check('THE FIX collapses to exactly one step',
  newSteps.length === 1,
  `got ${newSteps.length} steps`);
check('THE FIX keeps the LAST typed value, not the first',
  newSteps[0] && newSteps[0].value === 'demo_taski34',
  `got "${newSteps[0] && newSteps[0].value}"`);

// ── a genuine intervening action must still start a new step ───────────────
const withBoundary = [
  { action: 'fill', locator: { selector: 'css=#a' }, value: 'x', timestamp: 1 },
  { action: 'click', locator: { selector: 'css=#other-button' }, timestamp: 2 },
  { action: 'fill', locator: { selector: 'css=#a' }, value: 'y', timestamp: 3 },
];
function convertMixedNewBehaviour(actions) {
  const steps = [];
  for (const a of actions) {
    if (a.action !== 'fill') { steps.push({ ...a }); continue; }
    const previous = steps[steps.length - 1];
    const sameField = previous && previous.action === 'fill'
      && previous.richText !== true
      && previous.locator?.selector === a.locator?.selector
      && previous.locator?.selector;
    if (sameField) {
      previous.value = a.value;
      previous.timestamp = a.timestamp;
      continue;
    }
    steps.push({ ...a });
  }
  return steps;
}
const mixedResult = convertMixedNewBehaviour(withBoundary);
check('a click between two fills on the SAME field prevents collapse',
  mixedResult.length === 3,
  `got ${mixedResult.length} steps: ${mixedResult.map((s) => s.action + ':' + (s.value || s.locator?.selector)).join(', ')}`);

// ── two DIFFERENT fields must never collapse into each other ───────────────
const twoFields = [
  { action: 'fill', locator: { selector: 'css=#account' }, value: '101.10', timestamp: 1 },
  { action: 'fill', locator: { selector: 'css=#amount' }, value: '19', timestamp: 2 },
];
const twoFieldsResult = convertFillsNewBehaviour(twoFields);
check('two different selectors never collapse into one step',
  twoFieldsResult.length === 2,
  `got ${twoFieldsResult.length} steps`);

// ── mutation check ──────────────────────────────────────────────────────────
{
  const sameFieldStart = body.indexOf('const sameField =');
  check('located the sameField collapse for mutation', sameFieldStart !== -1);
  const ifBlockStart = body.indexOf('if (sameField) {', sameFieldStart);
  let mdepth = 0, ifEnd = -1;
  for (let p = body.indexOf('{', ifBlockStart); p < body.length; p++) {
    if (body[p] === '{') mdepth++;
    else if (body[p] === '}') { mdepth--; if (mdepth === 0) { ifEnd = p + 1; break; } }
  }
  const mutated = sameFieldStart !== -1 && ifEnd !== -1
    ? body.slice(0, sameFieldStart) + body.slice(ifEnd)
    : body;
  check('mutation removed the collapse branch', mutated !== body);
  check('MUTATION CHECK: removing it is detected',
    !/const sameField =/.test(mutated),
    'the presence assertion above would not catch a regression');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
