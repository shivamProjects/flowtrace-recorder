/**
 * Drive the SHIPPED date-pairing code with a sequence captured from the LIVE
 * dev29 Create Journal form.
 *
 * Captured 2026-09-22 by driving the real calendar through Playwright:
 *
 *   day cell   <td role="gridcell"> text "18", NO id, NO componentId
 *              ancestors: …DefaultEffectiveDate1::pop::cd::cg
 *                         …DefaultEffectiveDate1::pop::cd::date
 *   value      9/15/26 -> 9/18/26
 *   poll       140ms, first try
 *   then       Category launcher …sis3:userJeCategoryNameInputSearch1::btn
 *
 * The live capture's own gap to the Category click was 10,608ms, which is too
 * wide to reproduce anything: the old code paired correctly at that spacing
 * too. CATEGORY_AT is therefore set to the 1,657ms the REAL corrupted recording
 * had — the live DOM supplies the locators and the poll latency, the recording
 * supplies the timing that actually breaks.
 *
 * Run the real looksLikeDayCell + the real pairing loops over it and see which
 * step each pass chooses, with and without the guard.
 */
import { readFileSync } from 'node:fs';

const POPUP = 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/popup/popup.js';
const src = readFileSync(POPUP, 'utf8');

// ── slice the shipped helper and constants ────────────────────────────────
const s = src.indexOf('function looksLikeDayCell(loc) {');
let d = 0, e = -1;
for (let p = src.indexOf('{', s); p < src.length; p++) {
  if (src[p] === '{') d++;
  else if (src[p] === '}') { d--; if (!d) { e = p + 1; break; } }
}
const looksLikeDayCell = new Function(`${src.slice(s, e)}; return looksLikeDayCell;`)();
const SLACK = Number(src.match(/const GENERIC_DATE_SLACK_MS = (\d+);/)[1]);
const ORACLE_GAP = Number(src.match(/const ORACLE_DATE_FALLBACK_GAP_MS = (\d+);/)[1]);
const GENERIC_GAP = Number(src.match(/const GENERIC_DATE_MAX_GAP_MS = (\d+);/)[1]);

// ── the LIVE-captured sequence ────────────────────────────────────────────
const DAY_CLICK_AT = 1790057023255;
const REC_AT       = 1790057023395;   // +140ms, measured
const CATEGORY_AT  = 1790057023255 + 1657;   // user recording spacing

// Locators exactly as the recorder emits them for these elements.
const steps = [
  { ts: DAY_CLICK_AT - 2000, id: 'launcher',
    locator: { selector: 'tr >> internal:has-text=/^\\*Accounting Date.*$/ >> a' } },
  { ts: DAY_CLICK_AT, id: 'daycell',
    locator: { role: 'gridcell', name: '18', selector: 'internal:role=gridcell[name="18"i]' } },
  { ts: CATEGORY_AT, id: 'category',
    locator: { name: 'Category', containerRole: 'combobox',
      selector: 'internal:role=combobox[name="Category"i] >> a',
      componentId: 'pt1:_FOr1:1:_FONSr2:0:MAnt2:1:pt1:ap1:sis3:userJeCategoryNameInputSearch1::cntnr' } },
];

const popupBase = 'pt1:_FOr1:1:_FONSr2:0:MAnt2:1:pt1:ap1:DefaultEffectiveDate1';
const under = popupBase + '::pop';

// ── the Oracle pass, as shipped ───────────────────────────────────────────
function oraclePass(at, { guard = true } = {}) {
  let day = null, dayTs = -1, dayByAddress = false;
  for (const step of steps) {
    const loc = step.locator || {};
    const ts = step.ts;
    const byAddress = String(loc.componentId || loc.domId || '').indexOf(under) !== -1;
    const byTime = Boolean(at && ts && ts <= at + SLACK && at - ts <= ORACLE_GAP
      && (!guard || looksLikeDayCell(loc)));
    if (!byAddress && !byTime) continue;
    if (byAddress && !dayByAddress) { day = step; dayTs = ts; dayByAddress = true; continue; }
    if (dayByAddress && !byAddress) continue;
    if (ts >= dayTs) { day = step; dayTs = ts; }
  }
  return day && day.id;
}

// ── the generic pass, as shipped ──────────────────────────────────────────
function genericPass(at, { guard = true } = {}) {
  let day = null;
  for (const step of steps) {
    const ts = step.ts;
    if (!ts || ts > at + SLACK) continue;
    if (at - ts > GENERIC_GAP) continue;
    if (guard && !looksLikeDayCell(step.locator)) continue;
    day = step;
  }
  return day && day.id;
}

console.log('\nLIVE dev29 sequence -> shipped pairing code');
console.log(`  slack=${SLACK}  oracleGap=${ORACLE_GAP}  genericGap=${GENERIC_GAP}`);
console.log(`  day click -> Category click: ${CATEGORY_AT - DAY_CLICK_AT}ms`);
console.log(`  measured poll latency      : ${REC_AT - DAY_CLICK_AT}ms\n`);

console.log('  shape guard on the captured locators:');
for (const st of steps) {
  console.log(`    ${st.id.padEnd(9)} looksLikeDayCell = ${looksLikeDayCell(st.locator)}`);
}

let bad = 0;
const assert = (label, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${got}`);
};

console.log('\n  WITH the fix (as shipped):');
assert('oracle pass @ measured rec.at ', oraclePass(REC_AT), 'daycell');
assert('generic pass @ measured rec.at', genericPass(REC_AT), 'daycell');
// The Oracle pass allows a ~4s poll; every lag must still choose the day cell.
for (const lag of [500, 1500, 2500, 4000]) {
  assert(`oracle pass @ +${String(lag).padStart(4)}ms lag   `, oraclePass(DAY_CLICK_AT + lag), 'daycell');
}

// Without the guard the corruption must come BACK, or this harness is not
// testing what it claims and the guard is not what fixes the defect.
console.log('\n  WITHOUT the shape guard (what shipped before):');
assert('oracle  @ +2500ms reproduces the bug', oraclePass(DAY_CLICK_AT + 2500, { guard: false }), 'category');
assert('oracle  @ +4000ms reproduces the bug', oraclePass(DAY_CLICK_AT + 4000, { guard: false }), 'category');
assert('generic @ +4000ms reproduces the bug', genericPass(DAY_CLICK_AT + 4000, { guard: false }), 'category');

console.log(`\n${bad ? bad + ' FAILURE(S)' : 'ALL PASS — the live sequence pairs correctly'}\n`);
process.exit(bad ? 1 : 0);
