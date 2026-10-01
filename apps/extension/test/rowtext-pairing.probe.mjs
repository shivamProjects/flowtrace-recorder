/**
 * stampClickRowText — does it pair row records to row-cell steps correctly,
 * and does it REFUSE when the counts disagree?
 *
 * Slices the real function out of popup.js rather than reimplementing it: the
 * pairing rule is what is under test, so a copy would prove nothing.
 */
import { readFileSync } from 'node:fs';

const POPUP = 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/popup/popup.js';
const src = readFileSync(POPUP, 'utf8');

function sliceFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name}() not found in popup.js — the result would be meaningless`);
  // Walk braces to the end of the function.
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i + 1); }
  }
  throw new Error(`${name}() is unbalanced`);
}

const stampClickRowText = new Function(
  'console',
  `${sliceFn('stampClickRowText')}; return stampClickRowText;`,
)({ log: () => {} });

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
};

console.log('\n######## stampClickRowText ########\n');

// 1 — the ordinary case: one row click, one row record.
{
  const steps = [
    { action: 'fill', locator: { selector: 'internal:role=textbox[name="Invoice Number"i]' } },
    { action: 'click', locator: { selector: '.xwn' } },
    { action: 'click', locator: { selector: 'internal:role=button[name="Pay in Full"i]' } },
  ];
  const records = [
    { label: 'Search', role: 'button' },
    { label: 'test_pare_012', role: 'cell', rowText: 'test_pare_012 9/10/26 Advanced Corp', rowKey: '2' },
  ];
  const n = stampClickRowText(steps, records);
  check('stamps the row-cell step', [n, steps[1].locator.rowText, steps[1].locator.rowKey],
    [1, 'test_pare_012 9/10/26 Advanced Corp', '2']);
  check('leaves the button step alone', steps[2].locator.rowText, undefined);
  check('leaves the fill step alone', steps[0].locator.rowText, undefined);
}

// 2 — THE SAFETY RULE: counts disagree, so nothing is stamped. A misaligned
//     rowText would aim the replayer at the wrong row.
{
  const steps = [
    { action: 'click', locator: { selector: '.xwn' } },
    { action: 'click', locator: { selector: '.xwn' } },
  ];
  const records = [
    { label: 'test_pare_012', role: 'cell', rowText: 'test_pare_012 …', rowKey: '2' },
  ];
  const n = stampClickRowText(steps, records);
  check('refuses to guess when 2 steps but 1 record',
    [n, steps[0].locator.rowText, steps[1].locator.rowText], [0, undefined, undefined]);
}

// 3 — two of each, paired in order.
{
  const steps = [
    { action: 'click', locator: { selector: '.xwn' } },
    { action: 'click', locator: { selector: 'internal:role=button[name="Search"i]' } },
    { action: 'click', locator: { selector: '.xwn' } },
  ];
  const records = [
    { rowText: 'row A', rowKey: '0' },
    { rowText: 'row B', rowKey: '5' },
  ];
  const n = stampClickRowText(steps, records);
  check('pairs two row clicks in order',
    [n, steps[0].locator.rowText, steps[2].locator.rowText], [2, 'row A', 'row B']);
}

// 4 — no row records at all: a no-op, not a crash.
{
  const steps = [{ action: 'click', locator: { selector: '.xwn' } }];
  check('no row records -> no-op', stampClickRowText(steps, [{ label: 'x', role: 'button' }]), 0);
}

// 5 — an already-stamped step is not overwritten.
{
  const steps = [{ action: 'click', locator: { selector: '.xwn', rowText: 'already' } }];
  const n = stampClickRowText(steps, [{ rowText: 'new', rowKey: '1' }]);
  check('does not overwrite an existing rowText', [n, steps[0].locator.rowText], [0, 'already']);
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
