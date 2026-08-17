# vendor/playwright

## Status: extracted and proven to run standalone. Not yet wired in.

`injected-script.js` is Playwright's injected script, extracted verbatim from
the pinned `playwright-core` and committed. `VERSION` records which release it
came from — the two are only ever regenerated together, by `npm run vendor`.

```
injected-script.js   309 KB   generated — do not edit
VERSION              the playwright-core release it was taken from
```

`test/injected-engine.test.js` instantiates it under jsdom and generates a
selector for every fixture in `test/fixtures.js`. It needs no CDP session, no
browser process and no `chrome.debugger` — which was the open question, and is
now closed.

`src/core/content/selector.js` is **unchanged**. Nothing calls the engine yet;
`dist/selector-engine.js` is emitted but not referenced. Swapping the ladder for
the engine is a separate change, deliberately kept separate so the extraction
can be reviewed on its own.

## What landed here

`generateSelector` and its dependencies from Playwright's injected script. As of
1.62 this code lives in its own package — the shipped bundle carries the marker
`// packages/injected/src/selectorGenerator.ts` — which makes it far more
vendorable than when it was buried inside `playwright-core/src/server/injected/`.

## Why it can be taken without taking `chrome.debugger` with it

The injected script is evaluated **in the page** and needs no CDP session. It is
present as a source string inside `playwright-core/lib/coreBundle.js` and
exposes `generateSelectorSimple(element)` and `asLocator(language, selector)` as
ordinary in-page calls. That is the whole reason this approach is possible: the
part of Playwright worth having is independent of the transport that makes
recording slow on heavy applications.

## How it is taken

`scripts/vendor-injected.mjs`, run by `npm run vendor`.

`playwright-core` is pinned to an exact version — `"1.62.1"`, not `"^1.62.1"` —
because the extractor reads a minified third-party bundle and a caret would let
npm silently move the ground under it.

The injected script sits inside `playwright-core/lib/coreBundle.js` as an
escaped single-quoted string literal (playwright-core's own job is to hand that
string to a browser and eval it). The extractor finds every `sourceN = '…'`
literal, walks each one respecting backslash escapes — a naive `indexOf("'")`
truncates the engine a tenth of the way in at the first `\'` — decodes it, and
keeps the one containing `generateSelectorSimple`, `InjectedScript` and
`asLocator`. Identifying it by content rather than by pinning `source4` means a
reordered bundle is a non-event; a *renamed* one still fails loudly.

Then it asserts, and exits non-zero on any violation:

- exactly one candidate matches, not zero and not several
- the result contains `generateSelectorSimple`
- it is over 200 KB
- it assigns to `module.exports`

That noise is the point. The marker-based approach will break on some future
Playwright release, and silently vendoring a fragment — every selector the
recorder emits quietly getting worse, with a green build — is a far more
expensive failure than a red one.

Do **not** hand-copy functions. The selector generator is coupled to
`roleUtils`, `elementText` and the CSS tokenizer, and a hand-maintained copy
will drift within two releases.

## How it is instantiated

Purely in the page. There is no CDP involved:

```js
const module = { exports: {} };
/* vendored source */
const Ctor = module.exports.InjectedScript();   // called twice — see below
const injected = new Ctor(globalThis, {
  isUnderTest: false, sdkLanguage: 'javascript', frameSeq: 0,
  testIdAttributeName: 'data-testid', stableRafCount: 1,
  browserName: 'chromium', shouldPrependErrorPrefix: false,
  isUtilityWorld: false, customEngines: [],
});
```

`module.exports.InjectedScript` is a lazy getter produced by esbuild's
`__toCommonJS`; reading it yields a thunk, and calling the thunk yields the
class. Two consequences worth knowing before they cost an hour: the literal
string `InjectedScript` does not appear as a property assignment anywhere in the
artifact, and the bootstrap cannot name its own local binding `InjectedScript`
because the bundle already declares a class by that name in the same scope.

Useful surface:

| call | gives |
|---|---|
| `injected.generateSelectorSimple(el)` | `internal:role=textbox[name="Amount"i]` |
| `injected.utils.asLocator('javascript', sel)` | `getByRole('textbox', { name: 'Amount' })` |
| `injected.parseSelector(sel)` + `injected.querySelectorAll(parsed, doc)` | resolve it again |

Playwright's selectors are not CSS, so `document.querySelectorAll` cannot verify
them. The engine's own query implementation is the round trip.

## How it ships

`dist/selector-engine.js`, ~159 KB minified, emitted by `build.mjs` as a bundle
**separate from `content.js`** and deliberately absent from the manifest's
`content_scripts`. At that size, declaring it would parse and run it in every
frame of every page the user visits, recording or not. It is injected on demand
when recording starts, and exposes the instance as
`window.__flowtracePwInjected`, guarding against double injection.

## What it needs that jsdom lacks

Exactly one thing: `CSS.escape`, already polyfilled in `test/setup.js` for the
existing selector tests.

`getComputedStyle(el, '::before')` is also called; jsdom logs
`Not implemented: Window's getComputedStyle() method: with pseudo-elements` to
stderr but returns an empty style rather than throwing, so text extraction
degrades to ignoring pseudo-element content. Chrome implements it, so this is a
test-environment artefact only. Nothing else was missing — no `elementFromPoint`,
no layout, no `IntersectionObserver` on the `generateSelectorSimple` path.

## What changes when it arrives

`src/core/content/selector.js` is the only file that needs to change. Everything
else calls `generateSelector(el, opts)` and nothing else.

Two properties the current implementation lacks, in the order they matter:

1. **Verify before accepting.** Playwright builds every candidate with a score,
   sorts, then queries the DOM and takes the first that resolves uniquely to the
   target. The current ladder returns on first match and never checks, so
   ambiguous locators ship silently.

2. **The score table is the opposite way round from ours.** Lower is better:

   | | | | |
   |---|---|---|---|
   | testId | 1 | role+name | 100 |
   | other testId | 2 | placeholder | 120 |
   | iframe by attribute | 10 | label | 140 |
   | | | text | 180 |
   | **CSS id** | **500** | role without name | 510 |
   | input type/name | 520 | tag name | 530 |
   | nth | 10000 | CSS fallback | 1e7 |

   A CSS id scores 500 — worse than a label at 140 — and ids failing
   `isGuidLike` are rejected outright. Our ladder ranks `#id` first. On ADF,
   where ids look like `pt1:r1:0:AP1:i1:r2:0:it10::content`, our first choice is
   Playwright's last resort.

### Measured, fixture by fixture

Both generators run against `test/fixtures.js` on 1.62.1. `—` means they agree.

| fixture | ours | Playwright |
|---|---|---|
| id with a CSS namespace separator | `locator('[id="idcs-…-username\|input"]')` | — |
| plain author-written id | `locator('#submit-order')` | `getByRole('button', { name: 'Place order' })` |
| numeric id rejected as unstable | `getByText("Totals", { exact: true })` | `getByText('Totals')` |
| data-testid | `locator('[data-testid="checkout"]')` | `getByTestId('checkout')` |
| name attribute | `locator('[name="quantity"]')` | `getByRole('textbox')` |
| anchor name is not identity | `getByRole('link', { name: 'Back to top' })` | — |
| aria-label | `getByLabel('Close dialog')` | `getByRole('button', { name: 'Close dialog' })` |
| label[for] association | `locator('#email')` | `getByRole('textbox', { name: 'Email address' })` |
| placeholder only | `getByPlaceholder('Search invoices')` | `getByRole('textbox', { name: 'Search invoices' })` |
| role plus visible text | `getByRole('link', { name: 'Create Transaction' })` | — |
| unique visible text | `getByText("Outstanding balance", { exact: true })` | `getByText('Outstanding balance')` |
| utility-class soup | `locator('span:nth-of-type(1)')` | `getByText('A')` |
| svg path, one meaningful class | `locator('path.svg-outline')` | `locator('path')` |
| repeated svg paths | `locator('path.svg-outline:nth-of-type(4)')` | `locator('path').nth(3)` |
| quote inside an aria-label | `getByLabel('Delete O\'Brien\'s row')` | `getByRole('button', { name: 'Delete O\'Brien\'s row' })` |
| backslash inside a name | `locator('[name="DOMAIN\\\\user"]')` | `getByRole('textbox')` |
| **ADF** generated name on a text input | `locator('[name="pt1:_FOr1:1:…:inputText2"]')` | `getByRole('textbox')` |
| **ADF** label[for] with `::content` | `getByLabel('Transaction Number')` | `getByRole('textbox')` |
| **ADF** row/first-cell label | `locator('[id="bu::content"]')` | — |
| **ADF** container label | `locator('[id="ship::content"]')` | — |
| **ADF** required marker stripped | `locator('#amt')` | `getByRole('textbox', { name: '** Amount' })` |

Reading it:

- **The id preference inverts exactly as predicted.** Every fixture where we
  lead with `#id` or `[id="…"]`, Playwright reaches past it for the accessible
  name — `#submit-order` → `getByRole('button', { name: 'Place order' })`,
  `#amt` → `getByRole('textbox', { name: '** Amount' })`, `#email` →
  `getByRole('textbox', { name: 'Email address' })`. The ADF ids
  (`pt1:_FOr1:1:…`) are rejected outright by `isGuidLike`.

- **Where it keeps the id, it is because nothing better exists.** The two
  agreeing ADF cases — `bu::content`, `ship::content` — have labels ADF
  associates by table layout or container nesting, which is not an association
  any spec-compliant engine can see. Playwright falls back to the id (500) over
  a bare `role=textbox` (510) and lands on our answer by a different route.
  **This is the gap the Oracle patch's `resolveAdfLabel` fills and Playwright
  cannot**, and it is the reason the patch layer survives the migration: the
  engine replaces the ladder, not the ADF label knowledge.

- **The ADF `::content` case is the one regression to watch.** We emit
  `getByLabel('Transaction Number')`; Playwright emits a bare
  `getByRole('textbox')`, unique in the fixture but not on a real page. It sees
  `label[for="pt1:r1:0:it10"]` pointing at an id that is not the input's
  (`pt1:r1:0:it10::content`), so there is no accessible name. Feeding the
  patch-resolved label to the engine — rather than letting it derive one — is
  the integration problem the wiring step has to solve.

- **Two of ours are wrong in ways Playwright is not.** `[name="quantity"]` and
  `[name="DOMAIN\\user"]` are shape-of-the-DOM selectors that survive nothing;
  `span:nth-of-type(1)` for the utility-class fixture is positional where
  `getByText('A')` is semantic.

Also worth taking, roughly in order of value: the interactive-ancestor retarget
(already ported as `retargetToInteractive` in `core/content/dom.js` but not yet
wired into selector generation), parent recursion with the allowText /
disallowText token cache, `getAriaRole` + `getElementAccessibleName` from
`roleUtils`, and `suitableTextAlternatives` — which solves ADF's concatenated
LOV row text at record time rather than at replay time.

## Acceptance

`test/selector.characterization.test.js` asserts that the generator agrees with
the pre-restructure monolith except where the monolith emitted something that
could not find its own element. When the engine lands, that test will start
failing on the priority-order fixtures — which is the point. Convert it then
into pinned expectations and delete the legacy harness.
