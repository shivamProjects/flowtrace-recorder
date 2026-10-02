/**
 * destinations/index.js — Unified Destination Registry and Factory for FlowTrace Recorder.
 */

import { DESTINATION_TYPE, RecordingDestination } from './types.js';
import { FlowTraceDestination } from './flowtrace.js';
import { PlatformDestination } from './platform.js';

const registry = new Map();

function initRegistry() {
  if (registry.size === 0) {
    registry.set(DESTINATION_TYPE.FLOWTRACE, new FlowTraceDestination());
    registry.set(DESTINATION_TYPE.PLATFORM, new PlatformDestination());
  }
}

/**
 * Get or instantiate a recording destination by type identifier.
 * Defaults to FlowTrace standalone.
 *
 * @param {string} [type]
 * @returns {RecordingDestination}
 */
export function createDestination(type = DESTINATION_TYPE.FLOWTRACE) {
  initRegistry();
  const normalized = String(type || '').toLowerCase().trim();
  const found = registry.get(normalized);
  if (!found) {
    return registry.get(DESTINATION_TYPE.FLOWTRACE);
  }
  return found;
}

/**
 * Register a custom recording destination.
 *
 * @param {string} type
 * @param {RecordingDestination} destination
 */
export function registerDestination(type, destination) {
  if (!destination || typeof destination.uploadRecording !== 'function') {
    throw new TypeError('destination must implement uploadRecording()');
  }
  registry.set(String(type).toLowerCase().trim(), destination);
}

/**
 * Returns all currently registered destination adapters.
 *
 * @returns {Array<RecordingDestination>}
 */
export function getRegisteredDestinations() {
  initRegistry();
  return Array.from(registry.values());
}

export {
  DESTINATION_TYPE,
  RecordingDestination,
  FlowTraceDestination,
  PlatformDestination,
};
