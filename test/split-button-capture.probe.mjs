/**
 * split-button-capture.probe.mjs — does the CLIENT recorder capture an ADF
 * split-button caret?
 *
 * Runs `content/oracle-patch.js` from the client's syntra-flow-recorder, real
 * source, against the verbatim toolbar capture in
 * `replayer/checks/pages/adf-split-button-save.html`, and reports what the
 * click records contain.
 *
 * The defect under test: a click on the "Save and Close" caret is never
 * recorded, so popup.js's resolveTitleAttrSelectors finds only the Save
 * BUTTON's record and rewrites the caret's step onto it. Both steps then carry
 * `internal:role=button[name="Save"i]`, the menu never opens, and the following
 * step dies on a hidden menu item.
 *
 * Run:  node recorder/test/split-button-capture.probe.mjs
 *       node recorder/test/split-button-capture.probe.mjs --patched
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

/**
 * Both captures are of the SAME split button from DIFFERENT panel instances.
 * Running both is the point: the ids share no prefix, so anything that passes
 * on one and fails on the other was keying off the volatile part.
 */
const PAGES_UNDER_TEST = [
  { page: 'adf-split-button-save.html', instance: 'MAnt2:2 / Trans1 / ap110' },
  { page: 'adf-split-button-save-tcf.html', instance: 'MAnt2:0 / TCF / ap1' },
];

const CARET = 'a[id$="saveMenu::popEl"]';
// Addressed by suffix too — the button is the caret's sibling inside saveMenu,
// and hard-coding either instance's full id would break on the other.
const BUTTON = 'div[id$=":saveMenu"] a.xrg';

/**
 * The proposed changes, applied to the real source as literal replacements.
 * Each THROWS if its anchor is not found, because a patch that silently applies
 * to nothing reports "the fix does nothing".
 *
 * Three parts, and all three are load-bearing — R1 alone was measured making no
 * difference at all, because the record is dropped twice over.
 */
const PATCHES = [
  {
    // R1 — closest() never matched the caret: <a> with no href and no role, so
    // it climbed to the wrapping <td id="…::popArea">.
    name: 'R1 closest() list',
    from: "'td, th, ' +",
    to: "'a[id$=\"::popEl\"], [_afrpopid] > a, ' +\n          'td, th, ' +",
  },
  {
    // R2a — roleOf() returns '' for an <a> without href (:1509), so even once
    // closest() finds the caret the `!role` guard drops it. A launcher is
    // exempt: it is addressed by id, so it needs no role and no name.
    name: 'R2a role/label guard',
    from: '    if (!role || !label) return;',
    to:
      '    const popId = target.id && /::popEl$/.test(target.id) ? String(target.id) : \'\';\n' +
      '    if (!popId && (!role || !label)) return;',
  },
  {
    // R2b — carry the address that actually replays. Never role+name (the title
    // collides with the sibling button) and never the full id (the panel
    // instance differs between recording and replay).
    name: 'R2b fixedSelector on the record',
    from: '      fieldId: String(target.id || \'\'),',
    to:
      '      fieldId: String(target.id || \'\'),\n' +
      '      ...(popId ? {\n' +
      '        isPopupLauncher: true,\n' +
      '        fixedSelector: \'css=a[id$="\' + (popId.match(/[^:]+::popEl$/) || [popId])[0] + \'"]\',\n' +
      '      } : {}),',
  },
];

function chromeShim() {
  window.__ftStorage = [];
  window.chrome = {
    runtime: {
      id: 'harness',
      lastError: null,
      getURL: () => 'about:blank',
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

async function run({ patched, page: PAGE }) {
  let src = readFileSync(CLIENT_RECORDER, 'utf8').split('\r\n').join('\n');
  if (patched) {
    for (const patch of PATCHES) {
      if (!src.includes(patch.from)) {
        throw new Error(
          `${patch.name}: anchor ${JSON.stringify(patch.from)} not found in ` +
          'oracle-patch.js — the code was reworded, so the result would be ' +
          'meaningless.',
        );
      }
      src = src.replace(patch.from, patch.to);
    }
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const p = await browser.newPage();
    await p.addInitScript(chromeShim);
    await p.goto('file:///' + join(PAGES, PAGE).split('\\').join('/'), {
      waitUntil: 'domcontentloaded',
    });
    await p.addScriptTag({ content: src });
    await p.waitForTimeout(200);

    // Static facts about the markup, before any clicking. These answer the
    // Phase-2 question — is the generic launcher selector unique? — without
    // needing a replay.
    const dom = await p.evaluate(() => ({
      launchers: [...document.querySelectorAll('a[id$="::popEl"]')].map((a) => ({
        id: a.id.slice(a.id.lastIndexOf(':', a.id.length - 8) + 1),
        title: a.getAttribute('title'),
        href: a.hasAttribute('href'),
        role: a.getAttribute('role'),
        text: (a.textContent || '').trim(),
      })),
      genericSaveMatches: document.querySelectorAll('a[id$="::popEl"][title="Save"]').length,
      titleSaveMatches: document.querySelectorAll('[title="Save"]').length,
      nameSaveMatches: [...document.querySelectorAll('a[role="button"], button')]
        .filter((e) => (e.textContent || '').trim() === 'Save').length,
    }));

    // What the recorder's own closest() list resolves the caret to. The list is
    // extracted from the source being tested, patched or not — a hand-copied
    // literal here would report the unpatched answer forever.
    const listSrc = src.slice(src.indexOf('target = clicked.closest('));
    const list = [
      ...listSrc
        .slice(0, listSrc.indexOf(');'))
        // The list is interleaved with long // comments whose prose contains
        // apostrophes; without stripping them the join yields garbage that
        // querySelector rejects.
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n')
        .matchAll(/'([^']*)'/g),
    ].map((m) => m[1]).join('');
    const resolved = await p.evaluate(({ sel, list }) => {
      const caret = document.querySelector(sel);
      const hit = caret.closest(list);
      return { tag: hit?.tagName, id: hit?.id || '', isCaret: hit === caret };
    }, { sel: CARET, list });

    // Click the Save BUTTON first (as the operator did at step 48), then the
    // caret (step 49). Order matters: the button's record is what the popup's
    // rewrite later latches onto.
    await p.evaluate((sels) => {
      document.querySelector(sels.button)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.querySelector(sels.caret)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, { button: BUTTON, caret: CARET });

    await p.waitForTimeout(1200); // click records flush on a timer

    const writes = await p.evaluate(() => window.__ftStorage || []);
    const records = [];
    for (const w of writes) {
      for (const k of Object.keys(w)) {
        if (k.startsWith('syntraClickFields')) records.push(...(w[k] || []));
      }
    }
    await p.close();
    return { dom, resolved, records };
  } finally {
    await browser.close();
  }
}


const patched = process.argv.includes('--patched');

console.log(
  `\n######## client recorder, oracle-patch.js ` +
  `${patched ? '+ PATCH (R1 + R2a + R2b)' : '(AS SHIPPED)'} ########`,
);

let allCaptured = true;
for (const { page, instance } of PAGES_UNDER_TEST) {
  const { dom, resolved, records } = await run({ patched, page });

  console.log(`\n=== ${page}`);
  console.log(`    panel instance: ${instance}\n`);

  console.log('  launchers present (a[id$="::popEl"]):');
  for (const l of dom.launchers) {
    console.log(
      `    ${l.id.padEnd(18)} title=${JSON.stringify(l.title)}  ` +
      `href=${l.href}  role=${l.role}  text=${JSON.stringify(l.text)}`,
    );
  }

  console.log('\n  selector counts on this markup:');
  console.log(`    a[id$="::popEl"][title="Save"]  -> ${dom.genericSaveMatches}`);
  console.log(`    [title="Save"]                 -> ${dom.titleSaveMatches}`);
  console.log(`    buttons named "Save"           -> ${dom.nameSaveMatches}`);

  console.log(
    `\n  closest() resolves the caret to: <${resolved.tag?.toLowerCase()} ` +
    `id="...${resolved.id.slice(-22)}">   caret itself: ${resolved.isCaret}`,
  );

  console.log(`\n  click records: ${records.length}`);
  for (const r of records) {
    console.log(
      `    role=${JSON.stringify(r.role)} label=${JSON.stringify(r.label)} ` +
      `fieldId="...${String(r.fieldId || '').slice(-22)}"` +
      (r.fixedSelector ? `\n        fixedSelector: ${r.fixedSelector}` : ''),
    );
  }

  const caretRecorded = records.some((r) =>
    String(r.fieldId || '').endsWith('saveMenu::popEl'));
  console.log(`\n  caret captured as its own record: ${caretRecorded ? 'YES' : 'NO'}`);
  if (!caretRecorded) allCaptured = false;
}

console.log(`\n${allCaptured ? 'ALL' : 'NOT ALL'} instances captured the caret.\n`);
process.exit(allCaptured ? 0 : 1);
