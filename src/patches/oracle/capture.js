/**
 * capture.js — Oracle ADF / Fusion behaviour that can only be observed live.
 *
 * Almost everything here exists because ADF destroys or rewrites the evidence
 * before recording stops: an LOV popup closes and takes its row text with it, a
 * calendar disappears the moment a day is clicked, a dialog's OK button writes
 * a normalised value into a field a second later. None of it is recoverable
 * from the event list afterwards, so it has to be read at the moment it exists
 * and streamed to the service worker.
 *
 * State is owned by the patch instance and cleared in stop(). The monolith kept
 * these maps at module scope and hung one of them off `window`, so a second
 * recording in the same tab inherited the first one's data.
 */

import { cleanText, normaliseFieldName } from '../../core/content/dom.js';
import { detectRequired } from '../../core/content/required.js';
import { resolveAdfLabel } from './labels.js';
import {
  CHOICE_OPTION, COMMIT_BUTTON, COMMIT_TEXT, DATE_HEADERS, DATE_PICKER, DIALOG,
  FIELD_CONTAINER, JET_SELECT_HOST, LOV_POPUP, LOV_TRIGGER, NAV_TILE,
  NAV_TILE_CHILD,
} from './selectors.js';

const TRIGGER_MEMORY_MS = 8_000;
const REQUIRED_SCAN_MS = 2_000;
const REQUIRED_SCAN_WINDOW_MS = 120_000;
const OPENER_BINDING_LIMIT = 20;

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9,
  oct: 10, nov: 11, dec: 12, january: 1, february: 2, march: 3, april: 4,
  june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** All mutable state for one recording. Recreated by start(), dropped by stop(). */
function blankState() {
  return {
    lastTrigger: null,
    lastTriggerAt: 0,
    monthOffset: 0,
    openerBindings: [],
    requiredFields: {},
    committedValues: {},
    lovCells: {},
    datePicks: {},
    dateInputValues: {},
    menuItems: new Set(),
    timers: [],
  };
}

let state = blankState();

export const capture = {
  start(ctx) {
    state = blankState();

    // ADF marks required fields in half a dozen ways and re-renders them on
    // every partial refresh, so the map is kept warm by polling rather than
    // read once. The window is bounded because the markers stop changing once
    // the page has settled, and an unbounded interval on a Fusion page is not
    // a cost worth paying for the rest of the session.
    scanRequiredFields(ctx);
    const interval = setInterval(() => scanRequiredFields(ctx), REQUIRED_SCAN_MS);
    const stop = setTimeout(() => clearInterval(interval), REQUIRED_SCAN_WINDOW_MS);
    state.timers.push(() => { clearInterval(interval); clearTimeout(stop); });

    // Remember what opened a list, so the row clicked afterwards can be tied
    // back to the field it fills.
    const onMouseDown = (e) => {
      const trigger = e.target?.closest?.(LOV_TRIGGER);
      if (trigger) {
        state.lastTrigger = trigger;
        state.lastTriggerAt = Date.now();
      }
    };
    document.addEventListener('mousedown', onMouseDown, true);
    state.timers.push(() => document.removeEventListener('mousedown', onMouseDown, true));
  },

  onClick(target, _event, ctx) {
    // A choice-list option is a selection, not a click. Claim it so the core
    // does not also emit a bare click on the row.
    if (claimChoiceListOption(target, ctx)) return true;

    captureLovRowContext(target, ctx);
    captureCalendarNavigation(target);
    captureCalendarDayClick(target, ctx);
    captureOpenerBinding(target);
    capturePostCommitValues(target, ctx);
    captureMenuItem(target, ctx);
    captureNavTile(target, ctx);
    return false;
  },

  onInput(target, _event, ctx) {
    if (target.getAttribute('role') !== 'combobox') return;
    const value = target.value.trim();
    if (!value) return;
    const field = resolveAdfLabel(target);
    // Not streamed here — typing is in flight, and the committed value arrives
    // on change or in the post-dialog scan.
    if (field) state.committedValues[field] = value;
  },

  onChange(target, _event, ctx) {
    if (target.tagName !== 'INPUT' || target.getAttribute('role') !== 'combobox') return;
    const value = target.value.trim();
    if (!value) return;
    const field = resolveAdfLabel(target);
    if (!field) return;
    state.committedValues[field] = value;
    ctx.updateContext({ committedValueMap: { [field]: value } });
  },

  stop() {
    for (const dispose of state.timers) dispose();
    const snapshot = {
      committedValueMap: { ...state.committedValues },
      lovCellMap: { ...state.lovCells },
      datePickerMap: { ...state.datePicks },
      dateInputValueMap: { ...state.dateInputValues },
      requiredFieldMap: { ...state.requiredFields },
      menuItemSet: [...state.menuItems],
    };
    state = blankState();
    return snapshot;
  },
};

/**
 * Annotations merged into every event's meta. Read back by postProcess.
 * @param {Element} el
 */
export function metaFor(el) {
  if (!el) return {};
  const meta = {};

  const dialog = el.closest(DIALOG);
  if (dialog) {
    meta.inDialog = true;
    meta.dialogId = dialog.id || null;
    meta.dialogRole = dialog.getAttribute('role') || 'dialog';
  }

  // The full row text is what disambiguates one grid row from another when the
  // cell text alone repeats.
  const cell = el.closest('td');
  if (cell) {
    const row = cell.closest('tr');
    if (row) {
      const cells = [...row.querySelectorAll('td')].map((c) => c.textContent.trim()).filter(Boolean);
      meta.rowCells = cells;
      meta.fullRowText = cells.join(' ');
      meta.cellText = cell.textContent.trim();
    }
  }

  if (el.getAttribute('aria-required') === 'true' ||
      el.hasAttribute('required') ||
      el.closest('label[class*="required"], label[class*="Required"]')) {
    meta.required = true;
  }

  // ── Locator enrichment ──────────────────────────────────────────────────
  // These three end up on the event's RecordedLocator, and they are the reason
  // the patch API has a resolve.meta hook at all: the core builds locators and
  // must not learn what `::content` means, but the replayer's Oracle patch
  // needs all three and cannot re-derive any of them from a selector string.
  const componentId = adfComponentId(el);
  if (componentId) meta.componentId = componentId;

  const containerRole = adfContainerRole(el);
  if (containerRole) meta.containerRole = containerRole;

  if (hasAdjacentLovIcon(el)) meta.hasLovIcon = true;

  meta.isHomeLink = isHomeLink(el);
  meta.isNavElement = isNavElement(el);
  return meta;
}

// ── ADF component addressing ────────────────────────────────────────────────

/**
 * The id of the ADF component WRAPPER, not of the editable node inside it.
 *
 * ADF renders one logical component as several nodes sharing a base id with a
 * generated suffix: `…:it2` is the wrapper, `…:it2::content` the input,
 * `…:it2::lovIconId` the magnifier, `…:it2::pop` the calendar. The wrapper is
 * the strongest address a recording can carry — it survives a partial refresh
 * that renumbers nothing and it identifies the component when the input's own
 * id has drifted — which is why engine/types.ts asks for it EXPLICITLY rather
 * than digging it back out of a selector.
 */
function adfComponentId(el) {
  let node = el;
  for (let hops = 0; node && hops < 5; hops += 1, node = node.parentElement) {
    const id = node.id || '';
    if (id.includes('::')) return id.replace(/::[^:]*$/, '');
  }
  return '';
}

/** Suffixed roles that mark a wrapping control rather than the node clicked. */
const CONTAINER_ROLES =
  '[role="combobox"], [role="listbox"], [role="grid"], [role="treegrid"], ' +
  '[role="menu"], [role="tree"], [role="dialog"]';

/**
 * The role of the control this element is PART of.
 *
 * `combobox` is the one that pays for the rest: ADF paints a dropdown as a
 * wrapper carrying the role with a plain `<input>` inside it, so the recorded
 * element looks like a textbox and the replayer would fill it rather than
 * opening its list.
 */
function adfContainerRole(el) {
  const holder = el.closest(CONTAINER_ROLES);
  if (holder && holder !== el) return holder.getAttribute('role') || '';

  // The sibling form: the wrapper carries no role and the combobox is the input
  // beside the icon that was clicked. Scoped to the field's own wrapper, not
  // its table row — a row holds several fields and one field's combobox would
  // otherwise mark all of them.
  const scope = el.closest(LOV_SCOPE);
  const combo = scope && scope.querySelector('[role="combobox"]');
  return combo && combo !== el ? 'combobox' : '';
}

/** ADF's list-of-values magnifier, in every form Fusion renders it. */
const LOV_ICON =
  '[id*="lovIconId"], [id*="lovIcon"], [class*="lovIcon"], [class*="LovIcon"], ' +
  '[class*="af_inputListOfValues_button"], [class*="af_inputComboboxListOfValues_button"], ' +
  'a[title^="Search:"], a[title^="Select:"], ' +
  'img[title^="Search:"], img[title^="Select:"], img[alt^="Search:"], img[alt^="Select:"]';

/** The narrowest wrapper that still holds a field and its icon together. */
const LOV_SCOPE =
  '[class*="af_inputListOfValues"], [class*="af_inputComboboxListOfValues"], ' +
  '[class*="af_panelLabelAndMessage"], td';

/**
 * Does this field have an LOV magnifier next to it?
 *
 * The replayer treats a field with an icon as a list, not a text box — typing
 * into one and walking away leaves the value unresolved. Scoped to the field's
 * own wrapper rather than its row: a `<tr>` holds several fields, and one
 * field's magnifier would then mark all of them.
 */
function hasAdjacentLovIcon(el) {
  if (el.matches && el.matches(LOV_ICON)) return true;
  const scope = el.closest(LOV_SCOPE);
  if (!scope) return false;
  return !!scope.querySelector(LOV_ICON);
}

// ── choice lists ────────────────────────────────────────────────────────────

/**
 * af:selectOneChoice renders its options as a floating list that is not a
 * <select>. Clicking an option is a selection against the FIELD, so the event
 * is emitted against the trigger with the option as its value.
 *
 * Oracle JET oj-select-single/oj-combobox-one also renders options as
 * [role="option"] elements inside a popup. These are normalised to
 * `selectOption` (a stable, replay-safe action) rather than a positional click.
 *
 * @returns {boolean} true when handled
 */
function claimChoiceListOption(target, ctx) {
  const option = target.closest(CHOICE_OPTION);
  if (!option) return false;

  const optionText = option.textContent.trim();
  if (!optionText) return false;

  // ── Oracle JET oj-select-single / oj-combobox-one ────────────────────────
  // JET renders the dropdown in a popup detached from the host element. Walk
  // the event's composed path to find the host, or fall back to document query.
  const jetHost = (() => {
    // 1. Direct ancestor (when popup is rendered inside shadow DOM of host)
    const direct = target.closest ? target.closest(JET_SELECT_HOST) : null;
    if (direct) return direct;
    // 2. Find the currently open JET select that has focus
    return document.querySelector(`${JET_SELECT_HOST}[open], ${JET_SELECT_HOST}[aria-expanded="true"]`);
  })();

  if (jetHost) {
    const hostLabel = resolveAdfLabel(jetHost) ||
      jetHost.getAttribute('aria-label') ||
      jetHost.getAttribute('label') ||
      jetHost.getAttribute('label-hint') ||
      jetHost.id || '';

    ctx.emit(ctx.makeEvent('selectOption', jetHost, {
      value: optionText,
      meta: {
        optionLabel: optionText,
        selectByClick: true,
        jetHost: jetHost.tagName.toLowerCase(),
        triggerSelector: ctx.selectorFor(jetHost).selector,
      },
    }));
    return true;
  }

  // ── ADF af:selectOneChoice ────────────────────────────────────────────────
  if (!state.lastTrigger) return false;
  if (Date.now() - state.lastTriggerAt > TRIGGER_MEMORY_MS) return false;

  const triggerLabel = resolveAdfLabel(state.lastTrigger);
  if (!triggerLabel) return false;

  // Prefer a locator that names the option; fall back to the role form when the
  // generated one is positional and would not survive a re-render.
  const generated = ctx.selectorFor(option).locator;
  const locator = generated && !generated.includes('nth-of-type')
    ? generated
    : `page.getByRole('option', { name: '${escapeSingleQuote(optionText)}' })`;

  ctx.emit(ctx.makeEvent('select', state.lastTrigger, {
    value: optionText,
    locator,
    meta: {
      optionLabel: optionText,
      selectByClick: true,
      triggerSelector: ctx.selectorFor(state.lastTrigger).selector,
    },
  }));

  state.committedValues[triggerLabel] = optionText;
  ctx.updateContext({ committedValueMap: { [triggerLabel]: optionText } });
  state.lastTrigger = null;
  return true;
}

// ── list of values ──────────────────────────────────────────────────────────

/** Record the row a clicked LOV cell belongs to, before the popup closes. */
function captureLovRowContext(target, ctx) {
  const cell = target.closest('td[role="gridcell"], td[role="cell"], td');
  if (!cell) return;
  if (!cell.closest(LOV_POPUP)) return;
  const row = cell.closest('tr');
  if (!row) return;

  const cellText = cell.textContent.trim();
  if (!cellText) return;
  const cells = [...row.querySelectorAll('td')].map((c) => c.textContent.trim()).filter(Boolean);

  state.lovCells[cellText] = cells[0] || cellText;
  ctx.updateContext({ lovCellMap: { [cellText]: cells[0] || cellText } });
}

// ── date picker ─────────────────────────────────────────────────────────────

/** Track month paging so a day click can be resolved even with no header. */
function captureCalendarNavigation(target) {
  const button = target.closest('a, button, span');
  if (!button || !button.closest(DATE_PICKER)) return;
  const hint = (button.getAttribute('title') ||
                button.getAttribute('aria-label') ||
                button.textContent.trim() || '').toLowerCase();
  if (/prev|back|left|←|previous/.test(hint)) state.monthOffset -= 1;
  else if (/next|forward|right|→/.test(hint)) state.monthOffset += 1;
}

/**
 * Reconstruct the full date from a day-cell click. The cell says "14"; the
 * month and year live in the header, an aria-label, or nowhere at all — in
 * which case the month paging counter is the only remaining source.
 */
function captureCalendarDayClick(target, ctx) {
  const cell = target.closest('td[role="gridcell"], td');
  if (!cell) return;
  const dayText = cell.textContent.trim();
  if (!/^\d{1,2}$/.test(dayText)) return;
  const day = Number(dayText);
  if (day < 1 || day > 31) return;

  const picker = cell.closest(DATE_PICKER);
  if (!picker) return;
  if (!looksLikeCalendarRow(cell)) return;

  let { month, year } = readDateFromLabels(cell, picker, day);
  if (!month || !year) ({ month, year } = readDateFromHeader(picker));
  if (!month || !year) {
    const base = new Date();
    const adjusted = new Date(base.getFullYear(), base.getMonth() + state.monthOffset, 1);
    month = adjusted.getMonth() + 1;
    year = adjusted.getFullYear();
  }

  const fullDate = `${month}/${day}/${year % 100}`;
  const targetFieldId = findDateInputId(picker);

  state.datePicks[dayText] = {
    fullDate, day, month, year, monthOffset: state.monthOffset, targetFieldId,
  };
  ctx.updateContext({ datePickerMap: { [dayText]: state.datePicks[dayText] } });

  // ADF writes the normalised value into the field asynchronously. Poll for it,
  // and drop the result if the recording ended in the meantime.
  const stillOurs = ctx.guard();
  for (const delay of [500, 1000, 1500]) {
    setTimeout(() => {
      if (!stillOurs()) return;
      const input = resolveDateInput(picker, targetFieldId);
      const value = input?.value?.trim();
      if (!value || !/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(value)) return;
      const id = input.id || targetFieldId;
      state.dateInputValues[id] = value;
      ctx.updateContext({ dateInputValueMap: { [id]: value } });
    }, delay);
  }

  state.monthOffset = 0;
}

/** A real calendar week is seven numeric cells; anything else is a data table. */
function looksLikeCalendarRow(cell) {
  const row = cell.closest('tr');
  if (!row) return true;
  const filled = [...row.querySelectorAll('td')].filter((c) => c.textContent.trim().length > 0);
  if (filled.length > 0 && filled.length !== 7) return false;
  return !filled.some((c) => !/^\d{1,2}$/.test(c.textContent.trim()));
}

function readDateFromLabels(cell, picker, day) {
  const candidates = [
    cell.getAttribute('aria-label'), cell.getAttribute('title'), cell.getAttribute('data-date'),
    picker.getAttribute('aria-label'), picker.getAttribute('title'),
  ].filter(Boolean);

  for (const raw of candidates) {
    const named = raw.trim().match(
      /(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})/i,
    );
    if (named && Number(named[2]) === day) {
      return { month: MONTHS[named[1].toLowerCase()], year: Number(named[3]) };
    }
    const numeric = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
    if (numeric && Number(numeric[2]) === day) {
      const year = Number(numeric[3]);
      return { month: Number(numeric[1]), year: year < 100 ? year + 2000 : year };
    }
  }
  return {};
}

function readDateFromHeader(picker) {
  for (const selector of DATE_HEADERS) {
    const header = picker.querySelector(selector);
    if (!header) continue;
    const match = header.textContent.trim().match(
      /(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i,
    );
    if (match) return { month: MONTHS[match[1].toLowerCase()], year: Number(match[2]) };
  }
  return {};
}

/** ADF names the input `<pickerBaseId>::content`. */
function findDateInputId(picker) {
  try {
    const id = picker.id || '';
    if (id.includes('::')) {
      const input = document.getElementById(`${id.replace(/::(?:pop|cd|dlg)$/, '')}::content`);
      if (input) return input.id;
    }
    const focused = document.querySelector(
      'input[id$="::content"][role="combobox"]:focus, input.af_inputDate_content:focus',
    );
    return focused ? focused.id : '';
  } catch {
    return '';
  }
}

function resolveDateInput(picker, targetFieldId) {
  if (targetFieldId) {
    const direct = document.getElementById(targetFieldId);
    if (direct) return direct;
  }
  if (picker.id) {
    const base = picker.id.replace(/::(?:pop|cd|dlg|cal).*$/, '');
    const byBase = document.getElementById(`${base}::content`) ||
                   document.getElementById(`${base}::input`);
    if (byBase) return byBase;
  }
  for (const input of document.querySelectorAll(
    'input[id$="::content"]:not([type="hidden"]), input.af_inputDate_content',
  )) {
    if (input.value && /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(input.value)) return input;
  }
  return null;
}

// ── composite pickers ───────────────────────────────────────────────────────

/**
 * A "Search: Customer" magnifier opens a dialog that fills a field elsewhere in
 * the layout. Bind the opener to that field now, so the value it eventually
 * writes can be attributed to the right label.
 */
function captureOpenerBinding(target) {
  const opener = target.closest('a, button, img, [role="link"], [role="button"]');
  if (!opener) return;

  const image = opener.tagName === 'IMG' ? opener : opener.querySelector('img[alt]');
  const name = (
    opener.getAttribute('title') ||
    opener.getAttribute('aria-label') ||
    (image ? image.getAttribute('title') || image.getAttribute('alt') : '') ||
    opener.textContent || ''
  ).replace(/\s+/g, ' ').trim();

  if (!/^(Search|Select):\s+\S/.test(name)) return;

  let node = opener.closest(FIELD_CONTAINER);
  let input = null;
  for (let hops = 0; node && hops < 6; hops += 1) {
    input = node.querySelector(
      'input:not([type="hidden"]):not([type="button"]):not([type="submit"])' +
      ':not([type="checkbox"]):not([type="radio"])',
    );
    if (input && input.id) break;
    input = null;
    node = node.parentElement?.closest(FIELD_CONTAINER) || null;
  }
  if (!input || !input.id) return;

  state.openerBindings.push({ openerTitle: name, targetInputId: input.id, consumed: false });
  if (state.openerBindings.length > OPENER_BINDING_LIMIT) {
    state.openerBindings.splice(0, state.openerBindings.length - OPENER_BINDING_LIMIT);
  }
}

/**
 * After a dialog is committed, ADF writes normalised values into the underlying
 * fields. Sweep for them once the write has had time to land.
 */
function capturePostCommitValues(target, ctx) {
  const button = target.closest(COMMIT_BUTTON);
  if (!button) return;

  const text = (button.textContent || '').trim();
  const isCommit =
    COMMIT_TEXT.test(text) ||
    COMMIT_TEXT.test(button.getAttribute('title') || '') ||
    COMMIT_TEXT.test(button.getAttribute('aria-label') || '') ||
    button.classList.contains('x1k8') ||
    button.classList.contains('x1ka') ||
    /ok|confirm/i.test(button.id || '');
  if (!isCommit) return;
  if (!button.closest(DIALOG)) return;

  const stillOurs = ctx.guard();
  setTimeout(() => {
    if (!stillOurs()) return;

    for (const field of document.querySelectorAll('input:not([type="hidden"]), textarea')) {
      const value = (field.value || '').trim();
      if (!value || field.offsetParent === null) continue;
      const label = resolveAdfLabel(field);
      if (!label) continue;
      state.committedValues[label] = value;
      ctx.updateContext({ committedValueMap: { [label]: value } });
    }

    for (const binding of state.openerBindings) {
      if (binding.consumed) continue;
      const input = document.getElementById(binding.targetInputId);
      const value = (input?.value || '').trim();
      if (!value) continue;

      const bare = binding.targetInputId.replace(/::content$/, '');
      const labelEl = document.querySelector(
        `label[for="${binding.targetInputId}"], label[for="${bare}"]`,
      );
      const label = labelEl
        ? labelEl.textContent.replace(/^\**\s*/, '').trim()
        : binding.openerTitle.replace(/^(?:Search|Select):\s*/i, '').trim();
      if (!label) continue;

      state.committedValues[label] = value;
      binding.consumed = true;
      ctx.updateContext({ committedValueMap: { [label]: value } });
    }
  }, 1000);
}

// ── menus and navigation ────────────────────────────────────────────────────

function captureMenuItem(target, ctx) {
  const item = target.closest('[role="menuitem"]');
  if (!item) return;
  const menu = item.closest('[role="menu"]');
  if (!menu || menu.offsetParent === null) return;
  const text = cleanText(item.textContent, 80);
  if (!text || text.length > 80) return;
  state.menuItems.add(text);
  ctx.updateContext({ menuItemSet: [text] });
}

/**
 * Springboard tiles are SVG with no accessible name, so the only way to tell a
 * tile that expanded a menu from one that navigated is to count its children
 * before and after.
 */
function captureNavTile(target, ctx) {
  const tile = target.closest(NAV_TILE);
  if (!tile || !tile.id) return;

  const before = tile.querySelectorAll(NAV_TILE_CHILD).length;
  const tileId = tile.id;
  const clickedTag = (target.tagName || '').toLowerCase();

  let pathIndex = -1;
  if (clickedTag === 'path' && target.parentElement) {
    const siblings = [...target.parentElement.children]
      .filter((c) => (c.tagName || '').toLowerCase() === 'path');
    pathIndex = siblings.indexOf(target);
  }

  const stillOurs = ctx.guard();
  setTimeout(() => {
    if (!stillOurs()) return;
    const after = tile.querySelectorAll(NAV_TILE_CHILD).length;
    ctx.emit({
      ...ctx.makeEvent('meta_nav_tile', tile),
      meta: {
        tileId,
        clickedTag,
        pathIndex,
        beforeMenuItems: before,
        afterMenuItems: after,
        navObservedExpansion: after > before,
        childLabels: [...tile.querySelectorAll(NAV_TILE_CHILD)]
          .map((el) => cleanText(el.textContent, 80))
          .filter((s) => s && s.length <= 80)
          .slice(0, 10),
        isNavTile: true,
        isNavElement: true,
      },
    });
  }, 800);
}

// ── required fields ─────────────────────────────────────────────────────────

/**
 * Ask the shared detector about every control on the page, keyed by the label
 * ADF associates with it.
 *
 * The detection itself is NOT Oracle-specific and no longer lives here — see
 * core/content/required.js. What remains Oracle's business is the key: only
 * `resolveAdfLabel` knows about the `::content` id suffix and the label cell
 * ADF emits with no `for` attribute.
 *
 * The map is TRI-STATE. `true` and `false` are answers; `null` means the page
 * gave no grounds either way, which is not the same as "optional" and must not
 * be written as `false`. A key absent from the map was never resolvable to a
 * label at all.
 *
 * A verdict is never downgraded. ADF re-renders its markers on every partial
 * refresh and a field can be mid-rewrite when the poll lands, so a marker seen
 * once is kept: only an unknown (absent or null) entry is overwritten, and only
 * `true` may overwrite a `false`.
 */
function scanRequiredFields(ctx) {
  try {
    const updates = {};

    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.type === 'hidden') continue;
      const name = normaliseFieldName(resolveAdfLabel(el));
      if (!name) continue;

      const seen = state.requiredFields[name];
      if (seen === true) continue;

      const verdict = detectRequired(el).required;
      if (verdict === null && seen !== undefined) continue;
      if (verdict === false && seen === false) continue;

      state.requiredFields[name] = verdict;
      updates[name] = verdict;
    }

    if (Object.keys(updates).length) ctx.updateContext({ requiredFieldMap: updates });
  } catch {
    // A malformed selector against an unexpected DOM must not stop recording.
  }
}

// ── misc ────────────────────────────────────────────────────────────────────

function isHomeLink(el) {
  const text = (el.textContent || '').trim();
  return /^Home$/i.test(text) || /^Home$/i.test(el.getAttribute('aria-label') || '');
}

function isNavElement(el) {
  const className = typeof el.className === 'string' ? el.className : '';
  return /flat-tabs-overflow|clusters_container|itemNode_/i.test(`${el.id || ''} ${className}`);
}

function escapeSingleQuote(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
