import { describe, it, expect, beforeEach } from 'vitest';
import { SurfaceRegistry } from '../src/core/background/surface-registry.js';
import { LifecycleObservers, EffectCorrelator } from '../src/core/background/observers.js';
import { RecorderBridge } from '@flowtrace/recorder-core';
import { FrameRegistry } from '@flowtrace/recorder-core';
import { FileCapture } from '@flowtrace/recorder-core';
import { GeometryCapture } from '@flowtrace/recorder-core';
import {
  isRedwoodHost,
  findRedwoodOption,
  resolveRedwoodHost,
  extractRedwoodOptionData,
  createRedwoodSelectEvent,
  getRedwoodLabel
} from '@flowtrace/recorder-core';
import { frameAncestryPath } from '@flowtrace/recorder-core';

describe('TRACE-43: Zero-CDP vs CRX Transport Equivalence Characterization Suite', () => {
  describe('1. Surface Lifecycle & Multi-Tab Popups (Equivalence with CrxTransport Page/Target events)', () => {
    it('accurately establishes primary surface and correlates spawned popup tab with opener linkage', () => {
      const sessionId = 'rec_sess_equiv_01';
      const surfaceRegistry = new SurfaceRegistry({ sessionId });

      // Primary tab initialization
      const primarySurface = surfaceRegistry.registerPrimary(101, { url: 'https://erp.example.com/main', windowId: 1 });
      expect(primarySurface.surfaceId).toBe(`surf_${sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}_main_101`);
      expect(primarySurface.openerSurfaceId).toBeNull();
      expect(primarySurface.url).toBe('https://erp.example.com/main');

      // Popup spawned with opener tab 101
      const popupSurface = surfaceRegistry.registerPopup(102, 101, {
        url: 'https://erp.example.com/lookup-dialog',
        windowId: 2
      });
      expect(popupSurface.surfaceId).toBe(`surf_${sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}_popup_1_102`);
      expect(popupSurface.openerSurfaceId).toBe(primarySurface.surfaceId);

      // Verify listing and retrieval
      const surfaces = surfaceRegistry.getAll();
      expect(surfaces).toHaveLength(2);
      expect(surfaceRegistry.getByTabId(102)).toEqual(popupSurface);
      expect(surfaceRegistry.getById(primarySurface.surfaceId)).toEqual(primarySurface);

      // Close popup tab
      const removed = surfaceRegistry.removeTab(102);
      expect(removed.surfaceId).toBe(popupSurface.surfaceId);
      expect(surfaceRegistry.getAll()).toHaveLength(1);
      expect(surfaceRegistry.hasTab(102)).toBe(false);
    });

    it('recovers surface state during MV3 service worker reboot', () => {
      const sessionId = 'rec_sess_equiv_02';
      const registry1 = new SurfaceRegistry({ sessionId });
      registry1.registerPrimary(201, { url: 'https://cloud.oracle.com/home' });
      registry1.registerPopup(202, 201, { url: 'https://cloud.oracle.com/modal' });

      const stateSnapshot = registry1.toJSON();

      // Simulate new instance after SW hibernation
      const registry2 = new SurfaceRegistry();
      registry2.fromJSON(stateSnapshot);

      expect(registry2.getAll()).toHaveLength(2);
      expect(registry2.getByTabId(202).openerSurfaceId).toBe(`surf_${sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}_main_201`);
    });
  });

  describe('2. Zero-CDP Browser Observers & Semantic Effect Correlation', () => {
    let effectCorrelator;

    beforeEach(() => {
      effectCorrelator = new EffectCorrelator();
    });

    it('correlates button click triggering navigation into a single durable effect', () => {
      // User initiates click action on save button
      const action = {
        id: 'act_001',
        type: 'click',
        action: 'click',
        selector: 'button#save-btn',
        surfaceId: 'surf_main_101',
        timestamp: Date.now()
      };
      effectCorrelator.recordAction(action);

      // Navigation observer catches URL transition on the same surface
      const navEffect = {
        kind: 'navigation',
        surfaceId: 'surf_main_101',
        tabId: 101,
        url: 'https://erp.example.com/details/456',
        timestamp: action.timestamp + 50
      };

      const correlated = effectCorrelator.correlateEffect(navEffect);
      expect(correlated).toBe(action);
      expect(action.effects).toBeDefined();
      expect(action.effects).toHaveLength(1);
      expect(action.effects[0].kind).toBe('navigation');
      expect(action.effects[0].url).toBe('https://erp.example.com/details/456');
    });

    it('correlates export action with zero-CDP download observer event', () => {
      const action = {
        id: 'act_002',
        type: 'click',
        action: 'click',
        selector: 'button.export-csv',
        surfaceId: 'surf_main_101',
        timestamp: Date.now()
      };
      effectCorrelator.recordAction(action);

      const downloadEffect = {
        kind: 'download',
        surfaceId: 'surf_main_101',
        downloadId: 991,
        url: 'https://erp.example.com/api/export.csv',
        filename: 'report_2026.csv',
        timestamp: action.timestamp + 120
      };

      const correlated = effectCorrelator.correlateEffect(downloadEffect);
      expect(correlated).toBe(action);
      expect(action.effects).toHaveLength(1);
      expect(action.effects[0].kind).toBe('download');
      expect(action.effects[0].filename).toBe('report_2026.csv');
    });

    it('correlates popup dialog opening with originating opener surface action', () => {
      const action = {
        id: 'act_003',
        type: 'click',
        action: 'click',
        selector: 'a.lov-dialog-trigger',
        surfaceId: 'surf_main_101',
        timestamp: Date.now()
      };
      effectCorrelator.recordAction(action);

      const popupEffect = {
        kind: 'popup',
        surfaceId: 'surf_popup_1_102',
        openerSurfaceId: 'surf_main_101',
        tabId: 102,
        url: 'https://erp.example.com/lov',
        timestamp: action.timestamp + 80
      };

      const correlated = effectCorrelator.correlateEffect(popupEffect);
      expect(correlated).toBe(action);
      expect(action.effects).toHaveLength(1);
      expect(action.effects[0].kind).toBe('popup');
      expect(action.effects[0].surfaceId).toBe('surf_popup_1_102');
    });
  });

  describe('3. In-Page Bridge & Monotonic Ordering (Replacing CrxTransport IPC)', () => {
    it('guarantees in-order delivery and ACK resolution without message loss', async () => {
      const receivedMessages = [];
      let messageHandler = null;

      const mockTransport = {
        send: (envelope) => {
          receivedMessages.push(envelope);
          if (envelope.waitForAck) {
            setTimeout(() => {
              if (messageHandler) {
                messageHandler({
                  channel: envelope.channel,
                  type: '__ACK__',
                  ackSeq: envelope.seq,
                  payload: { status: 'acknowledged' }
                });
              }
            }, 5);
          }
        },
        onMessage: (cb) => {
          messageHandler = cb;
        }
      };

      const bridge = new RecorderBridge({ transport: mockTransport });
      bridge.connect();

      const p1 = bridge.send('RECORD_EVENT', { verb: 'click', selector: '#btn1' }, { waitForAck: true });
      const p2 = bridge.send('RECORD_EVENT', { verb: 'input', value: 'test' }, { waitForAck: true });
      const p3 = bridge.send('RECORD_EVENT', { verb: 'submit', formId: 'f1' }, { waitForAck: true });

      const results = await Promise.all([p1, p2, p3]);

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ status: 'acknowledged' });
      expect(receivedMessages).toHaveLength(3);
      expect(receivedMessages[0].seq).toBe(1);
      expect(receivedMessages[1].seq).toBe(2);
      expect(receivedMessages[2].seq).toBe(3);

      bridge.dispose();
    });
  });

  describe('4. Nested Frame Hierarchy & Coordinate Translation', () => {
    it('generates frame locators and translates absolute coordinates via FrameRegistry', () => {
      const frameRegistry = new FrameRegistry({ tabId: 1 });
      
      // Register root frame (0)
      frameRegistry.registerFrame({ frameId: 0, parentFrameId: null, url: 'https://erp.example.com/' });

      // Register main sub-frame
      frameRegistry.registerFrame({
        frameId: 1,
        parentFrameId: 0,
        name: 'appFrame',
        url: 'https://erp.example.com/app',
        selector: 'iframe#appFrame'
      });

      // Register nested modal frame
      frameRegistry.registerFrame({
        frameId: 2,
        parentFrameId: 1,
        name: 'modalFrame',
        url: 'https://erp.example.com/modal',
        selector: 'iframe[name="modalFrame"]'
      });

      const locators = frameRegistry.getFrameLocators(2);
      expect(locators).toEqual(['iframe#appFrame', 'iframe[name="modalFrame"]']);

      const targetRect = { x: 20, y: 30, width: 100, height: 40 };
      const frameOffsets = [{ x: 50, y: 100 }, { x: 10, y: 20 }];
      const abs = frameRegistry.translateToAbsolute(targetRect, frameOffsets);

      expect(abs.x).toBe(80);
      expect(abs.y).toBe(150);
      expect(abs.width).toBe(100);
      expect(abs.height).toBe(40);
      expect(abs.right).toBe(180);
      expect(abs.bottom).toBe(190);
    });

    it('derives fallback frame ancestry path safely', () => {
      const path = frameAncestryPath();
      expect(Array.isArray(path)).toBe(true);
    });
  });

  describe('5. Oracle Redwood JET & Custom Element Normalization', () => {
    it('normalizes Oracle Redwood single select actions into clean semantic steps', () => {
      const hostEl = document.createElement('oj-c-select-single');
      hostEl.id = 'status-select';
      hostEl.setAttribute('label-hint', 'Order Status');
      document.body.appendChild(hostEl);

      const optionEl = document.createElement('div');
      optionEl.setAttribute('role', 'option');
      optionEl.setAttribute('data-oj-value', 'STATUS_ACTIVE');
      optionEl.textContent = 'Active Status';
      document.body.appendChild(optionEl);

      expect(isRedwoodHost(hostEl)).toBe(true);
      expect(findRedwoodOption(optionEl)).toBe(optionEl);
      expect(getRedwoodLabel(hostEl)).toBe('Order Status');

      const data = extractRedwoodOptionData(optionEl);
      expect(data.value).toBe('STATUS_ACTIVE');
      expect(data.label).toBe('Active Status');

      const event = createRedwoodSelectEvent(hostEl, optionEl, {
        selectorFor: () => ({ selector: 'oj-c-select-single#status-select', locator: 'page.locator("oj-c-select-single#status-select")' })
      });

      expect(event.type).toBe('selectOption');
      expect(event.value).toBe('Active Status');
      expect(event.meta.framework).toBe('oracle-redwood');
      expect(event.meta.componentType).toBe('oj-c-select-single');
      expect(event.meta.hostLabel).toBe('Order Status');

      document.body.removeChild(hostEl);
      document.body.removeChild(optionEl);
    });
  });

  describe('6. Detached File Input Interception & Evidence Capture', () => {
    it('records initiators and intercepts file changes without CDP', () => {
      let capturedPayload = null;
      const fileCapture = new FileCapture({
        onFileSelected: (payload) => {
          capturedPayload = payload;
        }
      });

      const button = document.createElement('button');
      button.id = 'upload-btn';
      document.body.appendChild(button);

      fileCapture.recordInitiator(button);
      expect(fileCapture.getActiveInitiator()).toBe(button);

      const input = document.createElement('input');
      input.type = 'file';

      fileCapture.install(window);

      // Manually trigger prototype interceptor logic
      input.click();

      // Set files property
      Object.defineProperty(input, 'files', {
        value: [{ name: 'invoice.pdf', size: 12040, type: 'application/pdf', lastModified: 1700000000 }],
        writable: true
      });

      input.dispatchEvent(new Event('change'));

      expect(capturedPayload).not.toBeNull();
      expect(capturedPayload.type).toBe('file-upload');
      expect(capturedPayload.files[0].name).toBe('invoice.pdf');
      expect(capturedPayload.initiatorElement).toBe(button);

      fileCapture.uninstall(window);
      document.body.removeChild(button);
    });

    it('handles reused input element across multiple click initiators accurately', () => {
      let capturedPayload = null;
      const fileCapture = new FileCapture({
        onFileSelected: (payload) => {
          capturedPayload = payload;
        }
      });

      const btn1 = document.createElement('button');
      btn1.id = 'btn-first';
      const btn2 = document.createElement('button');
      btn2.id = 'btn-second';
      document.body.appendChild(btn1);
      document.body.appendChild(btn2);

      const input = document.createElement('input');
      input.type = 'file';

      fileCapture.install(window);

      // First click on btn1
      fileCapture.recordInitiator(btn1);
      input.click();

      // Second click on btn2 reuses the same input
      fileCapture.recordInitiator(btn2);
      input.click();

      // Set files property
      Object.defineProperty(input, 'files', {
        value: [{ name: 'statement.csv', size: 512, type: 'text/csv', lastModified: 1700000000 }],
        writable: true
      });

      input.dispatchEvent(new Event('change'));

      expect(capturedPayload).not.toBeNull();
      expect(capturedPayload.initiatorElement).toBe(btn2);
      expect(capturedPayload.files[0].name).toBe('statement.csv');

      fileCapture.uninstall(window);
      document.body.removeChild(btn1);
      document.body.removeChild(btn2);
    });

    it('resolves actively expanded host ahead of preceding blurred element holding .oj-focus', () => {
      const blurredHost = document.createElement('oj-c-select-single');
      blurredHost.id = 'blurred-select';
      blurredHost.className = 'oj-focus'; // Preceding in DOM, but blurred

      const activeExpandedHost = document.createElement('oj-c-select-single');
      activeExpandedHost.id = 'active-select';
      activeExpandedHost.setAttribute('aria-expanded', 'true'); // Actively expanded

      document.body.appendChild(blurredHost);
      document.body.appendChild(activeExpandedHost);

      const option = document.createElement('div');
      option.className = 'oj-listbox-result-label';
      document.body.appendChild(option);

      const resolved = resolveRedwoodHost(option);
      expect(resolved).toBe(activeExpandedHost);

      document.body.removeChild(blurredHost);
      document.body.removeChild(activeExpandedHost);
      document.body.removeChild(option);
    });

    it('extracts precise bounding box and occlusion metrics using GeometryCapture', () => {
      const geometry = new GeometryCapture();
      const div = document.createElement('div');
      div.getBoundingClientRect = () => ({
        left: 100,
        top: 150,
        width: 200,
        height: 40,
        right: 300,
        bottom: 190,
        x: 100,
        y: 150
      });

      const metrics = geometry.capture(div, { force: true });
      expect(metrics).not.toBeNull();
      expect(metrics.viewportBox).toEqual({ x: 100, y: 150, width: 200, height: 40 });
      expect(metrics.centerPoint).toEqual({ x: 200, y: 170 });
      expect(metrics.isVisible).toBe(true);
    });
  });
});
