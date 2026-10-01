/**
 * date-stamp-lov-row.probe.mjs — an LOV autosuggest/picker ROW must never be
 * accepted as a calendar day cell, even though it renders with the same role.
 *
 * WHY THIS EXISTS
 * date-stamp-pairing.probe.mjs closed the gap for a combobox/textbox stealing
 * a date stamp. It did not close a second gap of the SAME shape: an LOV
 * dropdown ROW also renders as role="cell" (or "gridcell"), which
 * looksLikeDayCell() explicitly accepts — so a picker row satisfies every
 * check a real day cell does.
 *
 * A live Create Invoice recording (dev93, 2026-09-23) hit exactly this:
 *
 *   ...451574  click  Open Date Calendar (opener)
 *   ...451612  select Type = Standard (SAME-VALUE re-pick, deferred blur
 *                                       commit — see select-same-value.probe)
 *   ...451861  click  Open Date Calendar (2nd — the operator's click landed
 *                                       once, but the still-resolving Type
 *                                       blur meant the calendar did not open
 *                                       the first time, so they clicked again)
 *   ...454201  click  gridcell "22"    <- the REAL Invoice Date day cell
 *   ...455950  click  Search: Payment Terms (LOV opener)
 *   ...458496  click  cell "Immediate" <- a Payment Terms picker ROW, 4.3s
 *                                       after the real day cell, still inside
 *                                       the 15s Oracle fallback window
 *
 * The Payment Terms row's componentId
 * (…so3::dropdownPopup::dropDownContent::db) is a table cell, matched
 * `role: "cell"`, and arrived LATER than the real day cell — so "latest
 * wins" let it steal the Invoice Date's stamp. Invoice Date lost its
 * parameter; the Payment Terms pick was mislabelled "Date" with
 * dateBase pointing at the Date field, not Payment Terms.
 *
 * NOTE ON THE UPSTREAM CAUSE: the 249ms-apart double "Open Date Calendar"
 * click (steps above) is consistent with the SAME-VALUE Type re-pick's
 * deferred blur commit delaying focus release long enough that the
 * operator's first calendar-open click did not register, forcing a retry.
 * That is a plausible contributor to WHY a later click landed close enough
 * to compete for the stamp in the first place — worth checking against a
 * live trace, but this probe only asserts the shape-guard fix, which closes
 * the corruption regardless of what caused the timing.
 *
 * THE FIX: `::dropdownPopup` is already this file's own marker for an LOV
 * suggestion list (see POPUP_OWNER_SUFFIXES in oracle-patch.js). A calendar
 * popup is never nested under one, so rejecting it costs nothing on a real
 * day-cell click.
 *
 * Run: node recorder/test/date-stamp-lov-row.probe.mjs
 */

import { readFileSync } from 'node:fs';

const POPUP = 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/popup/popup.js';

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('\ndate-stamp-lov-row.probe.mjs');
console.log('  an LOV picker row must not be accepted as a calendar day cell\n');

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
const DAY_CELL = { role: 'gridcell', name: '22', selector: 'internal:role=gridcell[name="22"i]' };
const PAYMENT_TERMS_ROW = {
  role: 'cell',
  name: 'Immediate',
  selector: 'internal:role=cell[name="Immediate"i]',
  componentId: '_FOpt1:_FOr1:0:_FONSr2:0:MAnt2:1:pm1:r1:0:ap1:r2:0:so3::dropdownPopup::dropDownContent::db',
};

check('THE FIX: the real day cell is still accepted', looksLikeDayCell(DAY_CELL) === true);
check('THE FIX: the Payment Terms LOV row is REJECTED', looksLikeDayCell(PAYMENT_TERMS_ROW) === false,
  'this is the step that wrongly carried the Invoice Date stamp in the live recording');

// A row that happens to share the ::dropdownPopup marker via `selector`
// rather than `componentId` (some captures carry it there instead) must be
// caught the same way.
check('the marker is caught via selector too, not only componentId',
  looksLikeDayCell({ role: 'cell', selector: 'css=[id$="::dropdownPopup::dropDownContent::db"]' }) === false);

// A modal Search-and-Select LOV or SearchInputSelect widget renders as a
// DIFFERENT shape than the inline ::dropdownPopup suggestion list — reviewed
// and flagged by a second pass (antigravity-M1) after the first fix shipped.
// lovDialogId is independently confirmed live: it is the exact chrome the
// resourceNameId LOV rendered in the Create Project Task recording
// (_recorderDiagnostics idsUnderBase: "…lovDialogId::_hse", "…::tb", "…::close").
check('a modal Search-and-Select row (lovDialogId) is REJECTED',
  looksLikeDayCell({
    role: 'cell',
    selector: 'internal:role=cell[name="Row"i]',
    componentId: '_FOpt1:_FOr1:0:_FONSr2:0:MAnt2:1:r2:1:pt1:r1:0:AP1:resourceNameId::lovDialogId::tb',
  }) === false,
  'confirmed live in the resourceNameId LOV _recorderDiagnostics');
check('lovPopupId is REJECTED (already in POPUP_OWNER_SUFFIXES elsewhere in this codebase)',
  looksLikeDayCell({ role: 'gridcell', componentId: 'someField::lovPopupId::row3' }) === false);
check('_afrLovDialogId is REJECTED',
  looksLikeDayCell({ role: 'cell', selector: 'css=[id*="_afrLovDialogId"]' }) === false);
check('::sgstnCntnr (SearchInputSelect suggestion) is REJECTED',
  looksLikeDayCell({ role: 'cell', componentId: 'field::sgstnCntnr::row1' }) === false);

// Other genuine LOV shapes from this same codebase must be rejected too —
// not just the exact Payment Terms case.
check('a Business-Unit-style autosuggest row (role option, not cell) already rejected by role',
  looksLikeDayCell({ role: 'option', name: 'US1 Business Unit', selector: 'internal:role=option[name="US1 Business Unit"i]' }) === false);

// Real day cells must still work across the variety the existing probe covers.
check('a numbered day cell is accepted', looksLikeDayCell({ role: 'gridcell', name: '15', selector: 'internal:role=gridcell[name="15"i]' }));
check('an untyped cell click is still accepted (ADF renders plain <td>)',
  looksLikeDayCell({ selector: 'tr >> td' }),
  'rejecting these would silently stop stamping real dates');
check('a dot separator day cell (sparse calendar) is still accepted',
  looksLikeDayCell({ role: 'gridcell', name: '.', selector: 'internal:role=gridcell[name="."i]' }));

// ── behavioural model over the REAL recorded timestamps ────────────────────
const ORACLE_GAP = 15000;
const slackM = src.match(/const GENERIC_DATE_SLACK_MS = (\d+);/);
const SLACK = Number(slackM[1]);
check('forward slack is still 0 (unchanged by this fix)', SLACK === 0, `found ${SLACK}`);

const steps = [
  { ts: 1790142451574, loc: { selector: 'tr >> a' }, id: 'calendar-opener-1' },
  { ts: 1790142451861, loc: { selector: 'tr >> a' }, id: 'calendar-opener-2' },
  { ts: 1790142454201, loc: DAY_CELL, id: 'invoice-date-daycell' },
  // Verbatim from the recording: a popup-LAUNCHER icon, not a cell — carries
  // isPopupLauncher, exactly the marker date-stamp-pairing.probe.mjs and
  // oracle-patch.js already use to recognise one (see the `::popEl` /
  // isPopupLauncher check elsewhere in this file). looksLikeDayCell() does
  // NOT check isPopupLauncher today — it is untyped (no role) and slips
  // through the "ADF renders plain <td>" permissiveness meant for real day
  // cells. This step must never be picked as a day cell either.
  {
    ts: 1790142455950,
    loc: { title: 'Search: Payment Terms', selector: 'css=a[id$="so3::lovIconId"]', isPopupLauncher: true },
    id: 'payment-terms-opener',
  },
  { ts: 1790142458496, loc: PAYMENT_TERMS_ROW, id: 'payment-terms-row' },
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

// The real record's poll-completion time (`at`) is not in the pasted JSON,
// but it must land at or after the Payment Terms row's timestamp for the
// corruption to have happened at all (an Oracle byTime match requires
// ts <= at). Sweep a range covering that.
for (const at of [1790142458496, 1790142459000, 1790142460000, 1790142465000]) {
  check(`REGRESSION GUARD: with the fix, record polled at ${at} still stamps the real day cell`,
    oraclePair(at) === 'invoice-date-daycell',
    `got ${oraclePair(at)}`);
}

// ── mutation check ─────────────────────────────────────────────────────────
{
  check('MUTATION CHECK: without the ::dropdownPopup rejection, the LOV row wins',
    oraclePair(1790142460000, { guard: false }) === 'payment-terms-row',
    'if this still picks the day cell the guard is not what fixes it');
  check('MUTATION CHECK: at the row\'s own timestamp, unguarded still corrupts',
    oraclePair(1790142458496, { guard: false }) === 'payment-terms-row');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
