/**
 * e2e-record-replay.test.js — End-to-end integration test:
 * Records DOM actions using the REAL built content.js (not a synthetic shim),
 * compiles them to structured actions, and replays them through the Replayer
 * engine to verify 100% faithful playback.
 *
 * TRACE-007: Previously this test injected a hand-written 3-listener shim via
 * page.evaluate(), making capture.js, shadow DOM logic, credential detection,
 * and oracle patches completely invisible to the test. This version loads the
 * real dist/content.js via addScriptTag so any regression in capture.js will
 * cause this test to fail.
 */
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

import { compileActions } from '../src/core/background/compiler.js';

const here = dirname(fileURLToPath(import.meta.url));
const recorderRoot = resolve(here, '..');
const replayerRoot = resolve(here, '../../replayer');
const PAGES = resolve(replayerRoot, 'checks/pages');
const WORK = resolve(recorderRoot, '.work-e2e');

const require = createRequire(join(replayerRoot, 'package.json'));
const PW_CLI = join(dirname(require.resolve('@playwright/test/package.json')), 'cli.js');

function startFixtureServer() {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const name = req.url.replace(/^\//, '').split('?')[0];
      const file = join(PAGES, name);
      if (!name || !existsSync(file)) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => {
      done({ server, port: server.address().port });
    });
  });
}

function runReplayer(actionsPath, resultsPath) {
  return new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [PW_CLI, 'test', '--reporter=line', '--workers=1', '--retries=0'],
      {
        cwd: replayerRoot,
        env: {
          ...process.env,
          JOB_ACTIONS_PATH: actionsPath,
          JOB_RESULTS_PATH: resultsPath,
          PLAYWRIGHT_HEADLESS: 'true',
          REPLAY_ALLOW_PRIVATE_HOSTS: 'true',
          AI_RECOVERY_ENABLED: 'false',
        },
      },
    );
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => done({ code, out }));
    child.on('error', reject);
  });
}

describe('End-to-End Recording and Replay Verification', () => {
  it('records user interactions via the real content.js and successfully replays them', async () => {
    if (!existsSync(WORK)) mkdirSync(WORK, { recursive: true });

    const { server, port } = await startFixtureServer();
    const fixtureUrl = `http://127.0.0.1:${port}/fields.html`;

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // ── Step 1: Expose the event collector BEFORE navigating ──────────────────
    // Events emitted by the real content.js will arrive via chrome.runtime.sendMessage.
    // We intercept them here and accumulate into recordedEvents.
    const recordedEvents = [];
    await page.exposeFunction('__recordEvent', (ev) => {
      recordedEvents.push(ev);
    });

    // ── Step 2: Inject chrome API stub BEFORE content.js loads ────────────────
    // content.js calls chrome.runtime.sendMessage / chrome.runtime.onMessage.
    // In a plain Playwright page context there is no chrome object. We inject a
    // minimal stub that:
    //   - Routes RECORD_EVENT messages → window.__recordEvent (our collector)
    //   - Provides onMessage.addListener so the content script can register
    //   - Provides runtime.id so the guard in bus.js does not short-circuit
    await page.addInitScript(() => {
      const messageListeners = [];
      window.chrome = {
        runtime: {
          id: 'flowtrace-e2e-stub',
          lastError: undefined,
          sendMessage(msg, cb) {
            // Route recorder events to the Node-side collector
            if (msg && msg.action === 'RECORD_EVENT' && msg.event) {
              if (typeof window.__recordEvent === 'function') {
                window.__recordEvent(msg.event);
              }
            }
            // Acknowledge all other messages (GET_STATUS, PATCH_CONTEXT_UPDATE, etc.)
            if (typeof cb === 'function') {
              setTimeout(() => { cb(null); }, 0);
            }
          },
          onMessage: {
            addListener(fn) {
              messageListeners.push(fn);
            },
          },
        },
      };
      // Expose a helper so we can trigger __flowtrace_activate__ after navigation
      window.__flowtraceMessageListeners = messageListeners;
    });

    // ── Step 3: Navigate to fixture ───────────────────────────────────────────
    await page.goto(fixtureUrl);

    // ── Step 4: Load the real bundled content script ───────────────────────────
    // This is the critical difference from the old shim approach: we load the
    // actual dist/content.js so capture.js, dom.js, shadow DOM logic, credential
    // detection, and oracle patches are all exercised.
    await page.addScriptTag({ path: join(recorderRoot, 'dist/content.js') });

    // ── Step 5: Activate recording via the real content script mechanism ───────
    // index.js listens for __flowtrace_activate__ window events to start capture.
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('__flowtrace_activate__', {
        detail: { patchId: 'generic' },
      }));
    });

    // Brief pause for activation to settle
    await page.waitForTimeout(100);

    // ── Step 6: Perform real user interactions ─────────────────────────────────
    await page.locator('#bu').fill('Acme Global');
    await page.locator('#dt').fill('15-Jan-2026');
    await page.locator('#rel').selectOption('1');

    // Wait for fill debounce (600ms) to flush, plus a buffer
    await page.waitForTimeout(800);

    await browser.close();

    // ── Step 7: Verify real capture.js emitted events ─────────────────────────
    // The real capture.js has a 600ms fill debounce, so we expect at least the
    // 3 interactions (fill, fill, select) plus the navigate event.
    expect(recordedEvents.length, 'Real capture.js should have emitted events').toBeGreaterThanOrEqual(3);

    // Verify event structure matches the real RecordedEvent schema (has selector,
    // label, locator — not just the shim's minimal fields)
    const fillEvents = recordedEvents.filter(e => e.type === 'fill');
    expect(fillEvents.length, 'Should have fill events from real onInput handler').toBeGreaterThanOrEqual(1);
    expect(fillEvents[0]).toHaveProperty('selector');
    expect(fillEvents[0]).toHaveProperty('label');
    expect(fillEvents[0]).toHaveProperty('locator');

    // ── Step 8: Compile and replay ────────────────────────────────────────────
    const allEvents = [{ type: 'navigate', url: fixtureUrl }, ...recordedEvents];
    const actions = compileActions(allEvents);
    expect(actions.length).toBeGreaterThanOrEqual(4);

    const actionsPath = join(WORK, 'e2e-actions.json');
    const resultsPath = join(WORK, 'e2e-results.json');
    if (existsSync(resultsPath)) rmSync(resultsPath);

    writeFileSync(actionsPath, JSON.stringify(actions, null, 2), 'utf8');

    let code, out;
    try {
      const res = await runReplayer(actionsPath, resultsPath);
      code = res.code;
      out = res.out;
    } finally {
      server.close();
    }

    if (!existsSync(resultsPath)) {
      console.error('Replayer failed to write results.json. Output:\n', out);
    }
    expect(existsSync(resultsPath)).toBe(true);
    const results = JSON.parse(readFileSync(resultsPath, 'utf8'));

    if (!results.success) {
      console.error('Replayer failed! Results:\n', JSON.stringify(results, null, 2), '\nEngine Output:\n', out);
    }

    expect(results.success).toBe(true);
    const passed = results.results.filter((r) => r.status === 'success').length;
    const failed = results.results.filter((r) => r.status === 'failed').length;
    expect(failed).toBe(0);
    expect(passed).toBeGreaterThanOrEqual(3);

    // Cleanup
    if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true });
  }, 45_000);
});
