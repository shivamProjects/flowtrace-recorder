/**
 * desktop-recorder.js — Observational Desktop Recorder Engine.
 *
 * Uses Playwright solely as a host shell to launch Chromium and expose the event bridge.
 * All user interaction capture, element inspection, locator construction, and patch
 * transformations run through the unified pure @flowtrace/recorder-core engine.
 *
 * Zero Playwright Codegen, zero _enableRecorder(), zero CDP interception.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const { DesktopRecorderHost } = require('./host/desktop-host');
const LoggerService = require('../services/logger.service');

function detectBrowserChannel() {
  const candidates = process.platform === 'darwin'
    ? [
        { channel: 'chrome', exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
        { channel: 'msedge', exe: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      ]
    : [
        { channel: 'chrome', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
        { channel: 'chrome', exe: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
        {
          channel: 'chrome',
          exe: process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe')
            : '',
        },
        { channel: 'msedge', exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
        { channel: 'msedge', exe: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
      ];
  for (const { channel, exe } of candidates) {
    if (exe && fsSync.existsSync(exe)) return channel;
  }
  return null;
}

class DesktopRecorder {
  constructor() {
    this.browser = null;
    this.context = null;
    this.isRecording = false;
    this.originalUrl = null;
    this.recordingMode = 'instant';
    this.patchId = 'oracle';
    this.events = [];
    this.host = new DesktopRecorderHost();
    this.pageSurfaceMap = new WeakMap();
    this.surfaceCounter = 1;
    this.sessionId = `session_${Date.now()}`;
  }

  async _loadCore() {
    if (!this._core) {
      this._core = await import('@flowtrace/recorder-core');
    }
    return this._core;
  }

  async startRecording(url, mode = 'instant', patchId = 'oracle') {
    const startTime = Date.now();
    LoggerService.logStep(1, 'Initializing Observational DesktopRecorder with Pure Core');
    try {
      if (this.isRecording) {
        return { success: false, error: 'Recording already in progress' };
      }

      const core = await this._loadCore();
      this.isRecording = true;
      this.originalUrl = url;
      this.recordingMode = mode;
      this.patchId = patchId;
      this.events = [];
      this.sessionId = `session_${Date.now()}`;

      const channel = detectBrowserChannel();
      const launchOptions = {
        headless: false,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-default-browser-check',
        ],
      };
      if (channel) launchOptions.channel = channel;

      this.browser = await chromium.launch(launchOptions);
      this.context = await this.browser.newContext({
        viewport: null,
      });

      // Expose pure host event sink to browser runtime
      await this.context.exposeBinding('__flowtrace_host_send__', ({ page }, payload) => {
        if (!this.isRecording) return;
        if (payload && payload.action === 'RECORD_EVENT' && payload.event) {
          const event = payload.event;
          const surfaceId = this.pageSurfaceMap.get(page) || `surface_main`;
          event.surfaceId = surfaceId;
          event.timestamp = event.timestamp || Date.now();
          this.events.push(event);
          this.host.storage.appendEvent(event);
        }
      });

      // Find extension bundle dist
      const extDist = path.resolve(__dirname, '../../extension/dist');
      const selectorEnginePath = path.join(extDist, 'selector-engine.js');
      const contentScriptPath = path.join(extDist, 'content.js');

      if (fsSync.existsSync(selectorEnginePath)) {
        await this.context.addInitScript({ path: selectorEnginePath });
      }

      // Inject observational page recorder bootstrap
      await this.context.addInitScript(`
        (() => {
          window.__FLOWTRACE_DESKTOP_HOST__ = true;
          window.__flowtrace_patch_id__ = ${JSON.stringify(this.patchId)};
        })();
      `);

      if (fsSync.existsSync(contentScriptPath)) {
        await this.context.addInitScript({ path: contentScriptPath });
      }

      // Track multi-window surfaces and navigations
      this.context.on('page', (page) => {
        const surfaceId = `surface_popup_${this.surfaceCounter++}`;
        this.pageSurfaceMap.set(page, surfaceId);

        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) {
            const navUrl = frame.url();
            if (navUrl && !navUrl.startsWith('about:')) {
              this.events.push({
                type: 'navigate',
                url: navUrl,
                surfaceId,
                timestamp: Date.now(),
              });
            }
          }
        });

        page.on('download', (download) => {
          this.events.push({
            type: 'download',
            url: download.url(),
            filename: download.suggestedFilename(),
            surfaceId,
            timestamp: Date.now(),
          });
        });
      });

      this.browser.on('disconnected', () => {
        this.isRecording = false;
        this.browser = null;
        this.context = null;
      });

      let page = this.context.pages()[0];
      if (!page) page = await this.context.newPage();
      this.pageSurfaceMap.set(page, 'surface_main');

      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
          const navUrl = frame.url();
          if (navUrl && !navUrl.startsWith('about:')) {
            this.events.push({
              type: 'navigate',
              url: navUrl,
              surfaceId: 'surface_main',
              timestamp: Date.now(),
            });
          }
        }
      });

      const startUrl = mode === 'manual' ? 'about:blank' : url;
      if (startUrl && startUrl !== 'about:blank') {
        page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((err) => {
          console.warn('[desktop-recorder] initial navigation warning:', err.message);
        });
      }

      const message = mode === 'manual'
        ? 'Browser opened in manual mode. Navigate to your desired page and perform your actions. Close the browser when finished.'
        : 'Recording started. Perform your actions, then close the browser window or click Stop to finish.';

      return { success: true, message };
    } catch (error) {
      console.error('Error starting recording:', error.message);
      this.isRecording = false;
      return { success: false, error: error.message };
    }
  }

  async stopRecording() {
    const startTime = Date.now();
    LoggerService.logStep(1, 'Stopping Observational DesktopRecorder and Compiling Envelope');
    try {
      if (!this.isRecording && !this.browser) {
        if (this.events.length > 0) return await this.processRecording();
        return { success: false, error: 'No recording in progress' };
      }

      if (this.browser) {
        try { await this.browser.close(); } catch (_) {}
        this.browser = null;
        this.context = null;
      }
      this.isRecording = false;

      return await this.processRecording();
    } catch (error) {
      console.error('Error stopping recording:', error.message);
      return { success: false, error: error.message };
    }
  }

  async processRecording() {
    const startTime = Date.now();
    LoggerService.logStep(1, 'Processing pure observational events through @flowtrace/recorder-core');
    try {
      const core = await this._loadCore();
      const patch = core.getPatch(this.patchId);

      // 1. Post-process events through patch
      let processed = [...this.events];
      if (patch && typeof patch.postProcess === 'function') {
        processed = patch.postProcess(processed, {
          sessionId: this.sessionId,
          sourceUrl: this.originalUrl,
        });
      }

      // 2. Navigation & action deduplication
      if (typeof core.dedupEvents === 'function') {
        processed = core.dedupEvents(processed);
      }

      // 3. Structured actions compilation
      const actions = core.compileActions(processed);
      const steps = core.compileSteps ? core.compileSteps(processed) : [];
      const script = core.compileScript
        ? core.compileScript(processed, { sourceUrl: this.originalUrl, events: this.events }, patch)
        : '';

      const envelope = {
        schemaVersion: '2.0',
        sessionId: this.sessionId,
        sourceUrl: this.originalUrl || '',
        recordedAt: new Date().toISOString(),
        hostType: 'desktop',
        patch: {
          id: patch?.id || this.patchId,
          version: patch?.version || '1.0.0',
        },
        actions,
        steps,
        rawEventCount: this.events.length,
        processedEventCount: processed.length,
      };

      return {
        success: true,
        actions,
        steps,
        script,
        envelope,
        count: actions.length,
      };
    } catch (error) {
      console.error('Error processing recording:', error.message);
      return { success: false, error: error.message };
    }
  }

  async saveRecording(filename, actions) {
    const startTime = Date.now();
    LoggerService.logStep(1, `Saving Desktop Recording locally: ${filename}`);
    try {
      const dir = path.join(os.tmpdir(), 'flowtrace-recorder', 'recordings');
      await fs.mkdir(dir, { recursive: true });
      const filepath = path.join(dir, `${filename}.json`);
      await fs.writeFile(filepath, JSON.stringify(actions, null, 2));
      return { success: true, filepath, message: `Recording saved to ${filepath}` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async loadRecording(filename) {
    try {
      const filepath = path.join(os.tmpdir(), 'flowtrace-recorder', 'recordings', `${filename}.json`);
      const data = await fs.readFile(filepath, 'utf8');
      return { success: true, actions: JSON.parse(data), message: `Recording loaded from ${filepath}` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  getStatus() {
    return {
      isRecording: this.isRecording,
      hasBrowser: !!this.browser,
      eventCount: this.events.length,
      sessionId: this.sessionId,
    };
  }
}

module.exports = DesktopRecorder;
