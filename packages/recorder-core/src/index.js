/**
 * @flowtrace/recorder-core
 *
 * Core pure DOM capture engine, targeting, correlator, and component adapters.
 * Usable identically by both Chrome Extension host and Desktop wrapper host.
 */

export * from './capture/pointer/click-correlator.js';
export * from './capture/keyboard/keyboard-capture.js';
export * from './capture/keyboard/key-classifier.js';
export * from './capture/focus/focus-state.js';
export * from './capture/input/native-select.js';
export * from './capture/input/contenteditable.js';
export * from './capture/input/range.js';
export * from './capture/targeting/target-snapshot.js';
export * from './capture/targeting/target-resolver.js';

export * from './content/selector.js';
export * from './content/locator-object.js';
export * from './content/widget.js';
export * from './content/dom.js';
export * from './content/escape.js';
export * from './content/required.js';
export * from './content/capture.js';

export * from './shared/schema.js';
export * from './shared/patch-api.js';
export * from './shared/sensitive.js';
export * from './shared/settings.js';
export * from './shared/types.js';

export * from './components/registry.js';
export * from './patches/index.js';
