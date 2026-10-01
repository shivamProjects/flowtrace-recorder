/**
 * escape.js — string escaping for generated selectors and locator expressions.
 *
 * Every escaping bug in a recorder shows up as a script that throws at parse
 * time rather than one that fails a lookup, so these are worth keeping in one
 * audited place instead of inline at each call site.
 *
 * When Playwright's injected engine lands in vendor/, its escapeForTextSelector
 * / escapeForAttributeSelector / quoteCSSAttributeValue replace the bodies here
 * and the call sites stay unchanged.
 */

/**
 * Quote a value for use inside a JS single-quoted string literal.
 * Escapes backslash first so it does not double-escape what follows.
 */
export function jsString(value) {
  if (value == null) return "''";
  return "'" + String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    + "'";
}

/**
 * Build an id selector that survives characters CSS treats as syntax.
 *
 * Oracle IDCS and ADF routinely produce ids like
 *   idcs-signin-basic-signin-form-username|input
 *   pt1:r1:0:AP1:i1::content
 * In CSS `|` is the namespace separator and `:` starts a pseudo-class, so
 * `#id-with|pipe` is a *parse error* — Playwright throws before it ever queries
 * the page. The attribute form sidesteps the whole class of problem, and reads
 * better than a string of backslashes.
 *
 * The previous implementation escaped the internal `selector` field but
 * interpolated the raw id into the emitted `locator` string, so the broken form
 * was the one that shipped to the user.
 */
export function idSelector(id) {
  // Keep the familiar `#name` form when the id is a plain CSS identifier, so
  // the common case still reads the way a human would write it. Fall back to
  // the attribute form the moment the id contains anything CSS treats as
  // syntax, which is where the old code silently produced a parse error.
  return PLAIN_IDENT.test(id) ? `#${id}` : `[id=${cssAttributeValue(id)}]`;
}

const PLAIN_IDENT = /^-?[_a-zA-Z][\w-]*$/;

/**
 * Quote an attribute value for a CSS attribute selector, choosing the quote
 * style that needs the least escaping.
 */
export function cssAttributeValue(value) {
  const s = String(value == null ? '' : value);
  if (!s.includes('"')) return `"${s.replace(/\\/g, '\\\\')}"`;
  if (!s.includes("'")) return `'${s.replace(/\\/g, '\\\\')}'`;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Build an `[attr="value"]` selector with the value correctly quoted. */
export function attributeSelector(name, value) {
  return `[${name}=${cssAttributeValue(value)}]`;
}

/**
 * Escape a class or id for use in a compound CSS selector where the identifier
 * form is genuinely wanted (e.g. `.some\.class`).
 */
export function cssIdentifier(value) {
  return typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(String(value))
    : String(value).replace(/([^\w-])/g, '\\$1');
}
