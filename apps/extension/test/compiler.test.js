/**
 * Compiler tests, written against the shapes that appear in the real Oracle
 * Fusion recording that motivated this work.
 *
 * The login lines in that recording were dead on arrival — `#…username|input`
 * is a CSS parse error, so Playwright threw before touching the page. That case
 * is pinned here so it cannot come back.
 */
import { describe, expect, it } from 'vitest';

import { compileScript, compileSteps } from '@flowtrace/recorder-core';

const session = { sourceUrl: 'https://example.test/start', events: [] };
const patch = { id: 'oracle', name: 'Oracle Fusion', version: '2.0.0' };

/** Statement lines only — header, boilerplate and blank lines removed. */
function statements(events) {
  return compileScript(events, { ...session, events }, patch)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('await ') && !l.startsWith('await browser.close'));
}

const clickOn = (meta, extra = {}) => ({
  type: 'click', url: 'https://example.test/', meta, ...extra,
});

describe('compiler', () => {
  it('emits an id selector that a browser can parse', () => {
    const [line] = statements([
      clickOn({ id: 'idcs-signin-basic-signin-form-username|input' }),
    ]);
    // The attribute form, not `#id-with|pipe`.
    expect(line).toBe(
      `await page.locator('[id="idcs-signin-basic-signin-form-username|input"]').click();`,
    );
    expect(line).not.toContain('#idcs');
  });

  it('keeps the readable hash form for a plain id', () => {
    const [line] = statements([clickOn({ id: 'submit-order' })]);
    expect(line).toBe(`await page.locator('#submit-order').click();`);
  });

  it('rejects ADF generated ids and falls through to the label', () => {
    const [line] = statements([
      clickOn({ id: 'pt1:_FOr1:1:_FONSr2:0:MAnt2:1:pt1:TCF:0:ap1:it2::content' },
        { label: 'Transaction Number' }),
    ]);
    expect(line).toBe(`await page.getByLabel('Transaction Number').click();`);
  });

  it('prefers a locator expression a patch has already decided on', () => {
    const [line] = statements([
      clickOn({ id: 'anything' }, { locator: `page.getByRole('option', { name: 'MANUAL' })` }),
    ]);
    expect(line).toBe(`await page.getByRole('option', { name: 'MANUAL' }).click();`);
  });

  it('fills with the value the application committed, not the one typed', () => {
    const [line] = statements([{
      type: 'fill',
      meta: { ariaLabel: 'Bill-to Name' },
      value: 'ADF USA',
      committedValue: 'ADF USA, Inc.',
    }]);
    expect(line).toBe(`await page.getByLabel('Bill-to Name').fill('ADF USA, Inc.');`);
  });

  it('escapes quotes and backslashes in generated values', () => {
    const [line] = statements([{
      type: 'fill', meta: { ariaLabel: 'Notes' }, value: `O'Brien \\ Co.`,
    }]);
    expect(line).toBe(`await page.getByLabel('Notes').fill('O\\'Brien \\\\ Co.');`);
  });

  it('drops a navigation that repeats the previous URL', () => {
    const lines = statements([
      { type: 'navigate', url: 'https://example.test/a' },
      { type: 'navigate', url: 'https://example.test/a' },
      { type: 'navigate', url: 'https://example.test/b' },
    ]);
    expect(lines).toEqual([
      `await page.goto('https://example.test/a');`,
      `await page.goto('https://example.test/b');`,
    ]);
  });

  it('emits check/uncheck rather than click for checkboxes', () => {
    const lines = statements([
      { type: 'check', meta: { ariaLabel: 'Taxable' }, checked: true },
      { type: 'check', meta: { ariaLabel: 'Taxable' }, checked: false },
    ]);
    expect(lines).toEqual([
      `await page.getByLabel('Taxable').check();`,
      `await page.getByLabel('Taxable').uncheck();`,
    ]);
  });

  it('clicks rather than selectOption when a patch marked the option a row', () => {
    const [line] = statements([{
      type: 'select',
      meta: { ariaLabel: 'Business Unit', selectByClick: true },
      value: 'McGrath RentCorp',
    }]);
    expect(line).toBe(`await page.getByLabel('Business Unit').click();`);
  });

  it('ignores patch-private bookkeeping events', () => {
    expect(statements([{ type: 'meta_nav_tile', meta: { tileId: 'itemNode_x' } }])).toEqual([]);
  });

  it('carries frame identity into steps so replay can target the right frame', () => {
    const [step] = compileSteps([
      clickOn({ ariaLabel: 'Save' }, {
        isTopFrame: false,
        frameUrl: 'https://example.test/inner',
        frameName: 'contentAreaFrame',
      }),
    ]);
    expect(step.frame).toEqual({
      url: 'https://example.test/inner',
      name: 'contentAreaFrame',
    });
  });

  it('omits frame data for top-frame steps', () => {
    const [step] = compileSteps([clickOn({ ariaLabel: 'Save' }, { isTopFrame: true })]);
    expect(step.frame).toBeUndefined();
  });

  it('omits frame.name rather than writing an explicit null', () => {
    // frameIdentity() returns null for a frame carrying no name, title or id.
    // `name: null` would read as "this frame is named nothing".
    const [step] = compileSteps([
      clickOn({ ariaLabel: 'Save' }, {
        isTopFrame: false,
        frameUrl: 'https://example.test/inner',
        frameName: null,
      }),
    ]);
    expect(step.frame).toEqual({ url: 'https://example.test/inner' });
    expect('name' in step.frame).toBe(false);
  });

  it('roots a framed statement in frameLocator instead of page', () => {
    const [line] = statements([
      clickOn({ ariaLabel: 'Save' }, {
        isTopFrame: false,
        frameUrl: 'https://example.test/inner',
        frameName: 'contentAreaFrame',
      }),
    ]);
    // All three attributes, because frameIdentity() does not report which one
    // it matched and the replayer tries name → id → title.
    expect(line).toBe(
      'await page.frameLocator(\'iframe[name="contentAreaFrame"], '
      + 'iframe[title="contentAreaFrame"], iframe[id="contentAreaFrame"]\')'
      + ".getByLabel('Save').click();",
    );
  });

  it('leaves a statement unscoped when the frame is not addressable', () => {
    // Inventing a positional nth() here would be a guess that reads as fact.
    const [line] = statements([
      clickOn({ ariaLabel: 'Save' }, {
        isTopFrame: false,
        frameUrl: 'https://example.test/inner',
        frameName: null,
      }),
    ]);
    expect(line).toBe("await page.getByLabel('Save').click();");
  });

  it('does not scope top-frame statements', () => {
    const [line] = statements([clickOn({ ariaLabel: 'Save' }, { isTopFrame: true })]);
    expect(line).not.toContain('frameLocator');
  });
});
