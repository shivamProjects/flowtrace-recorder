/**
 * postprocess.js — Oracle Fusion / ADF post-processing.
 *
 * Runs in the service worker once recording stops, with the whole event list
 * available. This is where hindsight-dependent rewrites belong: dropping the
 * navigations whose URLs carry a dead session token, replacing a calendar
 * gridcell click with a fill of the date the calendar produced, substituting
 * the value ADF committed for the one the user typed.
 *
 * The bodies below are the ones that shipped in profiles.js, moved rather than
 * rewritten. The only substantive edit is that enrichment now arrives on
 * `session.patchContext` instead of `session.oracleContext` — the core no
 * longer has a field named after one application.
 */

import { collapseRepeatedFills, collapseRepeatedNavigations } from '../shared/postprocess-helpers.js';
import { pruneLocator } from '../../shared/schema.js';
import { attributeSelector, idSelector } from '../../content/escape.js';
import { SESSION_URL_PARAMS } from './selectors.js';

// ─────────────────────────────────────────────────────────────────────────────
// ── Locator objects ──────────────────────────────────────────────────────────
//
// Each rewrite below provides both representations: the structured locator
// object for replayer candidate ladder evaluation, and the expression string
// for readable generated scripts.
//
// `patchLocator` merges rather than replaces, because the fields the content
// script captured against the live element — id, componentId, attrSelector,
// parent — are fallbacks that no rewrite here has any reason to discard.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A rewrite states itself as fields, and the result is put back through the
 * schema's allow-list. A patch is the one place a field nothing reads is most
 * likely to be invented — this is the service worker, the DOM is long gone, and
 * whatever is written here is what gets stored.
 *
 * @param {Object} ev     the event being rewritten
 * @param {Object} fields fields to overwrite on its locator object
 * @returns {Object}      the merged locator object
 */
function patchLocator(ev, fields) {
  const base = (ev.locatorObject && typeof ev.locatorObject === 'object') ? ev.locatorObject : {};
  const merged = { ...base };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') delete merged[key];
    else merged[key] = value;
  }
  return pruneLocator(merged);
}

/**
 * @param {Object[]} events
 * @param {Object} session
 * @returns {Object[]}
 */
export function postProcess(events, session) {
  const ctx = (session && session.patchContext) || {};
  let result = [...events];

  // ── Step 1: Drop ADF session-token navigation URLs ─────────────────────
  // ADF appends _adf.ctrl-state, _afrLoop, _afrWindowId etc. to URLs during
  // page transitions. These are not replayable and must be removed.
  result = result.filter(ev => {
    if (ev.type !== 'navigate') return true;
    return !SESSION_URL_PARAMS.test(ev.url || '');
  });

  // ── Step 2: Generic dedup baseline ────────────────────────────────────
  result = collapseRepeatedNavigations(result);
  result = collapseRepeatedFills(result);

  // ── Step 3: Oracle nav section dedup ──────────────────────────────────
  // Removes arrow-scroll clicks, cluster_container clicks, and duplicate
  // itemNode tile clicks in the Home → module → tile navigation region.
  result = applyOracleNavDedup(result);

  // ── Step 4: Home link normalization ────────────────────────────────────
  // Playwright codegen records Home clicks in several forms depending on the
  // DOM structure. Canonicalise to getByRole('link', { name: 'Home' }).
  result = applyHomeLinkNormalization(result);

  // ── Step 5: Menu item rewriting ────────────────────────────────────────
  // If a click's text was captured as a role=menuitem click by content.js,
  // override the role/locator so the compiler emits getByRole('menuitem',…).
  if (ctx.menuItemSet && ctx.menuItemSet.length > 0) {
    result = applyMenuItemRewriting(result, new Set(ctx.menuItemSet));
  }

  // ── Step 6: Date picker enrichment ────────────────────────────────────
  // If a calendar day-click has a reconstructed full date (from content.js
  // capturedDatePickerDayClick), replace the gridcell click with a fill
  // targeting the date input. If targetFieldId is missing we keep the click
  // as-is (compiler will fall back to gridcell role selector).
  if (ctx.datePickerMap && Object.keys(ctx.datePickerMap).length > 0) {
    result = applyDatePickerEnrichment(result, ctx.datePickerMap, ctx.dateInputValueMap || {});
  }

  // ── Step 7: LOV cell name enrichment ────────────────────────────────────
  // Playwright sometimes truncates LOV cell ARIA names. Replace with the
  // captured primary cell text if it is longer (genuine enrichment guard).
  if (ctx.lovCellMap && Object.keys(ctx.lovCellMap).length > 0) {
    result = applyLovCellEnrichment(result, ctx.lovCellMap);
  }

  // ── Step 8: Committed value substitution ───────────────────────────────
  // Replace fill event values with the ADF-committed canonical values
  // (captured from change events and post-OK scans in content.js).
  if (ctx.committedValueMap && Object.keys(ctx.committedValueMap).length > 0) {
    result = applyCommittedValues(result, ctx.committedValueMap);
  }

  // ── Step 9: Timestamp stripping ────────────────────────────────────────
  // Oracle ADF status text often embeds live dates/times that change between
  // record and replay (e.g. "Ready for download 5/15/26 12:06 PM").
  // Strip the timestamp portion and truncate the text selector to a stable prefix.
  result = applyTimestampStripping(result);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Oracle Fusion: Navigation dedup ──────────────────────────────────────────
// Mirrors CodegenParserService.applyNavigationDedup from the original project.
// ─────────────────────────────────────────────────────────────────────────────
function applyOracleNavDedup(events) {
  const isArrowClick   = ev => ev.type === 'click' && ev.selector && ev.selector.includes('flat-tabs-overflow');
  const isClusterClick = ev => ev.type === 'click' && ev.selector && ev.selector.includes('clusters_container');
  const isItemNode     = ev => ev.type === 'click' && ev.selector && ev.selector.includes('#itemNode_');
  const isHomeClick    = ev => ev.type === 'click' && ev.meta && ev.meta.isHomeLink;

  const homeIdx = events.findIndex(isHomeClick);
  if (homeIdx === -1) return events;

  const dropped = new Set();

  // Drop arrow overflow-scroll and cluster container clicks after Home
  for (let i = homeIdx; i < events.length; i++) {
    if (isArrowClick(events[i]) || isClusterClick(events[i])) dropped.add(i);
  }

  // Dedup duplicate itemNode tile clicks — keep last occurrence only
  const seenTiles = new Map();
  for (let i = events.length - 1; i >= homeIdx; i--) {
    if (!isItemNode(events[i])) continue;
    const tileId = (events[i].selector || '').match(/#itemNode_(\w+)/)?.[1] || events[i].selector;
    if (seenTiles.has(tileId)) {
      dropped.add(i); // earlier duplicate — drop it
    } else {
      seenTiles.set(tileId, i);
    }
  }

  // Pre-Home abandoned nav cleanup: drop arrow/cluster/itemNode clicks that
  // appeared BEFORE the first Home click (user navigated wrong module first).
  if (homeIdx > 0) {
    for (let i = 0; i < homeIdx; i++) {
      if (isArrowClick(events[i]) || isClusterClick(events[i]) || isItemNode(events[i])) {
        dropped.add(i);
      }
    }
  }

  return events.filter((_, i) => !dropped.has(i));
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Oracle Fusion: Home link normalization ────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function applyHomeLinkNormalization(events) {
  return events.map(ev => {
    if (ev.type !== 'click' || !ev.meta || !ev.meta.isHomeLink) return ev;
    const selector = '[aria-label="Home"], a[title="Home"], [role="link"]';
    return {
      ...ev,
      role: 'link',
      text: 'Home',
      // Override locator so compiler emits the canonical Home click
      locator: `page.getByRole('link', { name: 'Home', exact: true })`,
      selector,
      locatorObject: patchLocator(ev, {
        role: 'link',
        name: 'Home',
        text: 'Home',
        exact: true,
        selector,
        attrSelector: attributeSelector('aria-label', 'Home'),
      }),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Oracle Fusion: Menu item rewriting ───────────────────────────────────────
// If content.js captured the click target as a role=menuitem (via
// captureMenuItemClick), update the event's role and locator so the compiler
// emits the stable getByRole('menuitem', { name: '...' }) expression.
// ─────────────────────────────────────────────────────────────────────────────
function applyMenuItemRewriting(events, menuItemSet) {
  return events.map(ev => {
    if (ev.type !== 'click') return ev;
    // Check both the event's stored meta and the context-level set
    const text = (ev.text || '').trim();
    const isMenuItem = (ev.meta && ev.meta.isMenuItem) || menuItemSet.has(text);
    if (!isMenuItem || !text) return ev;
    return {
      ...ev,
      role: 'menuitem',
      // Compiler will see role=menuitem + text → getByRole('menuitem', { name: text })
      // Setting locator explicitly ensures even unusual menu structures work.
      locator: `page.getByRole('menuitem', { name: '${escapeSQ(text)}' })`,
      locatorObject: patchLocator(ev, {
        role: 'menuitem',
        name: text,
        text,
        // Substring, matching the expression above: ADF pads a menu item's
        // text with a shortcut hint and an indent that vary by release.
        exact: false,
      }),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Oracle Fusion: Date picker enrichment ─────────────────────────────────────
// Converts calendar day-click events into fill events targeting the date input.
// Falls back to gridcell click if no targetFieldId is available.
// ─────────────────────────────────────────────────────────────────────────────
function applyDatePickerEnrichment(events, datePickerMap, dateInputValueMap) {
  return events.map(ev => {
    if (ev.type !== 'click') return ev;

    // Path 1: event meta already contains isDatePickerClick (set by content.js)
    if (ev.meta && ev.meta.isDatePickerClick && ev.meta.fullDate) {
      const fullDate     = ev.meta.fullDate;
      const targetId     = ev.meta.targetFieldId || '';
      const committedVal = targetId ? (dateInputValueMap[targetId] || fullDate) : fullDate;

      if (targetId) {
        // Transform to a fill event on the date input
        return {
          ...ev,
          type:     'fill',
          selector: `#${targetId}`,
          locator:  `page.locator('${escapeSQ(idSelector(targetId))}')`,
          value:    committedVal,
          locatorObject: dateInputLocator(ev, targetId),
          meta:     { ...ev.meta, dateEnriched: true, originalType: 'click' },
        };
      }
      // No targetFieldId — keep as click but update locator to use the full date
      return {
        ...ev,
        locator: `page.getByRole('gridcell', { name: '${escapeSQ(fullDate)}', exact: true })`,
        text:    fullDate,
        locatorObject: patchLocator(ev, {
          role: 'gridcell', name: fullDate, text: fullDate, exact: true,
        }),
        meta:    { ...ev.meta, dateEnriched: true },
      };
    }

    // Path 2: cell text is a day number and datePickerMap has context for it
    const cellText = (ev.text || '').trim();
    if (/^\d{1,2}$/.test(cellText) && datePickerMap[cellText]) {
      const info         = datePickerMap[cellText];
      const committedVal = info.targetFieldId
        ? (dateInputValueMap[info.targetFieldId] || info.fullDate)
        : info.fullDate;

      if (info.targetFieldId) {
        return {
          ...ev,
          type:     'fill',
          selector: `#${info.targetFieldId}`,
          locator:  `page.locator('${escapeSQ(idSelector(info.targetFieldId))}')`,
          value:    committedVal,
          locatorObject: dateInputLocator(ev, info.targetFieldId),
          meta:     { ...ev.meta, dateEnriched: true, originalType: 'click', fullDate: info.fullDate },
        };
      }
    }

    return ev;
  });
}

/**
 * The date INPUT the calendar was opened from, replacing the gridcell the user
 * actually clicked.
 *
 * Every field the day cell contributed has to go: its role was `gridcell`, its
 * name and text were the day number, and its componentId addressed the popup.
 * Left in place they would be tried as fallbacks — and a `gridcell` named "14"
 * still resolves on the next replay's calendar, filling the wrong month.
 */
function dateInputLocator(ev, targetFieldId) {
  return patchLocator(ev, {
    id:           targetFieldId,
    selector:     idSelector(targetFieldId),
    attrSelector: attributeSelector('id', targetFieldId),
    componentId:  targetFieldId.replace(/::[^:]*$/, ''),
    sourceTag:    'input',
    role:         'textbox',
    // Cleared, not overwritten: nothing on the day cell describes the input.
    name: null, text: null, title: null, label: null, exact: null, containerRole: null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Oracle Fusion: LOV cell name enrichment ───────────────────────────────────
// Playwright sometimes records truncated LOV cell ARIA names. Replace with the
// primary (longer) captured cell text when available.
// Guard: only enrich when primary is strictly longer (prevents cross-contamination).
// ─────────────────────────────────────────────────────────────────────────────
function applyLovCellEnrichment(events, lovCellMap) {
  return events.map(ev => {
    if (ev.type !== 'click') return ev;
    const cellText = ev.meta && ev.meta.cellText;
    if (!cellText) return ev;
    const primary = lovCellMap[cellText];
    if (primary && typeof primary === 'string' && primary.length > cellText.length) {
      return {
        ...ev,
        text:    primary,
        locator: `page.getByRole('cell', { name: '${escapeSQ(primary)}', exact: true })`,
        locatorObject: patchLocator(ev, {
          role: 'cell', name: primary, text: primary, exact: true,
        }),
        meta:    { ...ev.meta, lovEnrichedCell: primary, originalCellText: cellText },
      };
    }
    return ev;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Oracle Fusion: Committed value substitution ───────────────────────────────
// Replace fill event values with ADF-committed canonical values (captured from
// post-OK scans and change events in content.js).
// ─────────────────────────────────────────────────────────────────────────────
function applyCommittedValues(events, committedValueMap) {
  let result = events.map(ev => {
    if (ev.type !== 'fill') return ev;
    const label = normalizeOracleLabel(ev.label || (ev.meta && ev.meta.resolvedLabel) || '');
    if (!label) return ev;
    for (const [fieldName, committedVal] of Object.entries(committedValueMap)) {
      if (normalizeOracleLabel(fieldName) === label) {
        return {
          ...ev,
          value: committedVal,
          meta:  { ...ev.meta, committedValue: committedVal, originalValue: ev.value },
        };
      }
    }
    return ev;
  });

  // Convert click to fill + tab, and drop intermediate dialog actions for fields in committedValueMap that lack a fill event
  for (const [fieldName, committedVal] of Object.entries(committedValueMap)) {
    const targetLabel = normalizeOracleLabel(fieldName);
    if (!targetLabel) continue;

    // Check if there is already a fill event for this field
    const hasFill = result.some(ev => 
      ev.type === 'fill' && 
      normalizeOracleLabel(ev.label || (ev.meta && ev.meta.resolvedLabel) || '') === targetLabel
    );
    if (hasFill) continue;

    // Find the click event on this field (which opened the KFF or LOV dialog)
    const clickIdx = result.findIndex(ev => 
      ev.type === 'click' && 
      normalizeOracleLabel(ev.label || (ev.meta && ev.meta.resolvedLabel) || '') === targetLabel
    );

    if (clickIdx !== -1) {
      const origEvent = result[clickIdx];

      // Convert the click to a fill event
      const fillEvent = {
        ...origEvent,
        type: 'fill',
        value: committedVal,
        meta: {
          ...origEvent.meta,
          committedValue: committedVal,
          isLovCollapse: true
        }
      };

      // Create a Tab press event to commit the value
      const tabEvent = {
        type: 'press',
        timestamp: origEvent.timestamp + 10,
        url: origEvent.url,
        selector: origEvent.selector,
        locator: origEvent.locator,
        tagName: origEvent.tagName,
        inputType: origEvent.inputType,
        value: 'Tab',
        checked: null,
        text: 'Tab',
        key: 'Tab',
        label: origEvent.label,
        role: origEvent.role,
        // The keystroke lands on the field that was just filled, so it inherits
        // that field's locator rather than being left with none — a press with
        // no locator falls back to page.keyboard, which types at whatever has
        // focus by then.
        locatorObject: origEvent.locatorObject,
        meta: { ...origEvent.meta }
      };

      // Replace the click event with [fill, tab]
      result.splice(clickIdx, 1, fillEvent, tabEvent);

      // Drop all subsequent dialog events (meta.inDialog === true) until the first non-dialog event
      let scanIdx = clickIdx + 2; // start after the tabEvent we just inserted
      while (scanIdx < result.length) {
        const nextEv = result[scanIdx];
        if (nextEv.meta && nextEv.meta.inDialog) {
          result.splice(scanIdx, 1);
        } else {
          break; // hit first non-dialog event — stop dropping
        }
      }
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Oracle Fusion: Timestamp stripping ───────────────────────────────────────
// Oracle ADF status text embeds live dates (e.g. "Ready for download 5/15/26").
// Strip the timestamp to create a stable prefix-based text selector.
// ─────────────────────────────────────────────────────────────────────────────
const TS_RE = /\s+(?:\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}:\d{2}(?:\s*[AP]M)?|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?)/i;

function applyTimestampStripping(events) {
  return events.map(ev => {
    if (ev.type !== 'click') return ev;
    const text = ev.text || '';
    const tsIdx = text.search(TS_RE);
    if (tsIdx <= 0) return ev;
    const prefix = text.substring(0, tsIdx).trim();
    if (prefix.length < 3) return ev;
    return {
      ...ev,
      text: prefix,
      // The name loses the timestamp too, but only when the name WAS the text —
      // a control named by its own label keeps that name. `exact` goes with it
      // either way: a prefix is by definition not the whole name, and an exact
      // match on it finds nothing.
      locatorObject: patchLocator(ev, {
        text: prefix,
        exact: false,
        ...(ev.locatorObject && ev.locatorObject.name === text ? { name: prefix } : {}),
      }),
      meta: { ...ev.meta, timestampStripped: true, originalText: text },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Shared utility helpers ────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize an Oracle field label for comparison (strip required markers, extra whitespace). */
function normalizeOracleLabel(s) {
  return String(s || '').toLowerCase()
    .replace(/^\*{1,2}\s*/, '')
    .replace(/[_]+/g, ' ')
    .replace(/[:*]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escape a string for embedding in a single-quoted JS string. */
function escapeSQ(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
