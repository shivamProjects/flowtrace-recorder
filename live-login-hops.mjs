/**
 * Measure the recorder's login race against the REAL tenant.
 *
 * THE CLAIM (from a tester's service-worker log, 12 runs):
 * background.js's page-load wait finishes on an early hop, waits a fixed 4s,
 * then sends the auto-fill to a document that has already been replaced — so
 * chrome.tabs.sendMessage hits nothing and attempt 1 fails every time.
 *
 * ── HEADLESS DOES NOT WORK HERE ──────────────────────────────────────────
 * Akamai blocks a headless Chromium at the CDN edge, BEFORE Oracle is reached:
 *
 *     title    "Access Denied"
 *     body     You don't have permission to access
 *              "http://fa-euth-dev29-…oraclepdemos.com/" on this server.
 *     ref      #18.8f8d2c31.1790060248.7ec1d9c  (errors.edgesuite.net)
 *
 * The page "loads" in ~250ms and never redirects, which looks like the race
 * failing to reproduce. It is not — the login flow never started. Any headless
 * run against this tenant that shows no /authorize hop is measuring the block,
 * not the product. Use a HEADED browser (the Playwright MCP session reaches the
 * real sign-in page fine).
 *
 * ── WHAT WAS MEASURED, HEADED, ON dev29 ──────────────────────────────────
 * Navigating to /fscmUI/faces/AtkHomePageWelcome lands on IDCS
 * /ui/v1/signin, and on that document:
 *
 *     redirectCount     0        <- a SEPARATE document, not a redirect within
 *                                   the /authorize navigation
 *     responseEnd     323ms
 *     domInteractive 1557ms
 *     domComplete    3116ms
 *     password field  present
 *
 * `redirectCount: 0` is the finding that matters. The sign-in page is its own
 * document, so a content script injected into the /authorize document is torn
 * down when it loads — exactly the "Receiving end does not exist" the log
 * shows. And it finishes ~3.1s into its OWN life, i.e. after the recorder's 4s
 * settle already started counting from the PREVIOUS document's completion.
 *
 * So the fixed settle cannot be made reliable by lengthening it; it is anchored
 * to the wrong event. Poll for the content script becoming reachable instead.
 * The tester's log already shows it announcing itself
 * ("content script alive (top) on …/ui/v1/signin") seconds before the current
 * 60s waitForTabComplete expires.
 *
 * Read-only: navigates and observes, never submits credentials.
 *
 * Run (expect the Akamai block unless you point it at something reachable):
 *   node recorder/live-login-hops.mjs [url]
 */
import { chromium } from '@playwright/test';

const URL = process.argv[2] || 'https://fa-euth-dev29-saasfademo1.ds-fa.oraclepdemos.com';
const SETTLE_MS = 4000;              // background.js: "Waiting 4s for content script injection"

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const ctx = await browser.newContext();   // fresh profile => no session, like the recorder after its cookie clear
const page = await ctx.newPage();

const t0 = Date.now();
const docs = [];
const ms = () => Date.now() - t0;

page.on('framenavigated', (f) => {
  if (f !== page.mainFrame()) return;
  docs.push({ at: ms(), kind: 'navigated', url: f.url() });
});
page.on('load', () => {
  docs.push({ at: ms(), kind: 'LOAD (== status complete)', url: page.url() });
});

console.log(`\nlive-login-hops.mjs  ${URL}\n`);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  .catch((e) => console.log('  goto: ' + e.message.split('\n')[0]));
await page.waitForTimeout(20000);

// Detect the edge block before reporting anything as a product finding.
const blocked = await page.evaluate(() => /Access Denied/i.test(document.title)).catch(() => false);
if (blocked) {
  console.log('  *** AKAMAI EDGE BLOCK — headless is refused before Oracle is reached.');
  console.log('  *** This run measures the block, not the login race. Use a headed browser.');
  console.log(`  *** title="${await page.title()}"\n`);
}

console.log('  document timeline:');
for (const d of docs) {
  console.log(`    +${String(d.at).padStart(6)}ms  ${d.kind.padEnd(26)} ${d.url.replace(/^https:\/\//, '').slice(0, 72)}`);
}

const firstLoad = docs.find((d) => d.kind.startsWith('LOAD'));
if (firstLoad && !blocked) {
  const fireAt = firstLoad.at + SETTLE_MS;
  const liveThen = [...docs].filter((d) => d.at <= fireAt).pop();
  console.log('\n  the recorder\'s decision:');
  console.log(`    first complete at +${firstLoad.at}ms on ${firstLoad.url.replace(/^https:\/\//, '').slice(0, 68)}`);
  console.log(`    auto-fill would fire at +${fireAt}ms`);
  console.log(`    document live then       ${liveThen.url.replace(/^https:\/\//, '').slice(0, 68)}`);
  console.log(`\n    page had MOVED ON by fire time: ${liveThen.url !== firstLoad.url}`);
}

console.log(`\n  final url: ${page.url().replace(/^https:\/\//, '').slice(0, 72)}\n`);
await browser.close();
