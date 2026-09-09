/**
 * popup.js — the recorder popup panel.
 *
 * It draws two selections that are easy to confuse and are not the same thing:
 *   - the PATCH ("Application"), which decides how a page is recorded, and
 *   - the ENVIRONMENT, which decides where on the platform the recording is
 *     filed. The platform rejects a recording without one.
 *
 * The popup never holds the token. It posts a username, a password and — when
 * the account has MFA — a code to the worker and asks it for a yes or a no; the
 * worker mints, stores and spends the token, and keeps the intermediate MFA
 * token to itself. That split is what makes the sign-in screen here a
 * convenience rather than a security control — the control is the worker
 * refusing START_RECORDING.
 *
 * Likewise, the environment being required is not enforced by the disabled
 * button below. It is enforced by the worker. The button exists so the refusal
 * arrives before someone records ten minutes of work, not instead of it.
 */

(() => {
  'use strict';

  // ── DOM refs ────────────────────────────────────────────────────────────
  const btnStart    = document.getElementById('btn-start');
  const btnPause    = document.getElementById('btn-pause');
  const btnStop     = document.getElementById('btn-stop');
  const btnClear    = document.getElementById('btn-clear');
  const btnCopy     = document.getElementById('btn-copy');
  const btnExportJson = document.getElementById('btn-export-json');
  const btnExportJs   = document.getElementById('btn-export-js');
  const stepList    = document.getElementById('step-list');
  const timelineCount = document.getElementById('timeline-count');
  const timelineHint = document.getElementById('timeline-hint');
  const statusPill  = document.getElementById('status-pill');
  const statusText  = document.getElementById('status-text');
  const headerMode  = document.getElementById('header-mode');
  const eventCount  = document.getElementById('event-count').querySelector('span');
  const codeOutput  = document.getElementById('code-output');
  const logoDot     = document.getElementById('logo-dot');
  const tabUrlText  = document.getElementById('tab-url-text');
  const toast       = document.getElementById('toast');
  const patchSelect = document.getElementById('patch-select');
  const patchBadge  = document.getElementById('patch-badge');
  const envSelect   = document.getElementById('env-select');
  const envWarning  = document.getElementById('env-warning');
  const btnSave     = document.getElementById('btn-save');
  const btnSettings = document.getElementById('btn-settings');
  const settingsPanel = document.getElementById('settings-panel');
  const settingApiBase = document.getElementById('setting-api-base');
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const authScreen  = document.getElementById('auth-screen');
  const authForm    = document.getElementById('auth-form');
  const authUsername = document.getElementById('auth-username');
  const authPassword = document.getElementById('auth-password');
  const authError   = document.getElementById('auth-error');
  const btnSignIn   = document.getElementById('btn-sign-in');
  const mfaForm     = document.getElementById('mfa-form');
  const mfaCode     = document.getElementById('mfa-code');
  const mfaHint     = document.getElementById('mfa-hint');
  const mfaError    = document.getElementById('mfa-error');
  const btnVerifyMfa = document.getElementById('btn-verify-mfa');
  const btnMfaCancel = document.getElementById('btn-mfa-cancel');
  const appBody     = document.getElementById('app-body');
  const authUser    = document.getElementById('auth-user');
  const btnSignOut  = document.getElementById('btn-sign-out');

  // ── Poll interval while recording ───────────────────────────────────────
  let pollInterval = null;
  const POLL_MS    = 1500;

  /** Whether an environment is currently selected — gates Start. */
  let haveEnvironment = false;

  // ── Human-readable patch names (fallback if GET_PATCHES fails) ───────
  const PATCH_NAMES = {
    oracle:  'Oracle Fusion',
    ibm:     'IBM',
    generic: 'Generic',
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Initialise UI from background state + stored preferences
  // ─────────────────────────────────────────────────────────────────────────
  async function init() {
    // 1. Get the active tab URL
    const tab = await getActiveTab();
    if (tab) tabUrlText.textContent = tab.url || '—';

    // Load the API base before anything talks to the backend.
    const settings = await sendBg({ action: 'GET_SETTINGS' });
    if (settings && settings.apiBase) settingApiBase.value = settings.apiBase;

    // 2. Ask the server who this is, every time the popup opens. Without this,
    //    deactivating a customer would not reach them until their token lapsed
    //    seven days later.
    const authed = await refreshAuth();
    if (!authed) return;

    // 3. Load available patches and populate the Application dropdown
    await loadPatches();

    // 4. Load stored patch preference
    const storedPrefs = await chrome.storage.local.get('preferredPatchId');
    if (storedPrefs.preferredPatchId && patchSelect.querySelector(`option[value="${storedPrefs.preferredPatchId}"]`)) {
      patchSelect.value = storedPrefs.preferredPatchId;
    }

    // 5. Environments, from the platform. Done after auth because the endpoint
    //    needs the token the worker only has once signed in.
    await loadEnvironments();

    // 6. Sync background session state with the popup
    const resp = await sendBg({ action: 'GET_STATUS' });
    if (resp && resp.session) {
      // If background has a different patch (e.g. restored from storage), sync
      if (resp.session.patchId && resp.session.patchId !== patchSelect.value) {
        const opt = patchSelect.querySelector(`option[value="${resp.session.patchId}"]`);
        if (opt) patchSelect.value = resp.session.patchId;
      }
      applySession(resp.session);
    } else {
      updatePatchBadge(patchSelect.value);
      setUIState('idle');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Authentication
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Revalidate against the server and draw whichever screen the answer implies.
   * @returns {Promise<boolean>} whether the recorder is available
   */
  async function refreshAuth() {
    const resp = await sendBg({ action: 'AUTH_REVALIDATE' });
    // A null response means the worker did not answer at all; showing the
    // sign-in screen is the honest reading, since nothing can be recorded
    // either way.
    const authenticated = !!(resp && resp.authenticated);
    showAuthenticated(authenticated, resp && resp.user);
    if (authenticated && resp.offline) {
      showToast('⚠ Working offline — could not reach the platform.');
    }
    return authenticated;
  }

  function showAuthenticated(authenticated, user) {
    authScreen.classList.toggle('hidden', authenticated);
    appBody.classList.toggle('hidden', !authenticated);
    headerMode.textContent = authenticated ? headerMode.textContent : 'Signed out';
    if (authenticated) {
      showMfaStep(false);
      // UserInfo carries fullName and username; email may be absent entirely.
      authUser.textContent = displayName(user);
      authUser.title = (user && (user.email || user.username)) || '';
      authPassword.value = '';
      mfaCode.value = '';
      authError.textContent = '';
      mfaError.textContent = '';
    }
  }

  function displayName(user) {
    if (!user) return 'Signed in';
    return user.fullName || user.username || user.email || 'Signed in';
  }

  /** Swap the password form for the code form, or back. */
  function showMfaStep(pending, mfaType) {
    authForm.classList.toggle('hidden', pending);
    mfaForm.classList.toggle('hidden', !pending);
    if (pending) {
      mfaHint.textContent = String(mfaType).toUpperCase() === 'EMAIL'
        ? 'We emailed you a code.'
        : 'Enter the code from your authenticator app.';
      mfaCode.value = '';
      mfaCode.focus();
    }
  }

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.textContent = '';
    btnSignIn.disabled = true;
    btnSignIn.textContent = 'Signing in…';

    // The password leaves this scope in the message and is cleared from the
    // field immediately after; it is never stored, and never written to a log.
    const resp = await sendBg({
      action: 'AUTH_SIGN_IN',
      username: authUsername.value.trim(),
      password: authPassword.value,
    });
    authPassword.value = '';

    btnSignIn.disabled = false;
    btnSignIn.textContent = 'Sign in';

    if (resp && resp.success) {
      await onSignedIn(resp.user);
    } else if (resp && resp.mfaRequired) {
      // Not a failure — the first half of a two-step login. There is no token
      // yet and nothing works until the code is verified.
      showMfaStep(true, resp.mfaType);
    } else {
      authError.textContent = (resp && resp.error) || 'Sign-in failed.';
    }
  });

  mfaForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    mfaError.textContent = '';
    btnVerifyMfa.disabled = true;
    btnVerifyMfa.textContent = 'Verifying…';

    // Only the code. The MFA token it is checked against stays in the worker.
    const resp = await sendBg({ action: 'AUTH_VERIFY_MFA', code: mfaCode.value });
    mfaCode.value = '';

    btnVerifyMfa.disabled = false;
    btnVerifyMfa.textContent = 'Verify';

    if (resp && resp.success) {
      await onSignedIn(resp.user);
    } else if (resp && resp.mfaRequired) {
      mfaError.textContent = resp.error || 'That code was not accepted.';
      mfaCode.focus();
    } else {
      // The attempt is over — back to the password form.
      showMfaStep(false);
      authError.textContent = (resp && resp.error) || 'Sign-in failed.';
    }
  });

  btnMfaCancel.addEventListener('click', async () => {
    await sendBg({ action: 'AUTH_SIGN_OUT' });
    showMfaStep(false);
    authError.textContent = '';
  });

  async function onSignedIn(user) {
    showAuthenticated(true, user);
    await init();
    showToast('✓ Signed in');
  }

  btnSignOut.addEventListener('click', async () => {
    stopPolling();
    await sendBg({ action: 'AUTH_SIGN_OUT' });
    showAuthenticated(false, null);
    showToast('Signed out');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Load available patches from background and rebuild the dropdown
  // ─────────────────────────────────────────────────────────────────────────
  async function loadPatches() {
    try {
      const resp = await sendBg({ action: 'GET_PATCHES' });
      if (!resp || !resp.patches || !resp.patches.length) return;

      // Rebuild dropdown from the authoritative patch registry
      patchSelect.innerHTML = '';
      for (const p of resp.patches) {
        const opt = document.createElement('option');
        opt.value       = p.id;
        opt.textContent = p.name;
        patchSelect.appendChild(opt);
      }

      // Apply background's current patch
      if (resp.current) {
        const opt = patchSelect.querySelector(`option[value="${resp.current}"]`);
        if (opt) patchSelect.value = resp.current;
      }
    } catch (_) {
      // Background may not be ready yet — keep static HTML options
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Environments — the platform decides what these are, not the extension
  // ─────────────────────────────────────────────────────────────────────────
  async function loadEnvironments() {
    const chosen = await sendBg({ action: 'GET_ENVIRONMENT' });
    const current = (chosen && chosen.environment) || null;

    const resp = await sendBg({ action: 'GET_ENVIRONMENTS' });

    if (!resp || !resp.success) {
      // Offline fallback: retain any already selected environment for upload continuity.
      envSelect.innerHTML = '';
      envSelect.appendChild(option('', current ? `${current.name} (offline)` : 'Unavailable'));
      if (current) envSelect.appendChild(option(current.id, current.name));
      envSelect.value = current ? current.id : '';
      if (resp && resp.unauthenticated) showAuthenticated(false, null);
      else if (resp) showToast(`⚠ ${resp.error || 'Could not load environments.'}`);
      setEnvironmentKnown(!!current, current);
      return;
    }

    envSelect.innerHTML = '';
    envSelect.appendChild(option('', 'Select an environment…'));
    for (const env of resp.environments) {
      const label = env.type ? `${env.name} · ${env.type}` : env.name;
      envSelect.appendChild(option(env.id, label));
    }

    // Synchronize selection against active server environments, clearing stale selections.
    const stillListed = current && resp.environments.some((e) => e.id === current.id);
    envSelect.value = stillListed ? current.id : '';
    if (current && !stillListed) await sendBg({ action: 'SET_ENVIRONMENT', environment: null });

    setEnvironmentKnown(!!stillListed, stillListed ? current : null);
  }

  function option(value, text) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    return opt;
  }

  function setEnvironmentKnown(known, environment) {
    haveEnvironment = known;
    envWarning.classList.toggle('hidden', known);
    envSelect.title = known && environment ? `Recordings are filed under ${environment.name}` : '';
    // Start is only ever enabled with an environment in hand; the worker would
    // refuse anyway, and refusing here saves the recording rather than the click.
    if (!known) btnStart.disabled = true;
  }

  envSelect.addEventListener('change', async () => {
    const id = envSelect.value;
    const name = envSelect.options[envSelect.selectedIndex]?.textContent || id;

    const resp = await sendBg({
      action: 'SET_ENVIRONMENT',
      environment: id ? { id, name } : null,
    });

    if (resp && !resp.success) {
      showToast(`⚠ ${resp.error || 'Could not set the environment.'}`);
      return;
    }

    setEnvironmentKnown(!!id, resp && resp.environment);
    if (id) {
      btnStart.disabled = false;
      showToast(`Environment: ${name}`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Apply session state to UI
  // ─────────────────────────────────────────────────────────────────────────
  function applySession(session) {
    if (!session) return;

    eventCount.textContent = session.eventCount || 0;
    updatePatchBadge(session.patchId || patchSelect.value);

    if (session.generatedCode) codeOutput.value = session.generatedCode;

    renderTimeline(session.events || []);

    if (session.isRecording) {
      if (session.isPaused) {
        setUIState('paused');
      } else {
        setUIState('recording');
      }
      startPolling();
    } else if ((session.eventCount || 0) > 0) {
      setUIState('stopped');
    } else {
      setUIState('idle');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UI state machine
  // states: 'idle' | 'recording' | 'paused' | 'stopped'
  // ─────────────────────────────────────────────────────────────────────────
  function setUIState(state) {
    statusPill.className = `status-pill ${state}`;

    switch (state) {
      case 'idle':
        statusText.textContent  = 'Idle';
        headerMode.textContent  = 'Ready';
        logoDot.className       = 'logo-dot';
        btnStart.disabled       = !haveEnvironment;
        btnPause.disabled       = true;
        btnPause.textContent    = 'Pause';
        btnStop.disabled        = true;
        btnClear.disabled       = false;
        btnCopy.disabled        = true;
        btnSave.disabled        = true;
        btnExportJson.disabled  = true;
        btnExportJs.disabled    = true;
        patchSelect.disabled    = false;
        envSelect.disabled      = false;
        break;

      case 'recording':
        statusText.textContent  = 'Recording';
        headerMode.textContent  = 'Recording…';
        logoDot.className       = 'logo-dot recording';
        btnStart.disabled       = true;
        btnPause.disabled       = false;
        btnPause.textContent    = 'Pause';
        btnStop.disabled        = false;
        btnClear.disabled       = true;
        btnCopy.disabled        = true;
        btnSave.disabled        = true;
        btnExportJson.disabled  = true;
        btnExportJs.disabled    = true;
        patchSelect.disabled    = true;
        envSelect.disabled      = true;
        break;

      case 'paused':
        statusText.textContent  = 'Paused';
        headerMode.textContent  = 'Paused';
        logoDot.className       = 'logo-dot';
        btnStart.disabled       = true;
        btnPause.disabled       = false;
        btnPause.textContent    = 'Resume';
        btnStop.disabled        = false;
        btnClear.disabled       = false;
        btnCopy.disabled        = false;
        btnSave.disabled        = true;
        btnExportJson.disabled  = false;
        btnExportJs.disabled    = false;
        patchSelect.disabled    = true;
        envSelect.disabled      = true;
        break;

      case 'stopped':
        statusText.textContent  = 'Stopped';
        headerMode.textContent  = 'Script Ready';
        logoDot.className       = 'logo-dot';
        statusPill.className    = 'status-pill stopped';
        btnStart.disabled       = !haveEnvironment;
        btnPause.disabled       = true;
        btnPause.textContent    = 'Pause';
        btnStop.disabled        = true;
        btnClear.disabled       = false;
        btnCopy.disabled        = false;
        btnSave.disabled        = false;
        btnExportJson.disabled  = false;
        btnExportJs.disabled    = false;
        patchSelect.disabled    = false;
        envSelect.disabled      = false;
        break;
    }
  }

  // ── Tab switching ────────────────────────────────────────────────────────
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-tab');
      tabButtons.forEach(b => b.classList.toggle('active', b === btn));
      tabContents.forEach(c => c.classList.toggle('active', c.id === targetId));
    });
  });

  const btnCloseSettings = document.getElementById('btn-close-settings');
  if (btnCloseSettings) {
    btnCloseSettings.addEventListener('click', () => {
      settingsPanel.classList.add('hidden');
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Live Step Timeline Rendering & Deletion
  // ─────────────────────────────────────────────────────────────────────────
  function renderTimeline(events) {
    if (!stepList) return;
    if (timelineCount) timelineCount.textContent = (events && events.length) || 0;

    if (!events || events.length === 0) {
      stepList.innerHTML = `
        <div style="padding: 16px; text-align: center; color: var(--text-3); font-style: italic; font-size: 11px;">
          No steps recorded yet. Click Start to begin.
        </div>
      `;
      return;
    }

    stepList.innerHTML = events.map((evt, idx) => {
      const rawType = (evt.type || 'action').toLowerCase();
      let badgeClass = 'action';
      if (rawType.includes('click')) badgeClass = 'click';
      else if (rawType.includes('fill') || rawType.includes('input') || rawType.includes('type')) badgeClass = 'fill';
      else if (rawType.includes('lov')) badgeClass = 'lov';
      else if (rawType.includes('select')) badgeClass = 'select';
      else if (rawType.includes('nav') || rawType.includes('url')) badgeClass = 'navigate';
      else if (rawType.includes('check')) badgeClass = 'check';

      const label = evt.label || evt.text || evt.selector || (evt.meta && evt.meta.url) || 'interaction';
      const valStr = evt.value ? ` "${evt.value}"` : '';

      return `
        <div class="step-item" data-index="${idx}">
          <span class="step-num">#${idx + 1}</span>
          <span class="step-badge ${badgeClass}">${rawType}</span>
          <span class="step-desc" title="${escapeHtml(label + valStr)}">${escapeHtml(label + valStr)}</span>
          <button class="step-del" data-del="${idx}" title="Delete this step">×</button>
        </div>
      `;
    }).join('');

    stepList.querySelectorAll('button[data-del]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-del'));
        await deleteStep(idx);
      });
    });

    // Auto-scroll to bottom of timeline
    stepList.scrollTop = stepList.scrollHeight;
  }

  async function deleteStep(index) {
    const resp = await sendBg({ action: 'DELETE_STEP', index });
    if (resp && resp.success) {
      eventCount.textContent = resp.eventCount || 0;
      if (resp.generatedCode) codeOutput.value = resp.generatedCode;
      renderTimeline(resp.events || []);
      showToast(`Deleted step #${index + 1}`);
    } else {
      showToast(`⚠ ${(resp && resp.error) || 'Could not delete step.'}`);
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Update the patch badge
  // ─────────────────────────────────────────────────────────────────────────
  function updatePatchBadge(patchId) {
    if (!patchId) return;
    const name = PATCH_NAMES[patchId] ||
      (patchSelect.querySelector(`option[value="${patchId}"]`) || {}).textContent ||
      patchId;
    patchBadge.textContent = name;
    patchBadge.title       = `Application: ${name}`;

    // Colour the badge by application
    if (patchId === 'oracle') {
      patchBadge.style.background = 'rgba(245,166,35,0.15)';
      patchBadge.style.color      = '#f5a623';
      patchBadge.style.borderColor= 'rgba(245,166,35,0.3)';
    } else if (patchId === 'ibm') {
      patchBadge.style.background = 'rgba(79,142,247,0.15)';
      patchBadge.style.color      = '#4f8ef7';
      patchBadge.style.borderColor= 'rgba(79,142,247,0.25)';
    } else {
      patchBadge.style.background = 'rgba(45,206,124,0.12)';
      patchBadge.style.color      = '#2dce7c';
      patchBadge.style.borderColor= 'rgba(45,206,124,0.2)';
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Patch selector change handler
  // ─────────────────────────────────────────────────────────────────────────
  patchSelect.addEventListener('change', async () => {
    const patchId = patchSelect.value;
    updatePatchBadge(patchId);

    // Persist preference so it survives popup close
    await chrome.storage.local.set({ preferredPatchId: patchId });

    // Notify background
    const resp = await sendBg({ action: 'SET_PATCH', patchId });
    if (resp && !resp.success) {
      showToast(`⚠ ${resp.error || 'Could not set the application.'}`);
      return;
    }
    showToast(`Application: ${PATCH_NAMES[patchId] || patchId}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Start recording
  // ─────────────────────────────────────────────────────────────────────────
  btnStart.addEventListener('click', async () => {
    btnStart.disabled = true;

    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      showToast('⚠ Could not detect an active tab.');
      btnStart.disabled = false;
      return;
    }

    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) {
      showToast('⚠ Cannot record on browser internal pages.');
      btnStart.disabled = false;
      return;
    }

    // Inject content script (graceful if already present)
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (e) {
      console.warn('[popup] Script inject warning:', e.message);
    }

    const patchId = patchSelect.value;

    const resp = await sendBg({
      action: 'START_RECORDING',
      tabId:  tab.id,
      tabUrl: tab.url,
      patchId,
    });

    if (resp && resp.success) {
      setUIState('recording');
      updatePatchBadge(patchId);
      codeOutput.value = '';
      eventCount.textContent = '0';
      startPolling();
      showToast(`🔴 Recording → ${resp.environment ? resp.environment.name : 'environment'}`);
    } else if (resp && resp.unauthenticated) {
      // The worker refused. It is the only opinion that counts, so the UI
      // follows it rather than the other way round.
      showAuthenticated(false, null);
      showToast(`⚠ ${resp.error}`);
    } else if (resp && resp.environmentRequired) {
      // The worker and the popup disagreed about the environment — the worker
      // wins, and the list is reloaded so the UI stops claiming otherwise.
      setEnvironmentKnown(false, null);
      await loadEnvironments();
      showToast(`⚠ ${resp.error}`);
    } else {
      showToast(`⚠ ${resp?.error || 'Failed to start recording.'}`);
      btnStart.disabled = false;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Pause / Resume recording
  // ─────────────────────────────────────────────────────────────────────────
  btnPause.addEventListener('click', async () => {
    const isCurrentlyPaused = statusPill.classList.contains('paused');
    const action = isCurrentlyPaused ? 'RESUME_RECORDING' : 'PAUSE_RECORDING';
    const resp = await sendBg({ action });

    if (resp && resp.success) {
      if (resp.isPaused) {
        setUIState('paused');
        showToast('⏸ Recording paused');
      } else {
        setUIState('recording');
        showToast('▶ Recording resumed');
      }
    } else {
      showToast(`⚠ ${(resp && resp.error) || 'Failed to toggle pause.'}`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Stop recording
  // ─────────────────────────────────────────────────────────────────────────
  btnStop.addEventListener('click', async () => {
    btnStop.disabled = true;
    stopPolling();

    const resp = await sendBg({ action: 'STOP_RECORDING' });

    if (resp && resp.success) {
      eventCount.textContent = resp.eventCount || 0;
      codeOutput.value       = resp.generatedCode || '// No events recorded.';
      updatePatchBadge(resp.patchId || patchSelect.value);
      setUIState('stopped');

      const processedCount = resp.processedCount || resp.eventCount || 0;
      showToast(`✓ Done — ${processedCount} step(s) · ${PATCH_NAMES[resp.patchId] || resp.patchId || 'Generic'}`);
    } else {
      showToast(`⚠ ${resp?.error || 'Failed to stop recording.'}`);
      btnStop.disabled = false;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Clear recording
  // ─────────────────────────────────────────────────────────────────────────
  btnClear.addEventListener('click', async () => {
    stopPolling();
    const resp = await sendBg({ action: 'CLEAR_RECORDING' });
    codeOutput.value = '';
    eventCount.textContent = '0';
    renderTimeline([]);
    // Preserve the patch selection after clear
    if (resp && resp.patchId) {
      const opt = patchSelect.querySelector(`option[value="${resp.patchId}"]`);
      if (opt) patchSelect.value = resp.patchId;
      updatePatchBadge(resp.patchId);
    }
    setUIState('idle');
    showToast('Session cleared');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Export actions.json (for direct Replayer execution)
  // ─────────────────────────────────────────────────────────────────────────
  btnExportJson.addEventListener('click', async () => {
    const statusResp = await sendBg({ action: 'GET_STATUS' });
    const s = (statusResp && statusResp.session) || {};
    const actionsData = s.actions || s.events || [];

    if (!actionsData || actionsData.length === 0) {
      showToast('⚠ No actions to export.');
      return;
    }

    const payload = JSON.stringify(actionsData, null, 2);
    downloadFile(payload, 'flowtrace-actions.json', 'application/json');
    showToast('✓ actions.json downloaded');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Export Playwright Spec Script
  // ─────────────────────────────────────────────────────────────────────────
  btnExportJs.addEventListener('click', () => {
    const code = codeOutput.value.trim();
    if (!code || (code.startsWith('//') && code.split('\n').length < 4)) {
      showToast('⚠ No script to export.');
      return;
    }

    downloadFile(code, 'flowtrace-recording.spec.js', 'text/javascript');
    showToast('✓ Playwright script downloaded');
  });

  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Copy code to clipboard
  // ─────────────────────────────────────────────────────────────────────────
  btnCopy.addEventListener('click', async () => {
    const code = codeOutput.value.trim();
    if (!code || (code.startsWith('//') && code.split('\n').length < 4)) {
      showToast('⚠ Nothing to copy yet.');
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      showToast('✓ Copied to clipboard!');
    } catch (_) {
      codeOutput.select();
      document.execCommand('copy');
      showToast('✓ Copied!');
    }
  });

  // ── Settings panel toggle ────────────────────────────────────────────────
  btnSettings.addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
  });

  // ── Save Settings ────────────────────────────────────────────────────────
  btnSaveSettings.addEventListener('click', async () => {
    const resp = await sendBg({ action: 'SET_SETTINGS', apiBase: settingApiBase.value.trim() });
    if (resp && resp.apiBase) settingApiBase.value = resp.apiBase;
    showToast('✓ Configuration saved!');
    settingsPanel.classList.add('hidden');
    // A different server has different environments, and possibly a different
    // account behind the stored token.
    await refreshAuth();
    await loadEnvironments();
  });

  // ── Save the recording to the platform ───────────────────────────────────
  //
  // The worker performs the upload; it holds the token, the environment and the
  // compiled recording already. The popup contributes a name and reports the
  // outcome.
  btnSave.addEventListener('click', async () => {
    const statusResp = await sendBg({ action: 'GET_STATUS' });
    const currentSession = (statusResp && statusResp.session) || {};

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    btnSave.disabled = true;
    const origText = btnSave.innerHTML;
    btnSave.textContent = 'Saving...';

    const customNameInput = document.getElementById('sync-script-name');
    const customDescInput = document.getElementById('sync-script-desc');
    const scriptName = (customNameInput && customNameInput.value.trim()) || `Script_${currentSession.patchId || patchSelect.value}_${stamp}`;
    const scriptDesc = (customDescInput && customDescInput.value.trim()) || `Recorded from the Chrome extension on ${now.toLocaleString()}`;

    const resp = await sendBg({
      action: 'UPLOAD_RECORDING',
      name: scriptName,
      description: scriptDesc,
    });

    btnSave.innerHTML = origText;
    btnSave.disabled = false;

    if (resp && resp.success) {
      showToast('✓ Saved to the platform');
    } else if (resp && resp.unauthenticated) {
      showAuthenticated(false, null);
      showToast(`⚠ ${resp.error}`);
    } else {
      showToast(`⚠ ${(resp && resp.error) || 'Save failed.'}`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Live event-count polling while recording
  // ─────────────────────────────────────────────────────────────────────────
  function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(async () => {
      const resp = await sendBg({ action: 'GET_STATUS' });
      if (!resp || !resp.session) return;

      eventCount.textContent = resp.session.eventCount || 0;

      if (!resp.session.isRecording) {
        // Recording stopped externally (e.g. tab closed)
        stopPolling();
        if ((resp.session.eventCount || 0) > 0) {
          // Auto-compile
          const compResp = await sendBg({ action: 'COMPILE_CODE' });
          if (compResp && compResp.generatedCode) {
            codeOutput.value = compResp.generatedCode;
            updatePatchBadge(compResp.patchId || patchSelect.value);
          }
          setUIState('stopped');
        } else {
          setUIState('idle');
        }
      }
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  function getActiveTab() {
    return new Promise(resolve => {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    });
  }

  function sendBg(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, resp => {
          if (chrome.runtime.lastError) {
            console.warn('[popup] sendBg error:', chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          resolve(resp);
        });
      } catch (e) {
        console.warn('[popup] sendBg exception:', e.message);
        resolve(null);
      }
    });
  }

  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  init();
})();
