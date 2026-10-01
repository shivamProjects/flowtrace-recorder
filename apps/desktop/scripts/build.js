/**
 * Build helper — reads .env and passes an environment-tagged artifact name
 * to electron-builder so the output EXE identifies its target backend.
 *
 * Usage:  node scripts/build.js --win | --mac | --all
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
let envTag = '';

try {
  const envContent = fs.readFileSync(envPath, 'utf8');
  const match = envContent.match(/^API_BASE_URL\s*=\s*(.+)$/m);
  if (match) {
    const u = new URL(match[1].trim());
    const seg = u.pathname.replace(/^\/+/, '').split('/')[0].split('-')[0];
    envTag = seg ? u.hostname + '-' + seg : u.hostname;
  }
} catch (_) {}

const platformArg = process.argv.slice(2).join(' ') || '--win';
const artifactName = envTag
  ? `\${productName} Setup \${version} (${envTag}).\${ext}`
  : `\${productName} Setup \${version}.\${ext}`;

const localBuilderBin = path.join(__dirname, '..', 'node_modules', '.bin', 'electron-builder');
const cmd = `"${localBuilderBin}" ${platformArg} --config.nsis.artifactName="${artifactName}"`;
console.log(`[build] tag: ${envTag || '(none)'}`);
console.log(`[build] ${cmd}\n`);

execSync(cmd, {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
  shell: true,
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
});
