/**
 * index.js — the patch registry.
 *
 * Adding support for a new application means adding a directory here and one
 * line to REGISTRY. Nothing in core/ changes, and nothing in core/ imports this
 * file — the two entry points inject the selected patch instead, which is what
 * keeps the dependency arrow pointing one way.
 */

import { DEFAULT_PATCH_ID, normalisePatch } from '../shared/patch-api.js';
import genericPatch from './generic/index.js';
import oraclePatch from './oracle/index.js';
import ibmPatch from './ibm/index.js';

/** @type {Record<string, import('../shared/patch-api.js').Patch>} */
const REGISTRY = {
  generic: normalisePatch(genericPatch),
  oracle: normalisePatch(oraclePatch),
  ibm: normalisePatch(ibmPatch),
};

/** Display order in the popup. `generic` last so the specific ones lead. */
const ORDER = ['oracle', 'ibm', 'generic'];

export { DEFAULT_PATCH_ID };

/**
 * Look up a patch, falling back to generic rather than throwing — an unknown id
 * from stale storage should degrade to a plain recording, not break Start.
 */
export function getPatch(id) {
  return REGISTRY[id] || REGISTRY[DEFAULT_PATCH_ID];
}

export function hasPatch(id) {
  return Object.hasOwn(REGISTRY, id);
}

/** Metadata for the popup dropdown. */
export function listPatches() {
  return ORDER.filter(hasPatch).map((id) => ({
    id,
    name: REGISTRY[id].name,
    version: REGISTRY[id].version,
    description: REGISTRY[id].description,
  }));
}
