/**
 * desktop-host.js — Desktop Host implementation of RecorderHost SPI.
 */

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');

class DesktopSurfaceObserver {
  constructor(surfaceRegistry) {
    this.registry = surfaceRegistry;
    this._listeners = new Set();
  }

  onSurfaceCreated(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  onSurfaceDestroyed(_callback) {
    return () => {};
  }

  getActiveSurface() {
    if (!this.registry) return null;
    const surfaces = this.registry.getAll();
    return surfaces.find((s) => s.state === 'active') || null;
  }

  listSurfaces() {
    return this.registry ? this.registry.getAll() : [];
  }
}

class DesktopFrameObserver {
  resolveFrameIdentity(frame) {
    if (!frame) return null;
    try {
      return {
        url: frame.url ? frame.url() : '',
        name: frame.name ? frame.name() : undefined,
      };
    } catch {
      return null;
    }
  }

  onFrameNavigated(_callback) {
    return () => {};
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
    for (const cb of this._startedCallbacks) cb(url, surfaceId);
  }

  emitCompleted(url, surfaceId, status) {
    for (const cb of this._completedCallbacks) cb(url, surfaceId, status);
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
    for (const cb of this._startedCallbacks) cb(download);
  }

  emitCompleted(download) {
    for (const cb of this._completedCallbacks) cb(download);
  }
}

class DesktopSessionStore {
  constructor() {
    this.events = [];
    this.sessionData = null;
  }

  async saveSession(sessionData) {
    this.sessionData = sessionData;
  }

  async loadSession() {
    return this.sessionData;
  }

  async clearSession() {
    this.sessionData = null;
    this.events = [];
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
    this._stopCallbacks = new Set();
  }

  isPaused() {
    return this._paused;
  }

  pause() {
    this._paused = true;
  }

  resume() {
    this._paused = false;
  }

  onPause(_callback) {
    return () => {};
  }

  onResume(_callback) {
    return () => {};
  }

  onStop(callback) {
    this._stopCallbacks.add(callback);
    return () => this._stopCallbacks.delete(callback);
  }

  emitStop() {
    for (const cb of this._stopCallbacks) cb();
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

    this.surfaces = new DesktopSurfaceObserver(options.surfaceRegistry);
    this.frames = new DesktopFrameObserver();
    this.navigation = new DesktopNavigationObserver();
    this.downloads = new DesktopDownloadObserver();
    this.storage = new DesktopSessionStore();
    this.lifecycle = new DesktopLifecycleManager();
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
};
