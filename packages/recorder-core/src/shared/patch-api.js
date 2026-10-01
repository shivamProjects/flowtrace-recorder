/**
 * patch-api.js — the contract between the core recorder and application patches.
 *
 * The core recorder knows nothing about Oracle, IBM, or any other product. It
 * captures DOM interactions and turns elements into locators. Everything that
 * is true of one application and false of another lives in a patch.
 *
 * A patch has two halves that run in different worlds:
 *
 *   capture      runs in the PAGE (content script), while the user is recording.
 *                It inspects live DOM to capture transient interaction state —
 *                an open LOV popup, a calendar header, or post-dialog values.
 *
 *   postProcess  runs in the SERVICE WORKER when recording stops. It sees the
 *                whole event list at once and can merge, drop, reorder, or
 *                rewrite steps with full hindsight.
 *
 * Both halves are optional. A patch that only needs post-processing omits
 * `capture` entirely and costs the page nothing.
 *
 * This mirrors the replayer's patch split deliberately: the replayer's patches
 * own "how does this widget behave", the engine owns "what counts as proof".
 * Same division here — patches own application knowledge, core owns locator
 * quality and the event schema.
 */

/**
 * @typedef {Object} CaptureContext
 * Services the core hands to a patch's capture hooks. A patch should never
 * reach for chrome.* or the message bus directly — everything it needs is here.
 *
 * @property {string} patchId
 *   Id of the running patch, for logging.
 *
 * @property {(type: string, el: Element|null, extra?: Object) => Object} makeEvent
 *   Build a normalised RecordedEvent for `el` without emitting it. Use this when
 *   you want to adjust fields before sending.
 *
 * @property {(event: Object) => void} emit
 *   Send a RecordedEvent to the background. Increments the on-screen counter.
 *
 * @property {(partial: Object) => void} updateContext
 *   Stream a partial patch-context object to the background, where it is merged
 *   into `session.patchContext` and handed to postProcess later. Use this for
 *   data that must survive the page being navigated away or closed.
 *
 * @property {(el: Element) => {selector: string, locator: string, raw: Object}} selectorFor
 *   Run the core selector generator on an element.
 *
 * @property {(el: Element) => string} labelFor
 *   Core label resolution (aria-label, aria-labelledby, label[for], title).
 *
 * @property {(...args: any[]) => void} log
 */

/**
 * @typedef {Object} CaptureHooks
 *
 * @property {(ctx: CaptureContext) => void} [start]
 *   Called once per frame when recording begins. Set up observers, timers, or
 *   scans here. Anything started here must be torn down in `stop`.
 *
 * @property {(target: Element, event: MouseEvent, ctx: CaptureContext) => boolean} [onClick]
 *   Called on every click before the core emits its own click event.
 *   Return `true` to claim the interaction — the core will then emit nothing,
 *   because the patch has already emitted something better (an LOV selection,
 *   a date fill). Return `false`/undefined to let the core proceed normally.
 *
 * @property {(target: Element, event: Event, ctx: CaptureContext) => void} [onInput]
 * @property {(target: Element, event: Event, ctx: CaptureContext) => void} [onChange]
 *   Observation hooks. These cannot claim the interaction; the core always
 *   emits its own fill/select event. Use them to record enrichment data.
 *
 * @property {(ctx: CaptureContext) => Object} [stop]
 *   Called when recording ends. Tear down anything `start` created and return a
 *   final context snapshot to merge before postProcess runs.
 */

/**
 * @typedef {Object} ResolveHooks
 * Application conventions that must influence how the CORE builds a locator.
 *
 * These are separate from `capture` because they are consulted synchronously
 * during selector generation rather than in response to an interaction, and a
 * patch that supplies them changes what the core emits rather than emitting
 * anything itself.
 *
 * @property {(el: Element) => string} [label]
 *   Resolve a control's label using this application's conventions. When a
 *   patch supplies this, it executes in place of the core resolver. A patch
 *   that uses core label resolution as a fallback imports `resolveLabel` from
 *   core/content/dom.js and calls it explicitly.
 *
 *   Oracle needs this because ADF associates labels through
 *   `label[for="…::content"]` and through table-cell adjacency, neither of
 *   which any specification describes.
 *
 * @property {(el: Element) => Object} [meta]
 *   Extra fields to merge into `event.meta` for every event on this element.
 *   This is how a patch annotates events that the CORE emits — which dialog
 *   the control was in, the full text of its table row, whether it is marked
 *   required. postProcess reads these back later.
 *
 *   Core fields win on collision: a patch can add to the attribute bag but
 *   cannot overwrite what the selector generator recorded there.
 */

/**
 * @typedef {Object} Patch
 * @property {string} id            Stable key. Used in storage and the popup.
 * @property {string} name          Display name.
 * @property {string} version
 * @property {string} description
 * @property {ResolveHooks} [resolve]
 * @property {CaptureHooks} [capture]
 * @property {(events: Object[], session: Object) => Object[]} [postProcess]
 */

/**
 * The default patch identifier when none is selected or when a stored id is unresolvable.
 * Defined in core so that the dependency arrow points strictly from patches to core.
 */
export const DEFAULT_PATCH_ID = 'generic';

/** No-op capture implementation ensuring safe non-null invocation across core handlers. */
export const NULL_CAPTURE = {
  start() {},
  onClick() { return false; },
  onInput() {},
  onChange() {},
  stop() { return {}; },
};

/**
 * Fill in the optional halves of a patch so callers can invoke every hook
 * unconditionally. Keeps the hot path in capture.js free of `?.` chains.
 * @param {Patch} patch
 * @returns {Patch & {capture: Required<CaptureHooks>}}
 */
export function normalisePatch(patch) {
  return {
    ...patch,
    resolve: { ...(patch.resolve || {}) },
    capture: { ...NULL_CAPTURE, ...(patch.capture || {}) },
    postProcess: patch.postProcess || ((events) => events),
  };
}

/**
 * Invoke a patch hook without letting it take the recorder down with it.
 *
 * A patch is application-specific guesswork running against a DOM that changes
 * without notice. When one of its assumptions breaks, the correct outcome is a
 * slightly worse recording, not a dead recorder — so every call from core into
 * a patch goes through here.
 *
 * @param {string} label   patch id and hook name, for the log line
 * @param {Function} fn
 * @param {any} fallback   returned when the hook throws
 * @param {...any} args
 */
export function safeInvoke(label, fn, fallback, ...args) {
  try {
    const result = fn(...args);
    return result === undefined ? fallback : result;
  } catch (err) {
    console.warn(`[recorder] patch hook failed: ${label} —`, err && err.message);
    return fallback;
  }
}
