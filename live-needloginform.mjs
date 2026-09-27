/**
 * Does needLoginForm actually separate the two documents?
 *
 * THE DEFECT IT FIXES (from a live service-worker log):
 *   +4379ms  "content script reachable after 27ms (1 poll(s))"
 *            attempt 1: message channel closed
 *            attempt 2: Receiving end does not exist
 *            "content script reachable after 532ms (3 poll(s))"
 *
 * 27ms is too fast for a fresh document — the reply came from
 * /oauth2/v1/authorize, which was already loaded and about to be replaced by
 * /ui/v1/signin. The old poll asked only "did anything answer", so it accepted
 * the doomed document. needLoginForm asks "is the sign-in form up".
 *
 * This walks the real redirect chain and evaluates probeLoginState's predicate
 * (a password field in the top frame) on EVERY document, so the two can be
 * compared directly rather than reasoned about.
 *
 * MUST BE RUN HEADED — Akamai blocks headless Chromium at the CDN edge on
 * these tenants ("Access Denied", errors.edgesuite.net), which produces a run
 * with no /authorize hop at all and looks like the chain failing to reproduce.
 *
 * Run: node recorder/live-needloginform.mjs
 */
import { chromium } from '@playwright/test';

const URL = process.argv[2]
  || 'https://fa-euth-dev29-saasfademo1.ds-fa.oraclepdemos.com/fscmUI/faces/AtkHomePageWelcome';

const browser = await chromium.launch({
  headless: false,                       // headless is refused at the edge
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await (await browser.newContext()).newPage();

const t0 = Date.now();
const seen = [];

// Evaluate the predicate as each document commits.
page.on('domcontentloaded', async () => {
  const at = Date.now() - t0;
  let url = '', hasForm = null;
  try {
    url = page.url();
    hasForm = await page.evaluate(() => !!document.querySelector('input[type="password"]'));
  } catch (_) { /* document swapped mid-eval; that is itself the phenomenon */ }
  seen.push({ at, url, hasForm });
});

console.log(`\nlive-needloginform.mjs\n  ${URL}\n`);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  .catch((e) => console.log('  goto: ' + e.message.split('\n')[0]));
await page.waitForTimeout(12000);

const blocked = await page.evaluate(() => /Access Denied/i.test(document.title)).catch(() => false);
if (blocked) {
  console.log('  *** AKAMAI EDGE BLOCK — run headed against a reachable tenant.');
  await browser.close();
  process.exit(2);
}

console.log('  documents, in order:\n');
let authHop = null, signinDoc = null;
for (const d of seen) {
  const short = d.url.replace(/^https:\/\//, '').slice(0, 64);
  const verdict = d.hasForm === null ? 'unreadable (swapped)'
    : d.hasForm ? 'HAS form  -> needLoginForm ACCEPTS'
                : 'no form   -> needLoginForm WAITS';
  console.log(`    +${String(d.at).padStart(6)}ms  ${short.padEnd(66)} ${verdict}`);
  if (/\/oauth2\/v1\/authorize/.test(d.url)) authHop = d;
  if (/\/ui\/v1\/signin/.test(d.url)) signinDoc = d;
}

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('');
check('the /authorize hop appeared', !!authHop,
  'without it this run cannot test the discrimination');
check('the sign-in document appeared', !!signinDoc);

if (authHop) {
  check('THE FIX: the /authorize hop is REJECTED (no login form)',
    authHop.hasForm === false,
    `hasForm=${authHop.hasForm} — if true, needLoginForm would accept the `
    + 'doomed document exactly as the old poll did');
}
if (signinDoc) {
  check('THE FIX: the sign-in document is ACCEPTED',
    signinDoc.hasForm === true,
    `hasForm=${signinDoc.hasForm} — if false, needLoginForm would wait out its `
    + 'whole budget and the fill would never be sent');
}
if (authHop && signinDoc) {
  check('the two are distinguishable at all',
    authHop.hasForm !== signinDoc.hasForm,
    'if both look the same, the predicate cannot separate them and the fix '
    + 'is not doing what it claims');
  console.log(`\n  gap between them: ${signinDoc.at - authHop.at}ms`);
}

console.log(`\n${bad ? bad + ' FAILURE(S)' : 'ALL PASS'}\n`);
await browser.close();
process.exit(bad ? 1 : 0);
