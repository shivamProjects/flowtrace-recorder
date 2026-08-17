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

    CLEAR_RECORDING: async () => {
      await session.clear();
      return { success: true, patchId: session.get().patchId };
    },

    RECORD_EVENT: async (msg, sender) => {
      const s = session.get();
      if (!s.isRecording) return { accepted: false };
      if (sender.tab && sender.tab.id !== s.activeTabId) return { accepted: false };

      if (!shouldAccept(msg.event, s.events)) {
        return { accepted: false, reason: 'deduplicated' };
      }
      // The content script masks credentials before sending, so this should
      // always be a no-op. It runs anyway because this is the boundary where an
      // event first becomes something that gets persisted to disk — the cheapest
      // possible check stands between a bug upstream and a stored password.
      s.events.push(maskEvent(msg.event));
      // Batched to keep storage writes off every single interaction.
      if (s.events.length % 5 === 0) await session.persist();
      return { accepted: true, totalEvents: s.events.length };
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

  if (msg.tabUrl && !msg.tabUrl.startsWith('chrome://') && msg.tabUrl !== 'about:blank') {
    next.events.push(makeNavigateEvent(msg.tabUrl));
  }
  session.set(next);
  await session.persist();

  // The manifest-declared content script covers frames that already existed,
  // but not ones that loaded before the extension was installed or reloaded.
  await inject(msg.tabId);
  await broadcast(msg.tabId, '__flowtrace_activate__', { patchId });

  return { success: true, environment, session: session.forTransport() };
}

async function stopRecording(patches) {
  const s = session.get();
  if (!s.isRecording) return { success: false, error: 'No active recording.' };

  s.isRecording = false;

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
