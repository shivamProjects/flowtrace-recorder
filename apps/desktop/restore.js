const fs = require('fs');

let fileContent = fs.readFileSync('codegen-recorder.js', 'utf8');

const restoreContent = `class CodegenRecorder {
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
      this.outputFile = path.join(tempDir, \`recording-\${timestamp}.js\`);
      await fs.promises.mkdir(tempDir, { recursive: true });

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
`;

const classIndex = fileContent.indexOf("class CodegenRecorder {");
const selectMapIndex = fileContent.indexOf("      });\n\n      this.selectOptionMap = {};");

fileContent = fileContent.substring(0, classIndex) + restoreContent + fileContent.substring(selectMapIndex + 10);
fs.writeFileSync('codegen-recorder.js', fileContent);
console.log("Restored");

