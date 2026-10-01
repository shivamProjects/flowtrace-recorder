import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentRegistry, GenericInputAdapter, GenericSelectAdapter, defaultRegistry } from '../src/core/components/registry.js';

describe('ComponentRegistry & Evidence Scoring (registry.js)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('detects generic input element with score and evidence', () => {
    document.body.innerHTML = '<input id="test_input" type="text" />';
    const el = document.getElementById('test_input');
    const match = defaultRegistry.detect(el);

    expect(match).not.toBeNull();
    expect(match.adapter.id).toBe('web.input.text');
    expect(match.result.component).toBe('web.input.text');
    expect(match.result.confidence).toBe(0.5);
    expect(match.result.evidence.length).toBeGreaterThan(0);
  });

  it('detects generic select element with score and evidence', () => {
    document.body.innerHTML = '<select id="test_select"><option>A</option></select>';
    const el = document.getElementById('test_select');
    const match = defaultRegistry.detect(el);

    expect(match).not.toBeNull();
    expect(match.adapter.id).toBe('web.select');
    expect(match.result.component).toBe('web.select');
    expect(match.result.confidence).toBe(0.5);
  });

  it('allows specific framework adapters to outrank generic ones via higher confidence', () => {
    const registry = new ComponentRegistry();
    registry.register(GenericInputAdapter);

    const MockAdfAdapter = {
      id: 'oracle.adf.inputText',
      framework: 'oracle-adf',
      detect(el) {
        if (el.id && el.id.includes('::content')) {
          return {
            component: 'oracle.adf.inputText',
            confidence: 0.95,
            evidence: [{ type: 'adf-content-id' }]
          };
        }
        return null;
      }
    };
    registry.register(MockAdfAdapter);

    document.body.innerHTML = '<input id="pt1:ap1:field::content" type="text" />';
    const el = document.getElementById('pt1:ap1:field::content');
    const match = registry.detect(el);

    expect(match).not.toBeNull();
    expect(match.adapter.id).toBe('oracle.adf.inputText');
    expect(match.result.confidence).toBe(0.95);
  });

  it('returns null gracefully when element matches no adapters', () => {
    document.body.innerHTML = '<div>Plain div</div>';
    const el = document.querySelector('div');
    expect(defaultRegistry.detect(el)).toBeNull();
  });
});
