/**
 * envelope-factory.js — Canonical Protocol 2.0 RecordingEnvelope Factory.
 *
 * Enforces strict validation against @flowtrace/contracts RecordingEnvelopeSchema
 * before envelopes are serialized, stored, or sent across repository boundaries.
 */

import { RecordingEnvelopeSchema } from '@flowtrace/contracts';

function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback RFC4122 v4 UUID generator
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Construct and strictly validate a canonical Protocol 2.0 RecordingEnvelope.
 *
 * @param {Object} params
 * @param {string} [params.recordingSessionId]
 * @param {string} [params.recordedAt]
 * @param {Object} [params.producer]
 * @param {('extension'|'desktop'|'custom')} [params.producer.kind='desktop']
 * @param {string} [params.producer.version='1.0.0']
 * @param {string} [params.producer.platform]
 * @param {string[]} [params.capabilities]
 * @param {Object} params.meta
 * @param {string} params.meta.sourceUrl
 * @param {string} [params.meta.patchId='generic']
 * @param {string} [params.meta.name]
 * @param {string} [params.meta.description]
 * @param {Array<Object>} params.steps
 * @returns {Object} Validated RecordingEnvelope
 */
export function buildRecordingEnvelope(params = {}) {
  const envelope = {
    protocolVersion: '2.0',
    recordingSessionId: params.recordingSessionId || generateUUID(),
    recordedAt: params.recordedAt || new Date().toISOString(),
    producer: {
      kind: params.producer?.kind || 'desktop',
      version: params.producer?.version || '1.0.0',
      ...(params.producer?.platform ? { platform: params.producer.platform } : {}),
    },
    capabilities: params.capabilities || ['multiSurface', 'nestedFrames', 'downloads', 'oracleADF'],
    meta: {
      sourceUrl: params.meta?.sourceUrl || 'about:blank',
      patchId: params.meta?.patchId || 'generic',
      ...(params.meta?.name ? { name: params.meta.name } : {}),
      ...(params.meta?.description ? { description: params.meta.description } : {}),
    },
    steps: params.steps || [],
  };

  return RecordingEnvelopeSchema.parse(envelope);
}
