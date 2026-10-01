/**
 * The schema is the thing every other module is checked against, so it is
 * checked on its own first. A permissive `validate` would let every conformance
 * test in test/actions.test.js pass while enforcing nothing — these tests exist
 * to show it actually rejects.
 */
import { describe, expect, it } from 'vitest';

import {
  ACTION_VERBS,
  LOCATOR_FIELDS,
  SCHEMA_VERSION,
  isLocatorlessVerb,
  makeEnvelope,
  pruneLocator,
  validate,
} from '../src/core/shared/schema.js';

const click = (extra = {}) => ({ action: 'click', skipInReport: false, ...extra });

describe('the verb enum', () => {
  it('spells the two split verbs and no longer contains the one they replaced', () => {
    expect(ACTION_VERBS).toContain('selectOption');
    expect(ACTION_VERBS).toContain('lovSelect');
    expect(ACTION_VERBS).not.toContain('select');
  });

  it('names the three verbs that act on the page rather than an element', () => {
    for (const verb of ['navigate', 'wait', 'scroll']) {
      expect(isLocatorlessVerb(verb), verb).toBe(true);
    }
    expect(isLocatorlessVerb('click')).toBe(false);
  });
});

describe('the locator allow-list', () => {
  it('excludes every field measured as unread payload', () => {
    // The list from the corpus audit. Named rather than counted, so that adding
    // one back is a visible edit to this test.
    const EXCLUDED = [
      'xpath', 'domSnapshot', 'recoveryStrategy', 'confidence', 'rect', 'visible',
      'display', 'pointerEvents', 'opacity', 'cursor', 'zIndex', 'position', 'page',
      'disabled', 'readonly', 'required', 'parentChain', 'siblingContext',
      'nativeAttrs', 'uniqueSignature', 'fieldType', 'fieldMeta', 'jsTriggers',
      'href', 'tableContext', 'popupContainer', 'section', 'ancestorLabels',
      'describedby', 'tab', 'testId',
    ];
    for (const field of EXCLUDED) expect(LOCATOR_FIELDS, field).not.toContain(field);
  });

  it('keeps only allow-listed keys and drops empties', () => {
    expect(pruneLocator({
      id: 'save', role: 'button', xpath: '//button', rect: { x: 1 },
      label: '', title: null, text: undefined,
    })).toEqual({ id: 'save', role: 'button' });
  });

  it('drops scratch keys a patch hung off the object mid-flight', () => {
    expect(pruneLocator({ id: 'x', _target: {}, _injected: true, _targetSection: 'a' }))
      .toEqual({ id: 'x' });
  });

  it('turns a stringified boolean back into a boolean', () => {
    // "false" is truthy, so `if (loc.exact)` took the wrong branch on it.
    expect(pruneLocator({ exact: 'false', hasLovIcon: 'true' }))
      .toEqual({ exact: false, hasLovIcon: true });
  });

  it('reduces a parent to the two fields it is allowed to have', () => {
    expect(pruneLocator({ parent: { name: 'Supplier', label: 'Supplier', rect: {} } }).parent)
      .toEqual({ name: 'Supplier', label: 'Supplier' });
    expect(pruneLocator({ parent: {} }).parent).toBeUndefined();
  });
});

describe('validate', () => {
  it('passes a well-formed action', () => {
    expect(validate(click({ locator: { id: 'save', exact: true } }))).toEqual([]);
  });

  it('rejects a verb outside the enum', () => {
    expect(validate({ action: 'rightClick', skipInReport: false }).join(' '))
      .toContain('not in the verb enum');
  });

  it('rejects an action field nobody declared', () => {
    expect(validate(click({ confidence: 0.8 })).join(' '))
      .toContain('"confidence" is not an allowed action field');
  });

  it('requires skipInReport to be present and boolean', () => {
    expect(validate({ action: 'click' }).join(' ')).toContain('skipInReport');
    expect(validate({ action: 'click', skipInReport: 'false' }).join(' '))
      .toContain('not a boolean');
  });

  it('refuses a locator on an action that acts on the page', () => {
    expect(validate({
      action: 'navigate', url: 'https://x.test/', skipInReport: false, locator: { id: 'a' },
    }).join(' ')).toContain('must carry no locator');
  });

  it('refuses an empty locator, which claims a blank element rather than none', () => {
    expect(validate(click({ locator: {} })).join(' ')).toContain('omit it instead');
  });

  it('refuses a wait whose duration is not a number', () => {
    expect(validate({ action: 'wait', skipInReport: false, durationMs: '2000' }).join(' '))
      .toContain('numeric durationMs');
    expect(validate({ action: 'wait', skipInReport: false, durationMs: 2000 })).toEqual([]);
  });

  it('refuses a field parked on the wrong verb', () => {
    expect(validate(click({ key: 'Tab' })).join(' ')).toContain('belongs only on press');
    expect(validate(click({ url: 'https://x.test/' })).join(' ')).toContain('belongs only on navigate');
  });
});

describe('the envelope', () => {
  it('states its version first, so no reader has to guess the format', () => {
    const envelope = makeEnvelope({
      name: 'Create Invoice',
      sourceUrl: 'https://fusion.test/',
      patchId: 'oracle',
      recordedAt: '2026-08-06T09:00:00.000Z',
      actions: [click()],
    });

    expect(Object.keys(envelope)[0]).toBe('schemaVersion');
    expect(envelope.schemaVersion).toBe(SCHEMA_VERSION);
    expect(envelope.recordedAt).toBe('2026-08-06T09:00:00.000Z');
  });

  it('timestamps itself when the caller had no start time to give', () => {
    expect(() => new Date(makeEnvelope({}).recordedAt).toISOString()).not.toThrow();
    expect(makeEnvelope({}).actions).toEqual([]);
  });
});
