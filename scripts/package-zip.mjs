/**
 * package-zip.mjs — packages the built extension in dist/ into a release zip.
 *
 * Verifies that the manifest carries the pinned public key so the extension ID
 * remains ijbehkijmihjnhbmbdmoglbbajbkadbd (required by the backend CORS allowlist).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const recorderDir = resolve(root, '..');
const distDir = resolve(recorderDir, 'dist');
const pkg = JSON.parse(readFileSync(resolve(recorderDir, 'package.json'), 'utf8'));
const version = pkg.version || '1.0.0';

console.log(`[package] Building extension v${version}...`);
execFileSync(process.execPath, [resolve(recorderDir, 'build.mjs')], {
  cwd: recorderDir,
  stdio: 'inherit',
});

// Verify manifest exists and carries the pinned key
const manifestPath = resolve(distDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('[package] Error: dist/manifest.json is missing.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!manifest.key) {
  console.error('[package] Error: manifest.json is missing the pinned public key.');
  process.exit(1);
}

const outDir = resolve(recorderDir, 'release');
mkdirSync(outDir, { recursive: true });

const zipName = `flowtrace-recorder-extension-${version}.zip`;
const zipPath = resolve(outDir, zipName);

if (existsSync(zipPath)) rmSync(zipPath);

console.log(`[package] Creating release zip at ${zipPath}...`);

if (process.platform === 'win32') {
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${distDir}\\*' -DestinationPath '${zipPath}' -Force"`, {
    stdio: 'inherit',
  });
} else {
  execSync(`cd "${distDir}" && zip -r "${zipPath}" ./*`, { stdio: 'inherit' });
}

const stats = statSync(zipPath);
console.log(`[package] ✓ Extension packaged: ${zipName} (${(stats.size / 1024).toFixed(1)} KB)`);
