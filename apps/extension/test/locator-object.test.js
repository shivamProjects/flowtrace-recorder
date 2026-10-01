/**
 * The locator object is what the replayer actually resolves against, and the
 * property under test throughout is NOT "field X holds value Y" but "every
 * fallback the DOM offered was kept".
 *
 * engine/types.ts states the failure mode plainly: reducing an element to one
 * `selector` string throws away every fallback the recorder went to the trouble
 * of capturing. So these tests assert breadth — id AND attrSelector AND label
 * AND title AND text — because a change that quietly starts picking a single
 * winner would still pass a test that only checked the winner.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { buildLocatorObject } from '../src/core/content/locator-object.js';
import { resolveAdfLabel, metaFor } from '@flowtrace/recorder-core';

function mount(html) {
  document.body.innerHTML = html;
  return (selector) => document.querySelector(selector);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('buildLocatorObject', () => {
  it('keeps every fallback the element offers rather than choosing one', () => {
    const $ = mount(`
      <div>
        <label for="bill-to">Bill-to Name</label>
        <input id="bill-to" title="Bill-to Name" placeholder="Customer name" name="BillTo">
      </div>
    `);

    const loc = buildLocatorObject($('#bill-to'));

    expect(loc.id).toBe('bill-to');
    expect(loc.role).toBe('textbox');
    expect(loc.label).toBe('Bill-to Name');
    expect(loc.name).toBe('Bill-to Name');
    expect(loc.title).toBe('Bill-to Name');
    expect(loc.placeholder).toBe('Customer name');
    expect(loc.sourceTag).toBe('input');
    expect(loc.selector).toBeTruthy();
    expect(loc.attrSelector).toBe('[title="Bill-to Name"]');
  });

  it('builds an attrSelector a browser can actually run', () => {
    const $ = mount(`<a id="lov" title="Search: Supplier's Site">go</a>`);
    const loc = buildLocatorObject($('#lov'));

    // The apostrophe is the case that breaks naive quoting — the helper picks
    // the quote style that needs no escaping.
    expect(loc.attrSelector).toBe(`[title="Search: Supplier's Site"]`);
    expect(document.querySelector(loc.attrSelector)).toBe($('#lov'));
  });

  it('escapes a double quote in an attribute value', () => {
    const $ = mount(`<button title='Save "Draft"'>Save</button>`);
    const loc = buildLocatorObject($('button'));

    expect(document.querySelector(loc.attrSelector)).toBe($('button'));
  });

  it('does not spend attrSelector on the id, which travels in its own field', () => {
    const $ = mount(`<button id="save" title="Save the order">Save</button>`);
    const loc = buildLocatorObject($('#save'));

    expect(loc.id).toBe('save');
    expect(loc.attrSelector).toBe('[title="Save the order"]');
  });

  it('names a button by its visible text and marks the match exact', () => {
    const $ = mount(`<button>Save and Close</button>`);
    const loc = buildLocatorObject($('button'));

    expect(loc.role).toBe('button');
    expect(loc.name).toBe('Save and Close');
    expect(loc.text).toBe('Save and Close');
    // "Save" also substring-matches "Save and Close"; exact is what stops the
    // replayer taking the wrong toolbar button.
    expect(loc.exact).toBe(true);
  });

  it('refuses to claim exactness for text it truncated', () => {
    const long = 'A'.repeat(400);
    const $ = mount(`<div role="cell">${long}</div>`);
    const loc = buildLocatorObject($('[role="cell"]'));

    expect(loc.text.length).toBeLessThan(long.length);
    expect(loc.exact).not.toBe(true);
  });

  it('records the labelled field an unnamed cell sits inside', () => {
    const $ = mount(`
      <div aria-label="Supplier">
        <table><tr><td><span id="cell">ACME Corp</span></td></tr></table>
      </div>
    `);

    const loc = buildLocatorObject($('#cell'));
    expect(loc.parent).toEqual({ name: 'Supplier', label: 'Supplier' });
  });

  it('uses the label resolver it is given, so ADF conventions reach the locator', () => {
    const $ = mount(`
      <div>
        <label for="pt1:r1:0:it2">Transaction Number</label>
        <input id="pt1:r1:0:it2::content">
      </div>
    `);
    const el = $('input');

    // Core alone cannot see ADF's ::content indirection.
    expect(buildLocatorObject(el).label).toBeUndefined();
    expect(buildLocatorObject(el, { resolveLabel: resolveAdfLabel }).label)
      .toBe('Transaction Number');
  });

  it('leaves the Oracle fields absent when no patch supplied them', () => {
    const $ = mount(`<input id="pt1:r1:0:it2::content">`);
    const loc = buildLocatorObject($('input'));

    expect(loc.componentId).toBeUndefined();
    expect(loc.containerRole).toBeUndefined();
    expect(loc.hasLovIcon).toBeUndefined();
  });

  it('carries the Oracle fields through when the patch meta hook supplied them', () => {
    // Wrapped in a real table: the HTML parser discards a <td> that is not in
    // one, and the element would then have no wrapper to find the icon in.
    const $ = mount(`
      <table><tbody><tr><td class="af_inputListOfValues">
        <input id="pt1:r1:0:it2::content" role="combobox">
        <a id="pt1:r1:0:it2::lovIconId" title="Search: Supplier"></a>
      </td></tr></tbody></table>
    `);
    const el = $('input');
    const loc = buildLocatorObject(el, { meta: metaFor(el) });

    expect(loc.componentId).toBe('pt1:r1:0:it2');
    expect(loc.hasLovIcon).toBe(true);
  });

  it('survives an element with nothing to say about itself', () => {
    const $ = mount(`<div></div>`);
    expect(buildLocatorObject($('div')).sourceTag).toBe('div');
    expect(buildLocatorObject(null)).toEqual({});
  });
});

describe('oracle resolve.meta', () => {
  it('strips the ADF suffix to reach the component wrapper id', () => {
    const $ = mount(`<input id="pt1:_FOr1:1:MAnt2:1:TCF:0:ap1:it2::content">`);
    expect(metaFor($('input')).componentId).toBe('pt1:_FOr1:1:MAnt2:1:TCF:0:ap1:it2');
  });

  it('finds the component id from a child of the wrapper', () => {
    const $ = mount(`<div id="pt1:r1:0:it2::wrapper"><span id="inner">x</span></div>`);
    expect(metaFor($('#inner')).componentId).toBe('pt1:r1:0:it2');
  });

  it('reports the wrapping combobox role, which the clicked node does not carry', () => {
    const $ = mount(`
      <div role="combobox" id="pt1:soc1">
        <span id="arrow" class="af_selectOneChoice-arrow"></span>
      </div>
    `);
    expect(metaFor($('#arrow')).containerRole).toBe('combobox');
  });

  it('does not mark a plain text field as a list of values', () => {
    const $ = mount(`
      <table><tbody><tr>
        <td class="af_panelLabelAndMessage"><input id="plain"></td>
        <td class="af_inputListOfValues">
          <input id="lovField"><a id="icon" title="Search: Supplier"></a>
        </td>
      </tr></tbody></table>
    `);
    // Scoped to the field's own wrapper: one field's magnifier must not mark
    // every other field in the same row.
    expect(metaFor($('#plain')).hasLovIcon).toBeUndefined();
    expect(metaFor($('#lovField')).hasLovIcon).toBe(true);
  });
});
