/**
 * oracle-components-characterization.test.js — Exhaustive characterization suite for
 * Oracle ADF, JET, and Redwood components, LOV search dialogs, and PPR effect correlation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  detectLov,
  LOV_KIND,
  getLovMetadata,
  stableLovSelector,
  isLovRecord,
  shapeLovStep,
  baseOf,
  contentIdOf,
  isRedwoodHost,
  findRedwoodOption,
  resolveRedwoodHost,
  getRedwoodLabel,
  extractRedwoodOptionData,
  createRedwoodSelectEvent,
  EffectCorrelator,
  SurfaceRegistry,
} from '@flowtrace/recorder-core';

describe('Oracle Components & Semantic Verification Characterization Suite (TRACE-66)', () => {
  let dom;
  let document;
  let window;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'https://fusion.oraclecloud.test/fscmUI/faces/FuseWelcome',
    });
    document = dom.window.document;
    window = dom.window;
    globalThis.document = document;
    globalThis.window = window;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('1. Oracle ADF LOV (List-of-Values) Component Classification & Resolution', () => {
    it('accurately identifies inline LOV dropdown (::dropdownPopup)', () => {
      document.body.innerHTML = `
        <div id="pt1:r1:inputDepartment" class="af_inputComboboxListOfValues">
          <label for="pt1:r1:inputDepartment::content">Department</label>
          <input id="pt1:r1:inputDepartment::content" role="combobox" type="text" />
          <div id="pt1:r1:inputDepartment::dropdownPopup" class="af_popup"></div>
        </div>
      `;

      const input = document.getElementById('pt1:r1:inputDepartment::content');
      const hit = detectLov(input);
      expect(hit).not.toBeNull();
      expect(hit.kind).toBe(LOV_KIND.INLINE);
      expect(hit.base).toBe('pt1:r1:inputDepartment');
      expect(hit.contentId).toBe('pt1:r1:inputDepartment::content');

      const meta = getLovMetadata(input);
      expect(meta.lovKind).toBe(LOV_KIND.INLINE);
      expect(meta.lovBase).toBe('pt1:r1:inputDepartment');
    });

    it('accurately identifies modal LOV search dialog (lovPopupId / ::lovIconId)', () => {
      document.body.innerHTML = `
        <div id="pt1:r1:supplierLov" class="af_inputListOfValues">
          <label for="pt1:r1:supplierLov::content">Supplier</label>
          <input id="pt1:r1:supplierLov::content" role="combobox" type="text" />
          <a id="pt1:r1:supplierLov::lovIconId" class="af_inputListOfValues_search-icon" href="#"></a>
          <div id="pt1:r1:supplierLovlovPopupId" class="af_dialog"></div>
        </div>
      `;

      const input = document.getElementById('pt1:r1:supplierLov::content');
      const hit = detectLov(input);
      expect(hit).not.toBeNull();
      expect(hit.kind).toBe(LOV_KIND.MODAL);
      expect(hit.base).toBe('pt1:r1:supplierLov');

      const stable = stableLovSelector(input);
      expect(stable).toBe('[id="pt1:r1:supplierLov::content"]');
    });

    it('accurately identifies SearchInputSelect / autosuggest (::sgstnCntnr / ::cntStmp)', () => {
      document.body.innerHTML = `
        <div id="pt1:r1:itemSuggest" class="af_inputSearch">
          <input id="pt1:r1:itemSuggest::content" type="text" />
          <div id="pt1:r1:itemSuggest::sgstnCntnr" class="af_suggestion-container">
            <div id="pt1:r1:itemSuggest::cntStmp"></div>
          </div>
        </div>
      `;

      const input = document.getElementById('pt1:r1:itemSuggest::content');
      const hit = detectLov(input);
      expect(hit).not.toBeNull();
      expect(hit.kind).toBe(LOV_KIND.SUGGEST);
      expect(hit.base).toBe('pt1:r1:itemSuggest');
    });

    it('shapes LOV step targeting stable base content input with label fallback', () => {
      const step = {
        action: 'fill',
        value: 'Acme Corporation',
        locator: {},
      };

      const record = {
        lovKind: LOV_KIND.MODAL,
        lovContentId: 'pt1:r1:supplierLov::content',
        label: 'Supplier Name',
      };

      const shaped = shapeLovStep(step, record);
      expect(shaped).toBe(true);
      expect(step.isLov).toBe(true);
      expect(step.locator.selector).toBe('[id="pt1:r1:supplierLov::content"]');
      expect(step.locator.label).toBe('Supplier Name');
      expect(step.locator.lovKind).toBe(LOV_KIND.MODAL);
    });
  });

  describe('2. Oracle Redwood & JET Custom Element Component Adapters', () => {
    it('detects Redwood component hosts (oj-c-select-single, oj-table, oj-list-view)', () => {
      const select = document.createElement('oj-c-select-single');
      const table = document.createElement('oj-table');
      const listView = document.createElement('oj-list-view');
      const plainDiv = document.createElement('div');

      expect(isRedwoodHost(select)).toBe(true);
      expect(isRedwoodHost(table)).toBe(true);
      expect(isRedwoodHost(listView)).toBe(true);
      expect(isRedwoodHost(plainDiv)).toBe(false);
    });

    it('resolves floating overlay popup option back to originating oj-c-select-single host', () => {
      document.body.innerHTML = `
        <div class="form-container">
          <oj-c-select-single id="currencySelect" label-hint="Transaction Currency" aria-expanded="true">
            <div class="oj-select-input-container">
              <input type="text" class="oj-select-input" value="USD" />
            </div>
          </oj-c-select-single>
        </div>

        <!-- Floating overlay attached to body -->
        <div class="oj-listbox-drop" data-oj-container-for="currencySelect">
          <ul role="listbox">
            <li role="option" class="oj-listbox-result" data-oj-value="EUR">
              <div class="oj-listbox-result-label">Euro (EUR)</div>
            </li>
            <li role="option" class="oj-listbox-result" data-oj-value="GBP">
              <div class="oj-listbox-result-label">British Pound (GBP)</div>
            </li>
          </ul>
        </div>
      `;

      const option = document.querySelector('li[data-oj-value="EUR"]');
      expect(findRedwoodOption(option)).toBe(option);

      const host = resolveRedwoodHost(option);
      expect(host).not.toBeNull();
      expect(host.id).toBe('currencySelect');

      const label = getRedwoodLabel(host);
      expect(label).toBe('Transaction Currency');

      const optionData = extractRedwoodOptionData(option);
      expect(optionData.value).toBe('EUR');
      expect(optionData.label).toBe('Euro (EUR)');

      const event = createRedwoodSelectEvent(host, option, {
        selectorFor: (el) => ({ selector: `#${el.id}`, locator: `page.locator('#${el.id}')` }),
      });

      expect(event.type).toBe('selectOption');
      expect(event.value).toBe('Euro (EUR)');
      expect(event.meta.framework).toBe('oracle-redwood');
      expect(event.meta.componentType).toBe('oj-c-select-single');
      expect(event.meta.hostLabel).toBe('Transaction Currency');
      expect(event.meta.optionValue).toBe('EUR');
      expect(event.meta.optionLabel).toBe('Euro (EUR)');
    });

    it('resolves Redwood oj-table and oj-list-view items', () => {
      document.body.innerHTML = `
        <oj-table id="invoicesTable" aria-label="Recent Invoices">
          <table>
            <tbody>
              <tr class="oj-table-body-row" data-oj-row-key="INV-1001">
                <td>INV-1001</td>
                <td>$2,500.00</td>
              </tr>
            </tbody>
          </table>
        </oj-table>
      `;

      const row = document.querySelector('.oj-table-body-row');
      expect(findRedwoodOption(row)).toBe(row);

      const host = resolveRedwoodHost(row);
      expect(host).not.toBeNull();
      expect(host.id).toBe('invoicesTable');

      const label = getRedwoodLabel(host);
      expect(label).toBe('Recent Invoices');
    });
  });

  describe('3. ADF PPR (Partial Page Rendering) & Effect Correlation', () => {
    it('correlates adf_ppr settlement to initiating action within correlation window', () => {
      const correlator = new EffectCorrelator();

      const action = {
        type: 'selectOption',
        selector: '#pt1:r1:orgSelect::content',
        value: 'US1 Operations',
        surfaceId: 'surface-tab-1',
        timestamp: 1000,
      };

      correlator.recordAction(action);

      const pprEffect = {
        kind: 'adf_ppr',
        surfaceId: 'surface-tab-1',
        timestamp: 1800, // 800ms later
      };

      const correlated = correlator.correlateEffect(pprEffect);
      expect(correlated).not.toBeNull();
      expect(correlated.value).toBe('US1 Operations');
    });

    it('rejects stale PPR effect outside maximum correlation window', () => {
      const correlator = new EffectCorrelator();

      correlator.recordAction({
        type: 'click',
        selector: '#refreshButton',
        surfaceId: 'surface-tab-1',
        timestamp: 1000,
      });

      const stalePprEffect = {
        kind: 'adf_ppr',
        surfaceId: 'surface-tab-1',
        timestamp: 5000, // 4000ms later (> max 3000ms for adf_ppr)
      };

      const correlated = correlator.correlateEffect(stalePprEffect);
      expect(correlated).toBeNull();
    });

    it('correlates popup dialog effect with opener surface matching', () => {
      const correlator = new EffectCorrelator();

      correlator.recordAction({
        type: 'click',
        selector: '#pt1:r1:supplierLov::lovIconId',
        surfaceId: 'surface-tab-1',
        timestamp: 2000,
      });

      const popupEffect = {
        kind: 'popup',
        openerSurfaceId: 'surface-tab-1',
        popupSurfaceId: 'surface-tab-2',
        timestamp: 2500,
      };

      const correlated = correlator.correlateEffect(popupEffect);
      expect(correlated).not.toBeNull();
      expect(correlated.selector).toBe('#pt1:r1:supplierLov::lovIconId');
    });
  });
});
