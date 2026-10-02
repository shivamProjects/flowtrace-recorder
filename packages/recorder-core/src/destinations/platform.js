/**
 * platform.js — Enterprise Platform destination.
 *
 * Interacts with Enterprise Platform backend:
 *   POST /api/oracle/recordings   { environmentId, stepsJson, name?, description? }
 *   GET  /api/environments        Lists environments
 */

import { RecordingDestination, DESTINATION_TYPE } from './types.js';
import { apiErrorMessage, unwrap } from '../shared/settings.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export class PlatformDestination extends RecordingDestination {
  constructor() {
    super(DESTINATION_TYPE.PLATFORM, 'Enterprise Platform');
  }

  /**
   * @param {{ apiBase?: string, token?: string, timeoutMs?: number }} [ctx]
   */
  async listEnvironments({ apiBase, token, timeoutMs = 5_000 } = {}) {
    if (!token) return { success: false, error: 'Sign in first.', unauthenticated: true };
    const base = (apiBase || '').replace(/\/+$/, '');
    if (!base) return { success: false, error: 'API base URL is not configured.' };

    let response;
    try {
      response = await fetch(`${base}/api/environments`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { success: false, error: 'Could not reach the platform.', offline: true };
    }

    if (response.status === 401) {
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
   * @param {{
   *   envelope: Object,
   *   name?: string,
   *   description?: string,
   *   environment?: ?{ id: string, name?: string },
   *   apiBase?: string,
   *   token?: string,
   *   timeoutMs?: number
   * }} ctx
   */
  async uploadRecording({
    envelope,
    name,
    description,
    environment,
    apiBase,
    token,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (!token) return { success: false, error: 'Sign in before saving.', unauthenticated: true };
    const base = (apiBase || '').replace(/\/+$/, '');
    if (!base) return { success: false, error: 'API base URL is not configured.' };

    if (!environment || !environment.id) {
      return {
        success: false,
        error: 'Choose an environment before saving.',
        environmentRequired: true,
      };
    }

    const recName = name || envelope?.name || defaultRecordingName(envelope?.patchId);
    const recDesc = description || envelope?.description || 'Recorded with the Chrome extension';

    const payload = {
      environmentId: environment.id,
      stepsJson: JSON.stringify(envelope),
      name: recName,
      description: recDesc,
    };

    let response;
    try {
      response = await fetch(`${base}/api/oracle/recordings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { success: false, error: 'Could not reach the platform.', offline: true };
    }

    if (response.status === 401) {
      return { success: false, error: 'Your session has ended. Sign in again.', unauthenticated: true };
    }

    const parsed = await response.json().catch(() => null);

    if (response.status === 403) {
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
}

function defaultRecordingName(patchId = 'oracle') {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Recording_${patchId}_${stamp}`;
}
