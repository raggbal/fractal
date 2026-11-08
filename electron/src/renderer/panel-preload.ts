/**
 * Preload of a Notes panel window (sandbox + contextIsolation, ADR-0013 / spec D3).
 *
 * The page gets exactly one global: acquireVsCodeApi() — VS Code's webview API (postMessage /
 * getState / setState), callable once like VS Code. Everything else stays in this isolated world:
 *   page → host   acquireVsCodeApi().postMessage(msg)   → ipc 'fractal-panel:post'
 *   host → page   ipc 'fractal-panel:message'           → window.postMessage(msg) ('message' event, like VS Code)
 *   ready         DOMContentLoaded of this document     → ipc 'fractal-panel:content-ready' (generation)
 *   flush         ipc 'fractal-panel:flush'             → the page's own flush paths run, then
 *                 'fractal-panel:flush-done' on the SAME pipe, so the host has every message the flush
 *                 produced before it sees the ack (close / quit / Save)
 *   theme         --vscode-* CSS variables (webFrame.insertCSS: not subject to the page CSP)
 *   toasts        non-modal show*Message, drawn in a closed shadow root
 *
 * A sandboxed preload can only require('electron'): the channel names are duplicated from
 * electron/src/main/ipc.ts — keep both in sync.
 */
import { contextBridge, ipcRenderer, webFrame } from 'electron';

const CH = {
    init: 'fractal-panel:init',
    post: 'fractal-panel:post',
    setState: 'fractal-panel:set-state',
    ready: 'fractal-panel:content-ready',
    message: 'fractal-panel:message',
    flush: 'fractal-panel:flush',
    flushDone: 'fractal-panel:flush-done',
    toast: 'fractal-panel:toast',
    toastClose: 'fractal-panel:toast-close',
    toastResult: 'fractal-panel:toast-result',
} as const;

interface InitReply {
    ok: boolean;
    state?: unknown;
    themeCss?: string;
}

interface ToastRequest {
    id: number;
    severity: 'info' | 'warning' | 'error';
    message: string;
    detail?: string;
    items: string[];
    /** 0 = stays until a button / ✕ is clicked */
    timeoutMs: number;
    progress?: boolean;
    dark?: boolean;
}

const generation = Number(new URLSearchParams(location.search).get('gen') || '0') || 0;

let init: InitReply | null = null;
try {
    init = ipcRenderer.sendSync(CH.init, generation) as InitReply | null;
} catch {
    init = null;
}

if (init && init.ok) {
    setUpPanel(init);
}

function setUpPanel(reply: InitReply): void {
    if (reply.themeCss) {
        try {
            webFrame.insertCSS(reply.themeCss);
        } catch {
            /* the page still works with its own fallbacks */
        }
    }

    // --- acquireVsCodeApi (VS Code: one instance per webview; state survives reloads of the same panel) ---
    let state: unknown = reply.state;
    let acquired = false;
    contextBridge.exposeInMainWorld('acquireVsCodeApi', () => {
        if (acquired) {
            throw new Error('An instance of the VS Code API has already been acquired');
        }
        acquired = true;
        return {
            postMessage: (message: unknown) => {
                ipcRenderer.send(CH.post, message);
            },
            setState: (newState: unknown) => {
                state = newState;
                ipcRenderer.send(CH.setState, newState);
                return newState;
            },
            getState: () => state,
        };
    });

    // --- host → page ---
    ipcRenderer.on(CH.message, (_event, data: unknown) => {
        window.postMessage(data, '*');
    });

    window.addEventListener(
        'DOMContentLoaded',
        () => {
            ipcRenderer.send(CH.ready, generation);
        },
        { once: true }
    );

    // --- flush (before close / quit / Save) ---
    ipcRenderer.on(CH.flush, (_event, token: number, mode: string) => {
        let result: unknown = null;
        try {
            result = contextBridge.executeInMainWorld({ func: flushPageInMainWorld, args: [mode === 'save' ? 'save' : 'close'] });
        } catch (err) {
            result = { error: String(err) };
        }
        // same pipe as the page's postMessage calls above → the host receives them before this ack
        ipcRenderer.send(CH.flushDone, token, result);
    });

    // --- toasts ---
    ipcRenderer.on(CH.toast, (_event, req: ToastRequest) => showToast(req));
    ipcRenderer.on(CH.toastClose, (_event, id: number) => removeToast(id, false));
}

/**
 * Runs in the page's world (serialized by executeInMainWorld: no closure variables).
 * Uses the webview's own flush paths only:
 *   - Outliner.flushSync(): the outliner's debounced sync (the page's tab manager calls it before unload)
 *   - a 'visibilitychange' to hidden: the md editors flush their unsynced edits exactly as when
 *     VS Code hides or unloads the webview (editor.js _handleVisibilityChange)
 */
function flushPageInMainWorld(mode: string): { outliner: boolean; hidden: boolean } {
    const w = window as unknown as { Outliner?: { flushSync?: () => void } };
    const r = { outliner: false, hidden: false };
    try {
        if (w.Outliner && typeof w.Outliner.flushSync === 'function') {
            w.Outliner.flushSync();
            r.outliner = true;
        }
    } catch (e) {
        /* keep flushing the rest */
    }
    let shadowed = false;
    try {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        shadowed = true;
        document.dispatchEvent(new Event('visibilitychange'));
        r.hidden = true;
    } catch (e) {
        /* ignore */
    } finally {
        if (shadowed) {
            delete (document as unknown as Record<string, unknown>).visibilityState;
            delete (document as unknown as Record<string, unknown>).hidden;
        }
    }
    if (mode === 'save' && shadowed) {
        // Save keeps the window: tell the listeners the page is visible again
        try {
            document.dispatchEvent(new Event('visibilitychange'));
        } catch (e) {
            /* ignore */
        }
    }
    return r;
}

// ---------------------------------------------------------------------------------------------
// Toasts (VS Code's non-modal notifications): a closed shadow root on <html>, outside the page's DOM
// ---------------------------------------------------------------------------------------------

/*
 * The Fractal design (docs/design/modern-2026.md §5.1 / §7.4 / §7.8): a floating card — bg-elevated,
 * 1px border, corners 10px, shadow 3 — with a severity dot instead of a colored left edge, a 12px ×,
 * the first action a primary button. The --fr-* tokens come from the note page's own tokens.css
 * (custom properties inherit into the shadow root); the fallbacks are only for a page without them.
 */
const TOAST_CSS = `
:host { all: initial; }
.stack { position: fixed; right: 14px; bottom: 14px; z-index: 2147483647; display: flex; flex-direction: column;
  gap: 8px; align-items: flex-end; pointer-events: none; font-family: var(--fr-font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 13px; line-height: 1.4; }
.toast { --fb-bg: #ffffff; --fb-fg: #18181b; --fb-sub: #52525b; --fb-border: #e2e2e6; --fb-hover: rgba(24,24,27,.055);
  pointer-events: auto; box-sizing: border-box; width: 380px; max-width: calc(100vw - 28px); padding: 10px 8px 10px 12px;
  border-radius: var(--fr-radius-lg, 10px); background: var(--fr-color-bg-elevated, var(--fb-bg)); color: var(--fr-color-text-primary, var(--fb-fg));
  border: 1px solid var(--fr-color-border, var(--fb-border));
  box-shadow: var(--fr-shadow-3, 0 2px 6px rgba(17,17,20,.06), 0 12px 32px rgba(17,17,20,.14));
  display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; align-items: start; }
.toast.dark { --fb-bg: #2a2a2e; --fb-fg: #ededef; --fb-sub: #b4b4bc; --fb-border: #38383e; --fb-hover: rgba(255,255,255,.06); }
.msg { position: relative; padding: 1px 0 0 16px; white-space: pre-wrap; word-break: break-word; }
.msg::before { content: ''; position: absolute; left: 1px; top: 7px; width: 8px; height: 8px; border-radius: 50%;
  background: var(--fr-color-primary-strong, #0256c3); }
.toast.warning .msg::before { background: var(--fr-color-warning, #d97706); }
.toast.error .msg::before { background: var(--fr-color-danger, #c21d1d); }
.spinner + .msg { display: inline; padding-left: 0; }
.spinner + .msg::before { display: none; }
.detail { grid-column: 1 / span 2; padding-left: 16px; white-space: pre-wrap; word-break: break-word; font-size: 12px;
  color: var(--fr-color-text-secondary, var(--fb-sub)); }
.close { appearance: none; border: 0; margin: -1px 0 0; padding: 0; width: 20px; height: 20px; border-radius: var(--fr-radius-xs, 4px);
  background: transparent; color: var(--fr-color-text-tertiary, var(--fb-sub)); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.close:hover { background: var(--fr-color-fill-hover, var(--fb-hover)); color: var(--fr-color-text-primary, var(--fb-fg)); }
.close svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.buttons { grid-column: 1 / span 2; display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; margin-top: 4px; padding-right: 4px; }
.buttons button { appearance: none; height: 24px; padding: 0 10px; border-radius: var(--fr-radius-sm, 6px); font: inherit; font-size: 12px;
  font-weight: 500; cursor: pointer; border: 1px solid var(--fr-color-border-strong, var(--fb-border));
  background: var(--fr-color-bg-elevated, var(--fb-bg)); color: var(--fr-color-text-primary, var(--fb-fg)); }
.buttons button:hover { background-image: linear-gradient(var(--fr-color-fill-hover, var(--fb-hover)), var(--fr-color-fill-hover, var(--fb-hover))); }
.buttons button:first-child { border-color: transparent; background: var(--fr-color-primary, #0a68e6); color: var(--fr-color-primary-fg, #ffffff); }
.buttons button:first-child:hover { background: var(--fr-color-primary-hover, #0256c3); }
.close:focus-visible, .buttons button:focus-visible { outline: 2px solid var(--fr-color-focus-ring, #0a68e6); outline-offset: 1px; }
.spinner { display: inline-block; width: 10px; height: 10px; margin-right: 7px; border: 2px solid var(--fr-color-primary-strong, currentColor);
  border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -1px; }
@keyframes spin { to { transform: rotate(360deg); } }
`;

let toastHost: HTMLElement | null = null;
let toastStack: HTMLElement | null = null;
const toasts = new Map<number, { el: HTMLElement; timer: ReturnType<typeof setTimeout> | null }>();

function ensureStack(): HTMLElement | null {
    if (toastStack && toastHost && toastHost.isConnected) {
        return toastStack;
    }
    const parent = document.documentElement;
    if (!parent) {
        return null;
    }
    toastHost = document.createElement('fractal-desktop-toasts');
    const root = toastHost.attachShadow({ mode: 'closed' });
    try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(TOAST_CSS);
        root.adoptedStyleSheets = [sheet];
    } catch {
        const style = document.createElement('style');
        style.textContent = TOAST_CSS;
        root.appendChild(style);
    }
    toastStack = document.createElement('div');
    toastStack.className = 'stack';
    root.appendChild(toastStack);
    parent.appendChild(toastHost);
    return toastStack;
}

function removeToast(id: number, report: boolean, index = -1): void {
    const t = toasts.get(id);
    if (!t) {
        return;
    }
    toasts.delete(id);
    if (t.timer) {
        clearTimeout(t.timer);
    }
    t.el.remove();
    if (report) {
        ipcRenderer.send(CH.toastResult, id, index);
    }
}

function showToast(req: ToastRequest): void {
    const existing = toasts.get(req.id);
    if (existing) {
        // progress updates reuse the toast
        const msg = existing.el.querySelector('.msg');
        if (msg) {
            msg.textContent = req.message;
        }
        return;
    }
    const stack = ensureStack();
    if (!stack) {
        ipcRenderer.send(CH.toastResult, req.id, -1);
        return;
    }
    const el = document.createElement('div');
    el.className = `toast ${req.severity}${req.dark ? ' dark' : ''}`;
    el.setAttribute('role', req.severity === 'error' ? 'alert' : 'status');
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = req.message;
    if (req.progress) {
        const wrap = document.createElement('div');
        const spin = document.createElement('span');
        spin.className = 'spinner';
        wrap.appendChild(spin);
        wrap.appendChild(msg);
        el.appendChild(wrap);
    } else {
        el.appendChild(msg);
    }
    const close = document.createElement('button');
    close.className = 'close';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    // Lucide x (12px): the glyph buttons other than ☰ are icons (docs/design/modern-2026.md §5.5)
    const x = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    x.setAttribute('viewBox', '0 0 24 24');
    x.setAttribute('aria-hidden', 'true');
    const xPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    xPath.setAttribute('d', 'M18 6 6 18M6 6l12 12');
    x.appendChild(xPath);
    close.appendChild(x);
    close.addEventListener('click', () => removeToast(req.id, true, -1));
    el.appendChild(close);
    if (req.detail) {
        const detail = document.createElement('div');
        detail.className = 'detail';
        detail.textContent = req.detail;
        el.appendChild(detail);
    }
    if (req.items.length > 0) {
        const buttons = document.createElement('div');
        buttons.className = 'buttons';
        req.items.forEach((title, index) => {
            const b = document.createElement('button');
            b.textContent = title;
            b.addEventListener('click', () => removeToast(req.id, true, index));
            buttons.appendChild(b);
        });
        el.appendChild(buttons);
    }
    stack.appendChild(el);
    const timer = req.timeoutMs > 0 ? setTimeout(() => removeToast(req.id, true, -1), req.timeoutMs) : null;
    toasts.set(req.id, { el, timer });
}
