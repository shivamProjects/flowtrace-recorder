/**
 * index.js — service worker entry point.
 *
 * The second of the two places that know patches exist. It injects the registry
 * into the router so that everything under core/background/ stays independent
 * of which applications are supported.
 */

import * as patches from '../../patches/index.js';
import { createRouter, createExternalRouter } from './router.js';
import * as session from './session.js';

const route = createRouter(patches);
const routeExternal = createExternalRouter(patches);

chrome.runtime.onStartup.addListener(() => session.ensureLoaded());
chrome.runtime.onInstalled.addListener(() => session.ensureLoaded());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  route(msg, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error('[recorder] handler failed:', msg.action, err);
      sendResponse({ error: err.message });
    });
  return true; // response is asynchronous
});

if (chrome.runtime.onMessageExternal) {
  chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    routeExternal(msg, sender)
      .then(sendResponse)
      .catch((err) => {
        console.error('[recorder] external handler failed:', msg?.action, err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  });
}

