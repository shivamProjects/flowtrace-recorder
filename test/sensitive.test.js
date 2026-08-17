/**
 * Password masking, tested end to end: a keystroke in the page, through the
 * message the content script sends, into the script, the steps and the actions.
 *
 * The assertion that matters is the negative one — the typed value appears in
 * NONE of those. It is written as a search of the serialised output rather than
 * a check of the fields we happen to think about, because the way a credential
 * escapes is always through a field nobody remembered: `committedValue`,
 * `originalValue`, the locator's `text`, the attribute bag. Serialising the
 * whole thing and grepping it catches the field that has not been invented yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { compileActions, compileScript, compileSteps } from '../src/core/background/compiler.js';
import { startCapture, stopCapture } from '../src/core/content/capture.js';
import { normalisePatch } from '../src/core/shared/patch-api.js';
import { MASKED_VALUE, isSensitiveField, maskEvent } from '../src/core/shared/sensitive.js';
import * as bus from '../src/core/content/bus.js';

const SECRET = 'ATOM#integrate1';

/** Every RECORD_EVENT the content script sent during a test. */
let sent = [];

/** The debounce in capture.js. */
const FILL_DEBOUNCE_MS = 600;

beforeEach(() => {
  sent = [];
  vi.useFakeTimers();
  globalThis.chrome = {
    runtime: {
      id: 'test-extension',
      sendMessage: (msg, cb) => {
        if (msg.action === 'RECORD_EVENT') sent.push(msg.event);
        if (cb) cb({ accepted: true });
      },
      lastError: undefined,
    },
  };
  document.body.innerHTML = '';
});

afterEach(() => {
  stopCapture();
  bus.endSession();
  vi.useRealTimers();
  delete globalThis.chrome;
});

/**
 * Type into a field the way a person does — through the events the browser
 * fires — and return the event the recorder decided to send.
 */
function typeInto(field, value) {
  startCapture(normalisePatch({ id: 'generic', name: 'Generic', version: '1.0.0' }));
  bus.beginSession();

  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  vi.advanceTimersByTime(FILL_DEBOUNCE_MS + 1);

  return sent.find((e) => e.type === 'fill');
}

function fieldOf(html) {
  document.body.innerHTML = html;
  return document.querySelector('input');
}

/** The script, steps and actions for one event, serialised for searching. */
function compiledOutput(event) {
  const session = { sourceUrl: 'https://example.test/', events: [event] };
  const patch = { id: 'generic', name: 'Generic', version: '1.0.0' };
  return {
    script: compileScript([event], session, patch),
    steps: compileSteps([event]),
    actions: compileActions([event]),
  };
}

describe('sensitive field detection', () => {
  it('recognises the three platform rules and nothing else', () => {
    const cases = [
      ['<input type="password" />', true],
      ['<input type="text" autocomplete="current-password" />', true],
      ['<input type="text" autocomplete="new-password" />', true],
      // A token list, which is what the attribute actually allows.
      ['<input type="text" autocomplete="section-blue current-password" />', true],
      ['<input type="text" />', false],
      ['<input type="text" autocomplete="username" />', false],
      ['<input type="email" autocomplete="email" />', false],
    ];
    for (const [html, expected] of cases) {
      expect(isSensitiveField(fieldOf(html)), html).toBe(expected);
    }
  });

  it('sees through a component wrapper to the real input inside it', () => {
    // Oracle JET's oj-input-password is the case this rule was written for: the
    // component is a custom element, but the control it renders is an ordinary
    // password input, so no patch is needed to recognise it.
    document.body.innerHTML =
      '<oj-input-password id="idcs-signin-basic-signin-form-password">' +
      '<input type="password" data-oj-internal />' +
      '</oj-input-password>';
    expect(isSensitiveField(document.querySelector('input'))).toBe(true);
  });
});

describe('a password field', () => {
  it('still produces a fill, so replay knows to type here', () => {
    const event = typeInto(fieldOf('<input type="password" aria-label="Password" />'), SECRET);

    expect(event).toBeDefined();
    expect(event.type).toBe('fill');
  });

  it('carries the mask, the flag and the credential reference', () => {
    const event = typeInto(fieldOf('<input type="password" aria-label="Password" />'), SECRET);

    expect(event.value).toBe(MASKED_VALUE);
    expect(event.value).toBe('********');
    expect(event.sensitive).toBe(true);
    expect(event.credentialRef).toBe('password');
  });

  it('keeps the locator, so the masked fill still points at the field', () => {
    const event = typeInto(fieldOf('<input type="password" aria-label="Password" />'), SECRET);

    expect(compiledOutput(event).script).toContain("page.getByLabel('Password')");
  });

  it('never puts the typed value anywhere in the event', () => {
    const event = typeInto(fieldOf('<input type="password" aria-label="Password" />'), SECRET);

    expect(JSON.stringify(event)).not.toContain(SECRET);
  });

  it('never puts the typed value into the script, the steps or the actions', () => {
    const event = typeInto(fieldOf('<input type="password" aria-label="Password" />'), SECRET);
    const { script, steps, actions } = compiledOutput(event);

    expect(script).not.toContain(SECRET);
    expect(JSON.stringify(steps)).not.toContain(SECRET);
    expect(JSON.stringify(actions)).not.toContain(SECRET);

    expect(script).toContain(`fill('${MASKED_VALUE}')`);
    expect(steps[0].value).toBe(MASKED_VALUE);
    expect(actions[0].value).toBe(MASKED_VALUE);
  });

  it('tells the replayer which credential to substitute at run time', () => {
    const event = typeInto(fieldOf('<input type="password" aria-label="Password" />'), SECRET);
    const [action] = compiledOutput(event).actions;

    expect(action.action).toBe('fill');
    expect(action.sensitive).toBe(true);
    expect(action.credentialRef).toBe('password');
  });

  it('masks a field a page marked with autocomplete rather than with a type', () => {
    const event = typeInto(
      fieldOf('<input type="text" autocomplete="current-password" aria-label="Passcode" />'),
      SECRET,
    );

    expect(event.value).toBe(MASKED_VALUE);
    expect(JSON.stringify(event)).not.toContain(SECRET);
  });

  it('survives a postProcess that substitutes an application-committed value', () => {
    // Oracle's postProcess replaces what was typed with what ADF committed. It
    // cannot know the field was a password, so the mask is re-asserted after it
    // rather than trusted to survive it.
    const event = typeInto(fieldOf('<input type="password" aria-label="Password" />'), SECRET);
    const tampered = { ...event, value: SECRET, committedValue: SECRET };

    const remasked = maskEvent(tampered);
    expect(remasked.value).toBe(MASKED_VALUE);
    expect(remasked.committedValue).toBe(MASKED_VALUE);
    expect(JSON.stringify(compiledOutput(remasked))).not.toContain(SECRET);
  });
});

describe('an ordinary field', () => {
  it('is recorded exactly as typed', () => {
    const event = typeInto(fieldOf('<input type="text" aria-label="Bill-to Name" />'), 'ADF USA');

    expect(event.value).toBe('ADF USA');
    expect(event.sensitive).toBeUndefined();
    expect(event.credentialRef).toBeUndefined();
    expect(event.meta.sensitive).toBeUndefined();
  });

  it('reaches the script, the steps and the actions unchanged', () => {
    const event = typeInto(fieldOf('<input type="text" aria-label="Bill-to Name" />'), 'ADF USA');
    const { script, steps, actions } = compiledOutput(event);

    expect(script).toContain(`fill('ADF USA')`);
    expect(steps[0].value).toBe('ADF USA');
    expect(actions[0].value).toBe('ADF USA');
    expect(actions[0].sensitive).toBeUndefined();
  });
});

describe('a patch-marked field', () => {
  it('is masked through resolve.meta, the hook patches already have', () => {
    // The escape hatch for a credential the platform rules cannot see — a PIN
    // in a plain text box. Additive only: a patch can add `sensitive`, and
    // nothing it returns can take it away from a real password field.
    const patch = normalisePatch({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      resolve: { meta: (el) => (el.id === 'pin' ? { sensitive: true } : {}) },
    });

    startCapture(patch);
    bus.beginSession();

    const field = fieldOf('<input type="text" id="pin" aria-label="PIN" />');
    field.value = '4821';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(FILL_DEBOUNCE_MS + 1);

    const event = sent.find((e) => e.type === 'fill');
    expect(event.value).toBe(MASKED_VALUE);
    expect(JSON.stringify(event)).not.toContain('4821');
  });
});
