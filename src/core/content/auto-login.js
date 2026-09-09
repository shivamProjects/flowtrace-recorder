/**
 * auto-login.js — Enterprise SSO & Oracle IDCS automated login injection.
 *
 * Used when running automated replay or during test credential provisioning.
 * Handles React/Vue/JET controlled inputs by invoking native property setters
 * and dispatching synthetic input/blur/keyup events.
 *
 * IMPORTANT: This module must never be called while a recording session is active.
 * The synthetic `input` events it dispatches are deliberately not filtered on
 * `isTrusted` (see capture.js) — firing during recording would push plaintext
 * credentials onto the recorder bus. The message handler in index.js enforces
 * this guard; do not invoke autoFillLogin from any other call site without the
 * same check.
 */

/** Set input value piercing framework-controlled property wrappers (React/Vue/JET). */
export function setNativeValue(element, value) {
  if (!element) return;
  const proto = Object.getPrototypeOf(element);
  // Use the element's own realm (ownerDocument.defaultView) rather than the
  // top-frame `window`. If the login form lives inside a same-origin iframe the
  // element belongs to the iframe's realm; calling the top-frame setter on it
  // throws TypeError: Illegal invocation in Chrome.
  const realm = (element.ownerDocument && element.ownerDocument.defaultView) || window;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
    || Object.getOwnPropertyDescriptor(realm.HTMLInputElement.prototype, 'value');

  if (descriptor && descriptor.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Search for login inputs by heuristics (name, id, type, autocomplete). */
export function findLoginField(type = 'username', extraCandidates = []) {
  const isPass = type === 'password';
  if (isPass) {
    const pass = document.querySelector('input[type="password"]');
    if (pass) return pass;
  }

  const names = isPass
    ? ['password', 'os_password', 'passwd', 'pwd', 'signin-form-password', 'idcs-signin-basic-signin-form-password', 'Pass', ...extraCandidates]
    : ['username', 'userid', 'user_id', 'email', 'os_username', 'userName', 'signin-form-username', 'idcs-signin-basic-signin-form-username', 'User', ...extraCandidates];

  for (const name of names) {
    const el = document.querySelector(`input[name="${name}" i], input[id="${name}" i], input[id*="${name}" i], input[autocomplete="${name}" i]`);
    if (el) return el;
  }

  return isPass
    ? document.querySelector('input[type="password"]')
    : document.querySelector('input[type="text"], input[type="email"]');
}

/** Find the sign-in / submit button on enterprise login portals. */
export function findSignInButton() {
  const btn = document.querySelector('#btnActive, #idcs-signin-basic-signin-form-submit, button[type="submit"], input[type="submit"], button[id*="signin" i], button[id*="submit" i], [role="button"][id*="submit" i]');
  if (btn) return btn;

  for (const b of document.querySelectorAll('button, [role="button"], input[type="button"]')) {
    const text = (b.textContent || b.value || '').toLowerCase().trim();
    if (/sign in|log in|login|submit|continue/i.test(text)) return b;
  }
  return null;
}

/** Auto-fill login credentials and optionally trigger submit. */
export async function autoFillLogin(username, password, { submit = true } = {}) {
  let userField = null;
  let passField = null;
  let submitBtn = null;

  for (let attempt = 0; attempt < 10; attempt++) {
    userField = findLoginField('username');
    passField = findLoginField('password');
    submitBtn = findSignInButton();
    if (userField && passField) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (userField && username) {
    userField.focus();
    setNativeValue(userField, username);
    userField.dispatchEvent(new Event('change', { bubbles: true }));
    userField.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  if (passField && password) {
    passField.focus();
    setNativeValue(passField, password);
    passField.dispatchEvent(new Event('change', { bubbles: true }));
    passField.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  if (submit && submitBtn) {
    await new Promise((r) => setTimeout(r, 200));
    submitBtn.click();
  }

  return { success: !!(userField && passField) };
}
