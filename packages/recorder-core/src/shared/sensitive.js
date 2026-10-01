/**
 * sensitive.js — what counts as a credential, and what a recording says instead.
 *
 * This is CORE, not a patch, because the reason has nothing to do with any
 * particular application: a recording is a document that travels over the
 * network to the customer's FlowTrace instance, gets stored there, and is
 * read by whoever opens it. A password inside one is a leak with a long tail —
 * it survives every copy of that recording. There is no application for which
 * that is acceptable, so there is no application that gets to opt out.
 *
 * The detection rules are the platform's own, which is why they generalise:
 * `input[type="password"]` is the only control a browser will not read back in
 * plain text, and `autocomplete="current-password"` / `"new-password"` are what
 * a page tells a password manager. Component libraries build on those rather
 * than replacing them — Oracle JET's `<oj-input-password>` renders a real
 * `input[type="password"]` inside itself — so covering the primitives covers
 * the widgets too, without the core knowing any widget's name.
 *
 * A patch that knows about a field the platform rules cannot see (a PIN in a
 * plain text box, say) still marks it through the existing `resolve.meta` hook
 * by returning `{ sensitive: true }`. That path is additive; it cannot switch
 * masking off.
 *
 * The field is MASKED, not dropped. Replay needs to know that something is
 * typed here and where — a recording that silently omits the password step
 * replays into a form it never filled and fails somewhere later, with nothing
 * pointing at the cause. `credentialRef` names what the replayer should
 * substitute from its own configuration at run time.
 */

/** What appears in every recording, script, step and action in place of a secret. */
export const MASKED_VALUE = '********';

/** Which credential a replayer should supply here from its own configuration. */
export const CREDENTIAL_REF = 'password';

/** autocomplete tokens that name a password field. */
const PASSWORD_AUTOCOMPLETE = new Set(['current-password', 'new-password']);

/**
 * Whether an element holds a credential.
 *
 * @param {Element|null} el
 * @returns {boolean}
 */
export function isSensitiveField(el) {
  if (!el || !el.getAttribute) return false;
  if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'password') {
    return true;
  }
  const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase().trim();
  // The attribute is a token list ("section-blue billing current-password"), so
  // the tokens are tested rather than the whole string.
  return autocomplete.split(/\s+/).some((token) => PASSWORD_AUTOCOMPLETE.has(token));
}

/**
 * Whether an event has been marked as carrying a credential, by either route.
 * @param {Object} event
 */
export function isSensitiveEvent(event) {
  return !!(event && (event.sensitive || (event.meta && event.meta.sensitive)));
}

/**
 * The fields that replace a real value. Spread into an event rather than
 * assigned afterwards, so there is no moment at which the event holds the
 * secret — an overwrite still puts it in memory the caller can leak.
 */
export function maskedFields() {
  return { value: MASKED_VALUE, sensitive: true, credentialRef: CREDENTIAL_REF };
}

/**
 * Force the mask onto an event that may already carry a value.
 *
 * Used on paths where the event was built elsewhere — a patch emitting its own
 * event through `ctx.emit`, or a `postProcess` that substituted an
 * application-committed value into a field it did not realise was a password.
 * On those paths the value already exists and the best available outcome is to
 * replace it before it goes any further, which is why the core paths avoid
 * creating it in the first place instead of relying on this.
 *
 * @param {Object} event
 * @returns {Object} the event unchanged when it is not sensitive
 */
export function maskEvent(event) {
  if (!isSensitiveEvent(event)) return event;
  return {
    ...event,
    ...maskedFields(),
    // A patch's committed-value substitution is the application's normalisation
    // of what was typed — for a password that is the password.
    ...(event.committedValue !== undefined ? { committedValue: MASKED_VALUE } : {}),
    meta: { ...event.meta, sensitive: true },
  };
}
