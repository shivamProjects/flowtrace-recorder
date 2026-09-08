/**
 * capture-harness.js — drive the REAL recorder against REAL captured markup.
 *
 * Every capture bug found so far was diagnosed by writing the same throwaway
 * script again: shim `chrome.*`, load a page, inject the content script, click
 * something, read the events back. Eight such scripts existed before this file;
 * they differed only in which element they clicked.
 *
 * Two rules this encodes, both learned the hard way:
 *
 *  1. **Never hand-write Oracle markup.** A fixture written from an assumption
 *     tests the assumption. Redwood rows were once modelled as
 *     `li[role=row] > div[role=gridcell]`; the real widget is a bare `<td>`, and
 *     two diagnoses were wrong before anyone checked. Fixtures under
 *     `pages/` are verbatim captures — see pages/README.md.
 *
 *  2. **Check against the dump before the live tenant.** Driving a real Oracle
 *     pod for every hypothesis is slow, needs credentials, and fails for
 *     reasons that have nothing to do with the code (Akamai blocks headless
 *     Chrome on the demo pods entirely). Get it right against the captured DOM
 *     first; go live only to confirm, or to capture a NEW dump.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDER_ROOT = resolve(HERE, '..');

/** Verbatim DOM captures shared with the replayer's checks. */
export const PAGES = resolve(RECORDER_ROOT, '..', 'replayer', 'checks', 'pages');

/** The built content script — what actually ships. */
export const BUNDLE = resolve(RECORDER_ROOT, 'dist', 'content.js');

export const pageUrl = (name) =>
  'file:///' + join(PAGES, name).split('\\').join('/');

/**
 * The minimum `chrome.*` a content script needs to run outside an extension.
 *
 * Declared as a plain function so it can be passed to addInitScript, which
 * serialises it — it cannot close over anything from this module.
 */
function chromeShim() {
  window.__ftEvents = [];
  const record = (m) => {
    try {
      window.__ftEvents.push(m);
    } catch (_) { /* page torn down mid-flight */ }
  };
  window.chrome = {
    runtime: {
      id: 'harness',
      lastError: null,
      getURL: () => 'about:blank',
      sendMessage: (m, cb) => { record(m); if (cb) cb({ recording: true }); },
      onMessage: { addListener: () => {} },
    },
    storage: {
      local: {
        get: (k, cb) => cb && cb({}),
        set: (o, cb) => { record({ __storage: o }); if (cb) cb(); },
        remove: (k, cb) => cb && cb(),
      },
    },
  };
}

/**
 * Load a fixture with the recorder running, do something, return what it emitted.
 *
 * @param {Object}   opts
 * @param {string}   opts.page      fixture filename under pages/
 * @param {string}  [opts.source]   content-script source; defaults to the build
 * @param {Function} opts.act       runs IN THE PAGE; receives no arguments
 * @param {number}  [opts.settle]   ms to wait after `act` (default 400)
 * @returns {Promise<Object[]>} emitted events, oldest first
 */
export async function captureWith({ page, source, act, settle = 400 }) {
  const src = source ?? readFileSync(BUNDLE, 'utf8');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const p = await browser.newPage();
    await p.addInitScript(chromeShim);
    await p.goto(pageUrl(page), { waitUntil: 'domcontentloaded' });
    await p.addScriptTag({ content: src });
    await p.waitForTimeout(250);

    // The content script idles until told to record.
    await p.evaluate(() => {
      window.dispatchEvent(new CustomEvent('__flowtrace_activate__', { detail: {} }));
    }).catch(() => { /* older builds start on load */ });
    await p.waitForTimeout(200);

    await p.evaluate(act);
    await p.waitForTimeout(settle);

    const raw = await p.evaluate(() => window.__ftEvents || []);
    await p.close();
    return raw
      .map((m) => (m && (m.event || m)) || {})
      .filter((e) => e && e.type);
  } finally {
    await browser.close();
  }
}

/** `captureWith`, reduced to the last event — the common case. */
export async function captureOne(opts) {
  const events = await captureWith(opts);
  return events[events.length - 1] || null;
}

/**
 * Click one element, chosen by an expression evaluated in the page.
 *
 * An expression rather than a selector because the interesting targets are
 * often "the cell that contains exactly one checkbox" — a predicate, not a path.
 */
export function clickExpr(expr) {
  return new Function(`
    const el = ${expr};
    if (!el) throw new Error('harness: no element matched: ${expr.replace(/'/g, "\\'")}');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  `);
}

/**
 * Run the same scenario with a fix present and removed.
 *
 * A fix that changes nothing when removed was never fixing anything. The
 * transform is a LITERAL replacement and this THROWS when it fails to match —
 * an ablation that silently patches nothing reports "the fix does nothing",
 * which is how a working fix gets thrown away.
 *
 * @param {string} sourcePath  the source file to ablate (not the bundle)
 * @param {string} snippet     exact text to remove
 * @returns {{ with: string, without: string }} two content-script sources
 */
export function ablate(sourcePath, snippet) {
  // Normalise CRLF: sources are checked out with Windows line endings, and a
  // snippet written with \n would silently match nothing.
  const src = readFileSync(sourcePath, 'utf8').split('\r\n').join('\n');
  if (!src.includes(snippet)) {
    throw new Error(
      `ablation snippet not found in ${sourcePath} — the result would be ` +
      'meaningless. The code was reworded, or the fix is already gone.'
    );
  }
  return { with: src, without: src.replace(snippet, '') };
}
