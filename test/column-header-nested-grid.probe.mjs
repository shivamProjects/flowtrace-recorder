/**
 * column-header-nested-grid.probe.mjs — columnHeaderLabelOf() must name a grid
 * field by ITS OWN column, on a grid that scrolls.
 *
 * WHY THIS EXISTS
 * The original resolver read a cell's column as `frozenCount + indexWithinRow`.
 * That holds only while a grid has ONE fragment. Once it scrolls, ADF emits the
 * scrollable columns as a second table nested inside the LAST cell of the frozen
 * row, so the index is relative to a fragment and the sum lands arbitrarily.
 *
 * Measured on the live dev79 Create Invoice Lines capture (23 leaf columns,
 * _lastfrozen=3): the old arithmetic named 93% of fields and named them WRONG —
 * Amount came back as "Prorate Across All Item Lines". A confidently wrong name
 * is worse than none: it yields a selector addressing a different field, and on
 * a Pay in Full flow that is a different invoice.
 *
 * This probe slices the SHIPPED function out of content/oracle-patch.js and runs
 * it against two verbatim captures:
 *   - adf-lines-live.html          scrolling, two fragments  (the regression)
 *   - adf-table-row-checkbox.html  single fragment           (must not change)
 *
 * Run: node recorder/test/column-header-nested-grid.probe.mjs
 */

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/content/oracle-patch.js';
const LINES = 'D:/WorkingProjects/flowtrace/replayer/checks/pages/adf-lines-live.html';
const CHECKBOX = 'D:/WorkingProjects/flowtrace/replayer/checks/pages/adf-table-row-checkbox.html';

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('\ncolumn-header-nested-grid.probe.mjs');
console.log('  shipped columnHeaderLabelOf vs two verbatim grid captures\n');

// ── slice the shipped function ─────────────────────────────────────────────
const src = readFileSync(SRC, 'utf8');
const start = src.indexOf('function columnHeaderLabelOf(el) {');
if (start === -1) throw new Error('anchor moved: columnHeaderLabelOf not found');
let depth = 0, end = -1;
for (let p = src.indexOf('{', start); p < src.length; p++) {
  if (src[p] === '{') depth++;
  else if (src[p] === '}') { depth--; if (depth === 0) { end = p + 1; break; } }
}
const fnSrc = src.slice(start, end);

check('sliced columnHeaderLabelOf from the shipped source', fnSrc.length > 400);
check('it collects an index PER TABLE LEVEL, not one flat index',
  /levels\.unshift\(/.test(fnSrc) && /levels\[1\]/.test(fnSrc),
  'a single cellIndex cannot describe a position in a nested grid');

function load(fnText, document) {
  return new Function('document', `${fnText}; return columnHeaderLabelOf;`)(document);
}

// ── fixture 1: the scrolling grid that regressed ───────────────────────────
{
  const dom = new JSDOM(readFileSync(LINES, 'utf8'));
  const d = dom.window.document;
  const columnHeaderLabelOf = load(fnSrc, d);

  const root = d.querySelector('[_leafcolclientids]');
  const leaf = ((root.getAttribute('_leafcolclientids') || '').match(/'([^']*)'/g) || []).map(s => s.slice(1, -1));

  check('fixture is the two-fragment shape this exists for',
    leaf.length === 23 && root.getAttribute('_lastfrozen') === '3',
    `leafCols=${leaf.length} lastFrozen=${root.getAttribute('_lastfrozen')}`);

  const byToken = (tok) => [...d.querySelectorAll('input,textarea,select')]
    .find(e => e.id.endsWith(`ta2:0:${tok}::content`));

  // Ground truth: these four fields' columns are unambiguous on the captured
  // page, and two of them are the exact pair the old arithmetic got wrong.
  const EXPECT = [
    ['so12', 'Type'],
    ['i26', 'Amount'],                          // was "Prorate Across All Item Lines"
    ['kf1CS', 'Distribution Combination'],      // was "Distribution Set"
    ['i34', 'Description'],
  ];
  for (const [tok, want] of EXPECT) {
    const el = byToken(tok);
    const got = el ? columnHeaderLabelOf(el) : '(field missing)';
    check(`${tok} resolves to "${want}"`, got === want, `got ${JSON.stringify(got)}`);
  }

  // The frozen/scrollable split is the whole point: prove BOTH sides resolve,
  // so a pass cannot come from one branch alone.
  check('a FROZEN column resolves (levels[0] path)', columnHeaderLabelOf(byToken('so12')) === 'Type');
  check('a SCROLLABLE column resolves (levels[1] path)', columnHeaderLabelOf(byToken('i34')) === 'Description');

  // Fields in DIFFERENT cells must map to different columns. Two controls in
  // the SAME cell legitimately share one — an ADF date field emits `id1::content`
  // alongside its launcher `id1::lcId`, and both are in the Accounting Date
  // column. So the check is keyed by cell, not by control: aliasing distinct
  // cells onto one header is the failure the old arithmetic produced.
  const perCell = new Map();
  for (const e of d.querySelectorAll('input,textarea,select')) {
    const name = columnHeaderLabelOf(e);
    if (!name) continue;
    const cell = e.closest('td, th');
    if (!cell) continue;
    if (!perCell.has(cell)) perCell.set(cell, name);
  }
  const names = [...perCell.values()];
  check('no two CELLS claim the same column', new Set(names).size === names.length,
    `${names.length} cells named, ${new Set(names).size} distinct: ${JSON.stringify(names)}`);
}

// ── fixture 2: the single-fragment grid that must NOT change ───────────────
{
  const dom = new JSDOM(readFileSync(CHECKBOX, 'utf8'));
  const d = dom.window.document;
  const columnHeaderLabelOf = load(fnSrc, d);

  // The shipped caller uses this for checkbox/radio only, so this fixture is
  // what is live today. Any difference here is a real regression.
  const OLD = new Function('document', `
    return function old(el) {
      try {
        const tableRoot = el.closest && el.closest('[_leafcolclientids]');
        if (!tableRoot) return '';
        const raw = tableRoot.getAttribute('_leafcolclientids') || '';
        const leafIds = (raw.match(/'([^']*)'/g) || []).map(s => s.slice(1, -1));
        if (!leafIds.length) return '';
        const td = el.closest && el.closest('td, th');
        if (!td || !td.parentElement) return '';
        let cellIndex = 0;
        for (const sib of td.parentElement.children) {
          if (sib === td) break;
          cellIndex += parseInt(sib.getAttribute && sib.getAttribute('colspan') || '1', 10) || 1;
        }
        const lastFrozen = parseInt(tableRoot.getAttribute('_lastfrozen') || '-1', 10);
        const overallIndex = ((isNaN(lastFrozen) ? -1 : lastFrozen) + 1) + cellIndex;
        if (overallIndex < 0 || overallIndex >= leafIds.length) return '';
        const headerEl = document.getElementById(leafIds[overallIndex]);
        const labelEl = headerEl && headerEl.querySelector('.af_column_label-text');
        return labelEl ? String(labelEl.textContent || '').replace(/\\s+/g, ' ').trim() : '';
      } catch (_) { return ''; }
    };`)(d);

  const controls = [...d.querySelectorAll('input,textarea,select,[role="checkbox"],[role="radio"]')];
  const diffs = controls.filter(e => columnHeaderLabelOf(e) !== OLD(e));
  check('single-fragment grid is UNCHANGED from the old behaviour',
    controls.length > 0 && diffs.length === 0,
    `${controls.length} controls, ${diffs.length} differ`);
}

// ── mutation check: the fix must be load-bearing ───────────────────────────
{
  // Collapse the two-level lookup back to the flat sum. If the probe still
  // passes after this, it is not testing what it claims to.
  const broken = fnSrc.replace(
    /if \(levels\[0\] < frozenCount\) \{[\s\S]*?overallIndex = frozenCount \+ levels\[1\];\s*\}/,
    'overallIndex = frozenCount + levels[levels.length - 1];');
  check('mutation actually altered the source', broken !== fnSrc);

  const dom = new JSDOM(readFileSync(LINES, 'utf8'));
  const d = dom.window.document;
  const mutated = load(broken, d);
  const amount = [...d.querySelectorAll('input')].find(e => e.id.endsWith('ta2:0:i26::content'));
  const got = mutated(amount);
  check('MUTATION CHECK: flat arithmetic reproduces the original wrong name',
    got === 'Prorate Across All Item Lines',
    `expected the old defect back, got ${JSON.stringify(got)}`);
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
