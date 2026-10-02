/**
 * flowtrace.js — Standalone FlowTrace server destination.
 *
 * Interacts with FlowTrace Canonical Ingress API:
 *   POST /api/v1/recordings    Accepts canonical Protocol 2.0 RecordingEnvelope
 *   GET  /api/v1/environments  Lists environments (optional fallback)
 */

import { RecordingDestination, DESTINATION_TYPE } from './types.js';
import { apiErrorMessage, unwrap } from '../shared/settings.js';
import { buildRecordingEnvelope } from '../compiler/envelope-factory.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export class FlowTraceDestination extends RecordingDestination {
  constructor() {
    super(DESTINATION_TYPE.FLOWTRACE, 'FlowTrace Standalone');
  }

  /**
   * @param {{ apiBase?: string, token?: string, timeoutMs?: number }} [ctx]
   */
  async listEnvironments({ apiBase, token, timeoutMs = 5_000 } = {}) {
    const base = (apiBase || '').replace(/\/+$/, '');
    if (!base) {
      return { success: false, error: 'API base URL is not configured.' };
    }

    let response;
    try {
      response = await fetch(`${base}/api/v1/environments`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Standalone FlowTrace can run without pre-configured environments; return default environment
      return {
        success: true,
        environments: [{ id: 'default', name: 'Default FlowTrace Environment' }],
      };
    }

    if (response.status === 401) {
      return { success: false, error: 'Your session has ended. Sign in again.', unauthenticated: true };
    }

    if (response.status === 404) {
      // Fallback for standalone FlowTrace instances
      return {
        success: true,
        environments: [{ id: 'default', name: 'Default FlowTrace Environment' }],
      };
    }

    const parsed = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        success: false,
        error: apiErrorMessage(parsed, response.status, 'Could not load environments.'),
      };
    }

    const data = unwrap(parsed);
    const items = Array.isArray(data)
      ? data
      : (data?.items || [{ id: 'default', name: 'Default Environment' }]);
    return { success: true, environments: items };
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
    const base = (apiBase || '').replace(/\/+$/, '');
    if (!base) {
      return { success: false, error: 'API base URL is not configured.' };
    }

    const recName = name || envelope?.name || defaultRecordingName(envelope?.patchId);
    const recDesc = description || envelope?.description || 'Recorded with FlowTrace';

    // Canonical Protocol 2.0 payload
    const rawSteps = envelope?.steps || envelope?.actions || [];
    const normalizedSteps = rawSteps.map((s) => ({
      ...s,
      action: s.action || s.type || 'click',
    }));

    const payload = {
      name: recName,
      description: recDesc,
      protocolVersion: '2.0',
      schemaVersion: envelope?.schemaVersion || 2,
      recorderVersion: envelope?.recorderVersion || '2.0.0',
      producer: envelope?.producer || { kind: 'desktop', version: '2.0.0' },
      patchId: envelope?.patchId || 'oracle',
      sourceUrl: envelope?.sourceUrl || 'about:blank',
      actions: envelope?.actions || [],
      steps: normalizedSteps,
      ...(environment?.id && environment.id !== 'default' ? { environmentId: environment.id } : {}),
    };

    let response;
    try {
      response = await fetch(`${base}/api/v1/recordings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { success: false, error: 'Could not reach the FlowTrace server.', offline: true };
    }

    if (response.status === 401) {
      return { success: false, error: 'Your session has ended. Sign in again.', unauthenticated: true };
    }

    const parsed = await response.json().catch(() => null);

    if (response.status === 403) {
      return {
        success: false,
        error: apiErrorMessage(parsed, 403, 'You do not have permission to save recordings.'),
      };
    }

    if (!response.ok) {
      return {
        success: false,
        error: apiErrorMessage(parsed, response.status, 'Failed to save recording.'),
      };
    }

    const recording = unwrap(parsed);
    return { success: true, recording };
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
