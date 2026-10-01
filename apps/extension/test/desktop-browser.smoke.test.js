/**
 * desktop-browser.smoke.test.js — Integration & Smoke Test for Desktop Browser Host
 *
 * Verifies that DesktopRecorder:
 * 1. Launches a real browser context and injects the pure host-neutral page runtime (dist/page-runtime.js).
 * 2. Captures real DOM interactions (clicks, text inputs, selections) via window.__flowtrace_host_send__.
 * 3. Compiles a canonical Protocol 2.0 RecordingEnvelope via @flowtrace/recorder-core buildRecordingEnvelope().
 * 4. Passes full Zod schema validation (RecordingEnvelopeSchema, SemanticStepV2Schema).
 * 5. Persists the session envelope via DesktopRecorderHost storage.
 */

import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { RecordingEnvelopeSchema, SemanticStepV2Schema } from '@flowtrace/contracts';

const require = createRequire(import.meta.url);
const DesktopRecorder = require('../../desktop/src/desktop-recorder.js');

const here = dirname(fileURLToPath(import.meta.url));
const recorderRoot = resolve(here, '..');
const PAGES = resolve(recorderRoot, 'test', 'pages');
const TEST_STORAGE = resolve(recorderRoot, '.test-desktop-storage');

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

describe('TRACE-64 Desktop Browser Host Integration Smoke Suite', () => {
  it('launches real browser with page-runtime.js, captures user interaction, and emits valid Protocol 2.0 envelope', async () => {
    if (!existsSync(TEST_STORAGE)) mkdirSync(TEST_STORAGE, { recursive: true });

    const { server, port } = await startFixtureServer();
    const fixtureUrl = `http://127.0.0.1:${port}/fields.html`;

    const desktopRecorder = new DesktopRecorder({
      headless: true,
      channel: undefined, // default bundled chromium
      patchId: 'oracle',
      storageDir: TEST_STORAGE,
    });

    try {
      // 1. Start Recording session
      const startResult = await desktopRecorder.startRecording(fixtureUrl, 'instant', 'oracle');
      expect(startResult.success).toBe(true);
      expect(desktopRecorder.isRecording).toBe(true);
      expect(desktopRecorder.browser).not.toBeNull();
      expect(desktopRecorder.context).not.toBeNull();

      // Retrieve the active page
      const page = desktopRecorder.context.pages()[0];
      expect(page).toBeDefined();

      // Wait for page to finish loading
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(300);

      // 2. Perform user interactions on real DOM elements
      // Interaction A: Fill input #dt (Transaction Date)
      await page.click('#dt');
      await page.fill('#dt', '15-Mar-2026');
      await page.dispatchEvent('#dt', 'change');

      // Interaction B: Fill input #bu (Business Unit)
      await page.click('#bu');
      await page.fill('#bu', 'Oracle Cloud ERP Global');
      await page.dispatchEvent('#bu', 'change');

      // Interaction C: Select option in #rel
      await page.selectOption('#rel', '1');

      // Allow event dispatch and debouncer to settle
      await page.waitForTimeout(500);

      // 3. Stop recording and compile canonical Protocol 2.0 envelope
      const stopResult = await desktopRecorder.stopRecording();
      expect(stopResult.success).toBe(true);
      expect(stopResult.envelope).toBeDefined();

      const envelope = stopResult.envelope;

      // 4. Validate Canonical RecordingEnvelope Structure
      expect(envelope.protocolVersion).toBe('2.0');
      expect(envelope.producer.kind).toBe('desktop');
      expect(envelope.producer.platform).toBe(process.platform);
      expect(envelope.capabilities).toContain('multiSurface');
      expect(envelope.meta.sourceUrl).toContain(fixtureUrl);
      expect(Array.isArray(envelope.steps)).toBe(true);
      expect(envelope.steps.length).toBeGreaterThanOrEqual(2);

      // 5. Strict Zod Schema Parse Validation
      const parseResult = RecordingEnvelopeSchema.safeParse(envelope);
      expect(parseResult.success).toBe(true);

      for (const step of envelope.steps) {
        const stepParse = SemanticStepV2Schema.safeParse(step);
        expect(stepParse.success).toBe(true);
        if (step.surfaceId) {
          expect(step.surfaceId).toMatch(/^surf_/);
        }
      }

      // 6. Verify Target Locators for specific fields
      const fillSteps = envelope.steps.filter((s) => s.action === 'fill' || s.action === 'pressSequentially');
      expect(fillSteps.length).toBeGreaterThan(0);

      const dateFill = fillSteps.find((s) => s.value === '15-Mar-2026');
      expect(dateFill).toBeDefined();
      expect(dateFill.locator).toBeDefined();
      expect(dateFill.locator.label || dateFill.locator.name).toBe('Transaction Date');

      const selectStep = envelope.steps.find((s) => s.action === 'selectOption');
      expect(selectStep).toBeDefined();
      expect(selectStep.value).toBe('Alpha');

      // 7. Verify session persisted on disk
      const savedSession = await desktopRecorder.host.storage.loadSession(envelope.recordingSessionId);
      expect(savedSession).not.toBeNull();
      expect(savedSession.envelope.recordingSessionId).toBe(envelope.recordingSessionId);
    } finally {
      if (desktopRecorder.browser) {
        try { await desktopRecorder.browser.close(); } catch (_) {}
      }
      server.close();
      try { rmSync(TEST_STORAGE, { recursive: true, force: true }); } catch (_) {}
    }
  }, 30000);
});
