/**
 * types.js — Destination interface contracts and constants for FlowTrace Recorder.
 */

export const DESTINATION_TYPE = Object.freeze({
  FLOWTRACE: 'flowtrace',
  PLATFORM: 'platform',
});

/**
 * Base abstract class for recording destinations.
 */
export class RecordingDestination {
  /**
   * @param {string} id
   * @param {string} name
   */
  constructor(id, name) {
    this.id = id;
    this.name = name;
  }

  /**
   * List available environments for this destination.
   *
   * @param {{ apiBase?: string, token?: string, timeoutMs?: number }} [ctx]
   * @returns {Promise<{
   *   success: boolean,
   *   environments?: Array<Object>,
   *   error?: string,
   *   unauthenticated?: boolean,
   *   offline?: boolean
   * }>}
   */
  async listEnvironments(ctx) {
    throw new Error(`listEnvironments not implemented for destination '${this.id}'`);
  }

  /**
   * Upload and persist a recording envelope to this destination.
   *
   * @param {{
   *   envelope: Object,
   *   name?: string,
   *   description?: string,
   *   environment?: ?{ id: string, name?: string },
   *   apiBase?: string,
   *   token?: string,
   *   timeoutMs?: number
   * }} ctx
   * @returns {Promise<{
   *   success: boolean,
   *   recording?: Object,
   *   error?: string,
   *   unauthenticated?: boolean,
   *   offline?: boolean,
   *   environmentRequired?: boolean
   * }>}
   */
  async uploadRecording(ctx) {
    throw new Error(`uploadRecording not implemented for destination '${this.id}'`);
  }
}
