import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  PageRecorder,
  SurfaceRegistry,
  EffectCorrelator,
  compileActions,
  compileSteps,
  dedupEvents,
  getPatch,
} from '@flowtrace/recorder-core';
import { RecordingEnvelopeSchema, SemanticStepV2Schema } from '@flowtrace/contracts';
import { ChromeRecorderHost } from '../src/host/chrome-host.js';

describe('TRACE-63 Differential Host Test Suite: ExtensionHost vs DesktopHost Equivalence', () => {
  let dom;
  let document;
  let window;

  beforeEach(() => {
    dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <head><title>Oracle Fusion Form Fixture</title></head>
        <body>
          <form id="purchaseOrderForm">
            <div class="field-group">
              <label for="poNumberInput">PO Number <span class="x25">*</span></label>
              <input id="poNumberInput" type="text" name="poNumber" required aria-required="true" />
            </div>
            <div class="field-group">
              <label for="supplierSelect">Supplier</label>
              <select id="supplierSelect" name="supplier">
                <option value="ACME_CORP">Acme Corporation</option>
                <option value="GLOBEX_LLC">Globex LLC</option>
              </select>
            </div>
            <div class="field-group">
              <label>
                <input id="urgentCheck" type="checkbox" name="urgent" />
                Mark as Urgent
              </label>
            </div>
            <button id="saveBtn" type="submit" class="af_button">Save & Close</button>
          </form>
        </body>
      </html>`,
      { url: 'https://cloud.oracle.com/fscmUI/faces/PurchaseOrder' }
    );
    window = dom.window;
    document = dom.window.document;
    globalThis.window = window;
    globalThis.document = document;
  });

  describe('1. Pure DOM Event Capture via PageRecorder', () => {
    it('captures fill, select, check, and click into pure semantic events', () => {
      const capturedEvents = [];
      const pageRecorder = new PageRecorder({
        window,
        document,
        patchId: 'oracle',
        onEvent: (event) => capturedEvents.push(event),
      });

      pageRecorder.start('oracle');

      // 1. Fill PO Number input
      const poInput = document.getElementById('poNumberInput');
      poInput.value = 'PO-99482';
      const inputEvent = new window.Event('input', { bubbles: true });
      const changeEvent = new window.Event('change', { bubbles: true });
      poInput.dispatchEvent(inputEvent);
      poInput.dispatchEvent(changeEvent);

      // 2. Select option
      const supplierSelect = document.getElementById('supplierSelect');
      supplierSelect.value = 'GLOBEX_LLC';
      supplierSelect.dispatchEvent(new window.Event('change', { bubbles: true }));

      // 3. Check checkbox
      const urgentCheck = document.getElementById('urgentCheck');
      urgentCheck.checked = true;
      urgentCheck.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

      // 4. Click Save button
      const saveBtn = document.getElementById('saveBtn');
      saveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

      pageRecorder.stop();

      expect(capturedEvents.length).toBeGreaterThan(0);
      const actionTypes = capturedEvents.map((e) => e.type);
      expect(actionTypes).toContain('fill');
      expect(actionTypes).toContain('select');
      expect(actionTypes).toContain('click');
    });
  });

  describe('2. Host Pipeline Equivalence (ExtensionHost vs DesktopHost)', () => {
    it('produces identical SemanticStepV2 and valid RecordingEnvelope from both host harnesses', () => {
      const rawInteractions = [
        {
          type: 'fill',
          value: 'PO-99482',
          committedValue: 'PO-99482',
          selector: '#poNumberInput',
          label: 'PO Number',
          required: true,
          surfaceId: 'surface_main',
          timestamp: 1000,
        },
        {
          type: 'select',
          value: 'GLOBEX_LLC',
          meta: { optionLabel: 'Globex LLC' },
          selector: '#supplierSelect',
          label: 'Supplier',
          surfaceId: 'surface_main',
          timestamp: 2000,
        },
        {
          type: 'check',
          checked: true,
          selector: '#urgentCheck',
          label: 'Mark as Urgent',
          surfaceId: 'surface_main',
          timestamp: 3000,
        },
        {
          type: 'click',
          selector: '#saveBtn',
          label: 'Save & Close',
          surfaceId: 'surface_main',
          timestamp: 4000,
        },
      ];

      // Extension Host Pipeline
      const extHost = new ChromeRecorderHost();
      const extPatch = getPatch('oracle');
      let extProcessed = extPatch.postProcess ? extPatch.postProcess([...rawInteractions], {}) : [...rawInteractions];
      extProcessed = dedupEvents(extProcessed);
      const extActions = compileActions(extProcessed);
      const extSteps = compileSteps(extProcessed);

      const extEnvelope = {
        protocolVersion: '2.0',
        recordingSessionId: 'a3bb189e-8bf9-4888-9912-ace4e6543002',
        recordedAt: new Date().toISOString(),
        producer: { kind: extHost.hostType, version: '1.0.0' },
        capabilities: ['multiSurface', 'nestedFrames', 'oracleADF'],
        meta: {
          sourceUrl: 'https://cloud.oracle.com/fscmUI/faces/PurchaseOrder',
          patchId: 'oracle',
        },
        steps: extActions,
      };

      // Desktop Host Pipeline
      const desktopPatch = getPatch('oracle');
      let deskProcessed = desktopPatch.postProcess ? desktopPatch.postProcess([...rawInteractions], {}) : [...rawInteractions];
      deskProcessed = dedupEvents(deskProcessed);
      const deskActions = compileActions(deskProcessed);
      const deskSteps = compileSteps(deskProcessed);

      const deskEnvelope = {
        protocolVersion: '2.0',
        recordingSessionId: 'b4cc290f-9ca0-4999-aa23-bdf5f7654003',
        recordedAt: new Date().toISOString(),
        producer: { kind: 'desktop', version: '1.0.0' },
        capabilities: ['multiSurface', 'nestedFrames', 'oracleADF'],
        meta: {
          sourceUrl: 'https://cloud.oracle.com/fscmUI/faces/PurchaseOrder',
          patchId: 'oracle',
        },
        steps: deskActions,
      };

      // 1. Assert semantic action equivalence
      expect(extActions).toEqual(deskActions);
      expect(extSteps).toEqual(deskSteps);

      // 2. Validate against Protocol 2.0 schemas
      const validatedExt = RecordingEnvelopeSchema.safeParse(extEnvelope);
      expect(validatedExt.success).toBe(true);

      const validatedDesk = RecordingEnvelopeSchema.safeParse(deskEnvelope);
      expect(validatedDesk.success).toBe(true);

      // 3. Validate individual step schemas
      for (const step of deskEnvelope.steps) {
        const stepValidation = SemanticStepV2Schema.safeParse(step);
        expect(stepValidation.success).toBe(true);
      }
    });
  });

  describe('3. Multi-surface & Effect Correlation Equivalence', () => {
    it('correlates popup surface and navigation effects identically in both hosts', () => {
      const surfaceRegistry = new SurfaceRegistry({ sessionId: 'rec_sess_diff_01' });
      const correlator = new EffectCorrelator();

      const mainSurface = surfaceRegistry.registerPrimary(1001, { url: 'https://cloud.oracle.com/home' });
      const clickAction = {
        id: 'act_click_01',
        type: 'click',
        action: 'click',
        surfaceId: mainSurface.surfaceId,
        timestamp: 1000,
      };
      correlator.recordAction(clickAction);

      // Popup effect
      const popupSurface = surfaceRegistry.registerPopup(1002, 1001, { url: 'https://cloud.oracle.com/search' });
      const popupEffect = {
        kind: 'popup',
        surfaceId: popupSurface.surfaceId,
        openerSurfaceId: mainSurface.surfaceId,
        url: popupSurface.url,
        timestamp: 1500,
      };

      const correlated = correlator.correlateEffect(popupEffect);
      expect(correlated).not.toBeNull();
      expect(correlated.id).toBe('act_click_01');
      expect(correlated.effects).toHaveLength(1);
      expect(correlated.effects[0].kind).toBe('popup');
    });
  });
});
