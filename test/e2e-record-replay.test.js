/**
 * e2e-record-replay.test.js — End-to-end integration test:
 * Records DOM actions on a live fixture page, compiles them to structured actions,
 * and replays them through the Replayer engine to verify 100% faithful playback.
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
  it('records user interactions on fields.html and successfully replays them through the engine', async () => {
    if (!existsSync(WORK)) mkdirSync(WORK, { recursive: true });

    const { server, port } = await startFixtureServer();
    const fixtureUrl = `http://127.0.0.1:${port}/fields.html`;

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to form fixture
    await page.goto(fixtureUrl);

    // Initialize recording event capture in the page
    const recordedEvents = [];
    await page.exposeFunction('__recordEvent', (ev) => {
      recordedEvents.push(ev);
    });

    // Inject the bundled Playwright selector engine into the page
    const selectorEngineSrc = readFileSync(join(recorderRoot, 'dist/selector-engine.js'), 'utf8');
    await page.evaluate((src) => {
      window.eval(src);
    }, selectorEngineSrc);

    // Set up lightweight DOM capture listeners using the injected engine
    await page.evaluate(() => {
      const engine = window.__flowtracePwInjected;

      function emit(type, el, extra = {}) {
        let selector = '';
        if (engine && el) {
          try {
            selector = engine.generateSelectorSimple(el);
          } catch (_) {}
        }
        window.__recordEvent({
          type,
          url: window.location.href,
          selector: selector || (el.id ? '#' + el.id : el.tagName.toLowerCase()),
          label: el.getAttribute('aria-label') || el.name || el.id || '',
          value: el.value !== undefined ? el.value : '',
          tagName: el.tagName.toLowerCase(),
          meta: {
            id: el.id || '',
            name: el.name || '',
            ariaLabel: el.getAttribute('aria-label') || '',
          },
          ...extra,
        });
      }

      // Record initial navigation
      emit('navigate', document.body, { url: window.location.href });

      document.addEventListener('input', (e) => {
        if (e.target.tagName !== 'SELECT') {
          emit('fill', e.target, { value: e.target.value });
        }
      }, true);

      document.addEventListener('change', (e) => {
        if (e.target.tagName === 'SELECT') {
          emit('select', e.target, { value: e.target.value });
        }
      }, true);

      document.addEventListener('click', (e) => {
        emit('click', e.target);
      }, true);
    });

    // Perform real user interactions on the fixture
    await page.locator('#bu').fill('Acme Global');
    await page.locator('#dt').fill('15-Jan-2026');
    await page.locator('#rel').selectOption('1');

    // Wait a brief moment for events to flush
    await page.waitForTimeout(300);
    await browser.close();

    // Verify recorded events
    expect(recordedEvents.length).toBeGreaterThanOrEqual(3);

    // Compile recorded events into FlowTrace structured action envelope
    const actions = compileActions(recordedEvents);
    expect(actions.length).toBeGreaterThanOrEqual(3);

    // Write actions and results paths for Replayer
    const actionsPath = join(WORK, 'e2e-actions.json');
    const resultsPath = join(WORK, 'e2e-results.json');
    if (existsSync(resultsPath)) rmSync(resultsPath);

    writeFileSync(actionsPath, JSON.stringify(actions, null, 2), 'utf8');

    let code, out;
    try {
      // Run the Replayer child process while server is still listening
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
  }, 35_000);
});
