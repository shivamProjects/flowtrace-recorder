/**
 * selectors.js — every ADF/Fusion-specific CSS selector in one place.
 *
 * These strings were previously inline at a dozen call sites in content.js,
 * which meant that adding a dialog wrapper for one Fusion module involved
 * finding and editing several near-identical selector lists. They are grouped
 * by what they identify, not by which function happens to use them.
 *
 * When a new Fusion module turns out to use a wrapper we do not recognise, this
 * is the only file that needs to change.
 */

/** Containers ADF uses for modal and inline dialogs. */
export const DIALOG =
  '[id="__af_Z_window"], [id*="::dropDialog"], [id*="::lovDialog"], ' +
  '[id*="Popup"], [id*="popup"], [role="dialog"], [role="alertdialog"]';

/** Containers that hold list-of-values results. */
export const LOV_POPUP =
  '[id*="lovItems"], [id*="lov"], [id="__af_Z_window"], ' +
  '[id*="::dropDialog"], [id*="istribution"], [id*="Popup"], [id*="popup"]';

/** The calendar widget ADF opens from a date field. */
export const DATE_PICKER =
  '.af_inputDate_picker, .af_chooseDate, [id*="::pop"], [id*="::cd"], ' +
  '[id*="dateEditor"], [id*="calendar"], .xnd, [class*="chooseDate"]';

/** Headers inside the calendar that carry "Month YYYY". */
export const DATE_HEADERS = [
  '.af_chooseDate_title', '.af_inputDate_title', '[class*="calendar-title"]',
  '[class*="calendarHeader"]', 'caption', '[class*="month-year"]',
  '[class*="header"] span', 'th[colspan]', '.x11d', '.x11e', 'table span[id]',
];

/** Choice-list options rendered by af:selectOneChoice. */
export const CHOICE_OPTION =
  '[role="option"], .af_selectOneChoice-item, [id*="selectOneChoice"] li';

/** Anything that can open a list of values or a picker dialog. */
export const LOV_TRIGGER =
  'input, select, [role="combobox"], [class*="selectOneChoice"], ' +
  '[id*="lovIcon"], [class*="Lov"]';

/** Wrappers used when walking from a picker icon to the field it fills. */
export const FIELD_CONTAINER =
  'td, [class*="af_panelLabelAndMessage"], [class*="af_inputListOf"], ' +
  '[class*="fieldContainer"], [class*="inputContainer"], ' +
  '[class*="af_panelFormLayout"], [class*="panelFormLayout"], tr';

/** ADF field wrappers, used for label lookup and required-field detection. */
export const FIELD_WRAPPER = '[class*="af_input"], [class*="AF"]';

/** Markers ADF puts on a required field. */
export const REQUIRED_MARKER =
  '[class*="required"]:not([class*="Absence"]), ' +
  '[class*="Required"]:not([class*="Absence"]), ' +
  '.AFRequiredIcon:not(.AFRequiredIconAbsence)';

/** Buttons that commit a dialog. `.x1k8`/`.x1ka` are ADF's generated classes. */
export const COMMIT_BUTTON = 'button, a[role="button"], span[role="button"], a, span, .x1k8';

/** Text that identifies a commit button when the class does not. */
export const COMMIT_TEXT = /^(OK|Ok|Done|Save|Submit|Confirm)$/i;

/** Navigation tiles on the Fusion springboard. */
export const NAV_TILE = '[id^="itemNode_"]';

/** Children of a nav tile, counted before and after a click to detect expansion. */
export const NAV_TILE_CHILD =
  '[role="menuitem"], a[id^="itemNode_"], li a, .af_menu_item';

/** URL parameters ADF regenerates per session — never replayable. */
export const SESSION_URL_PARAMS = /_adf\.ctrl-state|_afrLoop|_afrWindowId|_afrWindowMode/;
