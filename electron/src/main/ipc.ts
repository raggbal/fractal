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

/** The sidebar page ↔ main (spec 20261107-0431 D4): handles / tokens only, never command ids. */
export const SIDEBAR_CH = {
    /** invoke, renderer → main: () → SidebarPageModel | null */
    getModel: 'fractal-sidebar:get-model',
    /** main → renderer: a new SidebarPageModel */
    model: 'fractal-sidebar:model',
    /** renderer → main: (handle) run the item's TreeItem.command */
    runItem: 'fractal-sidebar:run-item',
    /** renderer → main: (token) a header / row button or a welcome link */
    runAction: 'fractal-sidebar:run-action',
    /** renderer → main: (handle) the item's right-click menu */
    itemMenu: 'fractal-sidebar:item-menu',
    /** renderer → main: (viewId) the header's "…" menu */
    titleMenu: 'fractal-sidebar:title-menu',
    /** renderer → main: (handle) close the open note of this row (its ● → ×) */
    closeNote: 'fractal-sidebar:close-note',
    /** renderer → main: (collapsed) */
    setCollapsed: 'fractal-sidebar:set-collapsed',
    /** renderer → main: (width, done) while dragging the edge / at the end */
    setWidth: 'fractal-sidebar:set-width',
    /** renderer → main: (viewId, expanded) */
    setSection: 'fractal-sidebar:set-section',
} as const;

/** The settings screen ↔ main (settings-window.ts): keys under "fractal." and values only. */
export const SETTINGS_CH = {
    /** invoke, renderer → main: () → SettingsPageState */
    getState: 'fractal-settings:get-state',
    /** invoke, renderer → main: (key, value) → { ok, error? } */
    set: 'fractal-settings:set',
    /** invoke, renderer → main: (key) → { ok, error? } remove the user value */
    reset: 'fractal-settings:reset',
    /** invoke, renderer → main: (key) → a chosen path | null (the field's "Choose…") */
    pick: 'fractal-settings:pick',
    /** renderer → main: open settings.json */
    openFile: 'fractal-settings:open-file',
    /** main → renderer: a new SettingsPageState */
    state: 'fractal-settings:state',
    /** main → renderer: (key) scroll to that setting */
    focus: 'fractal-settings:focus',
} as const;

/** The scheme of a panel's document (VS Code's vscode-webview://): fractal-res://<panelId>/index.html */
export const PANEL_SCHEME = 'fractal-res';
/**
 * The scheme of the app's own pages: fractal-ui://prompt/index.html (prompt session),
 * fractal-ui://sidebar/index.html (sidebar session) and fractal-ui://settings/index.html (settings
 * session). Each session serves only its own host.
 */
export const UI_SCHEME = 'fractal-ui';
