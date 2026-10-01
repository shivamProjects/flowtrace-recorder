/**
 * desktop-host.js — Authoritative Desktop Host implementation of RecorderHost SPI.
 *
 * Owns surfaces, frames, navigation, downloads, lifecycle, storage, and script injection
 * for the Desktop Chromium environment.
 */

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');

class DesktopSurfaceObserver {
  constructor(options = {}) {
    this._surfaces = new Map(); // surfaceId -> SurfaceInfo
    this._pageToSurface = new WeakMap(); // Page -> surfaceId
    this._createdCallbacks = new Set();
    this._destroyedCallbacks = new Set();
    this._counter = 1;
    this.sessionId = options.sessionId || 'desktop_session';
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  registerPage(page, type = 'tab', openerSurfaceId = null) {
    if (this._pageToSurface.has(page)) {
      return this._surfaces.get(this._pageToSurface.get(page));
    }

    const hostSurfaceId = `desktop_window_${this._counter++}`;
    const surfaceId = `surf_${this.sessionId}_${hostSurfaceId}`;

    const surfaceInfo = {
      surfaceId,
      hostSurfaceId,
      type: type === 'popup' ? 'popup' : 'tab',
      ...(openerSurfaceId ? { openerSurfaceId } : {}),
      url: page.url ? page.url() : '',
      state: 'active',
      page,
    };

    this._surfaces.set(surfaceId, surfaceInfo);
    this._pageToSurface.set(page, surfaceId);

    for (const cb of this._createdCallbacks) {
      try { cb(surfaceInfo); } catch (_) {}
    }

    return surfaceInfo;
  }

  unregisterPage(page) {
    const surfaceId = this._pageToSurface.get(page);
    if (!surfaceId) return null;

    const surface = this._surfaces.get(surfaceId);
    if (surface) {
      surface.state = 'closed';
      this._surfaces.delete(surfaceId);
      for (const cb of this._destroyedCallbacks) {
        try { cb(surfaceId); } catch (_) {}
      }
    }
    this._pageToSurface.delete(page);
    return surface;
  }

  getSurfaceByPage(page) {
    const id = this._pageToSurface.get(page);
    return id ? this._surfaces.get(id) || null : null;
  }

  onSurfaceCreated(callback) {
    this._createdCallbacks.add(callback);
    return () => this._createdCallbacks.delete(callback);
  }

  onSurfaceDestroyed(callback) {
    this._destroyedCallbacks.add(callback);
    return () => this._destroyedCallbacks.delete(callback);
  }

  getActiveSurface() {
    for (const surface of this._surfaces.values()) {
      if (surface.state === 'active') return surface;
    }
    return null;
  }

  listSurfaces() {
    return Array.from(this._surfaces.values());
  }

  clear() {
    this._surfaces.clear();
    this._counter = 1;
  }
}

class DesktopFrameObserver {
  constructor(surfaceObserver) {
    this.surfaces = surfaceObserver;
    this._navigatedCallbacks = new Set();
  }

  resolveFrameIdentity(frame, surfaceId) {
    if (!frame) return null;
    try {
      const page = frame.page ? frame.page() : null;
      const sId = surfaceId || (page ? this.surfaces?.getSurfaceByPage(page)?.surfaceId : 'surf_main') || 'surf_main';
      const frameUrl = frame.url ? frame.url() : '';
      const frameName = frame.name ? frame.name() : undefined;
      const parentFrame = frame.parentFrame ? frame.parentFrame() : null;

      const hostFrameId = `${sId}_frame_${frameName || 'root'}_${frameUrl ? Buffer.from(frameUrl).toString('base64').slice(0, 8) : 'main'}`;
      const parentHostFrameId = parentFrame
        ? `${sId}_frame_${parentFrame.name ? parentFrame.name() : 'parent'}`
        : undefined;

      return {
        hostFrameId,
        parentHostFrameId,
        surfaceId: sId,
        url: frameUrl || undefined,
        name: frameName || undefined,
      };
    } catch {
      return null;
    }
  }

  onFrameNavigated(callback) {
    this._navigatedCallbacks.add(callback);
    return () => this._navigatedCallbacks.delete(callback);
  }

  emitFrameNavigated(frameIdentity) {
    for (const cb of this._navigatedCallbacks) {
      try { cb(frameIdentity); } catch (_) {}
    }
  }
}

class DesktopNavigationObserver {
  constructor() {
    this._startedCallbacks = new Set();
    this._completedCallbacks = new Set();
  }

  onNavigationStarted(callback) {
    this._startedCallbacks.add(callback);
    return () => this._startedCallbacks.delete(callback);
  }

  onNavigationCompleted(callback) {
    this._completedCallbacks.add(callback);
    return () => this._completedCallbacks.delete(callback);
  }

  emitStarted(url, surfaceId) {
    for (const cb of this._startedCallbacks) {
      try { cb(url, surfaceId); } catch (_) {}
    }
  }

  emitCompleted(url, surfaceId, status = 200) {
    for (const cb of this._completedCallbacks) {
      try { cb(url, surfaceId, status); } catch (_) {}
    }
  }
}

class DesktopDownloadObserver {
  constructor() {
    this._startedCallbacks = new Set();
    this._completedCallbacks = new Set();
  }

  onDownloadStarted(callback) {
    this._startedCallbacks.add(callback);
    return () => this._startedCallbacks.delete(callback);
  }

  onDownloadCompleted(callback) {
    this._completedCallbacks.add(callback);
    return () => this._completedCallbacks.delete(callback);
  }

  emitStarted(download) {
    for (const cb of this._startedCallbacks) {
      try { cb(download); } catch (_) {}
    }
  }

  emitCompleted(download) {
    for (const cb of this._completedCallbacks) {
      try { cb(download); } catch (_) {}
    }
  }
}

class DesktopSessionStore {
  constructor(options = {}) {
    this.storageDir = options.storageDir || path.join(os.tmpdir(), 'flowtrace-desktop-sessions');
    this.sessionData = null;
    this.events = [];
    this.sessionId = options.sessionId || `session_${Date.now()}`;
  }

  async init() {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
    } catch {}
  }

  async saveSession(sessionData) {
    this.sessionData = sessionData;
    await this.init();
    const filePath = path.join(this.storageDir, `${this.sessionId}.json`);
    await fs.writeFile(filePath, JSON.stringify(sessionData, null, 2), 'utf8');
  }

  async loadSession() {
    if (this.sessionData) return this.sessionData;
    try {
      const filePath = path.join(this.storageDir, `${this.sessionId}.json`);
      const raw = await fs.readFile(filePath, 'utf8');
      this.sessionData = JSON.parse(raw);
      return this.sessionData;
    } catch {
      return null;
    }
  }

  async clearSession() {
    this.sessionData = null;
    this.events = [];
    try {
      const filePath = path.join(this.storageDir, `${this.sessionId}.json`);
      await fs.unlink(filePath);
    } catch {}
  }

  async appendEvent(event) {
    this.events.push(event);
  }

  async getEvents() {
    return [...this.events];
  }
}

class DesktopLifecycleManager {
  constructor() {
    this._paused = false;
    this._pauseCallbacks = new Set();
    this._resumeCallbacks = new Set();
    this._stopCallbacks = new Set();
  }

  isPaused() {
    return this._paused;
  }

  pause() {
    this._paused = true;
    for (const cb of this._pauseCallbacks) {
      try { cb(); } catch (_) {}
    }
  }

  resume() {
    this._paused = false;
    for (const cb of this._resumeCallbacks) {
      try { cb(); } catch (_) {}
    }
  }

  onPause(callback) {
    this._pauseCallbacks.add(callback);
    return () => this._pauseCallbacks.delete(callback);
  }

  onResume(callback) {
    this._resumeCallbacks.add(callback);
    return () => this._resumeCallbacks.delete(callback);
  }

  onStop(callback) {
    this._stopCallbacks.add(callback);
    return () => this._stopCallbacks.delete(callback);
  }

  emitStop() {
    for (const cb of this._stopCallbacks) {
      try { cb(); } catch (_) {}
    }
  }
}

class DesktopScriptInjector {
  constructor(options = {}) {
    this.coreDistPath = options.coreDistPath || (
      fsSync.existsSync(path.resolve(__dirname, '../../../../packages/recorder-core/dist'))
        ? path.resolve(__dirname, '../../../../packages/recorder-core/dist')
        : path.resolve(__dirname, '../../../packages/recorder-core/dist')
    );
    this.extDistPath = options.extDistPath || (
      fsSync.existsSync(path.resolve(__dirname, '../../../../apps/extension/dist'))
        ? path.resolve(__dirname, '../../../../apps/extension/dist')
        : path.resolve(__dirname, '../../extension/dist')
    );
  }

  async injectScript(context, scriptPathOrContent) {
    if (typeof scriptPathOrContent === 'string' && fsSync.existsSync(scriptPathOrContent)) {
      await context.addInitScript({ path: scriptPathOrContent });
    } else if (typeof scriptPathOrContent === 'string') {
      await context.addInitScript(scriptPathOrContent);
    }
  }

  async injectRecorderRuntime(context, patchId = 'oracle') {
    // 1. Selector engine bundle
    const selectorEnginePath = path.join(this.extDistPath, 'selector-engine.js');
    if (fsSync.existsSync(selectorEnginePath)) {
      await context.addInitScript({ path: selectorEnginePath });
    }

    // 2. Desktop runtime configuration flags
    await context.addInitScript(`
      (() => {
        window.__FLOWTRACE_DESKTOP_HOST__ = true;
        window.__flowtrace_patch_id__ = ${JSON.stringify(patchId)};
      })();
    `);

    // 3. Pure host-neutral page-runtime bundle (PageRecorder + targeting)
    const pageRuntimePath = path.join(this.coreDistPath, 'page-runtime.js');
    if (fsSync.existsSync(pageRuntimePath)) {
      await context.addInitScript({ path: pageRuntimePath });
    }
  }
}

class DesktopRecorderHost {
  constructor(options = {}) {
    this.hostType = 'desktop';
    this.capabilities = {
      frameIdentification: true,
      cdpAvailable: false,
      downloadObservation: true,
      multiWindowObservation: true,
      persistentStorage: true,
      nativeSelectorInspection: true,
    };

    this.surfaces = new DesktopSurfaceObserver(options);
    this.frames = new DesktopFrameObserver(this.surfaces);
    this.navigation = new DesktopNavigationObserver();
    this.downloads = new DesktopDownloadObserver();
    this.storage = new DesktopSessionStore(options);
    this.lifecycle = new DesktopLifecycleManager();
    this.injector = new DesktopScriptInjector(options);
  }
}

module.exports = {
  DesktopRecorderHost,
  DesktopSurfaceObserver,
  DesktopFrameObserver,
  DesktopNavigationObserver,
  DesktopDownloadObserver,
  DesktopSessionStore,
  DesktopLifecycleManager,
  DesktopScriptInjector,
};
