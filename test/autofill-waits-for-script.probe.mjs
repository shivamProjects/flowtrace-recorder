/**
 * autofill-waits-for-script.probe.mjs — the auto-fill must wait for the content
 * script to ANSWER, not for a tab event or a fixed sleep.
 *
 * WHY THIS EXISTS
 * A tester reported the login "taking too long". From their service-worker log
 * (12 runs, dev29 + dev93) the page was never the problem:
 *
 *   attempt 1 of the auto-fill failed 12/12 runs — it has never succeeded
 *   gap from sending the fill to getting a result: 26,475ms – 56,991ms
 *   5 runs reached attach; 6 were abandoned when the tester closed the tab
 *
 * Two separate defects produced that:
 *
 *   1. The fill was sent after a FIXED 4s sleep anchored to the page-load wait,
 *      which finishes on whichever document completes first. During sign-in
 *      that is /oauth2/v1/authorize. Measured headed on dev29, IDCS
 *      /ui/v1/signin then loads as a SEPARATE document (redirectCount 0,
 *      domComplete ~3.1s into its own life) — so the sleep expired against a
 *      document already being torn down and the message landed on nothing.
 *
 *   2. Recovery called waitForTabComplete(tabId) with NO timeout argument, so
 *      it used the 60000ms default. The sign-in document's 'complete' had
 *      already fired on the earlier hop and never fires again, so it sat out
 *      the whole minute. That is the 26-57s.
 *
 * Both are now a poll for a reply (waitForContentScript), and every
 * waitForTabComplete call on these paths passes an explicit bound.
 *
 * Run: node recorder/test/autofill-waits-for-script.probe.mjs
 */

import { readFileSync } from 'node:fs';

const BG = 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/background.js';

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('\nautofill-waits-for-script.probe.mjs');
console.log('  wait for a reply, not for a tab event\n');

const src = readFileSync(BG, 'utf8');

// ── the helper exists and polls the right thing ────────────────────────────
const fnStart = src.indexOf('async function waitForContentScript(');
check('waitForContentScript is defined', fnStart !== -1);
const fnBody = src.slice(fnStart, fnStart + 1600);

check('it polls probeLoginState (an actual round trip)',
  /probeLoginState\(tabId\)/.test(fnBody),
  'reachability must be proven by a reply, not inferred from a tab event');
check('it gives up if the tab has gone',
  /chrome\.tabs\.get\(tabId\)[\s\S]{0,80}return false/.test(fnBody),
  'a closed tab will never answer — polling on would waste the whole budget');
check('it is bounded by a budget', /Date\.now\(\) - started < budget/.test(fnBody));
check('it reports how long it waited', /content script reachable after/.test(fnBody));

// ── defect 1: the fixed 4s sleep before the first fill is gone ─────────────
const execStart = src.indexOf('async function executePendingRecordNow');
const execEnd = src.indexOf('\nasync function ', execStart + 10);
const exec = src.slice(execStart, execEnd === -1 ? execStart + 40000 : execEnd);

check('THE FIX: no fixed 4s sleep before the first auto-fill',
  !/Waiting 4s for content script injection/.test(exec)
  && !/setTimeout\(r, 4000\)/.test(exec),
  'a fixed sleep is anchored to the wrong document and cannot be made reliable '
  + 'by lengthening it');
check('the first fill waits for reachability instead',
  /waitForContentScript\(tab\.id/.test(exec));

const iWait = exec.indexOf('waitForContentScript(tab.id');
const iFill = exec.indexOf('sendAutoFillLogin(tab.id');
check('the wait precedes the fill', iWait !== -1 && iFill !== -1 && iWait < iFill,
  `wait@${iWait} fill@${iFill}`);
check('a tab closed during the wait still aborts the run',
  /closedPromise[\s\S]{0,60}\)\s*,?\s*\]\)/.test(exec.slice(iWait, iWait + 400))
  || /closedPromise/.test(exec.slice(iWait, iWait + 300)),
  'the old sleep raced closedPromise; the poll must too');

// ── defect 2: no unbounded waitForTabComplete anywhere ─────────────────────
const bare = [...src.matchAll(/waitForTabComplete\(\s*tabId\s*\)/g)];
check('THE FIX: no waitForTabComplete(tabId) without a timeout',
  bare.length === 0,
  `${bare.length} unbounded call(s) — each would use the 60000ms default on a `
  + 'document whose "complete" has already fired');

const defStart = src.indexOf('async function waitForTabComplete(');
check('the 60s default still exists for other callers',
  /timeoutMs = timeoutMs \|\| 60000/.test(src.slice(defStart, defStart + 300)),
  'the default is fine; relying on it during sign-in was not');

// ── the mid-auth guard must survive ────────────────────────────────────────
check('the mid-auth guard is intact',
  /isMidAuthUrl\(settledUrl\)/.test(src)
  && /replays a spent code and 401s/.test(src),
  'removing it turns a working login into a 401 — it is the WAIT that was '
  + 'wrong, not the guard');

// ── behavioural model over the tester's REAL numbers ───────────────────────
// Budgets as written, read back from the source so the model cannot drift.
const midAuthBudget = Number((src.match(/const reachable = await waitForContentScript\(tabId, (\d+)\)/) || [])[1]);
const firstBudget = Number((src.match(/waitForContentScript\(tab\.id, (\d+)\)/) || [])[1]);
check('mid-auth poll budget is read from source', Number.isFinite(midAuthBudget), String(midAuthBudget));
check('first-fill poll budget is read from source', Number.isFinite(firstBudget), String(firstBudget));

// The log shows the script announcing itself on /ui/v1/signin well inside these
// budgets. Worst observed dead wait was 56,991ms.
const OBSERVED_WORST_MS = 56991;
const OBSERVED_BEST_MS = 26475;
check('the mid-auth budget is far below the worst observed dead wait',
  midAuthBudget < OBSERVED_BEST_MS,
  `budget ${midAuthBudget}ms vs best-case observed ${OBSERVED_BEST_MS}ms`);

const worstNow = firstBudget + midAuthBudget;   // both budgets exhausted
check('even the worst case now beats the best case before',
  worstNow < OBSERVED_BEST_MS,
  `worst now ${worstNow}ms vs ${OBSERVED_BEST_MS}ms observed best before`);
console.log(`        saving vs worst observed: ${OBSERVED_WORST_MS - worstNow}ms`);

// ── mutation check ─────────────────────────────────────────────────────────
{
  const mutated = src.replace(/waitForTabComplete\(tabId, 5000\)/, 'waitForTabComplete(tabId)');
  check('mutation reintroduced an unbounded call', mutated !== src);
  const bareAfter = [...mutated.matchAll(/waitForTabComplete\(\s*tabId\s*\)/g)];
  check('MUTATION CHECK: an unbounded call is detected',
    bareAfter.length > 0,
    'the bounded-call assertion would not catch a regression');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
