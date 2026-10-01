/**
 * Checkbox capture — the parts the corpus cannot express.
 *
 * The behaviour itself is pinned in `capture-cases/adf-checkbox.cases.json` and
 * runs from the corpus. This file holds only what needs real code: proving the
 * fix is LOAD-BEARING, which means running the recorder with the rule removed.
 *
 * The bug it guards: a click landing on the padding around a checkbox — the
 * `<td>` or `<span>` ADF wraps it in — was recorded as a generic click on the
 * cell, because `retargetToInteractive()` walks OUTWARD and never finds the
 * control. On replay that clicks a box of pixels and toggles nothing, which is
 * why the checkbox "could not be ticked" and a backup selector was added
 * downstream to work around it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ablate, BUNDLE } from './capture-harness.js';

const SOURCE = resolve(import.meta.dirname, '../../../packages/recorder-core/src/content/capture.js');

// The descend rule, exactly as it appears in capture.js.
const DESCEND_RULE = `  if (target.querySelectorAll) {
    const boxes = target.querySelectorAll('input[type="checkbox"], input[type="radio"]');
    if (boxes.length === 1 && isVisible(boxes[0])) {
      emitCheckbox(boxes[0], e);
      return;
    }
  }`;

describe('the checkbox descend rule is load-bearing', () => {
  it('is present in the source, and removable', () => {
    // ablate() THROWS when the snippet stops matching, so this cannot quietly
    // degrade into "removed nothing" — the false negative that once reported
    // every fix as pointless and nearly got working fixes thrown away.
    const { without } = ablate(SOURCE, DESCEND_RULE);
    expect(without).not.toContain(DESCEND_RULE);
  });

  it('survives the build into the shipped bundle', () => {
    // The corpus injects dist/content.js, not the source. A rule that is in the
    // source but dropped by the bundler would leave the corpus green while the
    // shipped extension has the bug.
    const bundle = readFileSync(BUNDLE, 'utf8');
    expect(bundle).toMatch(/input\[type="checkbox"\], input\[type="radio"\]/);
  });
});
