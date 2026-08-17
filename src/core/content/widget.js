/**
 * widget.js — the floating recording indicator.
 *
 * Injected into the top frame only, inside a shadow root so the host page's
 * stylesheet cannot reach it and ours cannot leak out. Purely presentational:
 * it reports state and offers a Stop button, and knows nothing about capture.
 */

export const WIDGET_HOST_ID = '__flowtrace_widget_host__';

const ACCENTS = {
  oracle: { color: '#f5a623', rgb: '245,166,35' },
  ibm: { color: '#4f8ef7', rgb: '79,142,247' },
  generic: { color: '#2dce7c', rgb: '45,206,124' },
};

let host = null;
let timer = null;
let startedAt = 0;
let minimised = false;
let observer = null;

/**
 * @param {{patchId: string, patchName: string, onStop: () => void}} options
 */
export function mountWidget({ patchId, patchName, onStop }) {
  unmountWidget();

  const accent = ACCENTS[patchId] || ACCENTS.generic;
  startedAt = Date.now();
  minimised = false;

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
  shadow.innerHTML = template(accent, patchName);

  const root = shadow.getElementById('w');
  const clock = shadow.getElementById('tmr');
  const counter = shadow.getElementById('cnt');
  const btnMin = shadow.getElementById('btnMin');
  const btnStop = shadow.getElementById('btnStop');

  timer = setInterval(() => {
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
    if (minimised && e.target !== btnStop) toggle(e);
  });

  btnStop.addEventListener('click', (e) => {
    e.stopPropagation();
    unmountWidget();
    onStop();
  });

  makeDraggable(root);
  host._counter = counter;

  // Some applications replace <body> wholesale on navigation, taking the widget
  // with it. Re-attach rather than leaving the user with no visible indication
  // that recording is still running.
  observer = new MutationObserver(() => {
    if (host && !document.getElementById(WIDGET_HOST_ID)) {
      document.documentElement.appendChild(host);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: false });
}

export function setWidgetCount(n) {
  if (!host || !host._counter) return;
  host._counter.innerHTML = `<b>${n}</b>&thinsp;event${n === 1 ? '' : 's'}`;
}

export function unmountWidget() {
  if (timer) { clearInterval(timer); timer = null; }
  if (observer) { observer.disconnect(); observer = null; }
  if (host) { host.remove(); host = null; }
}

/**
 * True when the node belongs to our own widget.
 *
 * The previous implementation returned true for ANY node inside ANY shadow
 * root, which meant every interaction with a page's own web components was
 * silently discarded. It checks for our host specifically now.
 */
export function isWidgetNode(node) {
  if (!node) return false;
  let current = node;
  while (current) {
    if (current.id === WIDGET_HOST_ID) return true;
    const root = current.getRootNode && current.getRootNode();
    current = root && root.host ? root.host : current.parentElement;
    if (current === document.documentElement) return false;
  }
  return false;
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
    // No preventDefault: it would suppress the host page's own mouse handling.
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
        background: rgba(10, 12, 18, 0.88);
        backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255,255,255,0.1); border-radius: 999px;
        padding: 9px 14px 9px 12px;
        box-shadow: 0 8px 40px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3),
                    inset 0 1px 0 rgba(255,255,255,0.06);
        cursor: grab; transition: gap 0.25s ease, padding 0.25s ease;
        font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
        will-change: transform;
      }
      #w:active { cursor: grabbing; }
      #w.minimized { gap: 0; padding: 11px; cursor: pointer; }
      .dot-wrap { position: relative; width: 14px; height: 14px; flex-shrink: 0; }
      .dot {
        width: 14px; height: 14px; border-radius: 50%; background: #ff3434;
        box-shadow: 0 0 10px rgba(255,52,52,0.9), 0 0 4px rgba(255,52,52,0.6);
        animation: blink 1.25s ease-in-out infinite; position: relative; z-index: 1;
      }
      .dot-ring {
        position: absolute; inset: -5px; border-radius: 50%;
        border: 2px solid rgba(255,52,52,0.5); animation: ripple 1.25s ease-out infinite;
      }
      @keyframes blink {
        0%,100% { opacity: 1; box-shadow: 0 0 10px rgba(255,52,52,0.9), 0 0 4px rgba(255,52,52,0.6); }
        50% { opacity: 0.35; box-shadow: 0 0 4px rgba(255,52,52,0.3); }
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
      .sep { width: 1px; height: 16px; background: rgba(255,255,255,0.1);
             flex-shrink: 0; transition: opacity 0.2s; }
      .timer {
        font-size: 12px; font-weight: 700; color: rgba(255,255,255,0.75);
        font-variant-numeric: tabular-nums; min-width: 36px; text-align: center;
        transition: opacity 0.2s, max-width 0.25s; overflow: hidden; white-space: nowrap;
      }
      .evt-count {
        font-size: 11px; color: rgba(255,255,255,0.4); min-width: 48px; text-align: left;
        transition: opacity 0.2s, max-width 0.25s; overflow: hidden; white-space: nowrap;
      }
      .evt-count b { color: rgba(255,255,255,0.75); font-weight: 700; }
      button { font-family: inherit; }
      .btn-min {
        width: 20px; height: 20px; border-radius: 50%;
        border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.07);
        color: rgba(255,255,255,0.45); font-size: 14px; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
        flex-shrink: 0; line-height: 1;
      }
      .btn-min:hover { background: rgba(255,255,255,0.18); color: #fff;
                       border-color: rgba(255,255,255,0.3); }
      .btn-stop {
        display: flex; align-items: center; gap: 5px;
        background: rgba(255,52,52,0.12); border: 1px solid rgba(255,52,52,0.28);
        color: #ff7070; border-radius: 999px; padding: 4px 12px;
        font-size: 11px; font-weight: 700; cursor: pointer; white-space: nowrap;
        transition: background 0.15s, border-color 0.15s, color 0.15s,
                    opacity 0.2s, max-width 0.25s;
        overflow: hidden; flex-shrink: 0;
      }
      .btn-stop:hover { background: rgba(255,52,52,0.28);
                        border-color: rgba(255,52,52,0.55); color: #ff3434; }
      .btn-stop .sq { font-size: 9px; }
      #w.minimized .rec-label, #w.minimized .env-badge, #w.minimized .sep,
      #w.minimized .timer, #w.minimized .evt-count, #w.minimized .btn-min,
      #w.minimized .btn-stop {
        opacity: 0; max-width: 0; overflow: hidden; pointer-events: none;
      }
    </style>
    <div id="w">
      <div class="dot-wrap"><div class="dot"></div><div class="dot-ring"></div></div>
      <span class="rec-label">REC</span>
      <span class="env-badge">${patchName}</span>
      <div class="sep"></div>
      <span class="timer" id="tmr">00:00</span>
      <span class="evt-count" id="cnt"><b>0</b>&thinsp;events</span>
      <div class="sep"></div>
      <button class="btn-min" id="btnMin" title="Minimise">&#8722;</button>
      <button class="btn-stop" id="btnStop" title="Stop recording">
        <span class="sq">■</span> Stop
      </button>
    </div>
  `;
}
