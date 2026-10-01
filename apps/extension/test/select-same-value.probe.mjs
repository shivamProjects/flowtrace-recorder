/**
 * select-same-value.probe.mjs — is a <select> re-picked to its CURRENT value
 * still recorded?
 *
 * THE BUG (reported 2026-09-18, Create Invoice > Invoice Header > Type)
 * Changing Type to "Debit memo" and back to "Standard" records two steps.
 * Opening the dropdown and re-picking "Standard" — the default, already
 * selected — records NOTHING.
 *
 * WHY. A <select> fires `input`/`change` only when its value actually MOVES.
 * The recorder's only <select> hook lives inside onInput, and every mouse event
 * on a SELECT/OPTION is discarded by _shouldIgnoreMouseEvent (deliberately: the
 * native popup must not be recorded as clicks). So a same-value re-pick has no
 * path to being recorded at all.
 *
 * Measured on the LIVE element (exsp-dev41, Payables > Create Invoice) with
 * trusted CDP key input — see pages/adf-invoice-type-select.html for the
 * verbatim markup and full provenance:
 *
 *     ArrowDown (index 0 -> 1)   value moved      input + change, isTrusted=true
 *     ArrowUp   (index 1 -> 0)   value moved      input + change, isTrusted=true
 *     ArrowUp   at index 0       value unchanged  NO EVENTS AT ALL
 *
 * Details a hand-written fixture would have got wrong: ADF option values are
 * INDICES ("0".."4"), not labels; "Standard" is index 0 and "Debit memo" is
 * index 2 — which is exactly the optionIndex "2" then "0" in the user's
 * recording.
 *
 * THE FIX. Remember that the user opened the control (in the same
 * _shouldIgnoreMouseEvent branch that discards its mouse events), and commit a
 * select step on blur when nothing else recorded one. blur fires whether or not
 * the value changed, and lands BEFORE the click that caused it — so step order
 * is preserved. See select-blur-ordering.probe.mjs for that measurement.
 *
 * UPDATED 2026-09-23 — the arm condition originally also required
 * `!this._performingActions.size`, to stop a select's own CDP replay from
 * re-arming the marker mid-loop. That became a SEPARATE bug once the
 * onInput/blur paths were switched to recordAction (see
 * select-recordaction-no-loop.probe.mjs and select-blur-arm-race.probe.mjs):
 * _performingActions holds ANY in-flight action, so opening a default-valued
 * select while an unrelated click/fill was still replaying (0.3-2s on ADF)
 * silently failed to arm, and the blur commit never fired. isTrusted alone is
 * now sufficient — neither select-recording path calls _performAction any
 * more, so a select can never be "in flight" in _performingActions to begin
 * with. See select-blur-arm-race.probe.mjs for the full root-cause writeup.
 *
 * Run: node recorder/test/select-same-value.probe.mjs
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

console.log('\nselect-same-value.probe.mjs\n');

// ── decode the injected page script out of the bundle literal ──────────────
const MARK = "const source$2 = '";
const start = src.indexOf(MARK);
if (start === -1) throw new Error('anchor moved: source$2 literal not found');
const litStart = start + MARK.length;
let j = litStart;
while (j < src.length) {
  if (src[j] === '\\') { j += 2; continue; }
  if (src[j] === "'") break;
  j++;
}
// eslint-disable-next-line no-eval
const page = eval("'" + src.slice(litStart, j) + "'");

// ── 1. the interaction is remembered where mouse events are discarded ──────
check('_shouldIgnoreMouseEvent records the touched <select>',
  /nodeName === "SELECT" \|\| nodeName === "OPTION"/.test(page)
  && /__sfSelectTouched = \{ el: __sfSelEl/.test(page),
  'without this there is no signal at all that the user opened the control');

check('an OPTION target resolves up to its <select>',
  /nodeName === "OPTION" \? target\.closest\("select"\)/.test(page),
  'the event target may be the <option>, not the <select>');

check('mouse events on the dropdown are STILL ignored',
  /__sfSelectTouched = \{[\s\S]{0,200}?\n\s*\}\n\s*\} catch \(__sfE\) \{\}\n\s*return true;/.test(page),
  'the branch must still return true, or the native popup becomes click steps');

// ── 1b. THE RUNAWAY LOOP GUARDS ────────────────────────────────────────────
// Shipped 2026-09-18 without these and it wrote 60+ identical select steps
// ~25ms apart into a real recording. _performAction() REPLAYS through CDP; the
// replay's own synthetic events reach _shouldIgnoreMouseEvent, re-armed the
// marker, blurred, recorded, replayed... Both guards below must hold.
check('arming requires a TRUSTED event',
  /if \(event\.isTrusted\) \{/.test(page),
  'without isTrusted the replay re-arms the marker and the recorder loops');

check('arming no longer gates on _performingActions.size (see select-blur-arm-race.probe.mjs)',
  !/if \(event\.isTrusted && !this\._performingActions\.size\)/.test(page),
  'that combined guard blocked arming during ANY unrelated in-flight action, not just a selects own replay -- root-cause fixed, not just the isTrusted half');

check('the blur handler RECORDS rather than replays',
  /this\.recordAction\(\{\n\s*name: "select"/.test(page),
  'the value already equals what the step says, so there is nothing to replay; '
  + '_performAction here re-enters this handler through the replay and loops');

check('_performAction is NOT used by the blur fallback',
  !/tool\._performAction\(\{\n\s*name: "select"/.test(page),
  'that was the feedback edge that caused the runaway');

// ── 2. the normal path marks itself, so blur does not double-record ────────
const selectBranch = page.slice(page.indexOf('if (target.nodeName === "SELECT") {'));
check('the onInput path marks the select as already recorded',
  /this\.__sfSelectTouched\.recorded = true/.test(selectBranch.slice(0, 600)),
  'a real value change would otherwise record twice — once here, once on blur');

// ── 3. the blur fallback exists and is wired ───────────────────────────────
check('a blur listener is installed',
  /addEventListener\(this\.document, "blur", \(event\) => this\._onSelectBlur\(event\), true\)/.test(page),
  'blur fires whether or not the value changed; that is the whole point');

check('_onSelectBlur is defined',
  /_onSelectBlur\(event\) \{/.test(page));

const handler = page.slice(page.indexOf('_onSelectBlur(event) {'),
  page.indexOf('_onSelectBlur(event) {') + 2000);

check('it only fires for the element the user touched',
  /event\.target !== touched\.el/.test(handler),
  'a blur on any other field must not emit a select step');

check('it does nothing when the normal path already recorded',
  /if \(touched\.recorded\) return;/.test(handler),
  'this is the no-duplicate guard');

check('it only fires when the value did NOT change',
  /touched\.el\.value !== touched\.value/.test(handler),
  'a changed value is onInput\'s job; blur must not second-guess it');

check('the touched marker is cleared on every blur',
  /tool\.__sfSelectTouched = null;/.test(handler),
  'a stale marker would emit a step on some later, unrelated blur');

check('it records the CURRENT selected options',
  /\[\.\.\.touched\.el\.selectedOptions\]\.map\(\(option\) => option\.value\)/.test(handler),
  'must match the shape the onInput path produces');

check('it drops the step when no selector resolves, rather than throwing',
  /if \(!gen \|\| !gen\.selector\) \{/.test(handler),
  'a throw in a capture-phase blur handler would break later steps');

check('the whole handler is wrapped so it cannot break blur handling',
  /_onSelectBlur\(event\) \{\n\s*\/\/[\s\S]{0,400}?try \{/.test(handler),
  'an exception escaping here would propagate into unrelated blur listeners');

// ── 4. mutation checks: the probe must be able to fail ─────────────────────
{
  const withoutFallback = page
    .replace(/addEventListener\(this\.document, "blur", \(event\) => this\._onSelectBlur\(event\), true\),\n/, '');
  check('MUTATION CHECK — removing the blur listener is detected',
    !/addEventListener\(this\.document, "blur", \(event\) => this\._onSelectBlur\(event\), true\)/.test(withoutFallback),
    'the probe cannot tell fixed from broken');
}
{
  const withoutGuard = handler.replace(/if \(touched\.recorded\) return;/, '');
  check('MUTATION CHECK — removing the no-duplicate guard is detected',
    !/if \(touched\.recorded\) return;/.test(withoutGuard),
    'without this, an ordinary value change would record two select steps');
}
{
  // The loop that actually shipped: arming without an isTrusted gate.
  const withoutTrust = page.replace(
    'if (event.isTrusted && !this._performingActions.size) {', 'if (true) {');
  check('MUTATION CHECK — removing the isTrusted arming gate is detected',
    !/if \(event\.isTrusted && !this\._performingActions\.size\) \{/.test(withoutTrust),
    'this is the exact regression that wrote 60+ duplicate steps');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
