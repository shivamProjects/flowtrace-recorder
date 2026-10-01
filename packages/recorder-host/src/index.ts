/**
 * @flowtrace/recorder-host
 *
 * Formal Ports-and-Adapters SPI for Recorder Hosts (Chrome Extension & Desktop Wrapper).
 * The pure Recorder Core depends on these abstractions rather than concrete browser or OS APIs.
 */

import type { FrameIdentity, SurfaceInfo } from '@flowtrace/contracts';

export interface HostCapabilities {
  frameIdentification: boolean;
  cdpAvailable: boolean;
  downloadObservation: boolean;
  multiWindowObservation: boolean;
  persistentStorage: boolean;
  nativeSelectorInspection: boolean;
}

export interface SurfaceObserver {
  onSurfaceCreated(callback: (surface: SurfaceInfo) => void): () => void;
  onSurfaceDestroyed(callback: (surfaceId: string) => void): () => void;
  getActiveSurface(): SurfaceInfo | null;
  listSurfaces(): SurfaceInfo[];
}

export interface FrameObserver {
  resolveFrameIdentity(frameWindow: unknown, documentUrl?: string): FrameIdentity | null;
  onFrameNavigated(callback: (frame: FrameIdentity) => void): () => void;
}

export interface NavigationObserver {
  onNavigationStarted(callback: (url: string, surfaceId: string) => void): () => void;
  onNavigationCompleted(callback: (url: string, surfaceId: string, status: number) => void): () => void;
}

export interface DownloadObserver {
  onDownloadStarted(callback: (download: { id: string; url: string; filename: string }) => void): () => void;
  onDownloadCompleted(callback: (download: { id: string; state: 'complete' | 'interrupted' }) => void): () => void;
}

export interface SessionStore {
  saveSession(sessionData: Record<string, unknown>): Promise<void>;
  loadSession(): Promise<Record<string, unknown> | null>;
  clearSession(): Promise<void>;
  appendEvent(event: Record<string, unknown>): Promise<void>;
  getEvents(): Promise<Record<string, unknown>[]>;
}

export interface ScriptInjector {
  injectScript(targetContext: unknown, scriptPathOrContent: string): Promise<void>;
}

export interface LifecycleManager {
  isPaused(): boolean;
  onPause(callback: () => void): () => void;
  onResume(callback: () => void): () => void;
  onStop(callback: () => void): () => void;
}

export interface RecorderHost {
  readonly hostType: 'extension' | 'desktop' | 'mock';
  readonly capabilities: HostCapabilities;
  readonly surfaces: SurfaceObserver;
  readonly frames: FrameObserver;
  readonly navigation: NavigationObserver;
  readonly downloads: DownloadObserver;
  readonly storage: SessionStore;
  readonly lifecycle: LifecycleManager;
  readonly injector?: ScriptInjector;
}
