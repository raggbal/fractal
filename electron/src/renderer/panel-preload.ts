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

const TOAST_CSS = `
:host { all: initial; }
.stack { position: fixed; right: 14px; bottom: 14px; z-index: 2147483647; display: flex; flex-direction: column;
  gap: 8px; align-items: flex-end; pointer-events: none; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.toast { pointer-events: auto; box-sizing: border-box; width: 380px; max-width: calc(100vw - 28px); padding: 10px 12px 10px 14px;
  border-radius: 8px; background: #ffffff; color: #1f1f1f; border: 1px solid rgba(0,0,0,.14);
  box-shadow: 0 6px 24px rgba(0,0,0,.18); display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; border-left: 4px solid #2f7de1; }
.toast.dark { background: #252526; color: #e6e6e6; border-color: rgba(255,255,255,.14); }
.toast.warning { border-left-color: #d89614; }
.toast.error { border-left-color: #e5484d; }
.msg { white-space: pre-wrap; word-break: break-word; }
.detail { grid-column: 1 / span 2; white-space: pre-wrap; word-break: break-word; opacity: .75; font-size: 12px; }
.close { appearance: none; border: 0; background: transparent; color: inherit; opacity: .55; cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 4px; }
.close:hover { opacity: 1; }
.buttons { grid-column: 1 / span 2; display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; margin-top: 4px; }
.buttons button { appearance: none; border: 1px solid rgba(127,127,127,.45); background: transparent; color: inherit; border-radius: 5px;
  padding: 3px 10px; font: inherit; cursor: pointer; }
.buttons button:first-child { background: #2f7de1; border-color: #2f7de1; color: #fff; }
.spinner { display: inline-block; width: 10px; height: 10px; margin-right: 7px; border: 2px solid currentColor; border-right-color: transparent;
  border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -1px; opacity: .7; }
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
    close.textContent = '✕';
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
