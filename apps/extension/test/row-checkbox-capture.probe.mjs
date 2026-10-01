/**
 * row-checkbox-capture.probe.mjs — does the CLIENT recorder capture a per-row
 * ADF table checkbox, with a name, a state, and a ROW identity?
 *
 * Runs `content/oracle-patch.js` from the client's syntra-flow-recorder against
 * the verbatim capture in
 * `replayer/checks/pages/adf-table-row-checkbox.html` (Manage Asset Locations).
 *
 * Three things have to hold before this step can be replayed or parameterized:
 *
 *   1. a record exists at all           (today it does not — no accessible name)
 *   2. it carries `checked`             (so replay SETS the state, not toggles)
 *   3. it carries the ROW               (so two rows never swap their values)
 *
 * Run:  node recorder/test/row-checkbox-capture.probe.mjs [--patched]
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = resolve(HERE, '..', '..', 'replayer', 'checks', 'pages');
const CLIENT_RECORDER = resolve(
  'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/content/oracle-patch.js',
);
const PAGE = 'adf-table-row-checkbox.html';
const CHECKBOX = 'input[type=checkbox][id*=":sbc1::content"]';

/**
 * Name a table-cell control from its COLUMN HEADER when it has none of its own.
 *
 * Inserted just before the `if (!role || !label) return;` guard. ADF lists the
 * leaf columns in order on the table div (`_leafcolclientids`); the data row's
 * cells align to that list once the frozen row-header column is dropped, so the
 * cell's own index picks the header id, and the header carries the label in
 * `.af_column_label-text`.
 *
 * The row index comes from the component id itself (`…:table1:<rk>:sbc1`) and
 * agrees with `tr[_afrrk]`, which is what keeps two rows' values apart.
 */
const COLUMN_NAME_PATCH = `
    // --- column-header naming for unnamed table-cell controls -------------
    let rowIndex = null, columnName = '';
    try {
      const idm = /:(\\d+):[^:]+(?:::content)?$/.exec(String(target.id || ''));
      if (idm) rowIndex = parseInt(idm[1], 10);
      const cellTd = target.closest && target.closest('td');
      const tableDiv = target.closest && target.closest('[_leafcolclientids]');
      if (!label && cellTd && tableDiv) {
        let leaf = [];
        try { leaf = JSON.parse(tableDiv.getAttribute('_leafcolclientids').replace(/'/g, '"')); } catch (_) {}
        const tds = cellTd.parentElement ? Array.prototype.slice.call(cellTd.parentElement.children) : [];
        const idx = tds.indexOf(cellTd);
        // The frozen row-header column is the first leaf id but is rendered in
        // its own table, so the data cells line up with leaf[1..].
        const colId = idx >= 0 ? leaf[leaf.length - tds.length + idx] : null;
        if (colId) {
          const th = document.getElementById(colId);
          const span = th && th.querySelector('.af_column_label-text');
          const txt = span ? (span.textContent || '').trim()
                           : (th ? (th.textContent || '').replace(/\\s+/g, ' ').trim() : '');
          if (txt) { columnName = txt; label = txt; }
        }
      }
    } catch (_) {}
    // ----------------------------------------------------------------------
`;

const PATCHES = [
  {
    /**
     * Two changes at one site.
     *
     * (a) Name the control from its column header BEFORE anything can drop it.
     *
     * (b) Narrow the popup-launcher branch. As shipped it fires for ANY element
     *     with `(!role || !label) && target.id`. This checkbox HAS a role
     *     ('checkbox') and no label, so it enters the launcher branch, finds no
     *     `title` to pair on, logs "NOT captured" and RETURNS — swallowing it
     *     before any other naming can run. Requiring an actual launcher (an id
     *     ending `::popEl`, or a `[_afrpopid]` ancestor) keeps that fix doing
     *     exactly its job and nothing else.
     */
    name: 'column-header naming + narrow the launcher branch',
    from: '    if ((!role || !label) && target.id) {',
    to:
      COLUMN_NAME_PATCH +
      "    const isPopupLauncher = /::popEl$/.test(String(target.id || '')) ||\n" +
      "      !!(target.closest && target.closest('[_afrpopid]'));\n" +
      '    if ((!role || !label) && target.id && isPopupLauncher) {',
  },
  {
    name: 'row/column on the record',
    from: "      fieldId: String(target.id || ''),",
    to:
      "      fieldId: String(target.id || ''),\n" +
      '      ...(rowIndex === null ? {} : { rowIndex }),\n' +
      "      ...(columnName ? { columnName } : {}),",
  },
];

function chromeShim() {
  window.__ftStorage = [];
  window.chrome = {
    runtime: {
      id: 'harness', lastError: null, getURL: () => 'about:blank',
      sendMessage: (m, cb) => { if (cb) cb({ recording: true }); },
      onMessage: { addListener: () => {} },
    },
    storage: {
      local: {
        get: (k, cb) => cb && cb({}),
        set: (o, cb) => { try { window.__ftStorage.push(o); } catch (_) {} if (cb) cb(); },
        remove: (k, cb) => cb && cb(),
      },
    },
  };
}

async function run(patched) {
  let src = readFileSync(CLIENT_RECORDER, 'utf8').split('\r\n').join('\n');
  if (patched) {
    for (const p of PATCHES) {
      if (!src.includes(p.from)) throw new Error(`${p.name}: anchor not found — result would be meaningless`);
      src = src.replace(p.from, p.to);
    }
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.addInitScript(chromeShim);
    await page.goto('file:///' + join(PAGES, PAGE).split('\\').join('/'), { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: src });
    await page.waitForTimeout(200);

    const facts = await page.evaluate((sel) => {
      const cb = document.querySelector(sel);
      const lbl = document.querySelector(`label[for="${CSS.escape(cb.id)}"]`);
      const rows = [...document.querySelectorAll('[id$=":table1::db"] tr[_afrrk]')].map((r) => {
        const cells = [...r.querySelectorAll('table tr td')];
        const last = cells[cells.length - 1];
        return {
          rk: r.getAttribute('_afrrk'),
          enabled: last && last.querySelector('input[type=checkbox]')
            ? 'checkbox(' + last.querySelector('input[type=checkbox]').checked + ')'
            : 'readonly-text(' + JSON.stringify((last ? last.textContent : '').trim()) + ')',
        };
      });
      return {
        checkboxes: document.querySelectorAll('input[type=checkbox][id*="sbc1"]').length,
        ariaLabelledbyText: JSON.stringify(
          (document.getElementById(cb.getAttribute('aria-labelledby') || '') || {}).textContent),
        labelForText: JSON.stringify(lbl ? lbl.textContent : null),
        ariaLabel: cb.getAttribute('aria-label'),
        title: cb.getAttribute('title'),
        rows,
      };
    }, CHECKBOX);

    await page.evaluate((sel) => {
      document.querySelector(sel).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, CHECKBOX);
    await page.waitForTimeout(1400);

    const writes = await page.evaluate(() => window.__ftStorage || []);
    const records = [];
    for (const w of writes) for (const k of Object.keys(w)) {
      if (k.startsWith('syntraClickFields')) records.push(...(w[k] || []));
    }
    await page.close();
    return { facts, records };
  } finally {
    await browser.close();
  }
}

const patched = process.argv.includes('--patched');
const { facts, records } = await run(patched);

console.log(`\n######## client recorder ${patched ? '+ PATCH' : '(AS SHIPPED)'} — ADF row checkbox ########\n`);
console.log('  markup facts (what a namer has to work with):');
console.log(`    editable checkboxes on the page : ${facts.checkboxes}`);
console.log(`    aria-labelledby resolves to     : ${facts.ariaLabelledbyText}`);
console.log(`    label[for] text                 : ${facts.labelForText}`);
console.log(`    aria-label / title              : ${facts.ariaLabel} / ${facts.title}`);
console.log('\n  rows as rendered:');
for (const r of facts.rows) console.log(`    row ${r.rk}: Enabled = ${r.enabled}`);

console.log(`\n  click records captured: ${records.length}`);
for (const r of records) {
  console.log(`    role=${JSON.stringify(r.role)} label=${JSON.stringify(r.label)} ` +
    `checked=${r.checked} rowIndex=${r.rowIndex} columnName=${JSON.stringify(r.columnName)}`);
  console.log(`      fieldId=…${String(r.fieldId || '').replace(/^.*:table1:/, 'table1:')}`);
}

const rec = records.find((r) => String(r.fieldId || '').includes('sbc1'));
const ok = !!rec && !!rec.label && rec.rowIndex !== undefined && rec.rowIndex !== null;
console.log(`\n  checkbox captured with a name AND a row: ${ok ? 'YES' : 'NO'}\n`);
process.exit(ok ? 0 : 1);
