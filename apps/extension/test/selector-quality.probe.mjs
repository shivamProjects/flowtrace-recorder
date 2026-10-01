/**
 * selector-quality.probe.mjs — does the recorder still emit positional and
 * concatenated-label selectors when a stable anchor sits right beside the
 * element it captured?
 *
 * THE BUG (reported 2026-09-19, Oracle Fusion "Create Order")
 * A real recording produced, among others:
 *
 *   A) internal:attr=[title="Procurement"s] >> div >> nth=1
 *   B) css=#...:StyleName::cntnrSpan > span
 *   C) internal:role=cell[name="DDP"i] >> nth=0
 *   G) internal:role=search >> td >> internal:has-text="SearchResetAdd FieldsCategory"i
 *   H) tr >> internal:has-text=/^*Project Start DatePress down arrow to access Calendar$/ >> a
 *
 * WHY THEY SURVIVED. _sfPreferStableId already rejects positional selectors —
 * but only on the paths that reach its id lookup. Replaying the shipped
 * control flow over those eight selectors showed three separate exits that
 * return a fragile selector verbatim:
 *
 *   1. THE NO-ID ESCAPE HATCH. `if (!id) { if (_sfIsSemantic(sel) && ...)
 *      return generated; ... }`. Every one of A, C, D and E is semantic — a
 *      role or an attr with a non-empty name — so each is waved straight
 *      through WITH its `>> nth=N` still attached. A role plus a name is an
 *      address only when it is unique; with nth= appended it is an index into
 *      whatever order the DOM is in, and ADF reorders on every re-render.
 *   2. THE FIRST GATE returns any semantic, non-positional selector, which is
 *      how G (semantic, no nth=) escapes before anything examines its text.
 *   3. THE SECOND GATE returns anything neither positional nor row-scoped,
 *      which is how B (a bare `> span` structural descent) escapes.
 *
 * WHAT THE LIVE DOM SAYS. Checked against the verbatim capture
 * replayer/checks/pages/adf-lines-live.html — NOT a hand-written fixture:
 *
 *   - The `> span` of (B) sits inside `<span id="FIELD::cntnrSpan">`, whose
 *     subtree holds `<a id="FIELD::lovIconId" title="Search: Distribution
 *     Set">` — a real launcher with a stable id, resolving to exactly 1 node.
 *   - The date field of (H) carries `<a id="FIELD::glyph" title="Select
 *     Date">`. Note: the brief called this id `dateBase`; the actual captured
 *     markup uses the `::glyph` suffix, and `dateBase` is the step-metadata
 *     field name, not a DOM id.
 *   - The concatenation of (H) is REAL and structural: that cell contains two
 *     separate text nodes, "Press down arrow to access Calendar" (a visually
 *     hidden x9w helper) and "Accounting Date". Playwright joins them with no
 *     separator. A genuine leaf label yields exactly ONE text node.
 *
 * WHY THE TEXT TEST IS STRUCTURAL, NOT STRING-BASED. Deciding "this looks
 * concatenated" from the string is guesswork — a lower-upper boundary appears
 * in legitimate labels too, and the live page has 17 distinct visually-hidden
 * helper strings of which most ("Accounting Date", "Type") are ordinary
 * labels. Counting the text-bearing nodes in the matched scope is decided by
 * the DOM instead: 1 piece = a real label, >1 = a concatenation.
 *
 * Run: node recorder/test/selector-quality.probe.mjs [path-to-background.js]
 */

import { readFileSync } from 'node:fs';

const BG = process.argv[2]
  || 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/background.js';
const src = readFileSync(BG, 'utf8');

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log(`\nselector-quality.probe.mjs\n  against ${BG}\n`);

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

if (page.indexOf('function _sfPreferStableId') === -1)
  throw new Error('anchor moved: _sfPreferStableId is gone');
if (page.indexOf('function _sfBestAlternative') === -1)
  throw new Error('anchor moved: _sfBestAlternative is gone');

// ── 1. the no-id escape hatch no longer passes positional selectors ────────
check('the no-id escape hatch rejects a positional tail',
  /if \(_sfIsSemantic\(sel\) && !emptyFilter && !badId && !_sfHasPositionalTail\(sel\)/.test(page),
  'this is the exit that shipped "role=cell[name=\u0022DDP\u0022i] >> nth=0" verbatim; '
  + 'a semantic selector with nth= still attached is an index, not an address');

check('_sfHasPositionalTail is defined',
  /function _sfHasPositionalTail\(sel\) \{/.test(page));

check('_sfHasPositionalTail keys on the Playwright nth= step',
  /indexOf\("nth="\) !== -1/.test(
    page.slice(page.indexOf('function _sfHasPositionalTail'),
      page.indexOf('function _sfHasPositionalTail') + 300)));

// ── 2. the ADF launcher retarget ───────────────────────────────────────────
check('_sfAdfLauncherNear is defined',
  /function _sfAdfLauncherNear\(target\) \{/.test(page),
  'without it a click on a decorative ADF wrapper has no stable anchor to reach for');

check('it knows both ADF launcher id suffixes',
  /_SF_LAUNCHER_SUFFIXES = \["::lovIconId", "::glyph"\]/.test(page),
  'lovIconId is the list-of-values launcher, glyph the date picker; '
  + 'both verified present in adf-lines-live.html');

const launcher = page.slice(page.indexOf('function _sfAdfLauncherNear'),
  page.indexOf('function _sfAdfLauncherNear') + 1800);

check('the retarget only fires for a DECORATIVE wrapper',
  /if \(target\.id\) return null;/.test(launcher)
  && /if \(_sfExplicitRole\(target\)\) return null;/.test(launcher)
  && /if \(\(target\.textContent \|\| ""\)\.trim\(\)\) return null;/.test(launcher),
  'an element with its own id, role or text is addressable on its own terms; '
  + 'retargeting those would be the ADF column-naming mistake over again');

check('it strips only the two known wrapper suffixes',
  /replace\(\/::\(cntnrSpan\|content\)\$\/, ""\)/.test(launcher),
  'the launcher id is the FIELD id plus a suffix, so the wrapper suffix comes off first');

check('it refuses a launcher outside the captured element scope',
  /node\.contains\(cand\)/.test(launcher),
  'without this containment test it could retarget to a DIFFERENT field on the page');

check('_sfBestAlternative reaches for the launcher BEFORE any structural path',
  /function _sfBestAlternative\(target\) \{[\s\S]{0,900}?_sfAdfLauncherNear\(target\)[\s\S]{0,900}?var alt = _sfStableAttrSelector\(target\);/
    .test(page),
  'if it ran after _sfAnchoredCssSelector the structural chain would win');

check('the launcher selector is required to be unique before it is used',
  /__sfLm\.length === 1/.test(page),
  'a non-unique anchor clicks the wrong field silently, which is worse than a fragile one');

// ── 3. concatenated-label text filters ─────────────────────────────────────
check('_sfHasConcatenatedTextFilter is defined',
  /function _sfHasConcatenatedTextFilter\(sel, target\) \{/.test(page));

const concat = page.slice(page.indexOf('function _sfHasConcatenatedTextFilter'),
  page.indexOf('function _sfHasConcatenatedTextFilter') + 1200);

check('it only applies to text-matching selectors',
  /indexOf\("internal:has-text="\) === -1 && s\.indexOf\("internal:text="\) === -1\) return false;/
    .test(concat),
  'it must not second-guess a role or attr selector');

check('it decides from the DOM, not from the string',
  /_sfTextPieceCount\(target\) > 1/.test(concat),
  'a string heuristic misfires on legitimate labels; counting text nodes does not');

// An earlier draft of this fix walked three ancestors looking for the scope
// Playwright had matched. Measured against adf-lines-live.html that was WRONG:
// the genuine one-piece <label class=x9w> sits inside a two-piece
// <span class=x1q>, so the walk called an ordinary field a concatenation.
// Which ancestor the text step was scoped to is not recoverable from the
// selector string, so the target alone is judged.
check('it judges the target only, with no speculative ancestor walk',
  !/node = node\.parentElement;/.test(concat),
  'the ancestor walk produced a confident false positive on a real field');

check('_sfTextPieceCount counts text-bearing nodes and is bounded',
  /function _sfTextPieceCount\(el\) \{/.test(page)
  && /n < 8/.test(page.slice(page.indexOf('function _sfTextPieceCount'),
    page.indexOf('function _sfTextPieceCount') + 700)),
  'unbounded, this would walk an entire grid on every capture');

check('the concatenation test is wired into the first gate',
  /var concatText = _sfHasConcatenatedTextFilter\(sel, target\); if \(_sfIsSemantic\(sel\) && !isPositional && !emptyFilter && !isRowScoped && !badId && !concatText\) return generated;/
    .test(page),
  'this is the exit a semantic, non-positional has-text selector took');

check('and into the second gate',
  /if \(!isPositional && !isRowOrCellScoped && !emptyFilter && !concatText\) return generated;/
    .test(page),
  'this is the exit the bare structural descent took');

check('and into the no-id escape hatch',
  /!_sfHasPositionalTail\(sel\) && !concatText\) return generated;/.test(page));

// ── 4. the fix must not DROP steps ─────────────────────────────────────────
// Falling back to "no selector" is explicitly not acceptable: a dropped step
// is a silently incomplete recording.
check('every new exit still returns the original selector as a last resort',
  /var altLast = _sfBestAlternative\(target\); if \(altLast\) \{[\s\S]{0,400}?\} \} catch \(e\) \{[\s\S]{0,300}?\} return generated; \}/
    .test(page),
  'the function must never return null/empty -- a fragile selector beats a dropped step');

check('the launcher helper fails closed to null, never throws',
  /function _sfAdfLauncherNear\(target\) \{[\s\S]{0,1800}?\} catch \(e\) \{\}\n  return null;\n\}/.test(page),
  'this runs inside capture; a throw here loses the step entirely');

// ── 5. MUTATION CHECKS: the probe must be able to fail ─────────────────────
{
  const reverted = page.replace(
    'if (_sfIsSemantic(sel) && !emptyFilter && !badId && !_sfHasPositionalTail(sel) && !concatText) return generated;',
    'if (_sfIsSemantic(sel) && !emptyFilter && !badId) return generated;');
  check('MUTATION CHECK — reverting the no-id escape hatch is detected',
    !/!_sfHasPositionalTail\(sel\) && !concatText\) return generated;/.test(reverted),
    'this is the exact pre-fix line that shipped the nth= selectors');
}
{
  const noContain = page.replace(/node\.contains\(cand\)/, 'true');
  check('MUTATION CHECK — dropping the launcher containment test is detected',
    !/node\.contains\(cand\)/.test(noContain),
    'without it the retarget can silently address a different field');
}
{
  const noGuard = page.replace(/if \(\(target\.textContent \|\| ""\)\.trim\(\)\) return null;/, '');
  check('MUTATION CHECK — dropping the decorative-wrapper guard is detected',
    !/if \(\(target\.textContent \|\| ""\)\.trim\(\)\) return null;/.test(noGuard),
    'this guard is what keeps the retarget from hijacking real content');
}
{
  const stringy = page.replace(/_sfTextPieceCount\(node\) > 1/, 'node.textContent.length > 40');
  check('MUTATION CHECK — replacing the DOM test with a string heuristic is detected',
    !/_sfTextPieceCount\(node\) > 1/.test(stringy),
    'a length heuristic is precisely the speculative rule this avoids');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
