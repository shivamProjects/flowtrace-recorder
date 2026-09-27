/**
 * date-stamp-pairing.probe.mjs — a picked date must land on its OWN day cell,
 * never on the next thing the operator clicked.
 *
 * WHY THIS EXISTS
 * A live Create Journal recording came back with the Accounting Date stamped
 * onto the Category dropdown:
 *
 *   ...703300  gridcell "."        <- the day cell (correct target)
 *   ...704957  combobox Category   <- got dateValue 9/22/26, kind "date",
 *                                     dateBase DefaultEffectiveDate1,
 *                                     label "Accounting Date",
 *                                     description "Select Accounting Date"
 *
 * Confirmed against the live dev29 form: Accounting Date
 * (DefaultEffectiveDate1::content, aria "Accounting Date", value 9/22/26) and
 * Category (sis3:userJeCategoryNameInputSearch1::content, aria "Category") are
 * two distinct elements 43px apart. So Accounting Date lost its parameter and
 * Category was mislabelled — one bug, both symptoms. The same recording shows
 * it twice: Conversion Date landed on an Account textbox.
 *
 * WHY TIME ALONE CANNOT FIX IT
 * Measured on the live calendar: the day <td> elements carry NO id, NO
 * componentId and NO distinguishing class, so the address join
 * ('<popupBase>::pop' in the step's componentId) can never match one — both the
 * day cell and the Category click fall through to the time fallback. And the
 * Oracle fallback window is 15s, far wider than the 1,657ms gap here, so
 * "latest wins" simply prefers whatever was clicked most recently.
 *
 * Also measured live: the value-poll saw the new date after 138ms (first try),
 * NOT the ~1.4s assumed. So tightening the forward slack alone does not fix
 * this recording — the shape guard is what does.
 *
 * Run: node recorder/test/date-stamp-pairing.probe.mjs
 */

import { readFileSync } from 'node:fs';

const POPUP = 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/popup/popup.js';

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('\ndate-stamp-pairing.probe.mjs');
console.log('  a picked date must not stamp the click after it\n');

const src = readFileSync(POPUP, 'utf8');

// ── slice the SHIPPED shape guard ──────────────────────────────────────────
const fnStart = src.indexOf('function looksLikeDayCell(loc) {');
check('looksLikeDayCell exists in the shipped source', fnStart !== -1);
let depth = 0, fnEnd = -1;
for (let p = src.indexOf('{', fnStart); p < src.length; p++) {
  if (src[p] === '{') depth++;
  else if (src[p] === '}') { depth--; if (depth === 0) { fnEnd = p + 1; break; } }
}
const looksLikeDayCell = new Function(`${src.slice(fnStart, fnEnd)}; return looksLikeDayCell;`)();

// ── the two locators, verbatim from the recording ──────────────────────────
const DAY_CELL = { role: 'gridcell', name: '.', selector: 'internal:role=gridcell[name="."i]' };
const CATEGORY = {
  name: 'Category',
  selector: 'internal:role=combobox[name="Category"i] >> a',
  containerRole: 'combobox',
  componentId: 'pt1:_FOr1:1:_FONSr2:0:MAnt2:1:pt1:ap1:sis3:userJeCategoryNameInputSearch1::cntnr',
};
// The second corruption in the same recording.
const ACCOUNT_BOX = { role: 'textbox', name: 'Account', selector: 'internal:role=textbox[name="Account"s]' };

check('THE FIX: a day cell is accepted', looksLikeDayCell(DAY_CELL) === true);
check('THE FIX: the Category combobox is REJECTED', looksLikeDayCell(CATEGORY) === false,
  'this is the step that wrongly carried the Accounting Date');
check('the Account textbox is REJECTED', looksLikeDayCell(ACCOUNT_BOX) === false,
  'the same recording stamped Conversion Date onto this');

// Real day cells carry a day number, and ADF sometimes renders untyped <td>.
check('a numbered day cell is accepted',
  looksLikeDayCell({ role: 'gridcell', name: '15', selector: 'internal:role=gridcell[name="15"i]' }));
check('an untyped cell click is still accepted (ADF renders plain <td>)',
  looksLikeDayCell({ selector: 'tr >> td' }),
  'rejecting these would silently stop stamping real dates');
check('other form controls are rejected',
  !looksLikeDayCell({ role: 'button', selector: 'internal:role=button[name="Save"i]' })
  && !looksLikeDayCell({ role: 'link', selector: 'internal:role=link[name="Post"i]' }));

// ── both passes must apply the guard ───────────────────────────────────────
const uses = (src.match(/looksLikeDayCell\(/g) || []).length;
check('both the Oracle and the generic pass call it', uses >= 3,
  `${uses} references — expected the definition plus both call sites`);

// ── an addressed match must outrank a timed one ────────────────────────────
check('an addressed match is never demoted by a later timed one',
  /byAddress && !dayByAddress/.test(src) && /dayByAddress && !byAddress/.test(src),
  'they used to compete on timestamp alone');

// ── behavioural model over the REAL timestamps ─────────────────────────────
const ORACLE_GAP = 15000;
const slackM = src.match(/const GENERIC_DATE_SLACK_MS = (\d+);/);
const SLACK = Number(slackM[1]);
check('forward slack is 0', SLACK === 0, `found ${SLACK}`);

const steps = [
  { ts: 1790054701277, loc: { selector: 'tr >> a' }, id: 'launcher' },
  { ts: 1790054703300, loc: DAY_CELL, id: 'daycell' },
  { ts: 1790054704957, loc: CATEGORY, id: 'category' },
];

function oraclePair(at, { guard = true, slack = SLACK } = {}) {
  let day = null, dayTs = -1;
  for (const s of steps) {
    const byTime = at && s.ts && s.ts <= at + slack && at - s.ts <= ORACLE_GAP
      && (!guard || looksLikeDayCell(s.loc));
    if (!byTime) continue;
    if (s.ts >= dayTs) { day = s; dayTs = s.ts; }
  }
  return day && day.id;
}

// The live-measured poll latency was 138ms, but the Oracle pass's own comment
// allows ~4s. Every lag must resolve to the day cell.
for (const lag of [138, 500, 1500, 1657, 2500, 4000]) {
  check(`poll lag ${lag}ms still stamps the day cell`,
    oraclePair(1790054703300 + lag) === 'daycell',
    `got ${oraclePair(1790054703300 + lag)}`);
}

// ── mutation check ─────────────────────────────────────────────────────────
{
  // Remove the shape guard and the corruption must come back at the lags that
  // exceed the gap to the next click.
  check('MUTATION CHECK: without the guard, the Category click wins again',
    oraclePair(1790054703300 + 2500, { guard: false }) === 'category',
    'if this still picks the day cell the guard is not what fixes it');
  // ...and the short lags were always fine, which is why it was intermittent.
  check('MUTATION CHECK: short lags were correct even unguarded (why it was intermittent)',
    oraclePair(1790054703300 + 138, { guard: false }) === 'daycell');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
