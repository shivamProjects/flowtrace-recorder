import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '../dist');
const DIST_BG_PATH = path.resolve(DIST_DIR, 'background.js');
const PINNED_EXT_ID = 'ijbehkijmihjnhbmbdmoglbbajbkadbd';

describe('TRACE-96: MV3 Service Worker Bootstrap (Worker-Safe Imports)', () => {
  it('boots dist/background.js cleanly in a DOM-free VM (no window, document, or history) and registers all listeners', () => {
    const code = fs.readFileSync(DIST_BG_PATH, 'utf8');
    const listeners = { startup: 0, installed: 0, internal: 0, external: 0 };

    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Promise,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      crypto: globalThis.crypto,
      fetch: async () => ({}),
      chrome: {
        runtime: {
          id: 'ijbehkijmihjnhbmbdmoglbbajbkadbd',
          getManifest: () => ({ version: '1.0.0' }),
          onStartup: { addListener: () => listeners.startup++ },
          onInstalled: { addListener: () => listeners.installed++ },
          onMessage: { addListener: () => listeners.internal++ },
          onMessageExternal: { addListener: () => listeners.external++ },
        },
        storage: {
          local: {
            get: async () => ({}),
            set: async () => {},
            remove: async () => {},
          },
        },
        tabs: { query: async () => [], sendMessage: async () => ({}) },
        scripting: { executeScript: async () => [] },
        action: {
          setBadgeText: async () => {},
          setBadgeBackgroundColor: async () => {},
        },
      },
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;

    // Must not throw ReferenceError: window/document/history is not defined
    vm.runInNewContext(code, sandbox);

    expect(listeners.startup).toBe(1);
    expect(listeners.installed).toBe(1);
    expect(listeners.internal).toBe(1);
    expect(listeners.external).toBe(1);
  });

  it('loads built extension in real Chromium, registers internal+external listeners, and responds to external PING_EXTENSION', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-worker-smoke-'));

    let context;
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless: true,
        args: [
          `--disable-extensions-except=${DIST_DIR}`,
          `--load-extension=${DIST_DIR}`,
        ],
      });

      let [sw] = context.serviceWorkers();
      if (!sw) {
        sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
      }
      expect(sw.url()).toBe(`chrome-extension://${PINNED_EXT_ID}/background.js`);

      const workerDiagnostics = await sw.evaluate(() => ({
        runtimeId: chrome.runtime.id,
        externalListener: chrome.runtime.onMessageExternal?.hasListeners?.() ?? false,
        internalListener: chrome.runtime.onMessage?.hasListeners?.() ?? false,
        windowType: typeof window,
      }));
      expect(workerDiagnostics).toEqual({
        runtimeId: PINNED_EXT_ID,
        externalListener: true,
        internalListener: true,
        windowType: 'undefined',
      });

      const page = await context.newPage();
      await page.route('http://localhost:3200/ping-smoke', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><html><body><h1>FlowTrace Ping Smoke</h1></body></html>',
        }),
      );
      await page.goto('http://localhost:3200/ping-smoke');

      const pingRes = await page.evaluate(
        (extId) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('PING_EXTENSION timed out')), 5000);
            chrome.runtime.sendMessage(extId, { action: 'PING_EXTENSION' }, (res) => {
              clearTimeout(timer);
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                resolve(res);
              }
            });
          }),
        PINNED_EXT_ID,
      );

      expect(pingRes).toMatchObject({
        success: true,
        isRecording: false,
      });
      expect(Array.isArray(pingRes.capabilities)).toBe(true);
      expect(pingRes.capabilities).toContain('launch_intent_v1');
    } finally {
      await context?.close().catch(() => {});
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
