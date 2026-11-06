/**
 * IPC channel names and URL schemes shared by the main-process modules.
 * The sandboxed preloads (src/renderer/*-preload.ts) cannot import this file: they repeat the
 * strings — change both together.
 */
export const PANEL_CH = {
    /** sendSync, renderer → main: (generation) → { ok, state, themeCss } */
    init: 'fractal-panel:init',
    /** renderer → main: one webview → host message (acquireVsCodeApi().postMessage) */
    post: 'fractal-panel:post',
    /** renderer → main: acquireVsCodeApi().setState(state) */
    setState: 'fractal-panel:set-state',
    /** renderer → main: DOMContentLoaded of the page of (generation) */
    ready: 'fractal-panel:content-ready',
    /** main → renderer: one host → webview message */
    message: 'fractal-panel:message',
    /** main → renderer: (token, 'close' | 'save') run the page's flush paths */
    flush: 'fractal-panel:flush',
    /** renderer → main: (token, result) every message the flush produced was sent before this */
    flushDone: 'fractal-panel:flush-done',
    /** main → renderer: show / update a toast */
    toast: 'fractal-panel:toast',
    /** main → renderer: (id) remove a toast */
    toastClose: 'fractal-panel:toast-close',
    /** renderer → main: (id, index | -1) */
    toastResult: 'fractal-panel:toast-result',
} as const;

export const PROMPT_CH = {
    get: 'fractal-prompt:get',
    validate: 'fractal-prompt:validate',
    done: 'fractal-prompt:done',
} as const;

/** The scheme of a panel's document (VS Code's vscode-webview://): fractal-res://<panelId>/index.html */
export const PANEL_SCHEME = 'fractal-res';
/** The scheme of the app's own small pages (prompt): fractal-ui://prompt/index.html */
export const UI_SCHEME = 'fractal-ui';
