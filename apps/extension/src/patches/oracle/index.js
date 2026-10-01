/**
 * Oracle Fusion / ADF patch.
 *
 * Split across four files because the concerns have different lifetimes:
 *   selectors.js   the ADF markup vocabulary — changes when Fusion changes
 *   labels.js      how ADF associates a label with a control
 *   capture.js     what must be read live, before ADF destroys the evidence
 *   postprocess.js what can only be decided with the whole recording in hand
 */

import { capture, metaFor } from './capture.js';
import { resolveAdfLabel } from './labels.js';
import { postProcess } from './postprocess.js';

export default {
  id: 'oracle',
  name: 'Oracle Fusion',
  version: '2.1.0',
  description:
    'Oracle ADF / Fusion Cloud. Resolves ADF label conventions, captures ' +
    'list-of-values rows and reconstructed dates before the widgets close, ' +
    'substitutes ADF-committed values, and drops session-token navigations.',

  resolve: {
    label: resolveAdfLabel,
    meta: metaFor,
  },

  capture,

  postProcess,
};
