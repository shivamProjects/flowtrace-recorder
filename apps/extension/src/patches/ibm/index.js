/**
 * IBM patch — scaffolding only.
 *
 * Kept because it documents the extension points that were identified for
 * Carbon, BPM Workflow and Maximo, and because having a second application
 * present keeps the core honest about not special-casing Oracle. It currently
 * does nothing beyond the generic cleanups.
 *
 * When it grows real behaviour, follow the Oracle layout: a selectors.js for
 * the markup vocabulary, capture.js for anything only observable live, and
 * postprocess.js for rewrites that need the whole recording.
 */

import {
  collapseRepeatedFills,
  collapseRepeatedNavigations,
} from '../shared/postprocess-helpers.js';

export default {
  id: 'ibm',
  name: 'IBM',
  version: '2.0.0',
  description:
    'IBM enterprise UI. Scaffolded for Carbon Design System, BPM Workflow ' +
    'and Maximo; currently applies generic cleanup only.',

  postProcess(events) {
    let result = collapseRepeatedNavigations([...events]);
    result = collapseRepeatedFills(result);

    // Extension points identified but not implemented:
    //  - drop navigations carrying jsessionid / WPS portal redirect chains
    //  - split Carbon DataTable compound aria-labels ("Status Active") so the
    //    locator names the cell value rather than header + value
    //  - normalise .bx--toolbar-action buttons to role=button
    //  - detect BPM wizard step transitions from hash changes
    //  - rewrite Maximo composite ids (pg:widget_name_ID) to [id$="…"]

    return result;
  },
};
