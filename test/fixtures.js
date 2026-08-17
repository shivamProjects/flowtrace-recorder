/**
 * fixtures.js — DOM snippets taken from the shapes that appear in real Oracle
 * Fusion recordings, plus the generic cases the core must keep handling.
 *
 * Each fixture names the element under test with `target`, a querySelector run
 * against the mounted HTML.
 */

/** @typedef {{name: string, html: string, target: string, adf?: boolean}} Fixture */

/** Cases the core selector must handle with no patch involved. @type {Fixture[]} */
export const CORE_FIXTURES = [
  {
    name: 'id containing a CSS namespace separator',
    // Oracle IDCS emits exactly this. `#a|b` is a CSS parse error, which is why
    // the generated login lines threw before they ever queried the page.
    html: '<input id="idcs-signin-basic-signin-form-username|input" type="text">',
    target: 'input',
  },
  {
    name: 'plain author-written id',
    html: '<button id="submit-order">Place order</button>',
    target: 'button',
  },
  {
    name: 'numeric id is rejected as unstable',
    html: '<div id="12345">Totals</div>',
    target: 'div',
  },
  {
    name: 'data-testid beats everything below it',
    html: '<button data-testid="checkout" name="go" aria-label="Checkout">Go</button>',
    target: 'button',
  },
  {
    name: 'name attribute',
    html: '<input name="quantity" type="text">',
    target: 'input',
  },
  {
    name: 'anchor name is not identity',
    html: '<a name="top" href="#top">Back to top</a>',
    target: 'a',
  },
  {
    name: 'aria-label',
    html: '<button aria-label="Close dialog"><span>x</span></button>',
    target: 'button',
  },
  {
    name: 'label[for] association',
    html: '<label for="email">Email address</label><input id="email" type="text">',
    target: 'input',
  },
  {
    name: 'placeholder only',
    html: '<input placeholder="Search invoices" type="text">',
    target: 'input',
  },
  {
    name: 'role plus visible text',
    html: '<a href="/create">Create Transaction</a>',
    target: 'a',
  },
  {
    name: 'unique visible text on a non-semantic element',
    html: '<div>Outstanding balance</div><div>Something else</div>',
    target: 'div',
  },
  {
    name: 'utility-class soup falls through to CSS',
    html: '<div class="flex items-center gap-2 text-sm">' +
          '<span class="truncate">A</span><span class="truncate">B</span></div>',
    target: 'span',
  },
  {
    name: 'svg path with a single meaningful class',
    html: '<svg class="suiicon flat-tabs-overflow-right-svg"><path class="svg-outline"></path></svg>',
    target: 'path',
  },
  {
    name: 'repeated svg paths need positional disambiguation',
    html: '<svg><path class="svg-outline"></path><path class="svg-outline"></path>' +
          '<path class="svg-outline"></path><path class="svg-outline"></path></svg>',
    target: 'path:nth-of-type(4)',
  },
  {
    name: 'quote inside an aria-label',
    html: `<button aria-label="Delete O'Brien's row">x</button>`,
    target: 'button',
  },
  {
    name: 'backslash inside a name',
    // In CSS `\u` is an escape sequence, so the unescaped attribute selector
    // the monolith built matched "DOMAINuser" — parseable, but wrong.
    html: '<input name="DOMAIN\\user" type="text">',
    target: 'input',
  },
];

/**
 * Cases whose label resolution depends on ADF conventions. These are run with
 * the Oracle patch's label resolver installed, and must match the legacy
 * monolith exactly — that is the whole point of moving the logic rather than
 * rewriting it.
 * @type {Fixture[]}
 */
export const ORACLE_FIXTURES = [
  {
    name: 'ADF generated name on a text input',
    html: '<input name="pt1:_FOr1:1:_FONSr2:0:MAnt2:1:pt1:TCF:0:ap1:inputText2" ' +
          'id="pt1:_FOr1:1:_FONSr2:0:MAnt2:1:pt1:TCF:0:ap1:inputText2::content" type="text">',
    target: 'input',
    adf: true,
  },
  {
    name: 'ADF label[for] with the ::content suffix',
    html: '<label for="pt1:r1:0:it10">Transaction Number</label>' +
          '<input id="pt1:r1:0:it10::content" type="text">',
    target: 'input',
    adf: true,
  },
  {
    name: 'ADF row/first-cell label pattern',
    html: '<table><tr><td><label>Business Unit</label></td>' +
          '<td><input id="bu::content" type="text"></td></tr></table>',
    target: 'input',
    adf: true,
  },
  {
    name: 'ADF container label',
    html: '<div class="af_inputText"><label>Ship-to Site</label>' +
          '<input id="ship::content" type="text"></div>',
    target: 'input',
    adf: true,
  },
  {
    name: 'ADF required marker is stripped from the label',
    html: '<label for="amt">** Amount</label><input id="amt" type="text">',
    target: 'input',
    adf: true,
  },
];

/**
 * Mount a fixture and return the element under test.
 * @param {Document} doc
 * @param {Fixture} fixture
 * @returns {Element}
 */
export function mount(doc, fixture) {
  doc.body.innerHTML = fixture.html;
  const el = doc.body.querySelector(fixture.target);
  if (!el) throw new Error(`fixture "${fixture.name}": target ${fixture.target} not found`);
  return el;
}
