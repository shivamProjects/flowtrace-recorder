/**
 * pwsave-before-autofill.probe.mjs — the save-password override must be taken
 * BEFORE any credential is typed, and handed back on every failed start.
 *
 * WHY THIS EXISTS
 * Chrome decides whether to offer saving a password at FORM SUBMIT. The
 * suppression originally ran inside attach(), which happens only AFTER the
 * login completes — so the submit itself was unprotected.
 *
 * Measured on a real dev29 run:
 *     +10620ms  auto-fill result: success      <- credentials submitted
 *     +20290ms  pw-save suppressed             <- protection starts
 * a 9,670ms window, all of it Oracle's post-login redirects. It held only
 * because that tenant is slow. A faster login submits while the bubble is still
 * enabled and the operator is offered the tenant credentials to keep.
 *
 * The fix moves suppressPasswordSave() into executePendingRecordNow before the
 * tab is created. That makes the release path load-bearing: a run that fails
 * before attach() must hand the preference back, or the user's password manager
 * stays switched off with nothing recording.
 *
 * Run: node recorder/test/pwsave-before-autofill.probe.mjs
 */

import { readFileSync } from 'node:fs';

const BG = 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/background.js';

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('\npwsave-before-autofill.probe.mjs');
console.log('  suppression must precede the credential submit\n');

const src = readFileSync(BG, 'utf8');

// ── the two functions still exist ──────────────────────────────────────────
check('suppressPasswordSave is defined', /async function suppressPasswordSave\(\)/.test(src));
check('restorePasswordSave is defined', /async function restorePasswordSave\(/.test(src));

// ── ORDER: suppression before the auto-fill ────────────────────────────────
const execStart = src.indexOf('async function executePendingRecordNow');
check('found executePendingRecordNow', execStart !== -1);

// Bound the search to this function so a later call site cannot satisfy it.
const execEnd = src.indexOf('\nasync function ', execStart + 10);
const exec = src.slice(execStart, execEnd === -1 ? execStart + 40000 : execEnd);

const iSuppress = exec.indexOf('await suppressPasswordSave()');
const iFill = exec.indexOf('sendAutoFillLogin(');
const iCreate = exec.indexOf('chrome.tabs.create(');
const iAttach = exec.indexOf('attach(targetTab, "recording")');

check('suppressPasswordSave is awaited inside the exec run', iSuppress !== -1,
  'it must run here, not only in attach()');
check('THE FIX: suppression happens BEFORE the auto-fill',
  iSuppress !== -1 && iFill !== -1 && iSuppress < iFill,
  `suppress@${iSuppress} fill@${iFill} — Chrome decides at form submit`);
check('suppression also precedes the tab being created',
  iSuppress !== -1 && iCreate !== -1 && iSuppress < iCreate,
  `suppress@${iSuppress} create@${iCreate}`);
check('suppression precedes attach()',
  iSuppress !== -1 && iAttach !== -1 && iSuppress < iAttach);

// ── RELEASE: every failed start must hand the preference back ──────────────
const relStart = exec.indexOf('const release = (reason) => {');
const relEnd = exec.indexOf('};', relStart);
const releaseFn = relStart === -1 ? '' : exec.slice(relStart, relEnd);

check('release() restores the preference', /restorePasswordSave\(/.test(releaseFn),
  'a run that fails before attach() would otherwise strand the override');
check('release() does NOT restore on the successful path',
  /attach-success/.test(releaseFn),
  'restoring on attach-success would undo suppression the moment recording starts');

// Each failure path funnels through release(), so enumerate them and confirm
// none bypasses it.
for (const reason of ['tab-create-failed', 'tab-closed', 'attach-failed', 'outer-catch']) {
  check(`failure path "${reason}" goes through release()`,
    exec.includes(`release('${reason}')`),
    'if this path cleared the lock directly it would strand the override');
}

// ── the successful path is owned elsewhere ─────────────────────────────────
check('stopRecording restores', /restorePasswordSave\('stopRecording'\)/.test(src));
check('closeRecordingTab restores', /restorePasswordSave\('closeRecordingTab'\)/.test(src));
check('onStartup restores (crash backstop)',
  /onStartup[\s\S]{0,120}restorePasswordSave\('browser startup'\)/.test(src),
  'a crash mid-recording must not leave the setting off for good');

// ── the write is verified, not assumed ─────────────────────────────────────
const fnStart = src.indexOf('async function suppressPasswordSave()');
const fnBody = src.slice(fnStart, fnStart + 3000);
check('suppressPasswordSave READS BACK the setting',
  /pref\.get\(/.test(fnBody) && /levelOfControl/.test(fnBody),
  'a ChromeSetting can be owned by policy or a password manager: set() then '
  + 'resolves without error and changes nothing');
check('restore uses clear(), not a remembered value',
  /pref\.clear\(/.test(src.slice(src.indexOf('async function restorePasswordSave('), src.indexOf('async function restorePasswordSave(') + 800)),
  'clear() hands the pref back to whatever the user had');

// ── mutation check ─────────────────────────────────────────────────────────
{
  // Put the suppression back where it used to be — after the credential submit,
  // on the attach() side. The order assertion must then fail.
  const mutated = exec
    .replace('await suppressPasswordSave();', '/*moved to after the fill*/')
    .replace('log(`auto-fill result:', 'await suppressPasswordSave(); log(`auto-fill result:');
  const mS = mutated.indexOf('await suppressPasswordSave()');
  const mF = mutated.indexOf('sendAutoFillLogin(');
  check('mutation actually moved the call', mutated !== exec && mS !== -1);
  check('MUTATION CHECK: suppression after the fill is detected as wrong',
    mS !== -1 && mF !== -1 && mS > mF,
    `the mutated order must be fill@${mF} BEFORE suppress@${mS}; if it is not, `
    + 'the ordering assertion above proves nothing');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
