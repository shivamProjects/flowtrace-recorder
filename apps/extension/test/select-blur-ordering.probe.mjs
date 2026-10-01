/**
 * The recorder does not record a click when the click event fires — it schedules
 * _commitPendingClickAction() on a 200ms timer. A blur-recorded select step is
 * emitted synchronously. So the real question is not "does blur precede click"
 * (it does, proven) but: does the select step still land before the CLICK STEP
 * once that 200ms deferral is applied?
 *
 * Models both timelines against real trusted-input timings.
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const FIXTURE = 'D:/WorkingProjects/flowtrace/replayer/checks/pages/adf-invoice-type-select.html';
const body = readFileSync(FIXTURE, 'utf8');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.setContent(body + `
  <button id="save" type="button">Save</button>
  <script>
    window.__t = [];
    const t0 = performance.now();
    const rec = (t) => (e) => {
      const id = e.target && e.target.id ? (e.target.id === 'save' ? 'save' : 'select') : 'other';
      window.__t.push({ ev: t, on: id, at: +(performance.now() - t0).toFixed(1) });
    };
    for (const t of ['input','change','blur','click'])
      document.addEventListener(t, rec(t), true);
    window.__reset = () => { window.__t = []; };
  </script>`);

const SEL = 'select#pt1\\:_FOr1\\:1\\:_FONSr2\\:0\\:MAnt2\\:0\\:pm1\\:r1\\:0\\:ap1\\:r2\\:0\\:so1\\:\\:content';
const client = await page.context().newCDPSession(page);
const key = async (k, code) => {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: code });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp',   key: k, code: k, windowsVirtualKeyCode: code });
};

// Same-value re-pick, then IMMEDIATELY click Save — the tightest realistic race.
await page.selectOption(SEL, { index: 0 });
await page.focus(SEL);
await page.waitForTimeout(150);
await page.evaluate(() => window.__reset());
await key('ArrowUp', 38);               // no movement, no events
await page.locator('#save').click();    // blur + click
await page.waitForTimeout(400);

const t = await page.evaluate(() => window.__t.slice());
console.log('\nraw event timeline (ms from probe start):');
for (const e of t) console.log(`   ${String(e.at).padStart(7)}  ${e.ev} <- ${e.on}`);

const blur = t.find((e) => e.ev === 'blur' && e.on === 'select');
const click = t.find((e) => e.ev === 'click' && e.on === 'save');

if (!blur || !click) {
  console.log('\nFAIL: expected both a select blur and a save click');
  await browser.close();
  process.exit(1);
}

// Recorder timings: select step emitted at blur (synchronous);
// click step committed 200ms after the click event.
const selectStepAt = blur.at;
const clickStepAt = click.at + 200;

console.log('\n--- as the RECORDER would order them -------------------');
console.log(`   select step emitted at blur      : ${selectStepAt.toFixed(1)}ms`);
console.log(`   click  step committed at click+200: ${clickStepAt.toFixed(1)}ms`);
console.log(`   margin                            : ${(clickStepAt - selectStepAt).toFixed(1)}ms`);
const ok = selectStepAt < clickStepAt;
console.log(`   ORDER CORRECT (select before click): ${ok}`);

// Worst case: even with NO deferral on the click, does blur still win?
const okNoDefer = blur.at < click.at;
console.log(`   still correct if click were instant: ${okNoDefer}`);

await browser.close();
process.exit(ok && okNoDefer ? 0 : 1);
