/**
 * upload.js — hand a finished recording to the configured destination (Standalone FlowTrace
 * or Enterprise Platform), and list the environments it can go to.
 *
 * Both live here rather than in the popup for one reason: the token. If the
 * popup called the platform/backend, the popup would need the token, and a token that
 * has been handed to a page is a token that can be read out of that page. The
 * popup asks for a list or for an upload and is told what came back.
 *
 * The architecture delegates to @flowtrace/recorder-core destinations:
 *   - FlowTraceDestination: POST /api/v1/recordings (Protocol 2.0 native)
 *   - PlatformDestination:  POST /api/oracle/recordings (Legacy serialized envelope)
 */

import * as auth from '../auth/index.js';
import {
  makeEnvelope,
  getApiBase,
  getDestinationType,
  createDestination,
  getEnvironment,
} from '@flowtrace/recorder-core';
import * as session from './session.js';

const REQUEST_TIMEOUT_MS = 3_000;

/**
 * The environments this account may file a recording under.
 *
 * @returns {Promise<{success: boolean, environments?: Array<Object>, error?: string,
 *                    unauthenticated?: boolean, offline?: boolean}>}
 */
export async function listEnvironments() {
  const token = await auth.bearerToken();
  const destType = await getDestinationType();
  const destination = createDestination(destType);
  const apiBase = await getApiBase();

  const res = await destination.listEnvironments({
    apiBase,
    token,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  if (res.unauthenticated) {
    await auth.signOut();
  }

  return res;
}

/**
 * @param {{name?: string, description?: string}} msg
 * @returns {Promise<{success: boolean, error?: string, recording?: Object,
 *                    environmentRequired?: boolean, unauthenticated?: boolean}>}
 */
export async function uploadRecording(msg) {
  const token = await auth.bearerToken();
  const destType = await getDestinationType();
  const destination = createDestination(destType);
  const apiBase = await getApiBase();

  const isPlatform = destType === 'platform' || destination.id === 'platform';
  if (isPlatform && !token) {
    return { success: false, error: 'Sign in before saving.', unauthenticated: true };
  }

  // Should be unreachable: START_RECORDING refuses without an environment, so
  // no recording can exist that has nowhere to go. Checked anyway because the
  // selection lives in storage and could have been cleared mid-recording, and
  // because the server's rejection would arrive only after the upload.
  const environment = await getEnvironment();
  if (isPlatform && !environment) {
    return {
      success: false,
      error: 'Choose an environment before saving.',
      environmentRequired: true,
    };
  }

  const s = session.get();
  if (!s.actions || s.actions.length === 0) {
    return { success: false, error: 'Nothing to save — stop a recording first.' };
  }

  const name = msg.name || defaultName(s.patchId);
  const description = msg.description || 'Recorded with the Chrome extension';

  const envelope = makeEnvelope({
    name,
    description,
    sourceUrl: s.sourceUrl,
    patchId: s.patchId,
    actions: s.actions,
    steps: s.steps,
  });

  const res = await destination.uploadRecording({
    envelope,
    name,
    description,
    environment,
    apiBase,
    token,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  if (res.unauthenticated) {
    await auth.signOut();
  }

  return res;
}

function defaultName(patchId) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Recording_${patchId}_${stamp}`;
}
