/**
 * frames.js — which frame an interaction happened in.
 *
 * The content script runs in every frame, and until now nothing recorded which
 * one produced a given event. Every generated line was `page.…`, so a step
 * captured inside an iframe replayed against the top document and silently
 * found nothing. Oracle Fusion renders dialogs and embedded regions in frames,
 * so this is not a hypothetical.
 *
 * This module only stamps the identity; the compiler turns it into a
 * `page.frameLocator(…)` prefix and a `frame` field on the action, and the
 * replayer resolves it in engine/frames.ts. The data has to be stamped here at
 * capture time because backfilling a field onto recordings that were already
 * captured is not possible.
 */

/** @returns {{frameUrl: string, isTopFrame: boolean, frameName: string|null}} */
export function frameInfo() {
  const isTopFrame = window === window.top;
  return {
    frameUrl: window.location.href,
    isTopFrame,
    frameName: isTopFrame ? null : frameIdentity(),
  };
}

/**
 * A stable-ish handle for the current frame, from the attributes Playwright's
 * frameLocator can address: `name`, then `title`, then `id`.
 * Returns null when the frame carries none of them, which is the honest answer
 * — a frame with no addressable attribute cannot be targeted by name later.
 */
function frameIdentity() {
  try {
    const el = window.frameElement;
    if (!el) return null; // cross-origin: the parent will not let us look
    return el.getAttribute('name') || el.getAttribute('title') || el.id || null;
  } catch {
    return null; // cross-origin access threw
  }
}

/** True when this frame should own singleton UI such as the recording widget. */
export function isTopFrame() {
  return window === window.top;
}
