# FlowTrace Recorder

An Electron-based recorder for Oracle Fusion Cloud automation scripts. Records user interactions in the browser via Playwright Codegen and saves them as structured test scripts.

---

## 1. Prerequisites

Install these on the build machine (Windows or macOS):

| Tool | Minimum version | Download |
|------|----------------|----------|
| Node.js | 20 LTS | https://nodejs.org |
| Git | any recent | https://git-scm.com |
| Python | already bundled with Node-gyp on most systems — install only if `npm install` complains | https://www.python.org |

**macOS extras:** Xcode Command Line Tools (run `xcode-select --install` in Terminal if not already installed).
**Windows extras:** none — the bundled `windows-build-tools` comes with Node's installer.

---

## 2. Clone the repository

```bash
git clone https://github.com/vaneetg1/prrepo.git
cd "prrepo/PW- REC"
git checkout mainexe
```

---

## 3. Install dependencies

```bash
npm install
npx playwright install chromium
```

`npm install` pulls Electron, electron-builder, Express, and Playwright.
`npx playwright install chromium` downloads the Chromium browser Playwright uses for recording.

---

## 4. Configure `.env`

Copy the example and set the API URL:

```bash
cp .env.example .env
```

Edit `.env`:

```env
NODE_ENV=development
PORT=3000
API_BASE_URL=https://your-api-host.example.com/dev
PLAYWRIGHT_HEADLESS=false
PLAYWRIGHT_TIMEOUT=60000
RECORDINGS_DIR=./recordings
TEMP_DIR=./temp
```

`API_BASE_URL` must point at the backend that authenticates users and stores recordings. Use the dev URL above for dev, or the production URL for client builds.

---

## 5. Run in development mode

Launch the Electron app directly from source (hot-reload, no installer):

```bash
npm run electron
```

The recorder window opens. Log in, start a recording, perform actions in Oracle Fusion, stop, and save.

For the Express-server-only mode (browser UI at `http://localhost:3000`):

```bash
npm run dev
```

---

## 6. Build the installer

Installers are produced by `electron-builder`. You must build each platform on its own OS — you cannot cross-compile a `.dmg` from Windows or a `.exe` from macOS.

### Windows `.exe` installer

Run on a **Windows** machine:

```bash
npm run build:win
```

Output: `dist/electron/FlowTrace Recorder Setup <version>.exe`
Double-click to install. Creates Desktop and Start Menu shortcuts.

### macOS `.dmg` installer

Run on a **macOS** machine:

```bash
npm run build:mac
```

Output: `dist/electron/FlowTrace Recorder-<version>-universal.dmg`
Double-click the DMG, drag the app into `/Applications`.

The DMG is a universal binary — runs on both Intel and Apple Silicon.

---

## 7. How to record

1. Launch the installed app (or `npm run electron` in dev mode).
2. Log in with your FlowTrace credentials.
3. Enter the target URL (e.g. an Oracle Fusion login page) and click **Start Recording**.
4. A Chromium window opens — interact with the page normally (clicks, typing, LOV searches, date picks, etc.).
5. Click **Stop & Get Actions** in the recorder window when done.
6. Review the generated JSON steps, add a name + description, and click **Save Recording**. The script is uploaded to the backend (`API_BASE_URL`) and a local backup is kept under `recordings/`.

---

## 8. Troubleshooting

**`npm install` fails with gyp/python errors**
macOS: `xcode-select --install`. Windows: reinstall Node.js from the official installer (includes build tools).

**Chromium window doesn't open on record**
Run `npx playwright install chromium` again. Check that `PLAYWRIGHT_HEADLESS=false` in `.env`.

**Build produces empty `dist/electron/`**
Delete `node_modules` and `dist/`, run `npm install` again, then rebuild.

**macOS says "app is damaged" when opening the installed DMG**
The DMG is unsigned. Right-click the app → **Open** the first time, or run `xattr -cr "/Applications/FlowTrace Recorder.app"` in Terminal.

**API connection errors in the recorder**
Confirm `API_BASE_URL` in the app's bundled `.env` (inside `Resources/` in the installed app) is reachable from the user's network.

---

## 9. Project layout (reference)

```
PW- REC/
├── electron/main.js       # Electron main process
├── codegen-recorder.js    # Core recording logic
├── app.js                 # Express server (dev mode)
├── bin/www                # Server entry point
├── routes/                # API routes
├── views/                 # Jade templates for the UI
├── public/                # Static assets, logos
├── scripts/build.js       # electron-builder driver
├── .env                   # Runtime config (not committed normally)
└── package.json           # Dependencies + build:win / build:mac scripts
```

---

Private — All rights reserved.

