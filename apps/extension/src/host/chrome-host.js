/**
 * chrome-host.js — Chrome Extension Host Adapter for RecorderHost SPI.
 */

import { SurfaceRegistry, EffectCorrelator } from '@flowtrace/recorder-core';

export class ChromeSurfaceObserver {
  constructor(surfaceRegistry) {
    this.registry = surfaceRegistry || new SurfaceRegistry();
  }

  onSurfaceCreated(callback) {
    const orig = this.registry.onSurfaceAdded;
    this.registry.onSurfaceAdded = (s) => {
      orig(s);
      callback(s);
    };
    return () => {};
  }

  onSurfaceDestroyed(callback) {
    const orig = this.registry.onSurfaceRemoved;
    this.registry.onSurfaceRemoved = (s) => {
      orig(s);
      callback(s.surfaceId);
    };
    return () => {};
  }

  getActiveSurface() {
    const all = this.registry.getAll().filter((s) => s.state === 'active');
    return all[0] || null;
  }

  listSurfaces() {
    return this.registry.getAll();
  }
}

export class ChromeFrameObserver {
  resolveFrameIdentity(frameWindow, documentUrl) {
    try {
      const href = documentUrl || (frameWindow?.location?.href ?? '');
      const name = frameWindow?.name || '';
      return { url: href, name: name || undefined };
    } catch {
      return null;
    }
  }

  onFrameNavigated(_callback) {
    return () => {};
  }
}

export class ChromeNavigationObserver {
  constructor(effectCorrelator) {
    this.correlator = effectCorrelator;
  }

  onNavigationStarted(_callback) {
    return () => {};
  }

  onNavigationCompleted(callback) {
    if (typeof chrome !== 'undefined' && chrome.webNavigation?.onCommitted) {
      const listener = (details) => {
        if (details.frameId === 0) {
          callback(details.url, `surf_tab_${details.tabId}`, 200);
        }
      };
      chrome.webNavigation.onCommitted.addListener(listener);
      return () => chrome.webNavigation.onCommitted.removeListener(listener);
    }
    return () => {};
  }
}

export class ChromeDownloadObserver {
  constructor(effectCorrelator) {
    this.correlator = effectCorrelator;
  }

  onDownloadStarted(callback) {
    if (typeof chrome !== 'undefined' && chrome.downloads?.onCreated) {
      const listener = (item) => {
        callback({ id: String(item.id), url: item.url, filename: item.filename });
      };
      chrome.downloads.onCreated.addListener(listener);
      return () => chrome.downloads.onCreated.removeListener(listener);
    }
    return () => {};
  }

  onDownloadCompleted(callback) {
    if (typeof chrome !== 'undefined' && chrome.downloads?.onChanged) {
      const listener = (delta) => {
        if (delta.state?.current === 'complete') {
          callback({ id: String(delta.id), state: 'complete' });
        }
      };
      chrome.downloads.onChanged.addListener(listener);
      return () => chrome.downloads.onChanged.removeListener(listener);
    }
    return () => {};
  }
}

export class ChromeSessionStore {
  async saveSession(sessionData) {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ flowtrace_session: sessionData });
    }
  }

  async loadSession() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get('flowtrace_session');
      return res.flowtrace_session || null;
    }
    return null;
  }

  async clearSession() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.remove('flowtrace_session');
    }
  }

  async appendEvent(event) {
    const session = (await this.loadSession()) || { events: [] };
    session.events = session.events || [];
    session.events.push(event);
    await this.saveSession(session);
  }

  async getEvents() {
    const session = await this.loadSession();
    return session?.events || [];
  }
}

export class ChromeLifecycleManager {
  constructor() {
    this._paused = false;
  }

  isPaused() {
    return this._paused;
  }

  onPause(callback) {
    return () => {};
  }

  onResume(callback) {
    return () => {};
  }

  onStop(callback) {
    return () => {};
  }
}

export class ChromeScriptInjector {
  async injectScript(targetContext, scriptPathOrContent) {
    if (typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
      const tabId = typeof targetContext === 'number' ? targetContext : targetContext?.id;
      if (tabId) {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: [scriptPathOrContent],
        });
      }
    }
  }
}

export class ChromeRecorderHost {
  constructor(options = {}) {
    this.hostType = 'extension';
    this.capabilities = {
      frameIdentification: true,
      cdpAvailable: false,
      downloadObservation: true,
      multiWindowObservation: true,
      persistentStorage: true,
      nativeSelectorInspection: true,
    };

    this.surfaceRegistry = options.surfaceRegistry || new SurfaceRegistry();
    this.correlator = options.correlator || new EffectCorrelator();

    this.surfaces = new ChromeSurfaceObserver(this.surfaceRegistry);
    this.frames = new ChromeFrameObserver();
    this.navigation = new ChromeNavigationObserver(this.correlator);
    this.downloads = new ChromeDownloadObserver(this.correlator);
    this.storage = new ChromeSessionStore();
    this.lifecycle = new ChromeLifecycleManager();
    this.injector = new ChromeScriptInjector();
  }
}
