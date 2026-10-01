const RULES = require('../config/oracle-required-fields.json');

// Build Sets once at startup for O(1) lookups
const REQUIRED_SET = new Set(RULES.possibleRequiredFields);
const OPTIONAL_SET = new Set(RULES.optionalFields);

// Generic labels that are too broad for contains matching.
// These only match on EXACT — prevents "Reference Number" matching "number" as required.
const GENERIC_EXACT_ONLY = new Set([
  'name', 'number', 'date', 'type', 'amount', 'status',
  'description', 'code', 'id', 'value', 'title', 'source',
  'category', 'account', 'item', 'action', 'reason',
  'email', 'phone', 'location', 'department', 'organization',
  'currency', 'quantity', 'price', 'unit', 'set', 'plan',
  'option', 'resource', 'operation', 'project', 'bank',
  'position', 'job', 'grade', 'country', 'state', 'city'
]);

/**
 * Canonical field-name normalizer — used by:
 *  - live DOM required scan (browser-side mirror)
 *  - selector-derived field names (post-processing)
 *  - classifier input (this module)
 * Keep this in sync with the browser-side __flowtraceNormalize mirror.
 */
function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^\*{1,2}\s*/, '')   // leading star markers
    .replace(/[_]+/g, ' ')       // underscores → spaces
    .replace(/[:*]+/g, '')       // trailing colons and stray stars
    .replace(/\s+/g, ' ')       // collapse whitespace
    .trim();
}

function resolveAlias(normalized) {
  return RULES.aliases[normalized] || normalized;
}

/**
 * Classify an Oracle field label.
 *
 * Priority: optional exact → required exact → optional contains → required contains → unknown
 * Generic single-word labels (name, number, date, etc.) skip contains matching entirely.
 *
 * @param {string} label
 * @returns {{ classification: string, required: boolean|undefined, requiredCandidate: boolean, requiredSource: string }}
 */
function classifyOracleField(label) {
  const normalized = normalizeText(label);
  const canonical = resolveAlias(normalized);

  if (!canonical) {
    return { classification: 'unknown', requiredCandidate: true, requiredSource: 'unknown-empty' };
  }

  // 1. Optional exact match (check first to prevent false positives)
  if (OPTIONAL_SET.has(canonical)) {
    return { classification: 'optional', required: false, requiredCandidate: false, requiredSource: 'optional-exact' };
  }

  // 2. Required exact match
  if (REQUIRED_SET.has(canonical)) {
    return { classification: 'required', required: true, requiredCandidate: false, requiredSource: 'required-exact' };
  }

  // 3. For generic labels, stop here — no contains matching
  if (GENERIC_EXACT_ONLY.has(canonical)) {
    return { classification: 'unknown', requiredCandidate: true, requiredSource: 'unknown-generic' };
  }

  // 4. Contains matching for multi-word/compound labels only
  // Check optional contains first
  for (const opt of OPTIONAL_SET) {
    if (opt.length > 4 && canonical.includes(opt)) {
      return { classification: 'optional', required: false, requiredCandidate: false, requiredSource: 'optional-contains' };
    }
  }

  // Check required contains
  for (const req of REQUIRED_SET) {
    if (req.length > 4 && canonical.includes(req)) {
      return { classification: 'required', required: true, requiredCandidate: false, requiredSource: 'required-contains' };
    }
  }

  // 5. Unknown — flag for review
  return { classification: 'unknown', requiredCandidate: true, requiredSource: 'unknown-candidate' };
}

module.exports = { classifyOracleField, normalizeText, resolveAlias, RULES, GENERIC_EXACT_ONLY };

