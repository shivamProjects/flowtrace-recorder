const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');

const APP_VERSION = require(path.join(__dirname, '..', 'package.json')).version;
const APP_TITLE = `FlowTrace Recorder V${APP_VERSION}`;
const HOST = '127.0.0.1';

let mainWindow = null;
let splashWindow = null;
let webServer = null;
let webPort = null;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolveAppRoot() {
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
}

function resolveIconPath() {
  const root = resolveAppRoot();
  // 512x512 square padded variant of the C11 logo — required by NSIS
  // (electron-builder rejects sub-256 icons) and by macOS app bundles
  // which expect a square asset. Generated from C11 (light-mode logo)
  // centered on a transparent canvas.
  const png = path.join(root, 'public', 'images', 'flowtrace-icon.png');
  const fallback = path.join(root, 'public', 'favicon.ico');
  if (fs.existsSync(png)) return png;
  return fallback;
}

function resolveSplashLogoPath() {
  // C10 = dark-mode logo (white wordmark + S mark) — visible against the
  // splash window's dark navy background (#0f172a).
  const root = resolveAppRoot();
  const png = path.join(root, 'public', 'images', 'flowtrace-icon.png');
  return fs.existsSync(png) ? png : resolveIconPath();
}

// ---------------------------------------------------------------------------
// Splash screen
// ---------------------------------------------------------------------------

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 400,
    height: 340,
    frame: false,
    resizable: false,
    center: true,
    show: false,
    skipTaskbar: false,
    title: 'FlowTrace Recorder',
    icon: resolveIconPath(),
    backgroundColor: '#0f172a',
    webPreferences: { contextIsolation: false, nodeIntegration: false }
  });

  const splashPath = path.join(__dirname, 'splash.html');
  const logoUrl = 'file:///' + resolveSplashLogoPath().replace(/\\/g, '/');
  splashWindow.loadFile(splashPath, { query: { logo: logoUrl, version: APP_VERSION } });

  splashWindow.once('ready-to-show', () => {
    if (splashWindow) splashWindow.show();
  });
}

function updateSplash(progress, status) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.executeJavaScript(
      `window.postMessage(${JSON.stringify({ progress, status })}, '*')`
    ).catch(() => {});
  }
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
}

// ---------------------------------------------------------------------------
// Express web server (existing app.js)
// ---------------------------------------------------------------------------

function startWebServer() {
  return new Promise((resolve, reject) => {
    if (webServer) { resolve(webPort); return; }

    const appRoot = resolveAppRoot();
    const expressApp = require(path.join(appRoot, 'app'));

    webServer = expressApp.listen(0, HOST, () => {
      webPort = webServer.address().port;
      console.log(`[electron] Web server listening on ${HOST}:${webPort}`);
      resolve(webPort);
    });
    webServer.on('error', reject);
  });
}

function stopWebServer() {
  return new Promise((resolve) => {
    if (!webServer) { resolve(); return; }
    const server = webServer;
    webServer = null;
    webPort = null;

    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    server.close(done);
    setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      done();
    }, 2000);
  });
}

// ---------------------------------------------------------------------------
// Browser check — verify system Chrome/Edge is available
// ---------------------------------------------------------------------------

async function checkPlaywrightBrowsers() {
  // System browser detection happens in codegen-recorder.js (detectBrowserChannel)
  // Chrome/Edge is always available on modern Windows/Mac — no install needed
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

function createWindow() {
  if (mainWindow) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: APP_TITLE,
    icon: resolveIconPath(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !splashWindow) mainWindow.show();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Navigation guards — external links open in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== HOST && parsed.hostname !== 'localhost') {
        event.preventDefault();
        shell.openExternal(url).catch(() => {});
      }
    } catch { event.preventDefault(); }
  });

  return mainWindow;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap() {
  Menu.setApplicationMenu(null);

  createSplashWindow();

  updateSplash(15, 'Starting local server...');
  await startWebServer();

  updateSplash(45, 'Checking Playwright browsers...');
  await checkPlaywrightBrowsers();

  updateSplash(70, 'Loading application...');
  const win = createWindow();
  await win.loadURL(`http://${HOST}:${webPort}`);

  updateSplash(100, 'Ready!');
  await new Promise(r => setTimeout(r, 400));

  win.show();
  closeSplash();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.setAsDefaultProtocolClient('flowtrace-recorder');
app.setAsDefaultProtocolClient('flowtrace');

app.whenReady().then(() => {
  bootstrap().catch((err) => {
    dialog.showErrorBox('Startup Failed', String(err?.message || err));
    app.exit(1);
  });
});

app.on('open-url', (event, customUrl) => {
  event.preventDefault();
  if (mainWindow && webPort) {
    try {
      const parsed = new URL(customUrl);
      const target = parsed.searchParams.get('url') || parsed.searchParams.get('targetUrl');
      if (target) {
        mainWindow.loadURL(`http://${HOST}:${webPort}?targetUrl=${encodeURIComponent(target)}`).catch(() => {});
      }
    } catch {}
  }
});


app.on('activate', () => {
  if (mainWindow) { mainWindow.focus(); return; }
  if (webServer && webPort) {
    const win = createWindow();
    win.loadURL(`http://${HOST}:${webPort}`).catch(() => {});
    return;
  }
  bootstrap().catch((err) => {
    dialog.showErrorBox('Startup Failed', String(err?.message || err));
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  event.preventDefault();
  stopWebServer()
    .catch(() => {})
    .finally(() => app.exit(0));
});
