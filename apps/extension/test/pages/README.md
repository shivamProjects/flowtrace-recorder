# Fixture pages

Markup the recorder and replayer are tested against. Both sides use these — the
replayer via `checks/run.mjs`, the recorder via `recorder/test/capture-harness.js`
— so a fixture captured once serves both.

## The rule: capture, do not write

**A fixture written from an assumption tests the assumption.**

This is not a style preference; it cost two wrong diagnoses. The Redwood Business
Unit rows were modelled as `li[role=row] > div[role=gridcell]`, inferred from ids
seen in recordings. The real widget is a bare `<td>` with no ARIA role at all.
Every probe against the invented fixture reported "capture works" while the live
widget kept failing, and the wrong layer was blamed twice before anyone opened
the real DOM.

So: **get the markup out of a live page**, paste it verbatim, and say at the top
of the file where it came from and when. Do not tidy it. Oracle's class names,
nesting and generated ids are the entire point — that is what the code has to
survive.

## Working order

1. **Against the dump first.** Run the harness against the captured file until
   the behaviour is right. This is fast, deterministic, needs no credentials,
   and cannot be broken by the tenant being slow or blocked.
2. **Live only to confirm, or to capture something new.** Driving a real pod for
   every hypothesis is slow and fails for reasons unrelated to the code — Akamai
   blocks headless Chrome on the `oraclepdemos.com` demo pods outright, so a
   headless probe there returns "Access Denied" no matter what the code does.

A live run is for *obtaining* a dump or *validating* a finished fix. It is not
the debugging loop.

## What is here

**Verbatim captures** — real Oracle DOM, safe to reason from:

| file | what it is |
|---|---|
| `checkbox.html` | Create Supplier › Address › Address Purpose (ADF). Three checkboxes in one cell, plus a single-checkbox cell and a defaulted-on box. |
| `oracle-test.html` | A full ADF form, the largest capture here. |
| `redwood-picker.html` | Redwood LOV list, captured with the dropdown OPEN. |
| `redwood-table-picker.html` | Business Unit picker — the `oj-table` shape (`<td>`, no role). |
| `ambiguous.html` | Two controls sharing a label, as Oracle really renders them. |

**Synthetic** — hand-built for a specific mechanic, not claiming to be Oracle:
`accept`, `adf`, `audit`, `confirm`, `csp`, `fallback`, `fields`, `frame*`,
`login`, `lov`, `lov-title`, `reject*`, `rows`, `slow`.

These are legitimate: they pin behaviour that has nothing to do with Oracle's
exact markup (frame handling, CSP, a slow page). Keep them small and obvious.

> ⚠️ **`redwood-ids.html` is the cautionary case.** Its *ids* are real — copied
> from recordings 1629 and 1631 — but its *structure* (`li[role=row] >
> div[role=gridcell]`) is invented and does not match the real widget. It is
> still useful for what it actually tests (id-shape handling), but do not treat
> its nesting as evidence of anything.

## Growing the corpus

`recorder/test/oracle-capture-corpus.test.js` runs **every** case against
**every** build. That is the point: a fix for one page used to be verified only
on that page, so a later change could silently undo it. `td, th` in the Oracle
patch's `closest()` is the clearest example — it fixed ADF grid cells and
changed what every other table-shaped widget resolved to at the same time.

Cases are **data, not code**. They live in
`recorder/test/capture-cases/<widget>.cases.json`, one file per widget, and are
discovered automatically — adding one changes no JavaScript at all. One file per
widget rather than one growing list, so two people adding cases for different
widgets never touch the same file.

```json
{
  "fixture": "checkbox.html",
  "source":  "Oracle Fusion — Create Supplier › Address Purpose (ibqwjb-test, 2026-08-25)",
  "widget":  "ADF selectManyCheckbox",
  "cases": [{
    "name":    "a checkbox clicked on its wrapping cell still records as a check",
    "click":   "[...document.querySelectorAll('td')].find(td => td.querySelectorAll('input[type=checkbox]').length === 1)",
    "expect":  { "type": "check", "label": "Email Invoices" },
    "because": "retargetToInteractive walks OUTWARD, so the click resolved to the <td> and replay toggled nothing"
  }]
}
```

So when a new DOM is captured because something failed on it:

1. Save the capture here.
2. Add or extend a `.cases.json`.
3. Run it against the **current** build first. Passing means it is a regression
   guard from now on; failing means it is the bug about to be fixed — leave it
   red until the fix lands.

Give each case a `because:` naming the failure it guards against. When it goes
red in a year, that sentence is what tells the reader why the case exists — it
is printed with the assertion.

Pin only what the bug is about. An over-specified case fails on unrelated
changes, gets deleted as noise, and the guard is lost.

The runner fails loudly rather than silently skipping: a `.cases.json` naming a
fixture that is not here is reported by name, and a corpus that discovered no
cases at all fails outright.

## Capturing a new one

From a logged-in page, in the browser console or via a Playwright `evaluate`:

```js
// The smallest subtree that still contains the widget and its wrapper.
document.querySelector('<the widget>').closest('table, .oj-listbox-drop, form').outerHTML
```

Save it with a header saying which tenant, which page and which date:

```html
<!--
  Oracle Fusion — Create Supplier › Address › Address Purpose.
  Captured verbatim from ibqwjb-test on 2026-08-25; the ids, classes and
  nesting are Oracle's, not ours.
-->
```

Keep enough ancestry for the code under test to behave normally — a cell out of
its `<tr>` will not exercise a row lookup — and strip nothing but `<script>`.
