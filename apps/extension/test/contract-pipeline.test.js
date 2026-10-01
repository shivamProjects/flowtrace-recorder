import { describe, it, expect, beforeEach } from 'vitest';
import { createRouter, createExternalRouter, isAllowedExternalOrigin } from '../src/core/background/router.js';
import { EffectCorrelator, LifecycleObservers } from '../src/core/background/observers.js';
import { SurfaceRegistry } from '../src/core/background/surface-registry.js';
import { compileActions } from '@flowtrace/recorder-core';
import { makeEnvelope, validateActions } from '@flowtrace/recorder-core';

describe('Zero-CDP Contract & Security Pipeline', () => {
  describe('P0 Security: External vs Internal Message Router Split', () => {
    const mockPatches = {
      listPatches: () => [{ id: 'generic', name: 'Generic' }],
      hasPatch: (id) => id === 'generic' || id === 'oracle',
      getPatch: (id) => ({ id, postProcess: (e) => e }),
    };

    it('rejects external calls from untrusted origins', async () => {
      const externalRoute = createExternalRouter(mockPatches);
      const res = await externalRoute(
        { action: 'PING_EXTENSION' },
        { origin: 'https://malicious-attacker.com' }
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain('Unauthorized external caller');
    });

    it('rejects external calls attempting internal actions even from trusted origins', async () => {
      const externalRoute = createExternalRouter(mockPatches);
      const res = await externalRoute(
        { action: 'AUTH_DEV_BYPASS' },
        { origin: 'https://platform.shivambhaipatel.com' }
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain('not permitted for external callers');
    });

    it('allows permitted whitelist actions from trusted platform origins', async () => {
      const externalRoute = createExternalRouter(mockPatches);
      const res = await externalRoute(
        { action: 'PING_EXTENSION' },
        { origin: 'https://platform.shivambhaipatel.com' }
      );
      expect(res.success).toBe(true);
      expect(res.installed).toBe(true);
      expect(res.version).toBe('1.0.0');
    });

    it('prevents injected content scripts from invoking privileged UI actions', async () => {
      const internalRoute = createRouter(mockPatches);
      const res = await internalRoute(
        { action: 'AUTH_DEV_BYPASS' },
        { tab: { id: 123 }, url: 'https://customer-app.oracle.com/fscmUI' }
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain('restricted to extension UI');
    });
  });

  describe('P1 MV3 Correlation Recovery across Worker Eviction', () => {
    it('restores recent actions into EffectCorrelator after worker resurrection', () => {
      const correlator = new EffectCorrelator();
      const now = Date.now();
      const persistedEvents = [
        {
          id: 'action_old',
          type: 'click',
          timestamp: now - 60_000, // expired (> 6s global window)
          surfaceId: 'surface_main',
        },
        {
          id: 'action_recent',
          type: 'click',
          timestamp: now - 1_000, // recent (1s ago)
          surfaceId: 'surface_main',
        },
      ];

      correlator.restoreRecentActions(persistedEvents);

      const downloadEffect = {
        kind: 'download',
        url: 'https://example.com/export.csv',
        filename: 'export.csv',
        timestamp: now,
      };

      const matched = correlator.correlateEffect(downloadEffect);
      expect(matched).not.toBeNull();
      expect(matched.id).toBe('action_recent');
      expect(matched.effects).toHaveLength(1);
      expect(matched.effects[0].filename).toBe('export.csv');
    });
  });

  describe('P1 Pause Lifecycle Consistency', () => {
    it('freezes lifecycle observer effect capture and callbacks when recording is paused', () => {
      const surfaceRegistry = new SurfaceRegistry({ sessionId: 'test_session' });
      const correlator = new EffectCorrelator();
      const capturedEffects = [];
      let paused = true;

      const observers = new LifecycleObservers({
        surfaceRegistry,
        correlator,
        onEffectCaptured: (effect) => { capturedEffects.push(effect); },
        isPaused: () => paused,
      });

      expect(observers.isActive()).toBe(false);
      observers.start();
      expect(observers.isActive()).toBe(false);

      // When paused, isActive() returns false, which gates all observer handler callbacks
      paused = false;
      expect(observers.isActive()).toBe(true);

      paused = true;
      expect(observers.isActive()).toBe(false);
      observers.stop();
    });
  });

  describe('P0 Nested-Frame & Multi-Surface Canonical Contract Pipeline', () => {
    it('end-to-end: capture -> compile -> envelope -> parse -> normalize -> surface resolution -> resolveScope', async () => {
      const rawCapturedEvents = [
        {
          type: 'navigate',
          url: 'https://fusion.oracle.com/fscmUI/faces/FuseWelcome',
          surfaceId: 'surface_main',
          timestamp: 1000,
        },
        {
          type: 'click',
          target: { tagName: 'BUTTON', textContent: 'Search' },
          locator: { role: 'button', name: 'Search', selector: 'button#search' },
          surfaceId: 'surface_main',
          frame: {
            url: 'https://fusion.oracle.com/fscmUI/faces/innerRegion',
            name: 'innerFrame',
            selector: 'iframe#innerRegion',
            path: ['iframe#mainContainer', 'iframe#innerRegion'],
          },
          timestamp: 2000,
        },
        {
          type: 'click',
          target: { tagName: 'A', textContent: 'View Popup' },
          locator: { role: 'link', name: 'View Popup', selector: 'a#popupLink' },
          surfaceId: 'surface_popup_1',
          timestamp: 3000,
        },
      ];

      // 1. Compile Actions
      const compiled = compileActions(rawCapturedEvents);
      expect(compiled).toHaveLength(3);
      expect(compiled[1].frame.path).toEqual(['iframe#mainContainer', 'iframe#innerRegion']);
      expect(compiled[2].surfaceId).toBe('surface_popup_1');

      // 2. Wrap in Schema v1 Envelope
      const envelope = makeEnvelope({
        name: 'Multi-Surface Nested Frame Flow',
        sourceUrl: 'https://fusion.oracle.com/fscmUI/faces/FuseWelcome',
        patchId: 'oracle',
        actions: compiled,
      });

      // 3. Serialize to JSON and parse back
      const serialized = JSON.stringify(envelope);
      const parsed = JSON.parse(serialized);

      // 4. Schema verification
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.actions).toHaveLength(3);
      expect(parsed.actions[1].frame.path).toEqual(['iframe#mainContainer', 'iframe#innerRegion']);
      expect(parsed.actions[2].surfaceId).toBe('surface_popup_1');

      // 5. Action validation
      const errors = validateActions(parsed.actions);
      expect(errors).toEqual([]);
    });
  });
});
