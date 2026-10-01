import { describe, it, expect, beforeEach } from 'vitest';
import { createRouter, createExternalRouter, isAllowedExternalOrigin } from '../src/core/background/router.js';
import { EffectCorrelator, LifecycleObservers } from '../src/core/background/observers.js';
import { SurfaceRegistry } from '../src/core/background/surface-registry.js';
import { compileActions } from '../src/core/background/compiler.js';
import { makeEnvelope } from '../src/core/shared/schema.js';
import { parseRecording, normalizeAction, assertReplayable } from '../../replayer/engine/normalize.ts';
import { resolveScope, isTopFrame } from '../../replayer/engine/frames.ts';
import { ReplaySurfaceRegistry } from '../../replayer/engine/surfaces.ts';

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

      // 4. Replayer parseRecording & assertReplayable
      const recording = parseRecording(parsed);
      expect(recording.schemaVersion).toBe(1);
      assertReplayable(recording.entries, recording.schemaVersion);

      // 5. Replayer normalizeAction
      const normalized = recording.entries.map((e) => normalizeAction(e, recording.schemaVersion));
      expect(normalized[1].frame.path).toEqual(['iframe#mainContainer', 'iframe#innerRegion']);
      expect(normalized[2].surfaceId).toBe('surface_popup_1');

      // 6. Surface Resolution (ReplaySurfaceRegistry)
      const mockMainPage = {
        isClosed: () => false,
        url: () => 'https://fusion.oracle.com/fscmUI/faces/FuseWelcome',
        context: () => mockContext,
        frameLocator: (sel) => ({
          _selector: sel,
          frameLocator: (nestedSel) => ({
            _selector: `${sel} -> ${nestedSel}`,
          }),
        }),
      };

      const mockPopupPage = {
        isClosed: () => false,
        url: () => 'https://fusion.oracle.com/fscmUI/faces/popup',
        context: () => mockContext,
        waitForLoadState: async () => {},
        bringToFront: async () => {},
        evaluate: async () => {},
      };

      const mockContext = {
        pages: () => [mockMainPage, mockPopupPage],
        on: () => {},
        off: () => {},
      };

      const surfaceRegistry = new ReplaySurfaceRegistry(mockMainPage, normalized);
      surfaceRegistry.registerSurface('surface_popup_1', mockPopupPage);

      const resolvedMainSurface = await surfaceRegistry.resolveSurface(normalized[0], mockMainPage);
      expect(resolvedMainSurface).toBe(mockMainPage);

      const resolvedPopupSurface = await surfaceRegistry.resolveSurface(normalized[2], mockMainPage);
      expect(resolvedPopupSurface).toBe(mockPopupPage);

      // 7. Test Frame Resolution Chaining
      expect(isTopFrame(mockMainPage, normalized[0].frame)).toBe(true);
      expect(isTopFrame(mockMainPage, normalized[1].frame)).toBe(false);

      const resolvedNestedScope = await resolveScope(mockMainPage, normalized[1]);
      expect(resolvedNestedScope._selector).toBe('iframe#mainContainer -> iframe#innerRegion');

      // 8. Fail-closed assertion on missing popup surface
      const unresolvableAction = { ...normalized[2], surfaceId: 'surface_missing_popup' };
      await expect(
        surfaceRegistry.resolveSurface(unresolvableAction, mockMainPage, 0)
      ).rejects.toThrow(/Target surface "surface_missing_popup" not found/);

      surfaceRegistry.dispose();
    });
  });
});
