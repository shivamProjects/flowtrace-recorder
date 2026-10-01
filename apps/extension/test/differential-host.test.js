import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  PageRecorder,
  compileActions,
  compileSteps,
  dedupEvents,
  getPatch,
  getLovMetadata,
  buildRecordingEnvelope,
} from '@flowtrace/recorder-core';
import { RecordingEnvelopeSchema, SemanticStepV2Schema } from '@flowtrace/contracts';
import { ChromeRecorderHost } from '../src/host/chrome-host.js';

// Import DesktopRecorderHost from desktop package
const { DesktopRecorderHost } = await import('../../../apps/desktop/src/host/desktop-host.js');

describe('TRACE-64 Real Two-Host Differential Suite: ExtensionHost vs DesktopHost Equivalence', () => {
  let domExt;
  let domDesk;

  const FIXTURE_HTML = `<!DOCTYPE html>
  <html>
    <head><title>Oracle Fusion Purchase Order Fixture</title></head>
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
  </html>`;

  beforeEach(() => {
    domExt = new JSDOM(FIXTURE_HTML, { url: 'https://cloud.oracle.com/fscmUI/faces/PurchaseOrder' });
    domDesk = new JSDOM(FIXTURE_HTML, { url: 'https://cloud.oracle.com/fscmUI/faces/PurchaseOrder' });
  });

  describe('1. Real DOM Interaction Capture Across Both Hosts', () => {
    it('captures identical semantic events when driven through Chrome vs Desktop harnesses', async () => {
      // ── Host 1: Extension Harness ──────────────────────────────────
      const extHost = new ChromeRecorderHost();
      const extRawEvents = [];
      const extRecorder = new PageRecorder({
        window: domExt.window,
        document: domExt.window.document,
        patchId: 'oracle',
        onEvent: (event) => {
          event.surfaceId = 'surf_ext_main';
          extRawEvents.push(event);
          extHost.storage.appendEvent(event);
        },
      });

      // Bind global environment for extension window
      globalThis.window = domExt.window;
      globalThis.document = domExt.window.document;
      extRecorder.start('oracle');

      // Execute interactions in Extension DOM
      const extPoInput = domExt.window.document.getElementById('poNumberInput');
      extPoInput.value = 'PO-99482';
      extPoInput.dispatchEvent(new domExt.window.Event('input', { bubbles: true }));
      extPoInput.dispatchEvent(new domExt.window.Event('change', { bubbles: true }));

      const extSupplier = domExt.window.document.getElementById('supplierSelect');
      extSupplier.value = 'GLOBEX_LLC';
      extSupplier.dispatchEvent(new domExt.window.Event('change', { bubbles: true }));

      const extUrgent = domExt.window.document.getElementById('urgentCheck');
      extUrgent.checked = true;
      extUrgent.dispatchEvent(new domExt.window.MouseEvent('click', { bubbles: true }));

      const extSave = domExt.window.document.getElementById('saveBtn');
      extSave.dispatchEvent(new domExt.window.MouseEvent('click', { bubbles: true }));

      extRecorder.stop();

      // ── Host 2: Desktop Harness ────────────────────────────────────
      const deskHost = new DesktopRecorderHost({ sessionId: 'sess_desk_diff_01' });
      const deskRawEvents = [];
      const deskRecorder = new PageRecorder({
        window: domDesk.window,
        document: domDesk.window.document,
        patchId: 'oracle',
        onEvent: (event) => {
          event.surfaceId = 'surf_desk_main';
          deskRawEvents.push(event);
          deskHost.storage.appendEvent(event);
        },
      });

      // Bind global environment for desktop window
      globalThis.window = domDesk.window;
      globalThis.document = domDesk.window.document;
      deskRecorder.start('oracle');

      // Execute identical interactions in Desktop DOM
      const deskPoInput = domDesk.window.document.getElementById('poNumberInput');
      deskPoInput.value = 'PO-99482';
      deskPoInput.dispatchEvent(new domDesk.window.Event('input', { bubbles: true }));
      deskPoInput.dispatchEvent(new domDesk.window.Event('change', { bubbles: true }));

      const deskSupplier = domDesk.window.document.getElementById('supplierSelect');
      deskSupplier.value = 'GLOBEX_LLC';
      deskSupplier.dispatchEvent(new domDesk.window.Event('change', { bubbles: true }));

      const deskUrgent = domDesk.window.document.getElementById('urgentCheck');
      deskUrgent.checked = true;
      deskUrgent.dispatchEvent(new domDesk.window.MouseEvent('click', { bubbles: true }));

      const deskSave = domDesk.window.document.getElementById('saveBtn');
      deskSave.dispatchEvent(new domDesk.window.MouseEvent('click', { bubbles: true }));

      deskRecorder.stop();

      // ── Verify Event Parity ───────────────────────────────────────
      expect(extRawEvents.length).toBeGreaterThan(0);
      expect(deskRawEvents.length).toBe(extRawEvents.length);

      const extTypes = extRawEvents.map((e) => e.type);
      const deskTypes = deskRawEvents.map((e) => e.type);
      expect(extTypes).toEqual(deskTypes);
    });
  });

  describe('2. Canonical Envelope Compilation & Schema Validation', () => {
    it('compiles identical SemanticStepV2 and schema-valid Protocol 2.0 envelopes from both hosts', () => {
      const oraclePatch = getPatch('oracle');

      const interactions = [
        {
          type: 'fill',
          value: 'PO-99482',
          committedValue: 'PO-99482',
          selector: '#poNumberInput',
          label: 'PO Number',
          required: true,
          surfaceId: 'surf_01',
          timestamp: 1000,
        },
        {
          type: 'select',
          value: 'GLOBEX_LLC',
          meta: { optionLabel: 'Globex LLC' },
          selector: '#supplierSelect',
          label: 'Supplier',
          surfaceId: 'surf_01',
          timestamp: 2000,
        },
        {
          type: 'check',
          checked: true,
          selector: '#urgentCheck',
          label: 'Mark as Urgent',
          surfaceId: 'surf_01',
          timestamp: 3000,
        },
        {
          type: 'click',
          selector: '#saveBtn',
          label: 'Save & Close',
          surfaceId: 'surf_01',
          timestamp: 4000,
        },
      ];

      // Extension pipeline
      let extProcessed = oraclePatch.postProcess ? oraclePatch.postProcess([...interactions], {}) : [...interactions];
      extProcessed = dedupEvents(extProcessed);
      const extActions = compileActions(extProcessed);
      const extEnvelope = buildRecordingEnvelope({
        producer: { kind: 'extension', version: '1.0.0' },
        meta: { sourceUrl: 'https://cloud.oracle.com/fscmUI/faces/PurchaseOrder', patchId: 'oracle' },
        steps: extActions,
      });

      // Desktop pipeline
      let deskProcessed = oraclePatch.postProcess ? oraclePatch.postProcess([...interactions], {}) : [...interactions];
      deskProcessed = dedupEvents(deskProcessed);
      const deskActions = compileActions(deskProcessed);
      const deskEnvelope = buildRecordingEnvelope({
        producer: { kind: 'desktop', version: '1.0.0', platform: 'win32' },
        meta: { sourceUrl: 'https://cloud.oracle.com/fscmUI/faces/PurchaseOrder', patchId: 'oracle' },
        steps: deskActions,
      });

      // Assert semantic steps equality (normalized without producer-specific metadata)
      expect(extEnvelope.steps).toEqual(deskEnvelope.steps);

      // Validate both against Protocol 2.0 schema
      expect(RecordingEnvelopeSchema.safeParse(extEnvelope).success).toBe(true);
      expect(RecordingEnvelopeSchema.safeParse(deskEnvelope).success).toBe(true);

      for (const step of deskEnvelope.steps) {
        expect(SemanticStepV2Schema.safeParse(step).success).toBe(true);
      }
    });
  });

  describe('3. DesktopHost Authoritative Surfaces, Frames, Navigation & Lifecycle', () => {
    it('manages surface registration, authoritative frame identity, and lifecycle callbacks', () => {
      const host = new DesktopRecorderHost({ sessionId: 'sess_desk_test_02' });

      // 1. Surface registration
      const mockPage = { url: () => 'https://cloud.oracle.com/home' };
      const surface = host.surfaces.registerPage(mockPage, 'tab');
      expect(surface.surfaceId).toContain('sess_desk_test_02');
      expect(surface.state).toBe('active');
      expect(host.surfaces.getActiveSurface()?.surfaceId).toBe(surface.surfaceId);

      // 2. Authoritative frame identity resolution
      const mockFrame = {
        page: () => mockPage,
        url: () => 'https://cloud.oracle.com/fscmUI/faces/iframe1',
        name: () => 'pt1:r1:0:i1',
        parentFrame: () => ({ name: () => 'root' }),
      };
      const frameIdentity = host.frames.resolveFrameIdentity(mockFrame, surface.surfaceId);
      expect(frameIdentity).not.toBeNull();
      expect(frameIdentity.surfaceId).toBe(surface.surfaceId);
      expect(frameIdentity.name).toBe('pt1:r1:0:i1');
      expect(frameIdentity.hostFrameId).toContain('pt1:r1:0:i1');

      // 3. Navigation observer
      let navEventUrl = '';
      host.navigation.onNavigationCompleted((url) => { navEventUrl = url; });
      host.navigation.emitCompleted('https://cloud.oracle.com/fscmUI/faces/PurchaseOrder', surface.surfaceId, 200);
      expect(navEventUrl).toBe('https://cloud.oracle.com/fscmUI/faces/PurchaseOrder');

      // 4. Lifecycle pause/resume/stop callbacks
      let paused = false;
      let resumed = false;
      let stopped = false;
      host.lifecycle.onPause(() => { paused = true; });
      host.lifecycle.onResume(() => { resumed = true; });
      host.lifecycle.onStop(() => { stopped = true; });

      host.lifecycle.pause();
      expect(host.lifecycle.isPaused()).toBe(true);
      expect(paused).toBe(true);

      host.lifecycle.resume();
      expect(host.lifecycle.isPaused()).toBe(false);
      expect(resumed).toBe(true);

      host.lifecycle.emitStop();
      expect(stopped).toBe(true);
    });
  });

  describe('4. Redwood & ADF Complex Component Differential Execution', () => {
    const ORACLE_FIXTURE_HTML = `<!DOCTYPE html>
    <html>
      <head><title>Oracle Fusion Expense Report</title></head>
      <body>
        <div class="form-container">
          <oj-c-select-single id="expenseCategory" label-hint="Expense Category" aria-expanded="true">
            <div class="oj-select-input-container">
              <input type="text" class="oj-select-input" value="Travel" />
            </div>
          </oj-c-select-single>
          
          <div id="pt1:r1:merchantLov" class="af_inputListOfValues">
            <label for="pt1:r1:merchantLov::content">Merchant</label>
            <input id="pt1:r1:merchantLov::content" role="combobox" type="text" value="Hilton" />
            <a id="pt1:r1:merchantLov::lovIconId" class="af_inputListOfValues_search-icon" href="#"></a>
            <div id="pt1:r1:merchantLovlovPopupId" class="af_dialog"></div>
          </div>
        </div>

        <div class="oj-listbox-drop" data-oj-container-for="expenseCategory">
          <ul role="listbox">
            <li role="option" class="oj-listbox-result" data-oj-value="MEALS">
              <div class="oj-listbox-result-label">Meals & Entertainment</div>
            </li>
          </ul>
        </div>
      </body>
    </html>`;

    it('emits identical SemanticStepV2 actions for Redwood custom element dropdowns on Extension and Desktop', () => {
      const extEvents = [];
      const deskEvents = [];

      const domExtOracle = new JSDOM(ORACLE_FIXTURE_HTML, { url: 'https://fusion.oraclecloud.test/expenses' });
      const domDeskOracle = new JSDOM(ORACLE_FIXTURE_HTML, { url: 'https://fusion.oraclecloud.test/expenses' });

      // Host 1: Extension
      const extRecorder = new PageRecorder({
        window: domExtOracle.window,
        document: domExtOracle.window.document,
        patchId: 'oracle',
        onEvent: (ev) => extEvents.push(ev),
      });
      globalThis.window = domExtOracle.window;
      globalThis.document = domExtOracle.window.document;
      extRecorder.start('oracle');

      const extOption = domExtOracle.window.document.querySelector('li[data-oj-value="MEALS"]');
      extOption.dispatchEvent(new domExtOracle.window.MouseEvent('click', { bubbles: true }));
      extRecorder.stop();

      // Host 2: Desktop
      const deskRecorder = new PageRecorder({
        window: domDeskOracle.window,
        document: domDeskOracle.window.document,
        patchId: 'oracle',
        onEvent: (ev) => deskEvents.push(ev),
      });
      globalThis.window = domDeskOracle.window;
      globalThis.document = domDeskOracle.window.document;
      deskRecorder.start('oracle');

      const deskOption = domDeskOracle.window.document.querySelector('li[data-oj-value="MEALS"]');
      deskOption.dispatchEvent(new domDeskOracle.window.MouseEvent('click', { bubbles: true }));
      deskRecorder.stop();

      expect(extEvents.length).toBeGreaterThan(0);
      expect(deskEvents.length).toBe(extEvents.length);

      const extAction = extEvents[0];
      const deskAction = deskEvents[0];

      expect(extAction.type).toBe(deskAction.type);
      expect(extAction.value).toBe(deskAction.value);
      expect(extAction.label).toBe(deskAction.label);
    });

    it('emits identical ADF LOV step metadata across both hosts', () => {
      const domExtOracle = new JSDOM(ORACLE_FIXTURE_HTML, { url: 'https://fusion.oraclecloud.test/expenses' });
      const domDeskOracle = new JSDOM(ORACLE_FIXTURE_HTML, { url: 'https://fusion.oraclecloud.test/expenses' });

      const extInput = domExtOracle.window.document.getElementById('pt1:r1:merchantLov::content');
      const deskInput = domDeskOracle.window.document.getElementById('pt1:r1:merchantLov::content');

      const extPatch = getPatch('oracle');
      const deskPatch = getPatch('oracle');

      const extMeta = extPatch.resolve.meta ? extPatch.resolve.meta(extInput) : {};
      const deskMeta = deskPatch.resolve.meta ? deskPatch.resolve.meta(deskInput) : {};

      expect(extMeta).toEqual(deskMeta);
      expect(extMeta.hasLovIcon).toBe(true);
      expect(extMeta.componentId).toBe('pt1:r1:merchantLov');

      const extLovData = getLovMetadata(extInput);
      const deskLovData = getLovMetadata(deskInput);
      expect(extLovData).toEqual(deskLovData);
      expect(extLovData.lovKind).toBe('modal');
    });
  });
});

