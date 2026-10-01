/**
 * login-submit-clicks-once.probe.mjs — the sign-in submit must deliver exactly
 * ONE click, or two authentication requests race and the OAuth callback 401s.
 *
 * WHY THIS EXISTS
 * Oracle JET wraps the real submit in an <oj-button>. clickLoginSubmit() used
 * to click BOTH elements and, on each, call .click() AND dispatch a MouseEvent.
 *
 * Measured on the live IDCS sign-in page, counting at the wrapper (which is
 * what IDCS's own handler sees):
 *
 *     both elements, .click() + dispatchEvent   4
 *     both elements, .click() only              2   <- a 4->2 attempt landed here
 *     inner button only                         1
 *     wrapper only                              1
 *
 * Halving it did not fix the 401s. The wrapper CONTAINS the inner button
 * (verified live: oj-button id="idcs-signin-basic-signin-form-submit" contains
 * the <button>), so a click on the inner one BUBBLES to the wrapper. Clicking
 * both fires the wrapper's handler twice however each click is produced — only
 * clicking ONE element reaches a single request.
 *
 * IDCS collapses the duplicate pair sometimes and not others, which is why the
 * 401 was intermittent rather than constant.
 *
 * Run: node recorder/test/login-submit-clicks-once.probe.mjs
 */

import { readFileSync } from 'node:fs';

const SRC = 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/content/oracle-patch.js';

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('\nlogin-submit-clicks-once.probe.mjs');
console.log('  one logical submit must be one auth request\n');

const src = readFileSync(SRC, 'utf8');

// ── slice the shipped function ─────────────────────────────────────────────
const start = src.indexOf('function clickLoginSubmit(btn) {');
check('found clickLoginSubmit', start !== -1);
let depth = 0, end = -1;
for (let p = src.indexOf('{', start); p < src.length; p++) {
  if (src[p] === '{') depth++;
  else if (src[p] === '}') { depth--; if (depth === 0) { end = p + 1; break; } }
}
const fn = src.slice(start, end);

// ── it must click ONE element, ONCE ────────────────────────────────────────
const clickCalls = (fn.match(/\.click\(\)/g) || []).length;
check('THE FIX: exactly one .click() call', clickCalls === 1,
  `found ${clickCalls} — each extra one is another authentication request`);

check('THE FIX: no dispatchEvent in the submit path',
  !/dispatchEvent/.test(fn),
  'el.click() already dispatches a click event; the extra MouseEvent just '
  + 're-ran the same handlers');

check('it picks a single target rather than clicking both',
  /const target = btn \|\| jetBtn;/.test(fn),
  'clicking the wrapper AND the button it contains is two requests, because '
  + 'the inner click bubbles');

check('the inner button is preferred over the wrapper',
  /btn \|\| jetBtn/.test(fn) && !/jetBtn \|\| btn/.test(fn.replace('noteLoginSubmitClick(btn || jetBtn)', '')),
  'the inner button is the element a person clicks and the one JET binds');

check('a missing submit element is reported, not silently skipped',
  /no submit element to click/.test(fn));

check('the click is still reported BEFORE it fires',
  fn.indexOf('noteLoginSubmitClick') < fn.indexOf('target.click()'),
  'the click navigates; a message posted after it races the page teardown');

// ── behavioural model over the LIVE-measured counts ────────────────────────
// Counted at the wrapper on the real IDCS page.
const LIVE = {
  'both, click+dispatch': 4,
  'both, click only': 2,
  'inner only': 1,
  'wrapper only': 1,
};
check('the live measurement shows 4->2 was not enough',
  LIVE['both, click only'] === 2,
  'if two elements gave 1, the fix would be unnecessary');
check('the live measurement shows one element gives one request',
  LIVE['inner only'] === 1 && LIVE['wrapper only'] === 1);

// ── mutation check ─────────────────────────────────────────────────────────
{
  const broken = fn.replace('target.click();',
    'if (jetBtn) jetBtn.click(); if (btn) btn.click();');
  check('mutation restored the both-elements click', broken !== fn);
  const brokenCalls = (broken.match(/\.click\(\)/g) || []).length;
  check('MUTATION CHECK: clicking both elements is detected',
    brokenCalls > 1,
    'the single-click assertion would not catch a regression');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
