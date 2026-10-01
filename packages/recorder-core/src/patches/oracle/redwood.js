/**
 * redwood.js — Oracle Redwood / JET Core Pack custom element adapters.
 *
 * Oracle Cloud Fusion (Redwood UI) renders modern web components using Oracle JET
 * (JavaScript Extension Toolkit) and Oracle Core Pack:
 *   - oj-c-select-single / oj-select-single (Single select with search)
 *   - oj-c-select-multiple / oj-select-many (Multi select)
 *   - oj-c-combobox-one / oj-combobox-one (Combobox)
 *   - oj-c-input-text / oj-c-input-number / oj-c-text-area
 *   - oj-c-input-date-time / oj-c-input-date-text / oj-input-date-time
 *   - oj-list-view / oj-table (Data collections)
 *   - oj-c-radioset / oj-c-checkboxset
 *
 * PROBLEM:
 * When an operator interacts with a Redwood select or combobox:
 *   1. Clicking the component spawns a floating overlay popup attached to document.body
 *      (e.g., `<div class="oj-listbox-drop">` or `<oj-c-select-single-results>`).
 *   2. The dropdown list items carry dynamic GUIDs and ephemeral DOM structures.
 *   3. When an option is clicked, the popup is immediately destroyed.
 *
 * If recorded naively, Playwright emits clicks on detached ephemeral `li:nth-child(3)`
 * or body-level overlay nodes, leading to 100% replay failure.
 *
 * SOLUTION:
 * This module detects Redwood component interactions, traces floating popup items back
 * to their host component, and produces semantic, durable `selectOption` and `fill` actions.
 */

import { cleanText } from '../../content/dom.js';

/** Selectors matching Oracle Redwood / JET host elements. */
export const REDWOOD_HOST_SELECTORS = [
  'oj-c-select-single',
  'oj-select-single',
  'oj-c-select-multiple',
  'oj-select-many',
  'oj-c-combobox-one',
  'oj-combobox-one',
  'oj-combobox-many',
  'oj-c-input-text',
  'oj-c-input-number',
  'oj-c-text-area',
  'oj-c-input-date-time',
  'oj-c-input-date-text',
  'oj-input-date-time',
  'oj-list-view',
  'oj-table',
  'oj-c-radioset',
  'oj-c-checkboxset',
].join(', ');

/** Selectors matching option/item nodes in Redwood / JET popups and lists. */
export const REDWOOD_OPTION_SELECTORS = [
  '[role="option"]',
  'oj-option',
  '.oj-listbox-result',
  '.oj-c-select-single-item',
  '.oj-listview-item',
  '.oj-table-body-row',
  '[data-oj-vcomponent="oj-c-select-single-item"]',
].join(', ');

/** Selectors matching popup containers holding Redwood dropdown options. */
export const REDWOOD_POPUP_CONTAINERS = [
  '.oj-listbox-drop',
  '.oj-c-select-single-results',
  '.oj-listview-container',
  '.oj-popup',
  '[data-oj-container-for]',
  '[role="listbox"]',
].join(', ');

/**
 * Check whether a node is a Redwood / JET component host.
 * @param {Element} el
 * @returns {boolean}
 */
export function isRedwoodHost(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag.startsWith('oj-c-') || tag.startsWith('oj-');
}

/**
 * Check whether a node is a Redwood / JET option or dropdown item.
 * @param {Element} el
 * @returns {Element|null}
 */
export function findRedwoodOption(el) {
  if (!el || !el.closest) return null;
  return el.closest(REDWOOD_OPTION_SELECTORS);
}

/**
 * Trace a clicked popup option back to its originating host component.
 *
 * Strategies:
 * 1. Direct ancestor: host element wraps the option (Shadow DOM or inline list).
 * 2. Active trigger correlation: last recorded trigger within the active window.
 * 3. Container attributes: data-oj-container-for, aria-controls, or id links.
 * 4. Active state query: open / expanded / focused JET host in document.
 *
 * @param {Element} optionEl
 * @param {Element|null} lastTrigger
 * @param {number} lastTriggerTime
 * @param {number} timeoutMs
 * @returns {Element|null} Originating Redwood host element, or null
 */
export function resolveRedwoodHost(optionEl, lastTrigger = null, lastTriggerTime = 0, timeoutMs = 8000) {
  if (!optionEl) return null;

  // 1. Direct ancestor search
  const directHost = optionEl.closest(REDWOOD_HOST_SELECTORS);
  if (directHost) return directHost;

  // 2. Correlate with recent trigger
  if (lastTrigger && (Date.now() - lastTriggerTime <= timeoutMs)) {
    const triggerHost = lastTrigger.closest ? lastTrigger.closest(REDWOOD_HOST_SELECTORS) : null;
    if (triggerHost) return triggerHost;
    if (isRedwoodHost(lastTrigger)) return lastTrigger;
  }

  // 3. Container attribute lookup
  const container = optionEl.closest(REDWOOD_POPUP_CONTAINERS);
  if (container) {
    const targetId = container.getAttribute('data-oj-container-for') ||
                     container.getAttribute('aria-labelledby') ||
                     container.getAttribute('data-oj-host-id');
    if (targetId) {
      const host = document.getElementById(targetId);
      if (host) return host;
    }
  }

  // 4. Query active / expanded JET select hosts in the document (explicit pass for expanded/open first)
  const expandedHost = document.querySelector(
    'oj-c-select-single[aria-expanded="true"], ' +
    'oj-select-single[aria-expanded="true"], ' +
    'oj-c-combobox-one[aria-expanded="true"], ' +
    'oj-combobox-one[aria-expanded="true"], ' +
    'oj-c-select-single[open], ' +
    'oj-select-single[open]'
  );
  if (expandedHost) return expandedHost;

  const focusedHost = document.querySelector(
    'oj-c-select-single.oj-focus, ' +
    'oj-select-single.oj-focus, ' +
    'oj-c-combobox-one.oj-focus, ' +
    'oj-combobox-one.oj-focus'
  );

  return focusedHost || null;
}

/**
 * Extract clean, human-meaningful label for a Redwood component.
 * @param {Element} hostEl
 * @returns {string}
 */
export function getRedwoodLabel(hostEl) {
  if (!hostEl) return '';

  // 1. Explicit label-hint or label attribute (Core Pack convention)
  const labelHint = hostEl.getAttribute('label-hint') || hostEl.getAttribute('label');
  if (labelHint && labelHint.trim()) return cleanText(labelHint);

  // 2. aria-label
  const ariaLabel = hostEl.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return cleanText(ariaLabel);

  // 3. aria-labelledby
  const labelledBy = hostEl.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl && labelEl.textContent.trim()) return cleanText(labelEl.textContent);
  }

  // 4. Internal oj-label or label element
  const internalLabel = hostEl.querySelector('label, oj-label, .oj-label');
  if (internalLabel && internalLabel.textContent.trim()) {
    return cleanText(internalLabel.textContent);
  }

  // 5. Preceding sibling label or form container label
  const container = hostEl.closest('.oj-form-layout, .oj-flex-item, tr, td, .oj-form-control');
  if (container) {
    const siblingLabel = container.querySelector('label, oj-label, .oj-label-ncl');
    if (siblingLabel && siblingLabel.textContent.trim()) {
      return cleanText(siblingLabel.textContent);
    }
  }

  return hostEl.id || '';
}

/**
 * Extract the value or label text from a Redwood option element.
 * @param {Element} optionEl
 * @returns {{ label: string, value: string }}
 */
export function extractRedwoodOptionData(optionEl) {
  if (!optionEl) return { label: '', value: '' };

  const rawText = cleanText(optionEl.textContent || '');
  const value = optionEl.getAttribute('data-oj-value') ||
                optionEl.getAttribute('value') ||
                optionEl.getAttribute('data-value') ||
                rawText;

  // Clean secondary subtext (e.g. descriptions in dropdown items)
  // Redwood options often render: `<div class="oj-listbox-result-label">Name</div><div class="subtext">Code</div>`
  const labelNode = optionEl.querySelector('.oj-listbox-result-label, .oj-c-select-single-item-text, .oj-treeview-item-text');
  const label = labelNode ? cleanText(labelNode.textContent) : rawText;

  return { label: label || rawText, value: String(value) };
}

/**
 * Build a normalized selectOption event for Redwood dropdown components.
 * @param {Element} hostEl
 * @param {Element} optionEl
 * @param {Object} ctx Content script context with selector derivation
 * @returns {Object} Normalized event payload
 */
export function createRedwoodSelectEvent(hostEl, optionEl, ctx) {
  const { label: optionLabel, value: optionValue } = extractRedwoodOptionData(optionEl);
  const hostLabel = getRedwoodLabel(hostEl);
  const hostTag = hostEl.tagName.toLowerCase();

  const hostSelector = ctx?.selectorFor ? ctx.selectorFor(hostEl) : { selector: hostTag, locator: `page.locator('${hostTag}')` };

  return {
    type: 'selectOption',
    action: 'selectOption',
    target: hostEl,
    value: optionLabel || optionValue,
    locator: hostSelector.locator,
    meta: {
      framework: 'oracle-redwood',
      componentType: hostTag,
      hostLabel,
      optionLabel,
      optionValue,
      selectByClick: true,
      triggerSelector: hostSelector.selector,
    },
  };
}
