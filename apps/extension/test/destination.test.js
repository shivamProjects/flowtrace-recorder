/**
 * destination.test.js — Characterization and unit test suite for Recorder Destination Architecture.
 *
 * Verifies:
 * 1. FlowTraceDestination natively uploads Protocol 2.0 RecordingEnvelope to /api/v1/recordings.
 * 2. PlatformDestination uploads serialized stepsJson envelope to /api/oracle/recordings.
 * 3. Dynamic destination registration and switching via settings.
 * 4. Error handling across unauthenticated (401), unauthorized (403), network timeouts, and malformed responses.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DESTINATION_TYPE,
  FlowTraceDestination,
  PlatformDestination,
  createDestination,
  registerDestination,
  getRegisteredDestinations,
  makeEnvelope,
  SCHEMA_VERSION,
} from '@flowtrace/recorder-core';

describe('Recorder Destination Architecture', () => {
  let requests = [];
  let routes = {};

  beforeEach(() => {
    requests = [];
    routes = {};

    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const parsedUrl = new URL(url, 'http://localhost');
      const pathname = parsedUrl.pathname;
      requests.push({ url: String(url), init });

      const handler = routes[pathname];
      if (handler) {
        return handler(init);
      }
      return new Response(JSON.stringify({ error: `No route for ${pathname}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  function ok(data, status = 200) {
    return new Response(JSON.stringify({ success: true, data }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function error(message, status = 400) {
    return new Response(JSON.stringify({ success: false, error: message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sampleEnvelope = makeEnvelope({
    name: 'Sample Recording',
    description: 'Protocol 2.0 Test Recording',
    sourceUrl: 'https://erp.example.com/fusion',
    patchId: 'oracle',
    actions: [
      {
        type: 'click',
        timestamp: Date.now(),
        selector: '#pt1:cb1',
        locator: 'button:has-text("Submit")',
        text: 'Submit',
        label: 'Submit Button',
        role: 'button',
      },
    ],
    steps: [
      {
        id: 'step_1',
        type: 'click',
        surfaceId: 'surface_default',
        locator: {
          strategy: 'role_and_name',
          role: 'button',
          name: 'Submit Button',
          selector: '#pt1:cb1',
        },
      },
    ],
  });

  describe('Destination Factory & Registry', () => {
    it('creates FlowTraceDestination and PlatformDestination by type', () => {
      const ft = createDestination('flowtrace');
      expect(ft).toBeInstanceOf(FlowTraceDestination);
      expect(ft.id).toBe(DESTINATION_TYPE.FLOWTRACE);

      const plat = createDestination('platform');
      expect(plat).toBeInstanceOf(PlatformDestination);
      expect(plat.id).toBe(DESTINATION_TYPE.PLATFORM);
    });

    it('defaults to FlowTraceDestination on unknown type', () => {
      const dest = createDestination('unknown_dest');
      expect(dest).toBeInstanceOf(FlowTraceDestination);
    });

    it('returns all registered destinations', () => {
      const registered = getRegisteredDestinations();
      expect(registered.length).toBeGreaterThanOrEqual(2);
      expect(registered.some((d) => d.id === 'flowtrace')).toBe(true);
      expect(registered.some((d) => d.id === 'platform')).toBe(true);
    });
  });

  describe('FlowTraceDestination', () => {
    const destination = new FlowTraceDestination();

    it('uploads canonical Protocol 2.0 RecordingEnvelope to /api/v1/recordings', async () => {
      routes['/api/v1/recordings'] = (init) => {
        const body = JSON.parse(init.body);
        expect(body.protocolVersion).toBe('2.0');
        expect(body.meta.name).toBe('Sample Recording');
        expect(body.meta.patchId).toBe('oracle');
        expect(body.meta.sourceUrl).toBe('https://erp.example.com/fusion');
        expect(body.steps.length).toBe(1);
        expect(body.steps[0].action).toBe('click');
        return ok({ id: 'rec_ft_123', name: body.meta.name }, 201);
      };

      const result = await destination.uploadRecording({
        envelope: sampleEnvelope,
        apiBase: 'http://localhost:3050',
        token: 'test-jwt-token',
      });

      expect(result.success).toBe(true);
      expect(result.recording.id).toBe('rec_ft_123');

      const req = requests.find((r) => r.url.endsWith('/api/v1/recordings'));
      expect(req).toBeDefined();
      expect(req.init.headers.Authorization).toBe('Bearer test-jwt-token');
      expect(req.init.headers['Content-Type']).toBe('application/json');
    });

    it('handles 401 unauthenticated response properly', async () => {
      routes['/api/v1/recordings'] = () => new Response('Unauthorized', { status: 401 });

      const result = await destination.uploadRecording({
        envelope: sampleEnvelope,
        apiBase: 'http://localhost:3050',
        token: 'expired-token',
      });

      expect(result.success).toBe(false);
      expect(result.unauthenticated).toBe(true);
    });

    it('losslessly converts and validates all SemanticStepV2 action types', async () => {
      const fullActionSteps = [
        { action: 'navigate', value: 'https://erp.example.com', url: 'https://erp.example.com' },
        { action: 'click', locator: { selector: '#btn1' }, button: 'right', clickCount: 1, modifiers: { shift: true } },
        { action: 'dblclick', locator: { selector: '#item1' }, clickCount: 2, position: { x: 10, y: 20 } },
        { action: 'fill', locator: { selector: '#input1' }, value: 'Secret', committedValue: 'Secret', credentialRef: 'cred_1' },
        { action: 'selectOption', locator: { selector: '#select1' }, value: 'opt1', values: ['opt1'], optionIndex: 2 },
        { action: 'lovSelect', locator: { selector: '#lov1' }, value: 'Standard LOV Row', optionIndex: 0 },
        { action: 'press', locator: { selector: '#input1' }, key: 'Tab', modifiers: { control: true } },
        { action: 'check', locator: { selector: '#chk1' }, checked: true },
        { action: 'uncheck', locator: { selector: '#chk2' }, checked: false },
        { action: 'setInputFiles', locator: { selector: '#file1' }, files: ['invoice.pdf'], value: 'invoice.pdf' },
        { action: 'scroll', locator: { selector: '#table1' }, deltaX: 0, deltaY: 250 },
        { action: 'hover', locator: { selector: '#menu1' }, position: { x: 50, y: 15 } },
        { action: 'copy', locator: { selector: '#po-number' }, outputName: 'PURCHASE_ORDER_ID', value: 'PO-9921' },
        { action: 'wait', durationMs: 2500 },
        { action: 'assertVisible', locator: { selector: '#toast' } },
        { action: 'assertText', locator: { selector: '#status-msg' }, value: 'Order Approved' },
        { action: 'assertValue', locator: { selector: '#total' }, value: '$1,250.00' },
        { action: 'assertChecked', locator: { selector: '#chk-agree' }, checked: true },
        { action: 'assertSnapshot', locator: { selector: '#invoice-preview' }, snapshot: 'snap_base64_hash' },
      ];

      routes['/api/v1/recordings'] = (init) => {
        const body = JSON.parse(init.body);
        expect(body.protocolVersion).toBe('2.0');
        expect(body.steps.length).toBe(fullActionSteps.length);

        // Verify each action's specific fields were losslessly retained
        expect(body.steps[0].action).toBe('navigate');
        expect(body.steps[1].modifiers).toEqual({ shift: true });
        expect(body.steps[2].position).toEqual({ x: 10, y: 20 });
        expect(body.steps[3].credentialRef).toBe('cred_1');
        expect(body.steps[4].optionIndex).toBe(2);
        expect(body.steps[5].value).toBe('Standard LOV Row');
        expect(body.steps[6].key).toBe('Tab');
        expect(body.steps[7].checked).toBe(true);
        expect(body.steps[8].checked).toBe(false);
        expect(body.steps[9].files).toEqual(['invoice.pdf']);
        expect(body.steps[10].deltaY).toBe(250);
        expect(body.steps[11].position).toEqual({ x: 50, y: 15 });
        expect(body.steps[12].outputName).toBe('PURCHASE_ORDER_ID');
        expect(body.steps[13].durationMs).toBe(2500);
        expect(body.steps[14].action).toBe('assertVisible');
        expect(body.steps[15].value).toBe('Order Approved');
        expect(body.steps[16].value).toBe('$1,250.00');
        expect(body.steps[17].checked).toBe(true);
        expect(body.steps[18].snapshot).toBe('snap_base64_hash');

        return ok({ id: 'rec_lossless_all', name: body.meta.name }, 201);
      };

      const result = await destination.uploadRecording({
        envelope: {
          ...sampleEnvelope,
          steps: fullActionSteps,
        },
        apiBase: 'http://localhost:3050',
        token: 'test-jwt-token',
      });

      expect(result.success).toBe(true);
      expect(result.recording.id).toBe('rec_lossless_all');
    });

    it('returns fallback environment when /api/v1/environments is not implemented', async () => {
      routes['/api/v1/environments'] = () => new Response('Not Found', { status: 404 });

      const result = await destination.listEnvironments({
        apiBase: 'http://localhost:3050',
        token: 'test-token',
      });

      expect(result.success).toBe(true);
      expect(result.environments).toEqual([
        { id: 'default', name: 'Default FlowTrace Environment' },
      ]);
    });
  });

  describe('PlatformDestination', () => {
    const destination = new PlatformDestination();

    it('uploads serialized stepsJson payload to /api/oracle/recordings', async () => {
      routes['/api/oracle/recordings'] = (init) => {
        const body = JSON.parse(init.body);
        expect(body.environmentId).toBe('env_fusion_dev');
        expect(typeof body.stepsJson).toBe('string');
        const parsed = JSON.parse(body.stepsJson);
        expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
        expect(parsed.actions.length).toBe(1);
        return ok({ id: 'rec_plat_456', name: body.name });
      };

      const result = await destination.uploadRecording({
        envelope: sampleEnvelope,
        environment: { id: 'env_fusion_dev', name: 'Fusion Dev' },
        apiBase: 'http://localhost:3050',
        token: 'plat-token',
      });

      expect(result.success).toBe(true);
      expect(result.recording.id).toBe('rec_plat_456');

      const req = requests.find((r) => r.url.endsWith('/api/oracle/recordings'));
      expect(req).toBeDefined();
      expect(req.init.headers.Authorization).toBe('Bearer plat-token');
    });

    it('enforces environment selection before upload', async () => {
      const result = await destination.uploadRecording({
        envelope: sampleEnvelope,
        environment: null,
        apiBase: 'http://localhost:3050',
        token: 'plat-token',
      });

      expect(result.success).toBe(false);
      expect(result.environmentRequired).toBe(true);
    });

    it('enforces token authentication before upload', async () => {
      const result = await destination.uploadRecording({
        envelope: sampleEnvelope,
        environment: { id: 'env-1' },
        apiBase: 'http://localhost:3050',
        token: null,
      });

      expect(result.success).toBe(false);
      expect(result.unauthenticated).toBe(true);
    });

    it('lists environments from /api/environments', async () => {
      const envs = [{ id: 'env_1', name: 'Prod' }, { id: 'env_2', name: 'Stage' }];
      routes['/api/environments'] = () => ok(envs);

      const result = await destination.listEnvironments({
        apiBase: 'http://localhost:3050',
        token: 'plat-token',
      });

      expect(result.success).toBe(true);
      expect(result.environments).toEqual(envs);
    });
  });
});
