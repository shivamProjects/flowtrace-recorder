/**
 * widget.js — the floating recording indicator.
 *
 * Injected into the top frame only, inside a shadow root so the host page's
 * stylesheet cannot reach it and ours cannot leak out. Purely presentational:
 * it reports state and offers a Stop button, and knows nothing about capture.
 */

export const WIDGET_HOST_ID = '__flowtrace_widget_host__';
export const MODAL_HOST_ID = '__flowtrace_result_modal_host__';

const ACCENTS = {
  oracle:  { color: '#f5a623', rgb: '245,166,35', name: 'Oracle Fusion' },
  ibm:     { color: '#4f8ef7', rgb: '79,142,247', name: 'IBM' },
  generic: { color: '#2dce7c', rgb: '45,206,124', name: 'Generic' },
};

let host = null;
let modalHost = null;
let timer = null;
let startedAt = 0;
let isPaused = false;
let minimised = false;
let observer = null;

/**
 * @param {{patchId: string, patchName: string, onStop: () => Promise<Object> | void, onPauseToggle?: (paused: boolean) => void}} options
 */
export function mountWidget({ patchId, patchName, onStop, onPauseToggle }) {
  unmountWidget();

  const accent = ACCENTS[patchId] || ACCENTS.generic;
  startedAt = Date.now();
  minimised = false;
  isPaused = false;

  host = document.createElement('div');
  host.id = WIDGET_HOST_ID;
  Object.assign(host.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    zIndex: '2147483647',
    pointerEvents: 'auto',
    userSelect: 'none',
    lineHeight: 'normal',
  });
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = template(accent, patchName || accent.name);

  const root = shadow.getElementById('w');
  const clock = shadow.getElementById('tmr');
  const counter = shadow.getElementById('cnt');
  const btnMin = shadow.getElementById('btnMin');
  const btnStop = shadow.getElementById('btnStop');
  const btnPause = shadow.getElementById('btnPause');
  const recDot = shadow.getElementById('recDot');
  const recLabel = shadow.getElementById('recLabel');

  timer = setInterval(() => {
    if (isPaused) return;
    const s = Math.floor((Date.now() - startedAt) / 1000);
    clock.textContent =
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);

  const toggle = (e) => {
    e.stopPropagation();
    minimised = !minimised;
    root.classList.toggle('minimized', minimised);
    btnMin.textContent = minimised ? '+' : '−';
    btnMin.title = minimised ? 'Expand' : 'Minimise';
  };
  btnMin.addEventListener('click', toggle);
  root.addEventListener('click', (e) => {
    if (minimised && e.target !== btnStop && e.target !== btnPause) toggle(e);
  });

  if (btnPause) {
    btnPause.addEventListener('click', (e) => {
      e.stopPropagation();
      isPaused = !isPaused;
      root.classList.toggle('is-paused', isPaused);
      recLabel.textContent = isPaused ? 'PAUSED' : 'REC';
      recLabel.style.color = isPaused ? '#f5a623' : '#ff4d4d';
      btnPause.innerHTML = isPaused ? '&#9654;' : '&#10074;&#10074;';
      btnPause.title = isPaused ? 'Resume Recording' : 'Pause Recording';
      onPauseToggle?.(isPaused);
    });
  }

  btnStop.addEventListener('click', async (e) => {
    e.stopPropagation();
    unmountWidget();
    try {
      const resp = await onStop();
      if (resp && (resp.generatedCode || resp.eventCount)) {
        showResultModal(resp, accent, patchName || accent.name);
      }
    } catch (_) {}
  });

  makeDraggable(root);
  host._counter = counter;
  host._root = root;

  observer = new MutationObserver(() => {
    if (host && !document.getElementById(WIDGET_HOST_ID)) {
      document.documentElement.appendChild(host);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: false });
}

export function setWidgetCount(n, lastActionText) {
  if (!host || !host._counter) return;
  host._counter.innerHTML = `<b>${n}</b>&thinsp;event${n === 1 ? '' : 's'}`;
  if (lastActionText && host._root) {
    host._root.setAttribute('data-last-action', lastActionText);
  }
}

export function unmountWidget() {
  if (timer) { clearInterval(timer); timer = null; }
  if (observer) { observer.disconnect(); observer = null; }
  if (host) { host.remove(); host = null; }
}

/**
 * True when the node belongs to our own widget or result modal.
 */
export function isWidgetNode(node) {
  if (!node) return false;
  let current = node;
  while (current) {
    if (current.id === WIDGET_HOST_ID || current.id === MODAL_HOST_ID) return true;
    const root = current.getRootNode && current.getRootNode();
    current = root && root.host ? root.host : current.parentElement;
    if (current === document.documentElement) return false;
  }
  return false;
}

/**
 * Floating Shadow-DOM Result Dialog displaying the recorded Playwright code directly on the page.
 */
export function showResultModal(result, accent = ACCENTS.generic, patchName = 'Generic') {
  closeResultModal();

  modalHost = document.createElement('div');
  modalHost.id = MODAL_HOST_ID;
  Object.assign(modalHost.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '100vw',
    height: '100vh',
    zIndex: '2147483647',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0, 0, 0, 0.7)',
    backdropFilter: 'blur(8px)',
    pointerEvents: 'auto',
    userSelect: 'text',
    lineHeight: 'normal',
  });
  document.documentElement.appendChild(modalHost);

  const shadow = modalHost.attachShadow({ mode: 'open' });
  const scriptCode = result.generatedCode || '// No steps were recorded.';
  const stepCount = result.processedCount || result.eventCount || 0;

  shadow.innerHTML = `
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif; }
      .modal-card {
        width: 720px;
        max-width: 92vw;
        max-height: 88vh;
        background: #0d1017;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 14px;
        box-shadow: 0 24px 72px rgba(0, 0, 0, 0.85), 0 0 32px rgba(59, 130, 246, 0.25);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        animation: scaleIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      @keyframes scaleIn {
        from { opacity: 0; transform: scale(0.95); }
        to   { opacity: 1; transform: scale(1); }
      }
      .modal-header {
        padding: 16px 20px;
        background: #141824;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .title-group {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .logo-pill {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        border-radius: 8px;
        background: rgba(59, 130, 246, 0.2);
        border: 1px solid rgba(59, 130, 246, 0.4);
        color: #60a5fa;
        font-weight: 800;
        font-size: 15px;
      }
      .modal-title {
        font-size: 15px;
        font-weight: 700;
        color: #f3f4f6;
      }
      .modal-subtitle {
        font-size: 11px;
        color: #9ca3af;
      }
      .badge {
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
        background: rgba(34, 197, 94, 0.15);
        color: #4ade80;
        border: 1px solid rgba(34, 197, 94, 0.3);
      }
      .btn-close {
        background: transparent;
        border: none;
        color: #9ca3af;
        font-size: 20px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 6px;
        line-height: 1;
        transition: all 0.15s ease;
      }
      .btn-close:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }
      .modal-body {
        padding: 18px 20px;
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .code-view {
        width: 100%;
        height: 340px;
        background: #080a0e;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        padding: 12px 14px;
        font-family: ui-monospace, SFMono-Regular, "Cascadia Code", "Fira Mono", Consolas, monospace;
        font-size: 11.5px;
        line-height: 1.6;
        color: #93c5fd;
        resize: none;
        outline: none;
        white-space: pre;
        overflow: auto;
      }
      .modal-footer {
        padding: 14px 20px;
        background: #141824;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
      }
      .btn {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: none;
        transition: all 0.15s ease;
        outline: none;
      }
      .btn-primary {
        background: linear-gradient(135deg, #3b82f6, #2563eb);
        color: #fff;
        box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
      }
      .btn-primary:hover {
        background: linear-gradient(135deg, #60a5fa, #3b82f6);
      }
      .btn-secondary {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        color: #e5e7eb;
      }
      .btn-secondary:hover {
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
      }
    </style>
    <div class="modal-card">
      <div class="modal-header">
        <div class="title-group">
          <div class="logo-pill">⚡</div>
          <div>
            <div class="modal-title">FlowTrace Recording Complete</div>
            <div class="modal-subtitle">Compiled Playwright Automation Script</div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="badge">✓ ${stepCount} step${stepCount === 1 ? '' : 's'} · ${patchName}</span>
          <button class="btn-close" id="btnCloseModal" title="Close">×</button>
        </div>
      </div>
      <div class="modal-body">
        <textarea class="code-view" id="codeText" readonly>${escapeHtml(scriptCode)}</textarea>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="btnExportJson">💾 Download actions.json</button>
        <button class="btn btn-secondary" id="btnExportJs">💾 Download .spec.js</button>
        <button class="btn btn-primary" id="btnCopyScript">📋 Copy Playwright Script</button>
      </div>
    </div>
  `;

  const btnClose = shadow.getElementById('btnCloseModal');
  const btnCopy = shadow.getElementById('btnCopyScript');
  const btnExportJs = shadow.getElementById('btnExportJs');
  const btnExportJson = shadow.getElementById('btnExportJson');
  const codeText = shadow.getElementById('codeText');

  if (btnClose) btnClose.addEventListener('click', closeResultModal);
  modalHost.addEventListener('click', (e) => {
    if (e.target === modalHost) closeResultModal();
  });

  if (btnCopy) {
    btnCopy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(scriptCode);
        btnCopy.textContent = '✓ Copied to Clipboard!';
        setTimeout(() => { btnCopy.textContent = '📋 Copy Playwright Script'; }, 2000);
      } catch {
        codeText.select();
        document.execCommand('copy');
        btnCopy.textContent = '✓ Copied!';
        setTimeout(() => { btnCopy.textContent = '📋 Copy Playwright Script'; }, 2000);
      }
    });
  }

  if (btnExportJs) {
    btnExportJs.addEventListener('click', () => {
      downloadBlob(scriptCode, 'flowtrace-recording.spec.js', 'text/javascript');
    });
  }

  if (btnExportJson) {
    btnExportJson.addEventListener('click', () => {
      const actionsData = result.actions || result.steps || [];
      downloadBlob(JSON.stringify(actionsData, null, 2), 'flowtrace-actions.json', 'application/json');
    });
  }
}

export function closeResultModal() {
  if (modalHost) {
    modalHost.remove();
    modalHost = null;
  }
}

function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.documentElement.appendChild(a);
  a.click();
  document.documentElement.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function makeDraggable(root) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originRight = 24;
  let originBottom = 24;
  let right = 24;
  let bottom = 24;

  root.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    originRight = right;
    originBottom = bottom;
    root.style.cursor = 'grabbing';
    e.stopPropagation();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging || !host) return;
    right = clamp(originRight + (startX - e.clientX), window.innerWidth - host.offsetWidth - 8);
    bottom = clamp(originBottom + (e.clientY - startY), window.innerHeight - host.offsetHeight - 8);
    host.style.right = `${right}px`;
    host.style.bottom = `${bottom}px`;
  });

  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; root.style.cursor = ''; }
  });
}

const clamp = (v, max) => Math.max(8, Math.min(max, v));

function template(accent, patchName) {
  return `
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      :host { all: initial; }
      #w {
        display: inline-flex; align-items: center; gap: 10px;
        background: rgba(13, 16, 23, 0.92);
        backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
        border: 1px solid rgba(255,255,255,0.12); border-radius: 999px;
        padding: 8px 14px 8px 12px;
        box-shadow: 0 12px 48px rgba(0,0,0,0.6), 0 4px 16px rgba(0,0,0,0.4),
                    inset 0 1px 0 rgba(255,255,255,0.1);
        cursor: grab; transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
        will-change: transform;
      }
      #w:hover {
        border-color: rgba(255,255,255,0.2);
        box-shadow: 0 16px 56px rgba(0,0,0,0.7), 0 0 20px rgba(${accent.rgb}, 0.25);
      }
      #w:active { cursor: grabbing; }
      #w.minimized { gap: 0; padding: 10px; cursor: pointer; }
      #w.is-paused .dot { background: #f5a623; box-shadow: 0 0 10px rgba(245,166,35,0.9); animation: none; }
      #w.is-paused .dot-ring { display: none; }
      .dot-wrap { position: relative; width: 14px; height: 14px; flex-shrink: 0; }
      .dot {
        width: 14px; height: 14px; border-radius: 50%; background: #ff334b;
        box-shadow: 0 0 12px rgba(255,51,75,0.9), 0 0 4px rgba(255,51,75,0.6);
        animation: blink 1.25s ease-in-out infinite; position: relative; z-index: 1;
      }
      .dot-ring {
        position: absolute; inset: -5px; border-radius: 50%;
        border: 2px solid rgba(255,51,75,0.5); animation: ripple 1.25s ease-out infinite;
      }
      @keyframes blink {
        0%,100% { opacity: 1; box-shadow: 0 0 12px rgba(255,51,75,0.9), 0 0 4px rgba(255,51,75,0.6); }
        50% { opacity: 0.35; box-shadow: 0 0 4px rgba(255,51,75,0.3); }
      }
      @keyframes ripple {
        0% { transform: scale(0.7); opacity: 0.9; }
        100% { transform: scale(1.8); opacity: 0; }
      }
      .rec-label {
        font-size: 11px; font-weight: 800; letter-spacing: 0.12em; color: #ff4d4d;
        text-transform: uppercase; transition: opacity 0.2s, max-width 0.25s;
        overflow: hidden; white-space: nowrap;
      }
      .env-badge {
        font-size: 10px; font-weight: 600; color: ${accent.color};
        background: rgba(${accent.rgb}, 0.14); border: 1px solid rgba(${accent.rgb}, 0.28);
        border-radius: 999px; padding: 2px 8px; white-space: nowrap;
        transition: opacity 0.2s, max-width 0.25s; overflow: hidden;
      }
      .sep { width: 1px; height: 16px; background: rgba(255,255,255,0.12);
             flex-shrink: 0; transition: opacity 0.2s; }
      .timer {
        font-size: 12px; font-weight: 700; color: rgba(255,255,255,0.85);
        font-variant-numeric: tabular-nums; min-width: 38px; text-align: center;
        transition: opacity 0.2s, max-width 0.25s; overflow: hidden; white-space: nowrap;
      }
      .evt-count {
        font-size: 11px; color: rgba(255,255,255,0.45); min-width: 50px; text-align: left;
        transition: opacity 0.2s, max-width 0.25s; overflow: hidden; white-space: nowrap;
      }
      .evt-count b { color: #fff; font-weight: 700; }
      button { font-family: inherit; }
      .btn-icon-ctl {
        width: 22px; height: 22px; border-radius: 50%;
        border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.08);
        color: rgba(255,255,255,0.6); font-size: 11px; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: all 0.15s ease; flex-shrink: 0; line-height: 1;
      }
      .btn-icon-ctl:hover {
        background: rgba(255,255,255,0.2); color: #fff; border-color: rgba(255,255,255,0.35);
        transform: scale(1.05);
      }
      .btn-stop {
        display: flex; align-items: center; gap: 5px;
        background: linear-gradient(135deg, rgba(255,51,75,0.2), rgba(200,30,50,0.25));
        border: 1px solid rgba(255,51,75,0.4); color: #ff7085;
        border-radius: 999px; padding: 4px 12px;
        font-size: 11px; font-weight: 700; cursor: pointer; white-space: nowrap;
        transition: all 0.18s ease; overflow: hidden; flex-shrink: 0;
      }
      .btn-stop:hover {
        background: linear-gradient(135deg, rgba(255,51,75,0.35), rgba(200,30,50,0.4));
        border-color: rgba(255,51,75,0.7); color: #fff;
        box-shadow: 0 0 12px rgba(255,51,75,0.4); transform: scale(1.02);
      }
      .btn-stop .sq { font-size: 9px; }
      #w.minimized .rec-label, #w.minimized .env-badge, #w.minimized .sep,
      #w.minimized .timer, #w.minimized .evt-count, #w.minimized .btn-icon-ctl,
      #w.minimized .btn-stop {
        opacity: 0; max-width: 0; overflow: hidden; pointer-events: none;
      }
    </style>
    <div id="w">
      <div class="dot-wrap"><div class="dot" id="recDot"></div><div class="dot-ring"></div></div>
      <span class="rec-label" id="recLabel">REC</span>
      <span class="env-badge">${patchName}</span>
      <div class="sep"></div>
      <span class="timer" id="tmr">00:00</span>
      <span class="evt-count" id="cnt"><b>0</b>&thinsp;events</span>
      <div class="sep"></div>
      <button class="btn-icon-ctl" id="btnPause" title="Pause recording">&#10074;&#10074;</button>
      <button class="btn-icon-ctl" id="btnMin" title="Minimise">&#8722;</button>
      <button class="btn-stop" id="btnStop" title="Stop recording">
        <span class="sq">■</span> Stop
      </button>
    </div>
  `;
}
