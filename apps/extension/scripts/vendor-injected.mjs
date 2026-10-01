/**
 * vendor-injected.mjs — extract Playwright's injected script from the shipped
 * playwright-core bundle and vendor it as a pinned build artifact.
 *
 *   npm run vendor
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY EXTRACT RATHER THAN IMPORT
 *
 * Playwright's injected script is not a published entry point. It exists inside
 * `playwright-core/lib/coreBundle.js` as an escaped single-quoted JavaScript
 * string literal, because playwright-core's job is to hand that string to a
 * browser and eval it there. Everything the selector generator needs —
 * roleUtils, elementText, the CSS tokenizer, the scoring table — is inside that
 * one string, which is exactly why taking it wholesale is more durable than
 * hand-copying `generateSelector` and its dependencies.
 *
 * The injected script is evaluated IN THE PAGE and needs no CDP session, so
 * vendoring it does not drag `chrome.debugger` along with it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS ASSERTS SO LOUDLY
 *
 * The extraction is marker-based against a minified third-party bundle. It WILL
 * break on some future Playwright version. The failure mode that matters is not
 * "the build stops" — it is "the build silently vendors a 4 KB fragment of
 * something else and every selector the recorder emits gets quietly worse".
 * So every assumption is checked and any violation aborts with a non-zero exit.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = resolve(root, 'node_modules/playwright-core/lib/coreBundle.js');
const PKG_JSON = resolve(root, 'node_modules/playwright-core/package.json');
const OUT_DIR = resolve(root, 'vendor/playwright');
const OUT_JS = resolve(OUT_DIR, 'injected-script.js');
const OUT_VERSION = resolve(OUT_DIR, 'VERSION');

/** The extracted source must contain these, or it is not the injected script. */
const REQUIRED_TOKENS = ['generateSelectorSimple', 'InjectedScript', 'asLocator'];
/** Anything materially smaller than this is a fragment, not the engine. */
const MIN_BYTES = 200 * 1024;

function die(msg) {
  console.error(`\n[vendor-injected] FAILED: ${msg}\n`);
  console.error(
    'This extractor is pinned to a specific playwright-core build. If you have\n' +
    'just changed the pinned version, the marker layout in coreBundle.js has\n' +
    'most likely moved. Re-derive it rather than loosening the assertions:\n' +
    "  node -e \"const s=require('fs').readFileSync('node_modules/playwright-core/lib/coreBundle.js','utf8');\" +\n" +
    '           " for (const m of s.matchAll(/source\\\\w* = \'/g)) console.log(m[0], m.index)"\n',
  );
  process.exit(1);
}

/**
 * Walk a single-quoted JS string literal starting at the opening quote and
 * return the literal INCLUDING both quotes.
 *
 * Backslash escapes are skipped as pairs — that is the whole subtlety here. A
 * naive indexOf("'") stops at the first `\'` inside the source and truncates
 * the engine roughly a tenth of the way in.
 */
function readStringLiteral(text, openQuoteIndex) {
  if (text[openQuoteIndex] !== "'") die(`expected a quote at offset ${openQuoteIndex}`);
  let i = openQuoteIndex + 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") return text.slice(openQuoteIndex, i + 1);
    if (c === '\n') die(`unterminated string literal from offset ${openQuoteIndex}`);
  }
  die(`unterminated string literal from offset ${openQuoteIndex}`);
}

if (!existsSync(BUNDLE)) die(`${BUNDLE} not found — run npm install first`);

const version = JSON.parse(readFileSync(PKG_JSON, 'utf8')).version;
const bundle = readFileSync(BUNDLE, 'utf8');

// esbuild names the inlined sources `source`, `source3`, `source4`, … The
// injected script is one of them, but WHICH one is an artefact of module order
// and is not worth pinning. Identify it by content instead: extract every
// candidate and keep the one that carries the selector generator.
const candidates = [];
for (const m of bundle.matchAll(/\bsource(\w*) = '/g)) {
  const openQuote = m.index + m[0].length - 1;
  const literal = readStringLiteral(bundle, openQuote);
  let decoded;
  try {
    // The literal is data produced by our own build's dependency tree, read
    // from disk, and is being decoded — not executed. eval is the only exact
    // implementation of JS string-escape semantics available.
    decoded = (0, eval)(literal);
  } catch {
    continue; // not a plain string literal; ignore
  }
  candidates.push({ name: m[0].trim(), offset: m.index, source: decoded });
}

if (!candidates.length) die('no `sourceN = \'…\'` literals found in coreBundle.js');

const matches = candidates.filter((c) => REQUIRED_TOKENS.every((t) => c.source.includes(t)));

if (matches.length === 0) {
  die(
    'none of the inlined sources contain ' + REQUIRED_TOKENS.join(' + ') + '.\n' +
    'Found: ' + candidates.map((c) => `${c.name}@${c.offset} (${c.source.length}B)`).join(', '),
  );
}
if (matches.length > 1) {
  die(
    `${matches.length} inlined sources look like the injected script; the marker ` +
    'is no longer unambiguous: ' + matches.map((c) => `${c.name}@${c.offset}`).join(', '),
  );
}

const { name, offset, source } = matches[0];

// ── assertions ──────────────────────────────────────────────────────────────
for (const token of REQUIRED_TOKENS) {
  if (!source.includes(token)) die(`extracted source is missing "${token}"`);
}
const bytes = Buffer.byteLength(source, 'utf8');
if (bytes < MIN_BYTES) {
  die(`extracted source is ${bytes} bytes, below the ${MIN_BYTES}-byte floor — ` +
      'this is a fragment, not the engine');
}
// The injected script is a CommonJS-ish bundle that assigns to `module.exports`.
// If that stops being true the bootstrap in build.mjs cannot instantiate it.
if (!source.includes('module.exports')) {
  die('extracted source never assigns to module.exports — the bootstrap contract is broken');
}

mkdirSync(OUT_DIR, { recursive: true });

const banner =
  '// GENERATED FILE — DO NOT EDIT.\n' +
  '//\n' +
  `// Playwright's injected script, extracted verbatim from playwright-core@${version}\n` +
  '// (lib/coreBundle.js) by scripts/vendor-injected.mjs. Regenerate with:\n' +
  '//\n' +
  '//     npm run vendor\n' +
  '//\n' +
  '// It is a CommonJS bundle: it expects a `module` binding in scope and assigns\n' +
  '// its exports to `module.exports`. `module.exports.InjectedScript` is a lazy\n' +
  '// getter produced by esbuild\'s __toCommonJS, so grepping this file for that\n' +
  '// literal name will not find it. That is expected, not a bug.\n' +
  '//\n' +
  `// source literal: ${name} at byte offset ${offset} of coreBundle.js\n` +
  `// size: ${bytes} bytes\n`;

writeFileSync(OUT_JS, `${banner}\n${source}`, 'utf8');
writeFileSync(OUT_VERSION, `${version}\n`, 'utf8');

console.log(
  `[vendor-injected] playwright-core@${version} → vendor/playwright/injected-script.js ` +
  `(${(bytes / 1024).toFixed(1)} KB, from ${name} @ ${offset})`,
);
