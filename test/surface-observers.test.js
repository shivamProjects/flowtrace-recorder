/**
 * surface-observers.test.js — Unit tests for SurfaceRegistry and EffectCorrelator.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SurfaceRegistry } from '../src/core/background/surface-registry.js';
import { EffectCorrelator, LifecycleObservers } from '../src/core/background/observers.js';

describe('SurfaceRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new SurfaceRegistry();
  });

  it('registers and retrieves a primary surface', () => {
    const surface = registry.registerPrimary(101, { url: 'https://example.com/app', windowId: 1 });
    expect(surface.surfaceId).toMatch(/^surf_.*_main_101$/);
    expect(surface.tabId).toBe(101);
    expect(surface.kind).toBe('page');
    expect(surface.url).toBe('https://example.com/app');

    const lookup = registry.getByTabId(101);
    expect(lookup).toEqual(surface);
    expect(registry.hasTab(101)).toBe(true);
  });

  it('registers popup surface linked to opener surface', () => {
    const main = registry.registerPrimary(101, { url: 'https://example.com/app' });
    const popup = registry.registerPopup(102, 101, { url: 'https://example.com/auth' });

    expect(popup.kind).toBe('popup');
    expect(popup.tabId).toBe(102);
    expect(popup.openerSurfaceId).toBe(main.surfaceId);
    expect(registry.getByTabId(102)).toEqual(popup);
  });

  it('updates navigation on a registered surface', () => {
    registry.registerPrimary(101, { url: 'https://example.com/login' });
    const updated = registry.updateNavigation(101, 'https://example.com/dashboard');

    expect(updated.url).toBe('https://example.com/dashboard');
    expect(registry.getByTabId(101).url).toBe('https://example.com/dashboard');
  });

  it('handles tab removal gracefully', () => {
    registry.registerPrimary(101);
    expect(registry.hasTab(101)).toBe(true);

    const removed = registry.removeTab(101);
    expect(removed.state).toBe('closed');
    expect(registry.hasTab(101)).toBe(false);
    expect(registry.getByTabId(101)).toBeNull();
  });

  it('serializes and deserializes snapshot across worker restart', () => {
    const main = registry.registerPrimary(101, { url: 'https://example.com/main' });
    registry.registerPopup(102, 101, { url: 'https://example.com/popup' });

    const snapshot = registry.toJSON();

    const restored = new SurfaceRegistry();
    restored.fromJSON(snapshot);

    expect(restored.hasTab(101)).toBe(true);
    expect(restored.hasTab(102)).toBe(true);
    expect(restored.getByTabId(102).openerSurfaceId).toBe(main.surfaceId);
  });
});

describe('EffectCorrelator', () => {
  let correlator;

  beforeEach(() => {
    correlator = new EffectCorrelator({ correlationWindowMs: 2000 });
  });

  it('correlates popup effect to recent click action', () => {
    const action = {
      type: 'click',
      selector: '#btn-create-supplier',
      surfaceId: 'surface_main_101',
    };

    correlator.recordAction(action);

    const popupEffect = {
      kind: 'popup',
      surfaceId: 'surface_popup_1_102',
      openerSurfaceId: 'surface_main_101',
      url: 'https://example.com/supplier/create',
    };

    const correlated = correlator.correlateEffect(popupEffect);
    expect(correlated).toBe(action);
    expect(action.effects).toHaveLength(1);
    expect(action.effects[0]).toEqual(popupEffect);
  });

  it('correlates navigation effect to initiating button click', () => {
    const action = {
      type: 'click',
      selector: '#btn-submit',
      surfaceId: 'surface_main_101',
    };

    correlator.recordAction(action);

    const navEffect = {
      kind: 'navigation',
      surfaceId: 'surface_main_101',
      url: 'https://example.com/confirmation',
    };

    const correlated = correlator.correlateEffect(navEffect);
    expect(correlated).toBe(action);
    expect(action.effects[0].kind).toBe('navigation');
  });

  it('correlates download effect to export button click', () => {
    const action = {
      type: 'click',
      selector: '#btn-export-csv',
      surfaceId: 'surface_main_101',
    };

    correlator.recordAction(action);

    const downloadEffect = {
      kind: 'download',
      filename: 'suppliers_report.csv',
      mime: 'text/csv',
    };

    const correlated = correlator.correlateEffect(downloadEffect);
    expect(correlated).toBe(action);
    expect(action.effects[0].filename).toBe('suppliers_report.csv');
  });
});
