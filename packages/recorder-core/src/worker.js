/**
 * @flowtrace/recorder-core/worker
 *
 * Worker-safe entrypoint for MV3 service worker and Node/auth contexts.
 * Deliberately excludes DOM-dependent content capture modules (e.g. content/capture.js)
 * that access `window`, `document`, or `history` at module evaluation time.
 */

export * from './compiler/compiler.js';
export * from './compiler/envelope-factory.js';
export * from './correlation/dedup.js';
export * from './correlation/surface-registry.js';
export * from './correlation/effect-correlator.js';

export * from './shared/schema.js';
export * from './shared/patch-api.js';
export * from './shared/sensitive.js';
export * from './shared/settings.js';
export * from './shared/types.js';

export * from './destinations/index.js';
export * from './patches/index.js';
