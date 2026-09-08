/**
 * dedup.js — drops events that are artefacts of how the browser fires them
 * rather than things the user did.
 *
 * This runs at capture time, before storage. Anything requiring knowledge of a
 * specific application belongs in that patch's postProcess instead.
 */

const DUPLICATE_NAVIGATION_MS = 400;
const DUPLICATE_CLICK_MS = 300;
const FILL_SUPERSEDE_MS = 800;

/**
 * @param {Object} event      the incoming event
 * @param {Object[]} history  accepted events so far; may be mutated in place
 * @returns {boolean} whether to append `event`
 */
export function shouldAccept(event, history) {
  if (history.length === 0) return true;
  const last = history[history.length - 1];

  if (event.type === 'navigate' && last.type === 'navigate') {
    if (event.url === last.url) return false;
    // A redirect chain arrives as several navigations in quick succession; only
    // the destination is worth replaying.
    if (Math.abs(event.timestamp - last.timestamp) < DUPLICATE_NAVIGATION_MS) return false;
  }

  if (event.type === 'click' && last.type === 'click') {
    if (event.selector === last.selector &&
        Math.abs(event.timestamp - last.timestamp) < DUPLICATE_CLICK_MS) {
      return false;
    }
  }

  if (event.type === 'fill' && last.type === 'fill') {
    // Consecutive fills on the same selector within FILL_SUPERSEDE_MS collapse to the latest value.
    if (event.selector === last.selector &&
        Math.abs(event.timestamp - last.timestamp) < FILL_SUPERSEDE_MS) {
      history[history.length - 1] = event;
      return false;
    }
  }

  return true;
}
