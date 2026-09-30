/**
 * router.js — message handlers for the service worker.
 *
 * Every handler runs after `ensureLoaded()`, because the worker may have been
 * evicted and restarted between any two messages.
 */

import * as auth from '../auth/index.js';
import { safeInvoke } from '../shared/patch-api.js';
import { maskEvent } from '../shared/sensitive.js';
import { getApiBase, getEnvironment, setApiBase, setEnvironment } from '../shared/settings.js';
import { makeNavigateEvent } from '../shared/types.js';
import { shouldAccept } from './dedup.js';
import { compileActions, compileScript, compileSteps } from './compiler.js';
import * as session from './session.js';
import { listEnvironments, uploadRecording } from './upload.js';

/**
 * @param {{getPatch: Function, hasPatch: Function, listPatches: Function}} patches
 *   The registry, injected so this module does not import from patches/.
 */
export function createRouter(patches) {
  session.setInjectFunction(inject);
  session.setBroadcastFunction(broadcast);

  const handlers = {
    GET_STATUS: () => ({ session: session.forTransport() }),

    GET_PATCHES: () => ({
      patches: patches.listPatches(),
      current: session.get().patchId,
    }),

    SET_PATCH: async (msg) => {
      if (session.get().isRecording) {
        return { success: false, error: 'Cannot change patch during a recording.' };
      }
      if (!patches.hasPatch(msg.patchId)) {
        return { success: false, error: `Unknown patch: ${msg.patchId}` };
      }
      session.get().patchId = msg.patchId;
      await session.rememberPatchPreference(msg.patchId);
      await session.persist();
      return { success: true, patchId: msg.patchId };
    },

    START_RECORDING: (msg) => startRecording(msg, patches),
    STOP_RECORDING: () => stopRecording(patches),

    PAUSE_RECORDING: async () => {
      const s = session.get();
      if (!s.isRecording) return { success: false, error: 'Not recording.' };
      s.isPaused = true;
      await session.persist();
      return { success: true, isPaused: true };
    },

    RESUME_RECORDING: async () => {
      const s = session.get();
      if (!s.isRecording) return { success: false, error: 'Not recording.' };
      s.isPaused = false;
      await session.persist();
      return { success: true, isPaused: false };
    },

    DELETE_STEP: async (msg) => {
      const s = session.get();
      const idx = Number(msg.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= s.events.length) {
        return { success: false, error: 'Invalid step index.' };
      }
      s.events.splice(idx, 1);
      await session.persist();

      // If recording is stopped, re-compile so generated code and steps reflect deletion
      if (!s.isRecording && s.events.length > 0) {
        await compile(patches);
      } else if (!s.isRecording && s.events.length === 0) {
        s.generatedCode = '';
        s.steps = [];
        s.actions = [];
        s.processedEvents = [];
        await session.persist();
      }

      return {
        success: true,
        eventCount: s.events.length,
        events: s.events,
        generatedCode: s.generatedCode,
      };
    },

    CLEAR_RECORDING: async () => {
      await session.clear();
      return { success: true, patchId: session.get().patchId };
    },

    RECORD_EVENT: async (msg, sender) => {
      const s = session.get();
      if (!s.isRecording || s.isPaused) return { accepted: false };

      const surfaceRegistry = session.getSurfaceRegistry();
      const tabId = sender.tab ? sender.tab.id : s.activeTabId;

      // Allow events from primary tab or any registered popup surface
      if (sender.tab && sender.tab.id !== s.activeTabId && !surfaceRegistry.hasTab(sender.tab.id)) {
        return { accepted: false, reason: 'unrecognized_surface' };
      }

      if (!shouldAccept(msg.event, s.events)) {
        return { accepted: false, reason: 'deduplicated' };
      }

      // Tag surface identity onto event
      const surface = tabId ? surfaceRegistry.getByTabId(tabId) : null;
      if (surface) {
        msg.event.surfaceId = surface.surfaceId;
      }

      // The content script masks credentials before sending, so this should
      // always be a no-op. It runs anyway because this is the boundary where an
      // event first becomes something that gets persisted to disk — the cheapest
      // possible check stands between a bug upstream and a stored password.
      const masked = maskEvent(msg.event);
      s.events.push(masked);

      // Record for asynchronous effect correlation (popups, navigations, downloads)
      // Must pass the exact reference in s.events so correlated effects mutate the durable session event.
      session.getEffectCorrelator().recordAction(masked);

      session.persistSoon();
      return { accepted: true, totalEvents: s.events.length, surfaceId: msg.event.surfaceId };
    },

    PATCH_CONTEXT_UPDATE: (msg, sender) => {
      const s = session.get();
      if (!s.isRecording) return { ok: false };
      if (sender.tab && sender.tab.id !== s.activeTabId) return { ok: false };
      session.mergePatchContext(msg.context);
      return { ok: true };
    },

    COMPILE_CODE: () => compile(patches),

    // ── authentication ──────────────────────────────────────────────────────
    // The popup owns none of this. It asks for a screen to draw and posts a
    // username, a password and — when the account has MFA — a code; the token
    // is minted, stored and read entirely inside the worker, so a compromised
    // popup page has nothing to steal and no way to fabricate a session. The
    // intermediate MFA token never leaves the worker either, which is why the
    // popup sends only a code and not the token it belongs to.
    AUTH_STATUS: () => auth.status(),
    AUTH_REVALIDATE: () => auth.revalidate(),
    AUTH_SIGN_IN: (msg) => auth.signIn(msg.username, msg.password),
    AUTH_VERIFY_MFA: (msg) => auth.verifyMfa(msg.code),
    AUTH_SIGN_OUT: () => auth.signOut(),

    GET_SETTINGS: async () => ({ apiBase: await getApiBase() }),
    SET_SETTINGS: async (msg) => ({ success: true, apiBase: await setApiBase(msg.apiBase) }),

    // ── the environment a recording is filed under ──────────────────────────
    GET_ENVIRONMENTS: () => listEnvironments(),
    GET_ENVIRONMENT: async () => ({ environment: await getEnvironment() }),

    SET_ENVIRONMENT: async (msg) => {
      if (session.get().isRecording) {
        // The id is stamped on the upload, so moving it mid-recording would
        // file the recording somewhere the person did not record against.
        return { success: false, error: 'Cannot change environment during a recording.' };
      }
      try {
        return { success: true, environment: await setEnvironment(msg.environment) };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },

    UPLOAD_RECORDING: (msg) => uploadRecording(msg),

    // ── platform direct bridge ──────────────────────────────────────────────
    // `authenticated` is AWAITED. It looks like a detail and is not: without the
    // await this returns a Promise, which structured-clones across the message
    // boundary as `{}` — truthy in JavaScript, so a platform doing
    // `if (ping.authenticated)` was told TRUE for a signed-out user, every time.
    // Observed live against nitro before the fix: {"authenticated":{}}.
    PING_EXTENSION: async () => ({
      success: true,
      installed: true,
      version: '1.0.0',
      authenticated: await auth.isAuthenticated(),
      isRecording: session.get().isRecording,
    }),

    PLATFORM_LAUNCH_SESSION: (msg) => platformLaunchSession(msg, patches),
  };

  return async function route(msg, sender) {
    await session.ensureLoaded();
    const handler = handlers[msg.action];
    if (!handler) return { error: `Unknown action: ${msg.action}` };
    return handler(msg, sender);
  };
}


async function startRecording(msg, patches) {
  // THE GATE. It is here, in the service worker, and not in the popup, because
  // the popup is a web page: anyone can open the worker's devtools console and
  // post `{action:'START_RECORDING'}` directly, and any disabled button in the
  // UI is irrelevant to that. This is the only code path into a recording — the
  // content script is injected by the branch below and captures nothing until
  // it is activated from here — so refusing at this line refuses everywhere.
  //
  // Deliberately a local token check rather than a call to the backend: the
  // recorder has to start on a customer network that may not have a route to
  // the server at that moment, and revalidation on popup open is what keeps the
  // local answer honest.
  if (!(await auth.isAuthenticated())) {
    return { success: false, error: 'Sign in before recording.', unauthenticated: true };
  }

  // THE SECOND GATE, and it is here for the same reason as the first: the popup
  // can be bypassed, so a disabled Start button is not a rule.
  //
  // The platform rejects a recording that arrives without an environmentId, and
  // there is no way to supply one after the fact from here. Refusing at Start
  // costs a click; refusing at Save costs the entire recording, which cannot be
  // re-made without redoing the work by hand. So the requirement is enforced at
  // the only moment when nothing has been lost yet.
  const environment = await getEnvironment();
  if (!environment) {
    return {
      success: false,
      error: 'Choose an environment before recording — recordings cannot be saved without one.',
      environmentRequired: true,
    };
  }

  if (session.get().isRecording) {
    return { success: false, error: 'Recording already in progress.' };
  }

  const patchId = patches.hasPatch(msg.patchId) ? msg.patchId : session.get().patchId;
  const next = session.blankSession(patchId);
  next.isRecording = true;
  next.activeTabId = msg.tabId;
  next.startedAt = Date.now();
  next.sourceUrl = msg.tabUrl || null;

  // Initialize surface registry with primary root surface
  const surfaceRegistry = session.getSurfaceRegistry();
  surfaceRegistry.clear();
  surfaceRegistry.setSessionId(next.recordingSessionId);
  surfaceRegistry.registerPrimary(msg.tabId, { url: msg.tabUrl });

  // Start zero-CDP lifecycle observers (popups, navigations, downloads)
  session.initLifecycleObservers(inject, broadcast).start();

  if (msg.tabUrl && !msg.tabUrl.startsWith('chrome://') && msg.tabUrl !== 'about:blank') {
    const navEvent = makeNavigateEvent(msg.tabUrl);
    navEvent.surfaceId = surfaceRegistry.getByTabId(msg.tabId)?.surfaceId;
    next.events.push(navEvent);
  }
  session.set(next);
  await session.persist();

  // The manifest-declared content script covers frames that already existed,
  // but not ones that loaded before the extension was installed or reloaded.
  await inject(msg.tabId);
  await broadcast(msg.tabId, '__flowtrace_activate__', { patchId });

  return { success: true, environment, session: session.forTransport() };
}

async function platformLaunchSession(msg, patches) {
  // 1. Sync token & user from Platform if provided
  if (msg.token) {
    try {
      await auth.setSessionToken(msg.token, msg.user || null);
    } catch (e) {
      console.warn('[recorder] could not sync platform session token:', e.message);
    }
  }

  // 2. Set target environment in recorder settings
  if (msg.environment) {
    try {
      await setEnvironment(msg.environment);
    } catch (e) {
      console.warn('[recorder] could not set environment from platform launch:', e.message);
    }
  }

  const targetUrl = msg.targetUrl || msg.instance?.baseUrl || msg.url;
  if (!targetUrl) {
    return { success: false, error: 'Target URL or Instance URL is required to launch recording.' };
  }

  const patchId = patches.hasPatch(msg.patchId) ? msg.patchId : 'oracle';

  // 3. Open new tab with target URL
  let tab;
  try {
    tab = await chrome.tabs.create({ url: targetUrl, active: true });
  } catch (err) {
    return { success: false, error: `Failed to open tab: ${err.message}` };
  }

  if (!tab || !tab.id) {
    return { success: false, error: 'Failed to create browser tab.' };
  }

  // 4. Wait for the initial page load
  await waitForTabComplete(tab.id, 10_000);

  // 5. Inject recorder content scripts into the page
  await inject(tab.id);

  // 6. Handle automated login if requested and credentials are provided
  if (msg.autoLogin && msg.credentials && (msg.credentials.username || msg.credentials.password)) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'AUTO_FILL_LOGIN',
        username: msg.credentials.username || '',
        password: msg.credentials.password || '',
        submit: msg.autoSubmit !== false,
      });
      // Allow the form submit navigation to initiate and complete
      await new Promise((r) => setTimeout(r, 2000));
      await waitForTabComplete(tab.id, 8_000);
      await inject(tab.id);
    } catch (e) {
      console.warn('[recorder] auto-fill login injection notice:', e.message);
    }
  }

  // 7. Handle deep link navigation if specified and different from initial landing
  if (msg.deepLinkUrl && msg.deepLinkUrl !== targetUrl) {
    try {
      await chrome.tabs.update(tab.id, { url: msg.deepLinkUrl });
      await waitForTabComplete(tab.id, 8_000);
      await inject(tab.id);
    } catch (e) {
      console.warn('[recorder] deep link navigation notice:', e.message);
    }
  }

  // Retrieve latest tab info
  let currentTabUrl = targetUrl;
  try {
    const updatedTab = await chrome.tabs.get(tab.id);
    if (updatedTab && updatedTab.url) currentTabUrl = updatedTab.url;
  } catch (_) {}

  // 8. Start recording session on the active tab
  const startResult = await startRecording({
    tabId: tab.id,
    tabUrl: currentTabUrl,
    patchId,
  }, patches);

  // SUCCESS IS DERIVED FROM startRecording, NOT ASSERTED.
  //
  // This used to return a hardcoded `success: true` with the real outcome buried
  // in the sibling `startResult`. startRecording produces three well-shaped
  // refusals — `unauthenticated` (:197), `environmentRequired` (:210) and
  // "Recording already in progress." (:218) — and all three were discarded here.
  //
  // The environment one is a DATA-LOSS path, not a cosmetic lie: its own comment
  // above says refusing at Start costs a click while refusing at Save costs the
  // entire recording. A caller told `success: true` records the whole flow and
  // loses it at save, which is precisely the failure the gate exists to prevent.
  //
  // The discriminators are propagated to the top level so the platform can say
  // "sign in" or "choose an environment" rather than a generic "launch failed" —
  // telling a user their launch failed when they only need to sign in is its own
  // small lie. `startResult` is still returned whole for callers that want it.
  const ok = startResult?.success === true;
  return {
    success: ok,
    ...(ok ? {} : { error: startResult?.error || 'Recording did not start.' }),
    ...(startResult?.unauthenticated ? { unauthenticated: true } : {}),
    ...(startResult?.environmentRequired ? { environmentRequired: true } : {}),
    tabId: tab.id,
    targetUrl: currentTabUrl,
    environment: await getEnvironment(),
    startResult,
  };
}

function waitForTabComplete(tabId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let resolved = false;
    const listener = (tid, info) => {
      if (tid === tabId && info.status === 'complete') {
        if (!resolved) {
          resolved = true;
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, timeoutMs);
  });
}


async function stopRecording(patches) {
  const s = session.get();
  if (!s.isRecording) return { success: false, error: 'No active recording.' };

  s.isRecording = false;

  // Stop zero-CDP lifecycle observers
  session.getLifecycleObservers()?.stop();

  if (s.activeTabId) {
    await broadcast(s.activeTabId, '__flowtrace_deactivate__');
    // The top frame returns the patch's final context snapshot — data captured
    // in the page that never made it into a streamed update.
    try {
      const resp = await chrome.tabs.sendMessage(s.activeTabId, { action: 'DEACTIVATE_RECORDING' });
      if (resp?.patchContext) session.mergePatchContext(resp.patchContext);
    } catch {
      // Tab closed before Stop. Whatever was streamed during recording stands.
    }
  }

  const result = compile(patches);
  await session.persist();
  return { success: true, ...result };
}

function compile(patches) {
  const s = session.get();
  const patch = patches.getPatch(s.patchId);

  const processed = safeInvoke(
    `${patch.id}.postProcess`,
    patch.postProcess,
    [...s.events],
    [...s.events],
    s,
  // Re-asserted after postProcess, not just before it. A patch substitutes the
  // value the application committed for the one that was typed, and it has no
  // way of knowing that a given field was a password — Oracle's does exactly
  // this. Without this pass a masked fill could come out of postProcess holding
  // the real value, on its way into the script, the steps and the actions.
  ).map(maskEvent);

  s.processedEvents = processed;
  s.generatedCode = compileScript(processed, s, patch);
  s.steps = compileSteps(processed);
  // The structured form, and the only one the replayer can actually execute:
  // its dispatcher reads an action NAME, and every `steps` entry is named
  // `code`, which it does not handle. `steps` is kept for anything already
  // consuming the generated script text.
  s.actions = compileActions(processed);

  return {
    success: true,
    generatedCode: s.generatedCode,
    steps: s.steps,
    actions: s.actions,
    eventCount: s.events.length,
    processedCount: processed.length,
    patchId: s.patchId,
    session: session.forTransport(),
  };
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      // The selector engine first, and only here: at 159 KB, declaring it in
      // the manifest's content_scripts would parse and run it in every frame of
      // every page the user visits, recording or not. Injecting it in the same
      // call as content.js — files run in array order — is what guarantees
      // `window.__flowtracePwInjected` exists before capture can fire. Its
      // own bootstrap is a no-op on a second injection.
      files: ['selector-engine.js', 'content.js'],
    });
  } catch (err) {
    // Frames we are not allowed to script (chrome://, the web store) throw here.
    console.warn('[recorder] inject:', err.message);
  }
}

/** tabs.sendMessage reaches only the top frame, so state changes go via a DOM event. */
async function broadcast(tabId, eventName, detail) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (name, payload) => {
        window.dispatchEvent(new CustomEvent(name, { detail: payload }));
      },
      args: [eventName, detail || null],
    });
  } catch {
    // Tab may have navigated or closed; nothing to do.
  }
}
