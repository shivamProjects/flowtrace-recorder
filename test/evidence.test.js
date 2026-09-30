import { describe, it, expect, beforeEach } from 'vitest';
import { GeometryCapture } from '../src/core/evidence/geometry.js';
import { ScreenshotManager } from '../src/core/evidence/screenshot.js';

describe('GeometryCapture (geometry.js)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('captures accurate bounding box, viewport metrics, and center point', () => {
    const capture = new GeometryCapture();

    document.body.innerHTML = '<div id="target_el" style="width: 200px; height: 100px;">Button</div>';
    const el = document.getElementById('target_el');

    // Mock getBoundingClientRect
    el.getBoundingClientRect = () => ({
      left: 100,
      top: 50,
      right: 300,
      bottom: 150,
      width: 200,
      height: 100,
      x: 100,
      y: 50,
    });

    const geom = capture.capture(el, { force: true });

    expect(geom).not.toBeNull();
    expect(geom.viewportBox.x).toBe(100);
    expect(geom.viewportBox.y).toBe(50);
    expect(geom.viewportBox.width).toBe(200);
    expect(geom.viewportBox.height).toBe(100);
    expect(geom.centerPoint).toEqual({ x: 200, y: 100 });
    expect(geom.isVisible).toBe(true);
    expect(geom.visibilityRatio).toBe(1);
  });

  it('deduplicates rapid consecutive captures on the same element within time window', () => {
    const capture = new GeometryCapture({ dedupWindowMs: 1500 });

    document.body.innerHTML = '<input id="input_field" />';
    const el = document.getElementById('input_field');
    el.getBoundingClientRect = () => ({ left: 10, top: 10, width: 50, height: 20, right: 60, bottom: 30, x: 10, y: 10 });

    const geom1 = capture.capture(el);
    const geom2 = capture.capture(el);

    expect(geom1).toBe(geom2); // Exactly the same reference returned
  });

  it('applies iframe offset accumulation to absolute coordinates', () => {
    const capture = new GeometryCapture();

    document.body.innerHTML = '<button id="iframe_child">Inside Frame</button>';
    const el = document.getElementById('iframe_child');
    el.getBoundingClientRect = () => ({ left: 20, top: 30, width: 80, height: 40, right: 100, bottom: 70, x: 20, y: 30 });

    const geom = capture.capture(el, {
      force: true,
      frameOffsets: [{ x: 300, y: 200 }],
    });

    expect(geom.viewportBox.x).toBe(320);
    expect(geom.viewportBox.y).toBe(230);
    expect(geom.centerPoint).toEqual({ x: 360, y: 250 });
  });
});

describe('ScreenshotManager (screenshot.js)', () => {
  it('formats screenshot evidence payload with geometry highlights without DOM mutation', async () => {
    const mockProvider = {
      async captureVisibleTab(windowId, options) {
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      },
    };

    const manager = new ScreenshotManager({ captureProvider: mockProvider });
    const geometry = {
      viewportBox: { x: 100, y: 50, width: 200, height: 100 },
      viewport: { width: 1920, height: 1080, scrollX: 0, scrollY: 0 },
    };

    const evidence = await manager.captureTab({ windowId: 1, tabId: 2, geometry });

    expect(evidence.type).toBe('screenshot');
    expect(evidence.mimeType).toBe('image/png');
    expect(evidence.dataUrl).toContain('data:image/png;base64');
    expect(evidence.highlight).toEqual({ x: 100, y: 50, width: 200, height: 100 });
    expect(evidence.viewport).toEqual({ width: 1920, height: 1080, scrollX: 0, scrollY: 0 });

    manager.clear();
  });
});
