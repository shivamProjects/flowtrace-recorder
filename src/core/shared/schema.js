/**
 * schema.js — the recording format, version 1.
 *
 * There is one canonical shape for a recorded action and this file is it. It
 * lives in `shared/` because three places have to agree on it and none of them
 * can see each other: the content script builds locator objects, the service
 * worker's compiler assembles actions, and a patch's postProcess rewrites both.
 * When the allow-lists were implicit — a hand-written object literal in each of
 * those three places — they drifted, and the drift was invisible because
 * nothing downstream reads an unknown field: it just travels.
 *
 * The field set is measured, not guessed. Across a 9,010-step production corpus
 * the excluded fields below were 26% of every locator object by size and were
 * read by nothing in the replayer. Fields are therefore added here only when
 * something reads them, and the acceptance test in test/actions.test.js fails
 * if the compiler starts emitting one that is not listed.
 */

/** Bumped only for a change a reader cannot absorb silently. */
export const SCHEMA_VERSION = 1;

/**
 * Every verb a recording may contain, in the exact casing it is written.
 *
 * The replayer lowercases before dispatch but prints what it is given, so the
 * casing here is what a customer reads in the PDF report.
 *
 * `select` is deliberately absent. It meant two different interactions — an
 * HTML <select> and a row pick from an already-open list — and the replayer
 * resolved the ambiguity by clicking the dropdown and choosing nothing. Those
 * are now `selectOption` and `lovSelect`.
 */
export const ACTION_VERBS = Object.freeze([
  'navigate', 'click', 'dblclick', 'fill', 'press', 'selectOption', 'lovSelect',
  'check', 'uncheck', 'hover', 'scroll', 'copy', 'wait', 'setInputFiles',
  'assertVisible', 'assertText', 'assertValue', 'assertChecked', 'assertSnapshot',
]);

const VERBS = new Set(ACTION_VERBS);

/**
 * Verbs that act on the page rather than on an element.
 *
 * They carry no locator AT ALL rather than an empty one: `locator: {}` reads as
 * "an element was found and every field of it was blank", which is a different
 * and much more alarming statement than "there was no element".
 */
export const LOCATORLESS_VERBS = Object.freeze(['navigate', 'wait', 'scroll']);

const LOCATORLESS = new Set(LOCATORLESS_VERBS);

/** Every key an action object may carry. */
export const ACTION_FIELDS = Object.freeze([
  'action', 'locator', 'url', 'value', 'committedValue', 'sensitive',
  'credentialRef', 'durationMs', 'key', 'checked', 'optionIndex', 'outputName',
  'files', 'snapshot', 'deltaX', 'deltaY', 'description', 'skipInReport', 'frame',
]);

const ACTION_KEYS = new Set(ACTION_FIELDS);

/**
 * Every key a locator object may carry.
 *
 * The last three are patch territory: core never derives them, a patch's
 * `resolve.meta` hook supplies them already computed. Keeping them in the same
 * allow-list is what stops a patch inventing a fourth one that then travels
 * unread forever.
 */
export const LOCATOR_FIELDS = Object.freeze([
  'selector', 'name', 'role', 'label', 'exact', 'text', 'parent',
  'id', 'attrSelector', 'title', 'placeholder', 'sourceTag',
  'componentId', 'containerRole', 'hasLovIcon',
]);

const LOCATOR_KEYS = new Set(LOCATOR_FIELDS);

/** A parent is an identity, not a second locator — two fields, no recursion. */
const PARENT_KEYS = new Set(['name', 'label']);

/** Fields that must be a real boolean, never the strings "true" / "false". */
const BOOLEAN_ACTION_FIELDS = new Set(['sensitive', 'checked', 'skipInReport']);
const BOOLEAN_LOCATOR_FIELDS = new Set(['exact', 'hasLovIcon']);

/** Fields that only make sense on one verb. */
const VERB_ONLY_FIELDS = { url: 'navigate', key: 'press', durationMs: 'wait' };

export function isActionVerb(verb) {
  return VERBS.has(verb);
}

export function isLocatorlessVerb(verb) {
  return LOCATORLESS.has(verb);
}

/**
 * A locator reduced to the schema: allow-listed keys, no empties.
 *
 * Both the content script and the compiler build locators, and a patch merges
 * fields into the result of either. Routing all three through this one function
 * is what makes the allow-list a property of the format rather than a habit.
 *
 * `_`-prefixed keys are scratch state that patches hang off an object mid-flight
 * (`_target`, `_injected`); they were reaching stored recordings, and a stored
 * DOM node reference is both meaningless and enormous.
 */
export function pruneLocator(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const key of LOCATOR_FIELDS) {
    const value = coerce(raw[key], BOOLEAN_LOCATOR_FIELDS.has(key));
    if (value === undefined) continue;
    if (key === 'parent') {
      const parent = pruneParent(value);
      if (parent) out.parent = parent;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function pruneParent(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  for (const key of PARENT_KEYS) {
    const value = coerce(raw[key], false);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Drop what carries no information, and undo the one lossy round trip we know
 * about: a value that reached storage as JSON via a DOM attribute comes back as
 * the STRING "false", which is truthy, so `if (loc.exact)` took the wrong branch.
 */
function coerce(value, isBoolean) {
  if (value === undefined || value === null || value === '') return undefined;
  if (isBoolean) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (typeof value !== 'boolean') return undefined;
  }
  return value;
}

/**
 * Everything wrong with an action, as sentences.
 *
 * Returns a list rather than throwing so a test can report all of a step's
 * problems at once; a compiler that emitted three bad fields should not need
 * three runs to find out.
 *
 * @param {Object} action
 * @param {number} [index] position in the recording, for the message
 * @returns {string[]}
 */
export function validate(action, index) {
  const at = index === undefined ? 'action' : `action ${index}`;
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    return [`${at} is not an object`];
  }

  const problems = [];
  const verb = action.action;

  if (!isActionVerb(verb)) {
    problems.push(`${at}: "${verb}" is not in the verb enum`);
  }

  for (const key of Object.keys(action)) {
    if (!ACTION_KEYS.has(key)) {
      problems.push(`${at} (${verb}): "${key}" is not an allowed action field`);
      continue;
    }
    if (BOOLEAN_ACTION_FIELDS.has(key) && typeof action[key] !== 'boolean') {
      problems.push(`${at} (${verb}): "${key}" is ${JSON.stringify(action[key])}, not a boolean`);
    }
    const onlyOn = VERB_ONLY_FIELDS[key];
    if (onlyOn && verb !== onlyOn) {
      problems.push(`${at} (${verb}): "${key}" belongs only on ${onlyOn}`);
    }
  }

  if (typeof action.skipInReport !== 'boolean') {
    problems.push(`${at} (${verb}): skipInReport must always be present as a boolean`);
  }

  if (verb === 'navigate' && !action.url) problems.push(`${at}: navigate has no url`);
  if (verb === 'wait' && typeof action.durationMs !== 'number') {
    // The old format overloaded `text` with the duration, so a wait replayed as
    // a zero-length pause and the race it existed to absorb came back.
    problems.push(`${at}: wait has no numeric durationMs`);
  }

  problems.push(...validateLocator(action, at, verb));
  problems.push(...validateFrame(action.frame, at, verb));
  return problems;
}

function validateLocator(action, at, verb) {
  const problems = [];
  const locator = action.locator;

  if (locator === undefined) {
    return problems;
  }
  if (isLocatorlessVerb(verb)) {
    problems.push(`${at}: ${verb} acts on the page and must carry no locator`);
    return problems;
  }
  if (!locator || typeof locator !== 'object' || Array.isArray(locator)) {
    problems.push(`${at} (${verb}): locator is not an object`);
    return problems;
  }
  if (Object.keys(locator).length === 0) {
    problems.push(`${at} (${verb}): locator is empty — omit it instead`);
  }

  for (const [key, value] of Object.entries(locator)) {
    if (!LOCATOR_KEYS.has(key)) {
      problems.push(`${at} (${verb}): locator."${key}" is not in the locator allow-list`);
      continue;
    }
    if (BOOLEAN_LOCATOR_FIELDS.has(key) && typeof value !== 'boolean') {
      problems.push(`${at} (${verb}): locator."${key}" is ${JSON.stringify(value)}, not a boolean`);
    }
    if (value === null || value === '') {
      problems.push(`${at} (${verb}): locator."${key}" is empty — prune it instead`);
    }
  }

  if (locator.parent !== undefined) {
    const parent = locator.parent;
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) {
      problems.push(`${at} (${verb}): locator.parent is not an object`);
    } else {
      for (const key of Object.keys(parent)) {
        if (!PARENT_KEYS.has(key)) {
          problems.push(`${at} (${verb}): locator.parent."${key}" is not name or label`);
        }
      }
    }
  }
  return problems;
}

function validateFrame(frame, at, verb) {
  if (frame === undefined) return [];
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    return [`${at} (${verb}): frame is not an object`];
  }
  return Object.keys(frame)
    .filter((key) => key !== 'url' && key !== 'name')
    .map((key) => `${at} (${verb}): frame."${key}" is not url or name`);
}

/** Every problem in a whole recording's action list. */
export function validateActions(actions) {
  if (!Array.isArray(actions)) return ['actions is not an array'];
  return actions.flatMap((action, i) => validate(action, i + 1));
}

/**
 * The stored/uploaded envelope.
 *
 * `schemaVersion` is first and mandatory: a reader that cannot tell which
 * format it is holding has to guess from the contents, and every such guess in
 * this codebase's history has eventually guessed wrong.
 */
export function makeEnvelope({ name, description, recordedAt, sourceUrl, patchId, actions }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name,
    description,
    recordedAt: recordedAt || new Date().toISOString(),
    sourceUrl,
    patchId,
    actions: actions || [],
  };
}
