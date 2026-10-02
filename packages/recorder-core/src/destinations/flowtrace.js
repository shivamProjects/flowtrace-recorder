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

    // Canonical Protocol 2.0 payload construction
    const rawSteps = envelope?.steps || envelope?.actions || [];
    const canonicalSteps = rawSteps.map((s) => {
      const act = s.action || s.type || 'click';
      const step = {
        action: act,
        ...(s.description !== undefined ? { description: s.description } : {}),
        ...(s.skipInReport !== undefined ? { skipInReport: Boolean(s.skipInReport) } : {}),
        ...(s.required !== undefined ? { required: Boolean(s.required) } : {}),
        ...(s.requiredSource !== undefined ? { requiredSource: s.requiredSource } : {}),
        ...(s.requiredScope !== undefined ? { requiredScope: s.requiredScope } : {}),
        ...(s.surfaceId !== undefined ? { surfaceId: s.surfaceId } : {}),
        ...(s.frame !== undefined ? { frame: s.frame } : {}),
        ...(s.locator !== undefined
          ? { locator: s.locator }
          : (s.selector ? { locator: { selector: s.selector } } : {})),
        effects: s.effects || [],
        meta: s.meta || {},
      };

      if (act === 'navigate') {
        step.value = s.value || s.url || 'about:blank';
        if (s.url) step.url = s.url;
      } else if (act === 'click' || act === 'dblclick') {
        if (s.button) step.button = s.button;
        if (s.clickCount) step.clickCount = s.clickCount;
        if (s.modifiers) step.modifiers = s.modifiers;
        if (s.position) step.position = s.position;
      } else if (act === 'fill') {
        step.value = s.value != null ? String(s.value) : '';
        if (s.committedValue !== undefined) step.committedValue = s.committedValue;
        if (s.credentialRef !== undefined) step.credentialRef = s.credentialRef;
      } else if (act === 'selectOption') {
        if (s.value !== undefined) step.value = s.value;
        if (s.values !== undefined) step.values = s.values;
        if (s.optionIndex !== undefined) step.optionIndex = s.optionIndex;
      } else if (act === 'lovSelect') {
        step.value = s.value != null ? String(s.value) : '';
        if (s.optionIndex !== undefined) step.optionIndex = s.optionIndex;
      } else if (act === 'press') {
        step.key = s.key || s.value || 'Enter';
        if (s.modifiers) step.modifiers = s.modifiers;
      } else if (act === 'check') {
        step.checked = s.checked !== false;
      } else if (act === 'uncheck') {
        step.checked = false;
      } else if (act === 'setInputFiles') {
        step.files = Array.isArray(s.files) ? s.files : (s.value ? [String(s.value)] : []);
        if (s.value !== undefined) step.value = s.value;
      } else if (act === 'scroll') {
        if (s.deltaX !== undefined) step.deltaX = s.deltaX;
        if (s.deltaY !== undefined) step.deltaY = s.deltaY;
      } else if (act === 'hover') {
        if (s.position) step.position = s.position;
      } else if (act === 'copy') {
        if (s.outputName !== undefined) step.outputName = s.outputName;
        if (s.value !== undefined) step.value = s.value;
      } else if (act === 'wait') {
        step.durationMs = s.durationMs != null ? Number(s.durationMs) : (s.value ? Number(s.value) : 1000);
      } else if (act === 'assertText' || act === 'assertValue') {
        step.value = s.value != null ? String(s.value) : '';
      } else if (act === 'assertChecked') {
        step.checked = Boolean(s.checked);
      } else if (act === 'assertSnapshot') {
        step.snapshot = s.snapshot || s.value || '';
      }

      // Preserve all other properties losslessly
      for (const [k, v] of Object.entries(s)) {
        if (step[k] === undefined && v !== undefined) {
          step[k] = v;
        }
      }

      return step;
    });

    const canonicalEnvelope = buildRecordingEnvelope({
      recordingSessionId: envelope?.recordingSessionId,
      recordedAt: envelope?.recordedAt,
      producer: envelope?.producer || { kind: 'desktop', version: '2.0.0' },
      capabilities: envelope?.capabilities || ['multiSurface', 'nestedFrames', 'downloads', 'oracleADF'],
      meta: {
        name: recName,
        description: recDesc,
        sourceUrl: envelope?.sourceUrl || envelope?.meta?.sourceUrl || 'https://flowtrace.local',
        patchId: envelope?.patchId || envelope?.meta?.patchId || 'generic',
      },
      steps: canonicalSteps,
    });

    let response;
    try {
      response = await fetch(`${base}/api/v1/recordings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(canonicalEnvelope),
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
