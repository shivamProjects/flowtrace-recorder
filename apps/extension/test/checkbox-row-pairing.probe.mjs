/**
 * checkbox-row-pairing.probe.mjs — can applyCheckboxState() tell two table rows
 * apart, or does it interchange their states?
 *
 * Exercises the REAL `applyCheckboxState` from the client's popup.js. That file
 * is a browser script, not a module, so the function is sliced out by name and
 * evaluated with only the helpers it calls — no reimplementation, and the slice
 * THROWS if the function cannot be found.
 *
 * The case that matters: Manage Asset Locations has one Enabled checkbox per
 * row, and every one of them is named "Enabled" (the name comes from the column
 * header, so it is identical by construction). Pairing on the name alone leaves
 * only document order to separate them, and any reorder, retry or skipped row
 * swaps one row's state onto another.
 *
 * Run:  node recorder/test/checkbox-row-pairing.probe.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const POPUP = resolve(
  'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/popup/popup.js',
);

const src = readFileSync(POPUP, 'utf8').split('\r\n').join('\n');

/** Slice a top-level `function NAME(` out of the file, brace-balanced. */
function sliceFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name}() not found in popup.js — the result would be meaningless`);
  let depth = 0, i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

const bundle = [
  sliceFn('normalizeLabel'),
  sliceFn('selectorIds'),
  sliceFn('checkboxWidgetKey'),
  sliceFn('applyCheckboxState'),
  'applyCheckboxState',
].join('\n');

// eslint-disable-next-line no-new-func
const applyCheckboxState = new Function(`${bundle}; return applyCheckboxState;`)();

const ROW = (n) =>
  `_FOpt1:_FOr1:0:_FONSr2:0:MAnt2:0:r2:0:dynamicRegion1:0:pt1:SrLoc1:0:AP2:findLocationQueryResultId:_ATp:table1:${n}:sbc1`;

/**
 * Two rows, OPPOSITE states. Row 0 was ticked, row 1 was unticked. If the pass
 * cannot tell them apart the states come back swapped — and a swap is invisible
 * downstream, which is why this is the case worth testing.
 */
function scenario(stepOrder) {
  const steps = stepOrder.map((n) => ({
    action: 'click',
    description: 'Click Enabled',
    locator: { selector: `[id="${ROW(n)}::Label0"]`, componentId: ROW(n), sourceTag: 'input' },
  }));
  const records = [
    { fieldId: `${ROW(0)}::content`, label: 'Enabled', columnName: 'Enabled', rowIndex: 0, checked: true },
    { fieldId: `${ROW(1)}::content`, label: 'Enabled', columnName: 'Enabled', rowIndex: 1, checked: false },
  ];
  applyCheckboxState(steps, records);
  return steps.map((s, i) => ({
    step: `row ${stepOrder[i]}`,
    checked: s.checked,
    value: s.value,
    description: s.description,
    rowIndex: s.rowIndex,
  }));
}

const EXPECTED = { 0: true, 1: false };
let failures = 0;

for (const order of [[0, 1], [1, 0]]) {
  console.log(`\n=== steps in order: row ${order[0]}, then row ${order[1]} ===`);
  const out = scenario(order);
  for (let i = 0; i < out.length; i++) {
    const want = EXPECTED[order[i]];
    const ok = out[i].checked === want && out[i].rowIndex === order[i];
    if (!ok) failures++;
    console.log(
      `  ${out[i].step}: checked=${out[i].checked} (want ${want})  ` +
      `value=${JSON.stringify(out[i].value)}  desc=${JSON.stringify(out[i].description)}` +
      `  ${ok ? 'ok' : '<-- WRONG ROW'}`,
    );
  }
}

// The original path must still work: an id-less option group paired by label.
console.log('\n=== regression: id-less option group, paired by label in order ===');
const optSteps = [
  { action: 'click', locator: { selector: 'internal:text="Remit to"i', text: 'Remit to' } },
  { action: 'click', locator: { selector: 'internal:text="Remit to"i', text: 'Remit to' } },
];
applyCheckboxState(optSteps, [
  { label: 'Remit to', checked: true },
  { label: 'Remit to', checked: false },
]);
const optOk = optSteps[0].checked === true && optSteps[1].checked === false;
if (!optOk) failures++;
console.log(`  tick then untick -> ${optSteps[0].checked}, ${optSteps[1].checked} ${optOk ? 'ok' : '<-- BROKEN'}`);

/**
 * Mutation check. A test that cannot fail proves nothing, so run the SAME
 * scenario against the pre-fix logic — address matching removed, label queue
 * only — and require it to get a row wrong. If it does not, this probe is not
 * discriminating and its green result is worthless.
 */
console.log('\n=== mutation check: address matching removed (pre-fix logic) ===');
// Disable ONLY the address lookup, leaving the label queue exactly as it was.
// An over-broad mutation removed the label branch too and matched nothing,
// which looks like "no swap" and would have reported a false green.
const mutatedSrc = bundle.replace(
  'rec = takeUnused(byWidget.get(widget));',
  'rec = null;',
);
if (mutatedSrc === bundle) {
  console.log('  could not remove the address branch — mutation check is inconclusive');
  failures++;
} else {
  // eslint-disable-next-line no-new-func
  const mutated = new Function(`${mutatedSrc}; return applyCheckboxState;`)();
  // The steps carry the column name here, which is the situation the address
  // matching exists for: once the checkbox IS named (column-header naming), both
  // rows answer to "Enabled" and the label queue has only document order left to
  // separate them. Without a name on the step the old pass simply skipped it —
  // no state stamped at all — so naming the control is what turns a silent
  // no-op into a silent SWAP, and why the address key had to land with it.
  const steps = [1, 0].map((n) => ({
    action: 'click',
    locator: { selector: `[id="${ROW(n)}::Label0"]`, componentId: ROW(n), text: 'Enabled' },
  }));
  const quiet = console.log;
  console.log = () => {};
  mutated(steps, [
    { fieldId: `${ROW(0)}::content`, label: 'Enabled', rowIndex: 0, checked: true },
    { fieldId: `${ROW(1)}::content`, label: 'Enabled', rowIndex: 1, checked: false },
  ]);
  console.log = quiet;
  // Steps are row 1 then row 0; the label queue hands them out in record order
  // (row 0's TRUE first), so row 1 wrongly gets true.
  const swapped = steps[0].checked === true && steps[1].checked === false;
  console.log(
    `  steps [row 1, row 0] -> checked=${steps[0].checked}, ${steps[1].checked}` +
    `  ${swapped ? '<-- SWAPPED, as expected without the fix' : 'no swap — probe is NOT discriminating'}`,
  );
  if (!swapped) failures++;
}

console.log(`\n${failures === 0 ? 'PASS — rows never interchanged, and the check discriminates' : failures + ' FAILURE(S)'}\n`);
process.exit(failures === 0 ? 0 : 1);
