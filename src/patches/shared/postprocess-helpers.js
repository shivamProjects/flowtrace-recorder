/**
 * postprocess-helpers.js — cleanups every patch wants.
 *
 * Ported verbatim from the profiles.js registry. They are shared rather than
 * duplicated because "collapse repeated navigations" and "keep only the final
 * value typed into a field" are true of every application, not just one.
 */

/** Collapse consecutive duplicate navigation events (SPA pushState noise). */
export function collapseRepeatedNavigations(events) {
  return events.filter((ev, i) => {
    if (i === 0) return true;
    if (ev.type === 'navigate' && events[i - 1].type === 'navigate') {
      return ev.url !== events[i - 1].url;
    }
    return true;
  });
}

/**
 * Collapse consecutive fill events on the same selector.
 * Keeps the last value (committed value) and discards intermediate keystrokes
 * that may have slipped through the content.js debounce.
 */
export function collapseRepeatedFills(events) {
  const result = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === 'fill' && result.length > 0) {
      const prev = result[result.length - 1];
      if (prev.type === 'fill' && prev.selector === ev.selector) {
        result[result.length - 1] = ev; // replace with the committed value
        continue;
      }
    }
    result.push(ev);
  }
  return result;
}
