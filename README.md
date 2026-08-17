# FlowTrace Recorder

A Chrome extension that records browser interactions and generates Playwright
scripts. Application-specific behaviour lives in swappable **patches**; the core
recorder knows nothing about any particular product.

## Build

```bash
npm install
npm run build      # → dist/, which IS the unpacked extension
npm run watch      # rebuild on change
npm test           # selector + compiler tests
```

Load `dist/` via `chrome://extensions` → Load unpacked.

The build step exists because Chrome content scripts cannot use ES modules from
the manifest and an MV3 service worker with `type: module` cannot use
`importScripts`. It is also the mechanism that will pull in Playwright's
selector engine — see [vendor/playwright/README.md](vendor/playwright/README.md).

## Layout

```
public/            ships verbatim: manifest, icons, popup.html
src/
  core/            no knowledge of Oracle, IBM, or any product
    content/       runs in the page
      index.js       entry — one of two files that may import patches/
      capture.js     DOM listeners → RecordedEvent
      selector.js    element → Playwright locator   ← migration seam
      dom.js         label / role / text / visibility
      escape.js      selector and string escaping
      frames.js      which frame an interaction came from
      widget.js      the floating recording indicator
      bus.js         messaging + the recording epoch
    background/    runs in the service worker
      index.js       entry — the other file that may import patches/
      router.js      message handlers
      session.js     state and persistence
      dedup.js       capture-time noise removal
      compiler.js    events → Playwright script and replayer steps
    auth/          the extension's own sign-in, not any application's
      index.js       login (incl. MFA) / revalidate / sign out
      store.js       token + user, persisted, with the JWT's expiry
    shared/
      patch-api.js   the patch contract
      types.js       the event schema
      sensitive.js   what counts as a credential, and what replaces it
      settings.js    apiBase, the selected environment, response envelope
  patches/
    index.js       registry — add a new application with one line
    generic/       baseline; no capture hooks, so no per-page cost
    oracle/        selectors / labels / capture / postprocess
    ibm/           scaffolding
  ui/popup/
vendor/playwright/ pinned selector engine (not yet populated)
test/
```

**Dependency rule:** `core/` never imports from `patches/`. The two entry points
inject the selected patch; every core module receives it as a parameter. This is
what keeps `core/` buildable and testable on its own.

## Patches

A patch adapts the recorder to one application family. Three optional halves,
each running at a different moment:

| half | runs in | sees |
|---|---|---|
| `resolve` | the page, during selector generation | one element |
| `capture` | the page, during recording | live DOM, before it is destroyed |
| `postProcess` | the service worker, on stop | the whole event list |

`capture` exists for evidence that does not survive: an LOV popup closes and
takes its row text with it, a calendar disappears when a day is clicked, ADF
writes a normalised value into a field a second after a dialog commits.
`postProcess` exists for decisions that need hindsight.

A patch's `onClick` may return `true` to claim an interaction, meaning it has
already emitted something better than a generic click. Every call from core into
a patch is wrapped: a patch that throws degrades the recording rather than
stopping it.

To add an application: create `src/patches/<id>/index.js`, add one line to the
registry, and add an `<option>` to `public/popup.html`. Nothing in `core/`
changes. See `src/core/shared/patch-api.js` for the full contract.

## Recording epochs

Patches schedule delayed work — ADF's committed value is only readable 500-1500ms
after a dialog closes. Those callbacks can land after Stop, and if a second
recording has begun by then they would contaminate it. Every send carries the
epoch it was created under and is dropped if the epoch has moved on. Delayed
patch work should capture `ctx.guard()` and check it before acting.

## Tests

`test/selector.characterization.test.js` compares the generator against the
pre-restructure monolith (read from `../recorder.backup-pre-restructure/`). The
rule it enforces is not "produces X" but:

1. it agrees with the monolith, **except** where the monolith emitted something
   that could not find its own element, and
2. everything it emits does find its element.

That framing means the test needs no hand-maintained list of expected
differences — a difference is legitimate exactly when the old output was broken,
and the test checks that rather than taking our word for it.

jsdom rather than happy-dom: happy-dom's attribute-selector engine silently
fails on apostrophes and CSS escape sequences, which are the cases under test.

## Behaviour changes in the restructure

Three fixes, all for output that could not work:

1. **Id escaping.** `#idcs-…-username|input` is a CSS parse error (`|` is the
   namespace separator), so Playwright threw before querying the page — the two
   login lines of every Fusion recording were dead. The old code escaped the
   internal `selector` field and shipped the raw one in `locator`. Ids that are
   plain identifiers still emit `#name`; anything else uses `[id="…"]`.

2. **Inferred roles.** Priority 7 emitted `selector: [role="link"]` for an
   `<a href>` that had no `role` attribute — matching nothing. The locator was
   fine, but `selector` is the dedup and debounce key. It now falls back to a
   CSS selector that resolves when the role was inferred rather than written.

3. **Shadow DOM.** `isExtensionElement` returned true for any node inside any
   shadow root, so every interaction with a page's own web components was
   silently discarded. It now tests for our widget host specifically.

Two structural changes with behavioural consequences:

- Oracle capture only runs under the Oracle patch. Previously all the ADF DOM
  walking ran on every site regardless of selection; only the choice-list branch
  was gated.
- Patch state is scoped to a recording and cleared on stop. `openerBindings` in
  particular used to live on `window`, so a second recording in the same tab
  inherited the first one's data.

Events now carry `frameUrl` / `isTopFrame` / `frameName`, and steps carry a
`frame` object for non-top-frame interactions. The compiler does not use them
yet — but a recording captured today must not need re-recording when
`frameLocator` support lands.

## Passwords

A recording travels over the network to the customer's FlowTrace instance and
is stored and read there, so a password inside one leaks with every copy of it.

Detection is in `core/shared/sensitive.js` and uses the platform's own rules —
`input[type="password"]` and `autocomplete="current-password"` / `"new-password"`
— which is why it needs no help from a patch: component libraries render a real
password input underneath (Oracle JET's `oj-input-password` does). A patch can
mark an extra field through `resolve.meta` returning `{ sensitive: true }`; that
path is additive and cannot switch masking off.

The field is masked, not dropped. Replay still needs to know something is typed
there, so the fill is emitted with `value: '********'`, `sensitive: true` and
`credentialRef: 'password'`, and the replayer substitutes a real credential from
its own configuration. The real value is never assigned into the event at all —
`capture.js` passes the mask instead of reading `target.value` — and the mask is
re-asserted after `postProcess`, because a patch that substitutes an
application-committed value has no way of knowing the field was a password.

## Authentication

The extension ships to customers, so it authenticates against the platform
(`platform-api`, Spring) and refuses to work without a valid token. `apiBase`
(default `http://localhost:8080`) says where that backend is.

Every platform response is an `ApiResponse { success, message, data, error,
timestamp }` envelope; the payload is always `.data`. Failures are not
consistent about which field holds the prose — the exception handler puts the
sentence in `error` and "ERROR" in `message`, the access-denied handler does the
reverse — so `apiErrorMessage()` in `shared/settings.js` prefers whichever field
is not a machine code.

Sign-in is **two steps when the account has MFA**:

```
POST /api/auth/login      { username, password }  -> LoginResponse
POST /api/auth/verify-mfa { mfaToken, code }      -> LoginResponse
GET  /api/auth/me                                 -> UserInfo
```

`username`, not `email` — `LoginRequest` is `(username, password)` with
`@NotBlank` on both, and the two are different columns on `app_users`. When
`mfaRequired` is true the first response carries a **null** token and a null
user; only `verify-mfa` mints a usable one. The intermediate `mfaToken` is held
in worker memory and never persisted or handed to the popup, because it plus a
code is enough to become the user.

The gate is in the service worker, in `START_RECORDING`. A gate in the popup
would be worthless: the popup is an ordinary page, and anyone can open the
worker's console and post the message directly. `test/auth.test.js` drives the
router that way on purpose.

## Environments

The platform files every recording under an environment and rejects one that
arrives without an `environmentId`. So the environment is a precondition, not a
preference: the popup populates a picker from `GET /api/environments`, stores
the choice in `chrome.storage.local`, and `START_RECORDING` **refuses without
one** — enforced in the worker, alongside the auth gate, for the same reason.

The check is at Start rather than at Save deliberately. Refusing at Start costs
a click; refusing at Save costs the whole recording, which can only be re-made
by redoing the work by hand.

Note that the popup now has two selectors that used to be one. "Application" is
the patch — how a page is recorded. "Environment" is the platform environment —
where the recording is filed. They are unrelated.

## Upload

```
POST /api/oracle/recordings   roles MEMBER | ADMIN | SUPER_ADMIN
  { environmentId, stepsJson, name?, description? }
```

Not `/api/recordings`, which does not exist. `stepsJson` is a pre-serialised
JSON **string**: `RecordingService` takes the payload as a `Map<String, Object>`
and calls `.toString()` on this key, so posting a real JSON array persists
Java's `[{action=click}]` — unparseable, and silently, behind a 200. The upload
sends `JSON.stringify(session.actions)` and never inspects an individual action.

A 403 here is a role problem, not an expiry — `VIEWER` can list but not save —
so it does not sign anyone out. Only a 401 does.

The popup revalidates through `GET /api/auth/me` every time it opens, which is
what makes deactivating a customer take effect inside a session rather than
seven days later when the JWT lapses. A network failure does **not** sign anyone
out — the extension runs on customer VPNs that drop connections routinely, and
losing a recording to a timeout is worse than a few minutes of stale
authorisation. Only an explicit 401 or 403 clears the token.

The token never reaches the popup. Sign-in, storage and every authenticated
request live in the worker; the popup posts credentials and asks what to draw.

## Not done yet

- Playwright's selector engine (see `vendor/playwright/README.md`) — this is the
  change that matters most for replay stability on ADF.
- `frameLocator` emission in the compiler.
