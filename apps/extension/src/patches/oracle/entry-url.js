/**
 * entry-url.js — recover an application URL from an Oracle IDCS authorize URL.
 *
 * INTENTIONALLY UNUSED. Nothing imports this file, and nothing should until a
 * decision is made about where it belongs.
 *
 * It survives because the problem it solves is real and the solution took some
 * finding: when a recording starts on a Fusion page that is not yet
 * authenticated, IDCS redirects to
 * `/oauth2/v1/authorize?…state=…&nonce=…&enc=…`, and those three parameters are
 * minted per attempt and rejected on reuse. A recording whose first navigation
 * is that URL cannot replay — ever. The application's own URL is already inside
 * the authorize URL, so it can be recovered rather than asked for.
 *
 * What it is NOT is the recorder's business. The recorder records what
 * happened, including the redirect; deciding to substitute one URL for another
 * is an edit to the recording, and edits belong to the application that
 * receives it. So this is kept as a function, not wired into a patch, ready to
 * move downstream when that consumer exists.
 *
 * The selector constants it needs are inlined rather than imported from
 * selectors.js, because selectors.js describes markup the recorder actually
 * matches against and this file must not add entries there for code that no
 * running path uses.
 */

/**
 * The OAuth authorize endpoint — the URL that can never be replayed.
 */
const IDCS_AUTHORIZE_URL = /\/oauth2\/v1\/authorize\b|\/ui\/v1\/signin\b/i;

/**
 * Authorize-URL parameters that name the application being protected, best
 * first. IDCS puts the app's own entry URL into the request it built.
 * `redirect_uri` is handled separately below because it points at the OAuth
 * callback rather than at anything a person would navigate to.
 */
const IDCS_APP_URL_PARAMS = ['idcs_app_resource_url', 'app_resource_url'];
const IDCS_APP_HOST_PARAM = 'X-HOST-IDENTIFIER-NAME';
const IDCS_REDIRECT_PARAM = 'redirect_uri';

/**
 * Recover the application URL that a redirect to IDCS came from.
 * @param {string} rawUrl
 * @returns {?string} null when this is not an authorize URL, or when it carries
 *   nothing identifying the application — inventing one would be worse than
 *   leaving the recording honestly broken.
 */
export function applicationEntryUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    return null;
  }
  if (!IDCS_AUTHORIZE_URL.test(url.pathname)) return null;

  for (const param of IDCS_APP_URL_PARAMS) {
    const value = url.searchParams.get(param);
    if (value && /^https?:\/\//i.test(value)) return value;
  }

  // A host identifier names the application's own host, so the scheme and a
  // root path have to be assumed. That is safe: Fusion is served over TLS and
  // its root redirects to the welcome page.
  const host = url.searchParams.get(IDCS_APP_HOST_PARAM);
  if (host && /^[\w.-]+$/.test(host) && host.includes('.')) return `https://${host}/`;

  // The OAuth callback path is machinery, not a page — only its origin is a
  // place a person or a replay could start from.
  const redirect = url.searchParams.get(IDCS_REDIRECT_PARAM);
  if (redirect && /^https?:\/\//i.test(redirect)) {
    try {
      return `${new URL(redirect).origin}/`;
    } catch {
      return null;
    }
  }
  return null;
}
