/**
 * legacy-harness.js — loads the PRE-RESTRUCTURE content.js and exposes its
 * closure-scoped selector functions so the new implementation can be diffed
 * against them.
 *
 * This exists only for the duration of the refactor. Once the characterization
 * tests have been converted into ordinary assertions with pinned expectations,
 * this file and the backup directory it reads can both be deleted.
 *
 * The original is an IIFE, so the functions inside are unreachable from outside.
 * Rather than modify the file we are trying to hold still, the harness rewrites
 * the closing `})();` in memory to publish the handful of functions under test.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const LEGACY = resolve(here, '../../recorder.backup-pre-restructure/content.js');

const EXPORTS = [
  'buildSelectorMeta',
  'buildCSSFallback',
  'resolveLabel',
  'inferRole',
  'isStableId',
];

let cached = null;

/**
 * @returns {{buildSelectorMeta: Function, buildCSSFallback: Function,
 *            resolveLabel: Function, inferRole: Function, isStableId: Function}}
 */
export function loadLegacy() {
  if (cached) return cached;

  let source = readFileSync(LEGACY, 'utf8');

  const close = source.lastIndexOf('})();');
  if (close === -1) throw new Error('legacy content.js: could not find the IIFE close');
  source =
    source.slice(0, close) +
    `globalThis.__legacy = { ${EXPORTS.join(', ')} };\n` +
    source.slice(close);

  // The legacy script wires listeners and starts a 2s scan interval plus a 120s
  // teardown timer at load. Neutralise both so the test process can exit, and
  // stub the extension APIs it reaches for on the way in.
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realChrome = globalThis.chrome;

  globalThis.setInterval = () => 0;
  globalThis.setTimeout = () => 0;
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener() {} },
      sendMessage() {},
    },
  };

  try {
    // eslint-disable-next-line no-new-func
    new Function(source)();
    cached = globalThis.__legacy;
    if (!cached) throw new Error('legacy content.js: harness exports were not published');
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
    globalThis.chrome = realChrome;
  }

  return cached;
}
