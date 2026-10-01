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

/**
 * @returns {{
 *   frameUrl: string,
 *   isTopFrame: boolean,
 *   frameName: string|null,
 *   frameSelector?: string|null,
 *   framePath?: string[],
 * }}
 */
export function frameInfo() {
  const isTop = isTopFrame();
  if (isTop) {
    return {
      frameUrl: window.location.href,
      isTopFrame: true,
      frameName: null,
      framePath: [],
    };
  }

  const identity = frameIdentity();
  const selector = frameSelector();
  const ancestry = frameAncestryPath();

  return {
    frameUrl: window.location.href,
    isTopFrame: false,
    frameName: identity,
    frameSelector: selector,
    framePath: ancestry,
  };
}

/**
 * Build hierarchical framePath traversing frame ancestors up to top.
 * @returns {string[]}
 */
export function frameAncestryPath() {
  const chain = [];
  try {
    let curr = window;
    while (curr && curr !== curr.top) {
      const el = curr.frameElement;
      if (el) {
        const sel = deriveElementFrameSelector(el);
        if (sel) chain.unshift(sel);
      }
      if (curr === curr.parent) break;
      curr = curr.parent;
    }
  } catch {
    // Cross-origin boundaries throw; return whatever hierarchy was reachable
  }

  if (chain.length === 0) {
    const sel = frameSelector();
    if (sel) chain.push(sel);
  }
  return chain;
}

function deriveElementFrameSelector(el) {
  if (!el) return null;
  try {
    const name = el.getAttribute('name');
    if (name) return `iframe[name="${escapeAttr(name)}"]`;

    const id = el.id;
    if (id) return `iframe#${escapeAttr(id)}`;

    const title = el.getAttribute('title');
    if (title) return `iframe[title="${escapeAttr(title)}"]`;

    const src = el.getAttribute('src');
    if (src && !src.startsWith('blob:') && !src.startsWith('data:') && !src.startsWith('about:')) {
      const pathname = new URL(src, window.location.href).pathname;
      if (pathname && pathname !== '/') {
        return `iframe[src*="${escapeAttr(pathname)}"]`;
      }
    }
    return 'iframe';
  } catch {
    return 'iframe';
  }
}

/**
 * Derive a stable Playwright selector for the current frame element.
 * @returns {string|null}
 */
function frameSelector() {
  try {
    const el = window.frameElement;
    if (!el) return null;

    const name = el.getAttribute('name');
    if (name) return `iframe[name="${escapeAttr(name)}"]`;

    const id = el.id;
    if (id) return `iframe#${escapeAttr(id)}`;

    const title = el.getAttribute('title');
    if (title) return `iframe[title="${escapeAttr(title)}"]`;

    const src = el.getAttribute('src');
    if (src && !src.startsWith('blob:') && !src.startsWith('data:') && !src.startsWith('about:')) {
      const pathname = new URL(src, window.location.href).pathname;
      if (pathname && pathname !== '/') {
        return `iframe[src*="${escapeAttr(pathname)}"]`;
      }
    }

    return 'iframe';
  } catch {
    return null;
  }
}

/**
 * A stable-ish handle for the current frame, from the attributes Playwright's
 * frameLocator can address: `name`, then `title`, then `id`.
 * Returns null when the frame carries none of them.
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

function escapeAttr(s) {
  return String(s || '').replace(/"/g, '\\"');
}

/** True when this frame should own singleton UI such as the recording widget. */
export function isTopFrame() {
  try {
    return window === window.top;
  } catch {
    return false;
  }
}
