import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RecorderBridge } from '@flowtrace/recorder-core';
import { FrameRegistry } from '@flowtrace/recorder-core';
import { FileCapture } from '@flowtrace/recorder-core';

describe('RecorderBridge (recorder-bridge.js)', () => {
  it('sends messages with monotonic sequence numbers and receives ACK', async () => {
    let peerHandler = null;
    const sentToPeer = [];

    const mockTransport = {
      send(envelope) {
        sentToPeer.push(envelope);
        // Simulate peer acknowledging
        if (envelope.waitForAck) {
          setTimeout(() => {
            if (peerHandler) {
              peerHandler({
                type: '__ACK__',
                ackSeq: envelope.seq,
                payload: { received: true },
              });
            }
          }, 10);
        }
      },
      onMessage(handler) {
        peerHandler = handler;
      },
    };

    const bridge = new RecorderBridge({ transport: mockTransport });
    bridge.connect();

    const ackPromise = bridge.send('ACTION_RECORDED', { action: 'click' }, { waitForAck: true });
    const result = await ackPromise;

    expect(result).toEqual({ received: true });
    expect(sentToPeer.length).toBe(1);
    expect(sentToPeer[0].seq).toBe(1);
    expect(sentToPeer[0].type).toBe('ACTION_RECORDED');

    bridge.dispose();
  });

  it('queues messages before connection and flushes on connect', () => {
    const bridge = new RecorderBridge();
    bridge.send('QUEUED_1', { data: 1 });
    bridge.send('QUEUED_2', { data: 2 });

    expect(bridge._outboxQueue.length).toBe(2);

    const sent = [];
    bridge.transport = {
      send(msg) { sent.push(msg); },
      onMessage() {},
    };

    bridge.connect();
    expect(bridge._outboxQueue.length).toBe(0);

    bridge.dispose();
  });

  it('notifies registered listeners for incoming typed messages', () => {
    let peerHandler = null;
    const mockTransport = {
      send() {},
      onMessage(handler) { peerHandler = handler; },
    };

    const bridge = new RecorderBridge({ transport: mockTransport });
    bridge.connect();

    const received = [];
    bridge.on('RECORDER_CONFIG', (payload) => {
      received.push(payload);
    });

    peerHandler({
      type: 'RECORDER_CONFIG',
      payload: { mode: 'recording' },
    });

    expect(received).toEqual([{ mode: 'recording' }]);

    bridge.dispose();
  });
});

describe('FrameRegistry (frame-registry.js)', () => {
  it('registers and tracks nested frame hierarchy', () => {
    const registry = new FrameRegistry({ tabId: 101 });

    registry.registerFrame({ frameId: 0, url: 'https://app.oracle.com/main' });
    registry.registerFrame({ frameId: 1, parentFrameId: 0, name: 'iframe-app', url: 'https://app.oracle.com/sub' });
    registry.registerFrame({ frameId: 2, parentFrameId: 1, name: 'nested-view', url: 'https://app.oracle.com/view' });

    const chain = registry.getFrameChain(2);
    expect(chain.map((f) => f.frameId)).toEqual([0, 1, 2]);

    const locators = registry.getFrameLocators(2);
    expect(locators).toEqual([
      'iframe[name="iframe-app"]',
      'iframe[name="nested-view"]',
    ]);
  });

  it('derives iframe selector accurately', () => {
    const registry = new FrameRegistry();

    document.body.innerHTML = `
      <iframe id="crm_frame" name="main_frame" src="/page.html"></iframe>
      <iframe name="nameless_frame" src="/other.html"></iframe>
      <iframe title="Reporting View"></iframe>
    `;

    const frames = document.querySelectorAll('iframe');
    expect(registry.deriveIframeSelector(frames[0])).toBe('iframe#crm_frame');
    expect(registry.deriveIframeSelector(frames[1])).toBe('iframe[name="nameless_frame"]');
    expect(registry.deriveIframeSelector(frames[2])).toBe(`iframe[title="${CSS.escape('Reporting View')}"]`);
  });

  it('translates element bounding rect with iframe offset accumulation', () => {
    const registry = new FrameRegistry();
    const elRect = { x: 50, y: 30, width: 200, height: 40, top: 30, left: 50, right: 250, bottom: 70 };
    const frameOffsets = [
      { x: 100, y: 150 },
      { x: 20, y: 10 },
    ];

    const absRect = registry.translateToAbsolute(elRect, frameOffsets);
    expect(absRect.x).toBe(170);
    expect(absRect.y).toBe(190);
    expect(absRect.left).toBe(170);
    expect(absRect.top).toBe(190);
    expect(absRect.right).toBe(370);
    expect(absRect.bottom).toBe(230);
    expect(absRect.width).toBe(200);
    expect(absRect.height).toBe(40);
  });
});

describe('FileCapture (file-capture.js)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('associates detached file input click with active initiator element', () => {
    const captured = [];
    const fileCapture = new FileCapture({
      onFileSelected: (ev) => captured.push(ev),
    });

    fileCapture.install(window);

    document.body.innerHTML = '<button id="upload_btn">Upload Document</button>';
    const btn = document.getElementById('upload_btn');

    // Simulate user clicking upload button
    fileCapture.recordInitiator(btn);
    expect(fileCapture.getActiveInitiator()).toBe(btn);

    // Modern framework creates detached file input and calls click()
    const detachedInput = document.createElement('input');
    detachedInput.type = 'file';

    // Mock files property
    const mockFile = new File(['hello world'], 'contract.pdf', { type: 'application/pdf' });
    Object.defineProperty(detachedInput, 'files', {
      value: [mockFile],
      writable: false,
    });

    detachedInput.click();

    // Trigger change event
    detachedInput.dispatchEvent(new Event('change'));

    expect(captured.length).toBe(1);
    expect(captured[0].isDetached).toBe(true);
    expect(captured[0].initiatorElement).toBe(btn);
    expect(captured[0].files[0].name).toBe('contract.pdf');

    fileCapture.uninstall(window);
  });
});
