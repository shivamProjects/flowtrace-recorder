const { chromium } = require('playwright');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { classifyOracleField, normalizeText } = require('./utils/oracleFieldClassifier');
const LoggerService = require('./services/logger.service');
const CodegenParserService = require('./services/codegen-parser.service');

// Detect an installed system browser so Playwright does not need its own Chromium.
function detectBrowserChannel() {
  const candidates = process.platform === 'darwin'
    ? [
        { channel: 'chrome',  exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
        { channel: 'msedge',  exe: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' }
      ]
    : [
        { channel: 'chrome',  exe: 'C:Program FilesGoogleChromeApplicationchrome.exe' },
        { channel: 'chrome',  exe: 'C:Program Files (x86)GoogleChromeApplicationchrome.exe' },
        { channel: 'chrome',  exe: process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, 'GoogleChromeApplicationchrome.exe')
            : '' },
        { channel: 'msedge',  exe: 'C:Program Files (x86)MicrosoftEdgeApplicationmsedge.exe' },
        { channel: 'msedge',  exe: 'C:Program FilesMicrosoftEdgeApplicationmsedge.exe' }
      ];
  for (const { channel, exe } of candidates) {
    if (exe && fsSync.existsSync(exe)) return channel;
  }
  return null;
}

class CodegenRecorder {
  constructor() {
    this.browser = null;
    this.outputFile = null;
    this.isRecording = false;
    this.originalUrl = null;
    this.recordingMode = 'instant';
    this.selectOptionMap = {}; // value → label, captured during recording
    this.nthCellRowMap = {};  // 'cellText::nth(N)' → { row, cells }, captured during recording
  }

  async startRecording(url, mode = 'instant') {
    const startTime = Date.now();
    LoggerService.logStep(1, 'Initializing CodegenRecorder and Playwright browser');
    try {
      if (this.isRecording) {
        return { success: false, error: 'Recording already in progress' };
      }

      this.isRecording = true;
      this.originalUrl = url;
      this.recordingMode = mode;

      const timestamp = Date.now();
      const tempDir = path.join(os.tmpdir(), 'flowtrace-recorder');
      this.outputFile = path.join(tempDir, `recording-${timestamp}.js`);
      await fs.mkdir(tempDir, { recursive: true });

      const startUrl = mode === 'manual' ? 'about:blank' : url;

      // Suppress Playwright Inspector floating window
      process.env.PWTEST_CLI_HEADLESS = '1';

      const channel = detectBrowserChannel();
      const launchOptions = { headless: false, args: ['--remote-debugging-port=9222'] };
      if (channel) launchOptions.channel = channel;

      this.browser = await chromium.launch(launchOptions);
      // viewport: null fills the window
      const context = await this.browser.newContext({
        viewport: null
      });

      // Hide Playwright's recorder overlay / inspect-mode toolbar via CSS.
      // Also capture select value→label when user picks a dropdown during recording.
      await context.addInitScript({ path: require('path').join(__dirname, 'scripts', 'oracle-adf-tracker.js') });

      await context._enableRecorder({
        language: 'javascript',
        launchOptions: { headless: false },
        contextOptions: { viewport: { width: 1280, height: 720 } },
        mode: 'recording',
        outputFile: path.resolve(this.outputFile),
        handleSIGINT: false
      });

      this.browser.on('disconnected', () => {
        this.isRecording = false;
        this.browser = null;
      });

      this.selectOptionMap = {};
      this.liveRequiredFields = {};
      this.lovCellMap = {};
      this.nthCellRowMap = {};
      this.datePickerMap = {};
      this.dateInputValueMap = {};    // targetFieldId → actual committed input value from the date field
      this.menuItemSet = new Set();   // text of items clicked inside a menu/popup — used to rewrite getByText/nth menu clicks to role=menuitem
      this.navTileClicks = [];        // ordered clicks inside #itemNode_* nav tiles with expansion metadata — attached to actions in post-processing
      this.openerCommittedMap = {};   // composite-picker family — openerTitle → final committed value captured via DOM-proximity binding after dialog OK
      this.committedValueMap = {};    // fieldName → final ADF-committed value (from change event / post-OK scan)
      this.checkboxToggles = [];      // ordered { label, newChecked, checkboxId, tagName } per checkbox click — used to rewrite click → check()/uncheck()
      const self = this;
      const attachConsoleListener = (p) => {
        p.on('console', (msg) => {
          const text = msg.text();
          if (text.startsWith('__flowtrace_SELECT__:')) {
            try {
              const { value, label, fieldName, name, id } = JSON.parse(text.slice('__flowtrace_SELECT__:'.length));
              if (value !== undefined && label) self.selectOptionMap[value] = label;
              // Map select name/id → field label for stable selector generation
              if (name && fieldName) {
                if (!self.selectFieldMap) self.selectFieldMap = {};
                self.selectFieldMap[name] = fieldName;
              }
            } catch (_) {}
          } else if (text.startsWith('__flowtrace_LOV_CELL__:')) {
            try {
              const { cell, row, cells, nthIndex } = JSON.parse(text.slice('__flowtrace_LOV_CELL__:'.length));
              if (cell && cells && cells.length > 0) {
                self.lovCellMap[cell] = cells[0];
                self.lovCellMap['__row__' + cell] = row;
                if (nthIndex !== undefined && nthIndex >= 0) {
                  if (!self.nthCellRowMap) self.nthCellRowMap = {};
                  const key = `${cell}::nth(${nthIndex})`;
                  self.nthCellRowMap[key] = { row, cells };
                }
              }
            } catch (_) {}
          } else if (text.startsWith('__flowtrace_DATE_CELL__:')) {
            try {
              const data = JSON.parse(text.slice('__flowtrace_DATE_CELL__:'.length));
              if (data.day && data.fullDate) {
                if (!self.datePickerMap) self.datePickerMap = {};
                const key = String(data.day);
                self.datePickerMap[key] = {
                  fullDate: data.fullDate,
                  day: data.day,
                  month: data.month,
                  year: data.year,
                  monthOffset: data.monthOffset || 0,
                  targetFieldId: data.targetFieldId || ''
                };
              }
            } catch (_) {}
          } else if (text.startsWith('__flowtrace_DATE_INPUT_VALUE__:')) {
            try {
              const { targetFieldId, inputValue } = JSON.parse(text.slice('__flowtrace_DATE_INPUT_VALUE__:'.length));
              if (targetFieldId && inputValue) {
                if (!self.dateInputValueMap) self.dateInputValueMap = {};
                self.dateInputValueMap[targetFieldId] = inputValue;
              }
            } catch (_) {}
          } else if (text.startsWith('__flowtrace_DATE_NAV__:')) {
            // Ignored
          } else if (text.startsWith('__flowtrace_COMBOBOX_VALUE__:')) {
            try {
              const { fieldName, value } = JSON.parse(text.slice('__flowtrace_COMBOBOX_VALUE__:'.length));
              if (fieldName && value) {
                if (!self.comboboxValueMap) self.comboboxValueMap = {};
                self.comboboxValueMap[fieldName] = value;
              }
            } catch (_) {}
          } else if (text.startsWith('__flowtrace_CHECKBOX__:')) {
            try {
              const { label, newChecked, checkboxId, tagName } = JSON.parse(text.slice('__flowtrace_CHECKBOX__:'.length));
              if (!label) return;
              if (!self.checkboxToggles) self.checkboxToggles = [];
              self.checkboxToggles.push({ label, newChecked: !!newChecked, checkboxId: checkboxId || '', tagName: tagName || '' });
            } catch (_) {}
          } else if (text.startsWith('__flowtrace_COMMITTED_VALUE__:')) {
            try {
              const payload = JSON.parse(text.slice('__flowtrace_COMMITTED_VALUE__:'.length));
              const { fieldName, value, source, openerTitle } = payload;
              if (fieldName && value) {
                if (!self.committedValueMap) self.committedValueMap = {};
                self.committedValueMap[fieldName] = value;
                if (source === 'post-ok-binding' && openerTitle) {
                  if (!self.openerCommittedMap) self.openerCommittedMap = {};
                  self.openerCommittedMap[openerTitle] = value;
                }
              }
            } catch (_) {}
          } else if (text.startsWith('__flowtrace_OPENER_TARGET__:')) {
            // Ignored
          } else if (text.startsWith('__flowtrace_REQUIRED__:')) {
            try {
              const fields = JSON.parse(text.slice('__flowtrace_REQUIRED__:'.length));
              Object.assign(self.liveRequiredFields, fields);
            } catch (_) {}
          } else if (text.startsWith('__flowtrace_MENU_ITEM__:')) {
            try {
              const { text: itemText } = JSON.parse(text.slice('__flowtrace_MENU_ITEM__:'.length));
              if (itemText) {
                if (!self.menuItemSet) self.menuItemSet = new Set();
                self.menuItemSet.add(itemText);
              }
            } catch (_) {}
          } else if (text.startsWith('__flowtrace_NAV_TILE_CLICK__:')) {
            try {
              const data = JSON.parse(text.slice('__flowtrace_NAV_TILE_CLICK__:'.length));
              if (data && data.tileId) {
                if (!self.navTileClicks) self.navTileClicks = [];
                self.navTileClicks.push(data);
              }
            } catch (_) {}
          }
        });
      };
      // Attach popup listener BEFORE creating the first page so no popup is missed
      context.on('page', attachConsoleListener);
      let page = context.pages()[0];
      if (!page) page = await context.newPage();
      attachConsoleListener(page);

      if (startUrl && startUrl !== 'about:blank') {
        page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((err) => {
          console.error('Initial page.goto failed:', err.message);
        });
      }

      const message = mode === 'manual'
        ? 'Browser opened in manual mode. Navigate to your desired page and perform your actions. Close the browser when finished.'
        : 'Recording started. Perform your actions, then close the browser window to stop recording.';

      return { success: true, message };

    } catch (error) {
      console.error('Error starting recording:', error.message);
      this.isRecording = false;
      if (error.message && (error.message.includes('Executable does not exist') || error.message.includes('browserType.launch'))) {
        return { success: false, error: 'Browser not installed. Run: npx playwright install chromium' };
      }
      return { success: false, error: error.message };
    }
  }

  async stopRecording() {
    const startTime = Date.now();
    LoggerService.logStep(1, 'Stopping CodegenRecorder and cleaning up resources');
    try {
      if (!this.isRecording && !this.browser) {
        if (this.outputFile) return await this.processRecording();
        return { success: false, error: 'No recording in progress' };
      }
      if (this.browser) {
        try { await this.browser.close(); } catch (_) {}
        this.browser = null;
      }
      this.isRecording = false;
      await new Promise(resolve => setTimeout(resolve, 1500));
      return await this.processRecording();
    } catch (error) {
      console.error('Error stopping recording:', error.message);
      return { success: false, error: error.message };
    }
  }

  async processRecording() {
    const startTime = Date.now();
    LoggerService.logStep(1, 'Processing generated Codegen actions from output file');
    try {
      if (!this.outputFile) return { success: false, error: 'No output file found' };
      await new Promise(resolve => setTimeout(resolve, 1500));
      const generatedCode = await fs.readFile(this.outputFile, 'utf8');
      if (!generatedCode || generatedCode.length < 50) {
        return { success: false, error: 'No actions were recorded. Please close the browser window after performing actions.' };
      }
      const rawActions = CodegenParserService.parseCodegenOutput(generatedCode, this);
      const actions = CodegenParserService.applyNavigationDedup(rawActions);

      return { success: true, actions, count: actions.length, generatedCode };
    } catch (error) {
      console.error('Error processing recording:', error.message);
      return { success: false, error: error.message };
    }
  }

  async saveRecording(filename, actions) {
    const startTime = Date.now();
    LoggerService.logStep(1, `Saving CodegenRecording payload locally: ${filename}`);
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
    return { isRecording: this.isRecording, hasBrowser: !!this.browser, outputFile: this.outputFile };
  }
}

module.exports = CodegenRecorder;

