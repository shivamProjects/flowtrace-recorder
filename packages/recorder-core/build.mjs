/**
 * build.mjs — Bundles host-neutral page-runtime into packages/recorder-core/dist/
 */

import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(root, 'dist');

if (!existsSync(out)) {
  mkdirSync(out, { recursive: true });
}

await build({
  entryPoints: {
    'page-runtime': resolve(root, 'src/page-runtime.js'),
  },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: 'chrome110',
  platform: 'browser',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
});

console.log('[recorder-core] built dist/page-runtime.js');
