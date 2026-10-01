import { describe, it, expect, beforeEach } from 'vitest';
import { detectLov, LOV_KIND, stableLovSelector, shapeLovStep, baseOf } from '@flowtrace/recorder-core';

describe('Oracle LOV Classifier & Stable Selector (lov.js)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('correctly extracts baseOf an id ending with ::content', () => {
    expect(baseOf('pt1:_FOr1:1:_FONSr2:0:MAnt2:1:pt1:ap1:r1:0:icLov1::content')).toBe(
      'pt1:_FOr1:1:_FONSr2:0:MAnt2:1:pt1:ap1:r1:0:icLov1'
    );
    expect(baseOf('plain_input_id')).toBe('plain_input_id');
  });

  it('classifies SearchInputSelect (suggest) even when role=combobox is absent', () => {
    const base = 'pt1:ap1:supplierField';
    document.body.innerHTML = `
      <div>
        <input id="${base}::content" type="text" />
        <div id="${base}::sgstnCntnr"></div>
      </div>
    `;
    const input = document.getElementById(`${base}::content`);
    const result = detectLov(input);
    expect(result).not.toBeNull();
    expect(result.kind).toBe(LOV_KIND.SUGGEST);
    expect(result.base).toBe(base);
    expect(result.contentId).toBe(`${base}::content`);
  });

  it('classifies inline dropdown LOV with role=combobox and ::dropdownPopup', () => {
    const base = 'pt1:ap1:businessUnit';
    document.body.innerHTML = `
      <div>
        <input id="${base}::content" role="combobox" type="text" />
        <div id="${base}::dropdownPopup"></div>
      </div>
    `;
    const input = document.getElementById(`${base}::content`);
    const result = detectLov(input);
    expect(result).not.toBeNull();
    expect(result.kind).toBe(LOV_KIND.INLINE);
    expect(result.base).toBe(base);
  });

  it('classifies modal search-and-select LOV with role=combobox and lovPopupId', () => {
    const base = 'pt1:ap1:itemCategory';
    document.body.innerHTML = `
      <div>
        <input id="${base}::content" role="combobox" type="text" />
        <div id="${base}lovPopupId"></div>
      </div>
    `;
    const input = document.getElementById(`${base}::content`);
    const result = detectLov(input);
    expect(result).not.toBeNull();
    expect(result.kind).toBe(LOV_KIND.MODAL);
  });

  it('returns null for an ordinary text input', () => {
    document.body.innerHTML = `<input id="ordinary_field" type="text" />`;
    const input = document.getElementById('ordinary_field');
    expect(detectLov(input)).toBeNull();
  });

  it('shapes step to target stable ::content selector and preserves label fallbacks', () => {
    const step = {
      action: 'fill',
      value: 'Vision Operations',
      locator: {
        selector: 'internal:role=row[name="Vision Operations"]'
      }
    };
    const rec = {
      lovKind: 'suggest',
      lovContentId: 'pt1:ap1:buField::content',
      label: 'Business Unit'
    };

    const reshaped = shapeLovStep(step, rec);
    expect(reshaped).toBe(true);
    expect(step.locator.selector).toBe('[id="pt1:ap1:buField::content"]');
    expect(step.locator.id).toBe('pt1:ap1:buField::content');
    expect(step.locator.label).toBe('Business Unit');
    expect(step.locator.name).toBe('Business Unit');
    expect(step.locator.lovKind).toBe('suggest');
    expect(step.isLov).toBe(true);
  });
});
