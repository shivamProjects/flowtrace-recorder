/**
 * redwood.test.js — Unit tests for Oracle Redwood & JET Core Pack component adapter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  isRedwoodHost,
  findRedwoodOption,
  resolveRedwoodHost,
  getRedwoodLabel,
  extractRedwoodOptionData,
  createRedwoodSelectEvent,
} from '@flowtrace/recorder-core';

describe('Oracle Redwood / JET Component Adapter', () => {
  let dom;
  let document;
  let window;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
      url: 'https://fusion.oraclecloud.com/fscmUI/faces/FuseWelcome',
    });
    document = dom.window.document;
    window = dom.window;
    globalThis.document = document;
    globalThis.window = window;
  });

  afterEach(() => {
    dom = null;
  });

  describe('isRedwoodHost', () => {
    it('identifies Core Pack and JET custom element hosts', () => {
      const el1 = document.createElement('oj-c-select-single');
      const el2 = document.createElement('oj-select-single');
      const el3 = document.createElement('oj-c-input-text');
      const el4 = document.createElement('div');

      expect(isRedwoodHost(el1)).toBe(true);
      expect(isRedwoodHost(el2)).toBe(true);
      expect(isRedwoodHost(el3)).toBe(true);
      expect(isRedwoodHost(el4)).toBe(false);
      expect(isRedwoodHost(null)).toBe(false);
    });
  });

  describe('findRedwoodOption and extractRedwoodOptionData', () => {
    it('detects option element and extracts clean label and value', () => {
      const option = document.createElement('div');
      option.className = 'oj-listbox-result';
      option.setAttribute('data-oj-value', 'SUPP_001');

      const labelDiv = document.createElement('div');
      labelDiv.className = 'oj-listbox-result-label';
      labelDiv.textContent = 'Acme Supplier Corp';
      option.appendChild(labelDiv);

      const subDiv = document.createElement('div');
      subDiv.className = 'subtext';
      subDiv.textContent = 'Active • USD';
      option.appendChild(subDiv);

      document.body.appendChild(option);

      const found = findRedwoodOption(labelDiv);
      expect(found).toBe(option);

      const data = extractRedwoodOptionData(option);
      expect(data.label).toBe('Acme Supplier Corp');
      expect(data.value).toBe('SUPP_001');
    });
  });

  describe('resolveRedwoodHost', () => {
    it('resolves direct host ancestor', () => {
      const host = document.createElement('oj-c-select-single');
      host.id = 'supplier-select';
      const option = document.createElement('div');
      option.className = 'oj-listbox-result';
      option.textContent = 'Supplier A';
      host.appendChild(option);
      document.body.appendChild(host);

      expect(resolveRedwoodHost(option)).toBe(host);
    });

    it('resolves host via trigger correlation within memory window', () => {
      const host = document.createElement('oj-c-select-single');
      host.id = 'category-select';
      document.body.appendChild(host);

      // Ephemeral popup at body root
      const popup = document.createElement('div');
      popup.className = 'oj-listbox-drop';
      const option = document.createElement('li');
      option.className = 'oj-listbox-result';
      option.textContent = 'IT Services';
      popup.appendChild(option);
      document.body.appendChild(popup);

      const now = Date.now();
      const resolved = resolveRedwoodHost(option, host, now, 5000);
      expect(resolved).toBe(host);
    });

    it('resolves host via data-oj-container-for attribute', () => {
      const host = document.createElement('oj-c-select-single');
      host.id = 'payment-terms-select';
      document.body.appendChild(host);

      const popup = document.createElement('div');
      popup.className = 'oj-c-select-single-results';
      popup.setAttribute('data-oj-container-for', 'payment-terms-select');
      const option = document.createElement('div');
      option.className = 'oj-c-select-single-item';
      option.textContent = 'Net 30';
      popup.appendChild(option);
      document.body.appendChild(popup);

      const resolved = resolveRedwoodHost(option);
      expect(resolved).toBe(host);
    });

    it('resolves active open JET select in document', () => {
      const host = document.createElement('oj-c-select-single');
      host.id = 'currency-select';
      host.setAttribute('aria-expanded', 'true');
      document.body.appendChild(host);

      const popup = document.createElement('div');
      popup.className = 'oj-listbox-drop';
      const option = document.createElement('div');
      option.className = 'oj-listbox-result';
      option.textContent = 'USD - US Dollar';
      popup.appendChild(option);
      document.body.appendChild(popup);

      const resolved = resolveRedwoodHost(option);
      expect(resolved).toBe(host);
    });
  });

  describe('getRedwoodLabel', () => {
    it('extracts label from label-hint attribute', () => {
      const host = document.createElement('oj-c-select-single');
      host.setAttribute('label-hint', 'Procurement Business Unit');
      expect(getRedwoodLabel(host)).toBe('Procurement Business Unit');
    });

    it('extracts label from aria-label', () => {
      const host = document.createElement('oj-c-select-single');
      host.setAttribute('aria-label', 'Supplier Site');
      expect(getRedwoodLabel(host)).toBe('Supplier Site');
    });

    it('extracts label from internal oj-label', () => {
      const host = document.createElement('oj-c-select-single');
      const label = document.createElement('oj-label');
      label.textContent = 'Payment Terms';
      host.appendChild(label);
      expect(getRedwoodLabel(host)).toBe('Payment Terms');
    });
  });

  describe('createRedwoodSelectEvent', () => {
    it('constructs semantic selectOption event payload', () => {
      const host = document.createElement('oj-c-select-single');
      host.id = 'country-select';
      host.setAttribute('label-hint', 'Country');
      document.body.appendChild(host);

      const option = document.createElement('div');
      option.className = 'oj-listbox-result';
      option.setAttribute('data-oj-value', 'US');
      option.textContent = 'United States';

      const mockCtx = {
        selectorFor: (el) => ({
          selector: `#${el.id}`,
          locator: `page.locator('#${el.id}')`,
        }),
      };

      const event = createRedwoodSelectEvent(host, option, mockCtx);
      expect(event.type).toBe('selectOption');
      expect(event.value).toBe('United States');
      expect(event.target).toBe(host);
      expect(event.meta.framework).toBe('oracle-redwood');
      expect(event.meta.hostLabel).toBe('Country');
      expect(event.meta.optionValue).toBe('US');
      expect(event.locator).toBe("page.locator('#country-select')");
    });
  });
});
