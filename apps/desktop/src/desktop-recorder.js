/**
 * desktop-recorder.js — Observational Desktop Recorder Engine.
 *
 * Uses Playwright solely as a host shell to launch Chromium and expose the event bridge.
 * All interaction capture, element targeting, locators, and patch transformations
 * run through the pure @flowtrace/recorder-core engine and DesktopRecorderHost.
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
  constructor(options = {}) {
    this.options = options;
    this.browser = null;
    this.context = null;
    this.isRecording = false;
    this.originalUrl = null;
    this.recordingMode = 'instant';
    this.patchId = options.patchId || 'oracle';
    this.events = [];
    this.sessionId = `sess_desk_${Date.now()}`;
    this.host = new DesktopRecorderHost({ sessionId: this.sessionId, storageDir: options.storageDir });
  }

  async _loadCore() {
    if (!this._core) {
      this._core = await import('@flowtrace/recorder-core');
    }
    return this._core;
  }

  async startRecording(url, mode = 'instant', patchId = 'oracle') {
    const startTime = Date.now();
    LoggerService.logStep(1, 'Initializing Observational DesktopRecorder with Pure Core and DesktopRecorderHost');
    try {
      if (this.isRecording) {
        return { success: false, error: 'Recording already in progress' };
      }

      await this._loadCore();
      this.isRecording = true;
      this.originalUrl = url;
      this.recordingMode = mode;
      this.patchId = patchId || this.options.patchId || 'oracle';
      this.events = [];
      this.sessionId = `sess_desk_${Date.now()}`;
      this.host = new DesktopRecorderHost({ sessionId: this.sessionId, storageDir: this.options.storageDir });

      const channel = this.options.channel !== undefined ? this.options.channel : detectBrowserChannel();
      const isHeadless = this.options.headless !== undefined
        ? this.options.headless
        : (process.env.PLAYWRIGHT_HEADLESS === 'true' || process.env.CI === 'true' || false);
      const launchOptions = {
        headless: isHeadless,
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
          const surface = this.host.surfaces.getSurfaceByPage(page) || this.host.surfaces.registerPage(page);
          event.surfaceId = surface.surfaceId;
          event.timestamp = event.timestamp || Date.now();
          this.events.push(event);
          this.host.storage.appendEvent(event);
        }
      });

      // Inject host-neutral recorder runtime (page-runtime.js + selector-engine.js)
      await this.host.injector.injectRecorderRuntime(this.context, this.patchId);

      // Track multi-window surfaces and navigations through host observers
      this.context.on('page', (page) => {
        const surface = this.host.surfaces.registerPage(page, 'popup');

        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) {
            const navUrl = frame.url();
            if (navUrl && !navUrl.startsWith('about:')) {
              const navEvent = {
                type: 'navigate',
                url: navUrl,
                surfaceId: surface.surfaceId,
                timestamp: Date.now(),
              };
              this.events.push(navEvent);
              this.host.navigation.emitCompleted(navUrl, surface.surfaceId, 200);
            }
          }
        });

        page.on('download', (download) => {
          const dlEvent = {
            type: 'download',
            url: download.url(),
            filename: download.suggestedFilename(),
            surfaceId: surface.surfaceId,
            timestamp: Date.now(),
          };
          this.events.push(dlEvent);
          this.host.downloads.emitStarted({
            id: `dl_${Date.now()}`,
            url: download.url(),
            filename: download.suggestedFilename(),
          });
        });

        page.on('close', () => {
          this.host.surfaces.unregisterPage(page);
        });
      });

      this.browser.on('disconnected', () => {
        this.isRecording = false;
        this.browser = null;
        this.context = null;
        this.host.lifecycle.emitStop();
      });

      let page = this.context.pages()[0];
      if (!page) page = await this.context.newPage();
      const mainSurface = this.host.surfaces.registerPage(page, 'tab');

      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
          const navUrl = frame.url();
          if (navUrl && !navUrl.startsWith('about:')) {
            const navEvent = {
              type: 'navigate',
              url: navUrl,
              surfaceId: mainSurface.surfaceId,
              timestamp: Date.now(),
            };
            this.events.push(navEvent);
            this.host.navigation.emitCompleted(navUrl, mainSurface.surfaceId, 200);
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

      return { success: true, message, sessionId: this.sessionId };
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
      this.host.lifecycle.emitStop();

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

      // 4. Build strictly validated canonical Protocol 2.0 RecordingEnvelope
      const envelope = core.buildRecordingEnvelope({
        recordingSessionId: this.sessionId.startsWith('sess_')
          ? undefined // Let factory generate clean UUID if needed
          : this.sessionId,
        recordedAt: new Date().toISOString(),
        producer: {
          kind: 'desktop',
          version: '1.0.0',
          platform: process.platform,
        },
        capabilities: ['multiSurface', 'nestedFrames', 'downloads', 'oracleADF'],
        meta: {
          sourceUrl: this.originalUrl || 'about:blank',
          patchId: patch?.id || this.patchId,
        },
        steps: actions,
      });

      // Persist session envelope in host storage
      await this.host.storage.saveSession({
        envelope,
        rawEvents: this.events,
        processedEvents: processed,
      });

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
