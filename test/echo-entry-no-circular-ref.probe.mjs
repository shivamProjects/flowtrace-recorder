/**
 * echo-entry-no-circular-ref.probe.mjs — the echo-retention entry armed in
 * _performAction must never carry a reference back to the `action` object,
 * or the action becomes circular and crashes the FIRST time anything tries
 * to JSON.stringify it.
 *
 * WHY THIS EXISTS
 * The entry-arming change (moving __sfRec.push to _performAction entry, so
 * the retention window covers the replay round trip too, not just the time
 * after release) stamped a back-reference onto the action so __sfRelease
 * could update the SAME entry later:
 *
 *   var __sfEchoEntry = { el: action.__sfEchoEl, ..., action: action };
 *   action.__sfRecentEntry = __sfEchoEntry;
 *
 * That is a literal two-node cycle: __sfEchoEntry.action -> action,
 * action.__sfRecentEntry -> __sfEchoEntry. Live error, first real recording
 * after the change shipped:
 *
 *   Uncaught (in promise) TypeError: Converting circular structure to JSON
 *     --> starting at object with constructor 'Object'
 *     | property 'action' -> object with constructor 'Object'
 *     --- property '__sfRecentEntry' closes the circle
 *   at background.js:110296
 *
 * The back-reference was never necessary. __sfEchoEntry is declared with
 * `var` inside _performAction, and __sfRelease -- the nested arrow function
 * that needs to update it at release time -- is defined later in the SAME
 * function body, so __sfEchoEntry is already reachable through the closure.
 * Stamping it onto `action` only existed to hand the same object back in
 * through `action`, which is exactly what made it circular.
 *
 * THE FIX: drop the `action: action` field and `action.__sfRecentEntry`
 * entirely; __sfRelease reads the closure variable __sfEchoEntry directly.
 * Declared `= null` once above the arming branch so a release when no entry
 * was armed (action.__sfEchoEl falsy) still sees a defined variable, not a
 * ReferenceError.
 *
 * Run: node recorder/test/echo-entry-no-circular-ref.probe.mjs
 */

import { readFileSync } from 'node:fs';

const BG = 'D:/Freelance/FirstCron/syntra-recorder/syntra-flow-recorder/background.js';
const src = readFileSync(BG, 'utf8');

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
};

console.log('\necho-entry-no-circular-ref.probe.mjs');
console.log('  the echo entry must not point back at the action it is attached to\n');

// ── decode the injected page script out of the bundle literal ──────────────
const MARK = "const source$2 = '";
const start = src.indexOf(MARK);
check('found the source$2 literal', start !== -1);
const litStart = start + MARK.length;
let j = litStart;
while (j < src.length) {
  if (src[j] === '\\') { j += 2; continue; }
  if (src[j] === "'") break;
  j++;
}
const literal = src.slice(litStart, j);
const decoded = eval("'" + literal + "'");

// round-trip sanity — every probe that decodes this literal depends on it.
const reenc = (x) => x
  .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  .replace(/\n/g, '\\n').replace(/\r/g, '\\r');
check('the literal round-trips byte-identical (decode/encode sanity)',
  reenc(decoded) === literal,
  'if this fails, other probes decoding this literal are reading corrupted content');

// ── slice _performAction ────────────────────────────────────────────────────
const fnStart = decoded.indexOf('_performAction(action) {');
check('found _performAction', fnStart !== -1);
let depth = 0, fnEnd = -1;
for (let p = decoded.indexOf('{', fnStart); p < decoded.length; p++) {
  if (decoded[p] === '{') depth++;
  else if (decoded[p] === '}') { depth--; if (depth === 0) { fnEnd = p + 1; break; } }
}
const fn = decoded.slice(fnStart, fnEnd);

// ── THE FIX: no back-reference either direction ─────────────────────────────
check('THE FIX: the entry no longer carries a reference to `action`',
  !/action:\s*action\s*[,}]/.test(fn),
  'an `action: action` field inside the entry object recreates the cycle');
check('THE FIX: `action` no longer carries a reference to the entry',
  !/action\.__sfRecentEntry/.test(fn),
  '__sfRecentEntry was the OTHER half of the cycle — both must be gone');
check('__sfEchoEntry is declared before the arming branch (defined even when skipped)',
  /var __sfEchoEntry = null;/.test(fn),
  'without this, a release when no entry was armed reads an undeclared variable');
check('the arming branch still pushes an entry with el/at/until',
  /var __sfEchoEntry = \{ el: action\.__sfEchoEl, at: __sfNow, until: __sfNow \+ 8e3 \+ __SF_ECHO_RETAIN_MS \};/.test(fn));
check('__sfRelease updates the entry via the closure variable, not via `action`',
  /if \(__sfEchoEntry\) \{\s*__sfEchoEntry\.at = __sfNow;\s*__sfEchoEntry\.until = __sfNow \+ __SF_ECHO_RETAIN_MS;/.test(fn),
  'this is what makes the entry-arming fix (round trip + post-release window) still work without the cycle');

// ── behavioural proof: build the object the OLD code produced and show it
// really was circular; build what the NEW code produces and show it is not ──
function oldShape() {
  const action = { name: 'click', selector: '#foo', __sfEchoEl: {} };
  const entry = { el: action.__sfEchoEl, at: 1, until: 2, action };
  action.__sfRecentEntry = entry;
  return action;
}
function newShape() {
  const action = { name: 'click', selector: '#foo', __sfEchoEl: {} };
  const entry = { el: action.__sfEchoEl, at: 1, until: 2 };
  // __sfEchoEntry stays a local variable in the real code — nothing is
  // attached back onto `action`.
  void entry;
  return action;
}

let oldThrew = false;
try { JSON.stringify(oldShape()); } catch (e) { oldThrew = /circular/i.test(e.message); }
check('REGRESSION GUARD: the OLD shape really does throw on JSON.stringify',
  oldThrew,
  'if this fails, the bug scenario itself has drifted from the real crash');

let newThrew = false;
try { JSON.stringify(newShape()); } catch (e) { newThrew = true; }
check('THE FIX: the NEW shape serializes cleanly',
  !newThrew,
  'an action built by the fixed code must survive JSON.stringify anywhere it is logged or sent to the recorder panel');

// ── mutation check ──────────────────────────────────────────────────────────
{
  const mutated = fn
    .replace('var __sfEchoEntry = { el: action.__sfEchoEl, at: __sfNow, until: __sfNow + 8e3 + __SF_ECHO_RETAIN_MS };',
      'var __sfEchoEntry = { el: action.__sfEchoEl, at: __sfNow, until: __sfNow + 8e3 + __SF_ECHO_RETAIN_MS, action: action }; action.__sfRecentEntry = __sfEchoEntry;');
  check('mutation reintroduced the circular back-reference', mutated !== fn);
  const mutatedHasCycle = /action:\s*action\s*[,}]/.test(mutated) && /action\.__sfRecentEntry/.test(mutated);
  check('MUTATION CHECK: the cycle is detected',
    mutatedHasCycle,
    'the presence assertions above would not catch a regression');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
