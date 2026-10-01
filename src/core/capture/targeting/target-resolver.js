/**
 * target-resolver.js — resolves deep, interactive target elements from user interaction events.
 *
 * Combines composed-path inspection (for shadow DOM and nested spans),
 * interactive element traversal (buttons, links, inputs), and ADF/ERP wrapping cell
 * single-checkbox resolution behind one authoritative resolver.
 */

import { isVisible, retargetToInteractive } from '../../content/dom.js';
import { isWidgetNode } from '../../content/widget.js';

/**
 * Resolve the authoritative interactive target element from a raw DOM event.
 * @param {Event} event
 * @param {Object} [options]
 * @returns {Element|null}
 */
export function resolveInteractiveTarget(event, options = {}) {
  if (!event) return null;

  // 1. Extract raw target, inspecting composedPath for deep Shadow DOM boundary crossing
  let target = event.target;
  if (event.composedPath && typeof event.composedPath === 'function') {
    const path = event.composedPath();
    if (path && path.length > 0) {
      for (const node of path) {
        if (node instanceof Element) {
          target = node;
          break;
        }
      }
    }
  }

  if (!target || !(target instanceof Element)) return null;
  if (isWidgetNode(target)) return null;

  // 2. Checkbox-in-cell disambiguation:
  // If the user clicked the padding or wrapping <td>/<span> around a single checkbox,
  // resolve directly to that checkbox.
  if (target.querySelectorAll && target.tagName !== 'INPUT') {
    const boxes = target.querySelectorAll('input[type="checkbox"], input[type="radio"]');
    if (boxes.length === 1 && isVisible(boxes[0])) {
      return boxes[0];
    }
  }

  // 3. Walk outward to interactive container (e.g. button with child svg/span)
  const interactive = retargetToInteractive(target);
  return interactive || target;
}
