/**
 * types.js — the event schema shared by the content script, the service worker,
 * and every patch. This is the one contract that must not drift.
 */

/**
 * @typedef {'click'|'fill'|'select'|'check'|'radio'|'navigate'} EventType
 * Patches may introduce additional `meta_*` types for their own bookkeeping.
 * The compiler ignores any type it does not recognise, so a patch-private event
 * that postProcess forgets to consume is dropped rather than emitted as code.
 */

/**
 * @typedef {Object} RecordedEvent
 * @property {EventType|string} type
 * @property {number}  timestamp
 * @property {string}  url          window.location.href when the event fired
 * @property {string}  frameUrl     URL of the frame that captured it
 * @property {boolean} isTopFrame   false when captured inside an iframe
 * @property {string}  selector     best CSS/attribute selector
 * @property {string}  locator      Playwright locator expression
 * @property {string}  tagName      lowercase tag
 * @property {?string} inputType    input[type] or null
 * @property {?string} value
 * @property {?boolean} checked
 * @property {?string} text         trimmed visible text
 * @property {?string} label        resolved label
 * @property {?string} role         ARIA role, explicit or inferred
 * @property {Object}  meta         attribute bag plus patch enrichment
 */

/** Field order for a navigate event, kept in one place so both sides agree. */
export function makeNavigateEvent(url, frameInfo = {}) {
  return {
    type: 'navigate',
    timestamp: Date.now(),
    url,
    frameUrl: frameInfo.frameUrl || url,
    isTopFrame: frameInfo.isTopFrame !== false,
    selector: null,
    locator: null,
    tagName: null,
    inputType: null,
    value: null,
    checked: null,
    text: null,
    label: null,
    role: null,
    meta: {},
  };
}
