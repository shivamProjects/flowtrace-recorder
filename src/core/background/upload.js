/**
 * upload.js — hand a finished recording to the platform, and list the places it
 * can go.
 *
 * Both live here rather than in the popup for one reason: the token. If the
 * popup called the platform, the popup would need the token, and a token that
 * has been handed to a page is a token that can be read out of that page. The
 * popup asks for a list or for an upload and is told what came back.
 *
 * The contract (platform-api OracleRecordingController):
 *   POST /api/oracle/recordings   roles MEMBER | ADMIN | SUPER_ADMIN
 *     { environmentId, stepsJson, name?, description? }
 *   GET  /api/environments        roles VIEWER and up
 *
 * `/api/oracle/recordings`, not `/api/recordings` — the latter does not exist,
 * so every upload the extension has ever attempted 404'd.
 *
 * `stepsJson` is a pre-serialised JSON STRING, not an array. `RecordingService`
 * takes the payload as a `Map<String, Object>` and calls `.toString()` on
 * whatever this key holds, so posting a real JSON array persists Java's
 * `[{action=click, selector=#save}]` — which is not JSON, cannot be parsed
 * back, and fails silently: the request returns 200 and the recording is
 * already ruined. `JSON.stringify` here is the whole fix.
 *
 * The actions are stringified whole and never inspected. What an individual
 * action contains is the compiler's business and is being versioned separately;
 * this module must not grow an opinion about it, or it will need changing every
 * time the schema does.
 *
 * Nothing here sends a tenant id or a user id. Ownership is derived server-side
 * from the JWT — `TenantContext.requireCurrentTenant()` and
 * `TenantContext.getCurrentUser()` — and a client-supplied id would be a way to
 * write a recording into someone else's account.
 */

import * as auth from '../auth/index.js';
import { makeEnvelope } from '../shared/schema.js';
import { apiErrorMessage, apiUrl, getEnvironment, unwrap } from '../shared/settings.js';
import * as session from './session.js';

const REQUEST_TIMEOUT_MS = 3_000;

/**
 * The environments this account may file a recording under.
 *
 * @returns {Promise<{success: boolean, environments?: Array<Object>, error?: string,
 *                    unauthenticated?: boolean}>}
 */
export async function listEnvironments() {
  const token = await auth.bearerToken();
  if (!token) return { success: false, error: 'Sign in first.', unauthenticated: true };

  let response;
  try {
    response = await fetch(await apiUrl('/api/environments'), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { success: false, error: 'Could not reach the platform.', offline: true };
  }

  if (response.status === 401) {
    await auth.signOut();
    return { success: false, error: 'Your session has ended. Sign in again.', unauthenticated: true };
  }

  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    return { success: false, error: apiErrorMessage(parsed, response.status, 'Could not load environments.') };
  }

  const data = unwrap(parsed);
  return { success: true, environments: Array.isArray(data) ? data : [] };
}

/**
 * @param {{name?: string, description?: string}} msg
 * @returns {Promise<{success: boolean, error?: string, recording?: Object}>}
 */
export async function uploadRecording(msg) {
  const token = await auth.bearerToken();
  if (!token) return { success: false, error: 'Sign in before saving.', unauthenticated: true };

  // Should be unreachable: START_RECORDING refuses without an environment, so
  // no recording can exist that has nowhere to go. Checked anyway because the
  // selection lives in storage and could have been cleared mid-recording, and
  // because the server's rejection would arrive only after the upload.
  const environment = await getEnvironment();
  if (!environment) {
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

  // The envelope goes INSIDE stepsJson rather than alongside it. RecordingService
  // reads only environmentId / stepsJson / name / description and discards every
  // other key, so a schemaVersion sent at the top level would be dropped on the
  // floor — and a stored recording whose format cannot be identified is exactly
  // how three undocumented dialects accumulated in the existing corpus.
  const payload = {
    environmentId: environment.id,
    // A string, deliberately. See the header.
    stepsJson: JSON.stringify(makeEnvelope({
      name,
      description,
      sourceUrl: s.sourceUrl,
      patchId: s.patchId,
      actions: s.actions,
      steps: s.steps,
    })),
    name,
    description,
  };

  let response;
  try {
    response = await fetch(await apiUrl('/api/oracle/recordings'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { success: false, error: 'Could not reach the platform.' };
  }

  if (response.status === 401) {
    // The server rejected this token outright — the same signal revalidation
    // acts on, so act on it here too rather than leaving a dead session up.
    await auth.signOut();
    return { success: false, error: 'Your session has ended. Sign in again.', unauthenticated: true };
  }

  const parsed = await response.json().catch(() => null);

  if (response.status === 403) {
    // NOT a sign-out. Uploading needs MEMBER or above, so a VIEWER with a
    // perfectly valid session gets a 403 here — signing them out would look
    // like an expiry and would send them round the login screen to be refused
    // in exactly the same way.
    return {
      success: false,
      error: apiErrorMessage(parsed, 403, 'Your role cannot save recordings. Ask for MEMBER access.'),
    };
  }

  if (!response.ok) {
    return { success: false, error: apiErrorMessage(parsed, response.status) };
  }

  return { success: true, recording: unwrap(parsed) };
}

function defaultName(patchId) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Recording_${patchId}_${stamp}`;
}
