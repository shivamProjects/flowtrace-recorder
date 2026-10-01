/**
 * Generic patch — the baseline for any application we have no knowledge of.
 *
 * It has no capture hooks at all, which is the point: on a site that is not
 * Oracle, none of the ADF DOM walking runs, and the per-interaction cost is
 * just the core selector generation.
 *
 * Post-processing is limited to cleanups that are true everywhere. What you
 * record is what you get.
 */

import {
  collapseRepeatedFills,
  collapseRepeatedNavigations,
} from '../shared/postprocess-helpers.js';

export default {
  id: 'generic',
  name: 'Generic',
  version: '2.0.0',
  description:
    'Minimal, safe cleanup only. No assumptions about the application. Use ' +
    'this for any site without a dedicated patch.',

  postProcess(events) {
    return collapseRepeatedFills(collapseRepeatedNavigations([...events]));
  },
};
