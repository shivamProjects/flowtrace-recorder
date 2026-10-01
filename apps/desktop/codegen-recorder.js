/**
 * codegen-recorder.js — Backward-compatibility alias pointing to DesktopRecorder.
 *
 * @deprecated Use DesktopRecorder from './src/desktop-recorder' instead.
 */

const DesktopRecorder = require('./src/desktop-recorder');

module.exports = DesktopRecorder;
