/**
 * The settings screen (Fractal ▸ Settings…, ⌘,): fractal-ui://settings/index.html in its own window. It
 * shows the extension's contributed settings as fields (settings-schema.ts) and writes a change at once
 * through the shim's getConfiguration().update — userData/User/settings.json, JSONC kept — so open notes
 * pick it up like in VS Code. The page is the app's own code (src/renderer/settings-page.ts) served from
 * a dedicated session; IPC is taken only from that window's top frame, and every key and value is checked
 * against the schema before it is written. settings.json can still be opened from the screen.
 */
import { BrowserWindow, dialog, ipcMain, session, type IpcMainEvent, type IpcMainInvokeEvent, type OpenDialogOptions, type Session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { ShimLogger } from '../vscode-shim/adapters';
import { SETTINGS_CH, UI_SCHEME } from './ipc';
import { buildSettingsSchema, checkSettingValue, findField, nlsSuffix, type SettingField, type SettingSection } from './settings-schema';
import { settingsTexts, type SettingsTexts } from './settings-texts';
import { surfaceColors } from './theme';

interface FractalConfig {
    get(key: string): unknown;
    inspect(key: string): { globalValue?: unknown } | undefined;
    update(key: string, value: unknown, target?: number): Promise<void>;
}

export interface SettingsWorkspace {
    getConfiguration(section: string): FractalConfig;
}

export interface SettingsPageState {
    dark: boolean;
    texts: SettingsTexts;
    sections: SettingSection[];
    /** the values in effect (user value, else the default) */
    values: Record<string, unknown>;
    /** keys with a user value (they get "Reset") */
    modified: string[];
    /** settings.json cannot be parsed: the screen is read-only */
    error?: string;
}

export interface SettingsWindowOptions {
    log: ShimLogger;
    preloadPath: string;
    /** out/renderer/settings-page.js */
    pageScriptPath: string;
    extensionRoot: string;
    /** The extension's tokens.css + fr-base.css (design-tokens.ts) */
    designCss(): string;
    isDark(): boolean;
    /** The extension's vscode.workspace (undefined until it runs) */
    workspace(): SettingsWorkspace | undefined;
    /** The system language (FRACTAL_LANG / app.getLocale()), used while fractal.language is "default" */
    systemLanguage(): string;
    /** The parse error of settings.json, if any (writes are refused then) */
    settingsError(): string | undefined;
    openSettingsFile(): void;
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en" data-fr-theme="auto">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'">
<title>Settings</title>
<link rel="stylesheet" href="settings.css">
</head>
<body><div id="root"></div><script src="settings.js"></script></body>
</html>
`;

/**
 * After tokens.css + fr-base.css (docs/design/modern-2026.md): the page on bg-app, one column of at most
 * 720px; a section title 15px / 600; a row = title 13px / 500, description 12px secondary, then the
 * control; controls 28px on fill-subtle (the prompt's field), buttons like the prompt's.
 */
const PAGE_CSS = `
html, body { margin: 0; background: var(--fr-color-bg-app); color: var(--fr-color-text-primary);
  font-family: var(--fr-font-sans); font-size: var(--fr-text-base); line-height: 1.45; }
#root { max-width: 720px; margin: 0 auto; padding: 18px 24px 28px; }
h1 { font-size: var(--fr-text-lg, 18px); font-weight: 600; margin: 0 0 12px; }
h2 { font-size: var(--fr-text-md); font-weight: 600; margin: 22px 0 6px; padding-bottom: 6px; border-bottom: 1px solid var(--fr-color-border); }
.banner { padding: 8px 12px; border-radius: var(--fr-radius-sm); background: var(--fr-color-danger-soft); color: var(--fr-color-danger); margin-bottom: 12px; white-space: pre-wrap; }
.row { padding: 10px 0; display: flex; flex-direction: column; gap: 6px; }
.row + .row { border-top: 1px solid var(--fr-color-border-subtle, var(--fr-color-border)); }
.head { display: flex; align-items: baseline; gap: 8px; }
.title { font-weight: 500; }
.reset { margin-left: auto; }
.description { color: var(--fr-color-text-secondary); font-size: var(--fr-text-sm); white-space: pre-wrap; }
.line { display: flex; align-items: center; gap: 8px; }
.error { color: var(--fr-color-danger); font-size: var(--fr-text-sm); }
.field { height: 28px; flex: 1; min-width: 0; padding: 0 8px; border: 1px solid transparent; border-radius: var(--fr-radius-sm);
  background: var(--fr-color-fill-subtle); color: var(--fr-color-text-primary); font: inherit; outline: none; }
.field.number { flex: none; width: 120px; }
select.field { flex: none; min-width: 200px; }
.field::placeholder { color: var(--fr-color-text-tertiary); }
.field:hover:not(:focus):not(:disabled) { background: var(--fr-color-fill-hover); }
.field:focus { background: var(--fr-color-bg-elevated); border-color: var(--fr-color-focus-ring); box-shadow: var(--fr-shadow-focus); }
.check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.check input { width: 16px; height: 16px; margin: 0; accent-color: var(--fr-color-primary); }
.list { display: flex; flex-direction: column; gap: 4px; }
.item { display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 0 0 0 8px; border-radius: var(--fr-radius-sm); background: var(--fr-color-fill-subtle); }
.item .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--fr-font-mono, ui-monospace, monospace); font-size: var(--fr-text-sm); }
.empty { color: var(--fr-color-text-tertiary); font-size: var(--fr-text-sm); }
.footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid var(--fr-color-border); }
button { appearance: none; height: 28px; padding: 0 12px; border-radius: var(--fr-radius-sm); font: inherit; font-weight: 500; cursor: pointer; flex: none;
  border: 1px solid var(--fr-color-border-strong); background: var(--fr-color-bg-elevated); color: var(--fr-color-text-primary); }
button:hover:not(:disabled) { background-image: linear-gradient(var(--fr-color-fill-hover), var(--fr-color-fill-hover)); }
button:active:not(:disabled) { background-image: linear-gradient(var(--fr-color-fill-active), var(--fr-color-fill-active)); }
button.link { height: 22px; padding: 0 6px; border: none; background: transparent; color: var(--fr-color-text-secondary); font-size: var(--fr-text-sm); }
button.link:hover:not(:disabled) { color: var(--fr-color-text-primary); }
button:disabled, .field:disabled, .check input:disabled { opacity: 0.55; cursor: default; }
`;

function textResponse(body: string, type: string): Response {
    return new Response(body, {
        status: 200,
        headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
}

function readJson(file: string): Record<string, unknown> | undefined {
    try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
    } catch {
        return undefined;
    }
}

/** A chosen .app (macOS) → the program inside it (the browser for PDF export) */
export function appExecutable(p: string): string {
    if (!/\.app\/?$/.test(p)) {
        return p;
    }
    const dir = path.join(p, 'Contents', 'MacOS');
    const own = path.join(dir, path.basename(p.replace(/\/$/, ''), '.app'));
    if (fs.existsSync(own)) {
        return own;
    }
    try {
        const first = fs.readdirSync(dir).find((n) => !n.startsWith('.'));
        return first ? path.join(dir, first) : p;
    } catch {
        return p;
    }
}

export class SettingsWindow {
    private win: BrowserWindow | undefined;
    private readonly ses: Session;
    /** the setting to scroll to once the page is up (openSettings('fractal.resourceRoots')) */
    private focusKey: string | undefined;

    constructor(private readonly o: SettingsWindowOptions) {
        this.ses = session.fromPartition('fractal-settings', { cache: false });
        this.ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
        this.ses.setPermissionCheckHandler(() => false);
        this.ses.protocol.handle(UI_SCHEME, (req) => this.serve(req));
        ipcMain.handle(SETTINGS_CH.getState, (e) => (this.isOurs(e) ? this.state() : null));
        ipcMain.handle(SETTINGS_CH.set, (e, key: unknown, value: unknown) => (this.isOurs(e) ? this.set(key, value) : { ok: false, error: 'refused' }));
        ipcMain.handle(SETTINGS_CH.reset, (e, key: unknown) => (this.isOurs(e) ? this.set(key, undefined) : { ok: false, error: 'refused' }));
        ipcMain.handle(SETTINGS_CH.pick, (e, key: unknown) => (this.isOurs(e) ? this.pick(key) : null));
        ipcMain.on(SETTINGS_CH.openFile, (e: IpcMainEvent) => {
            if (this.isOurs(e)) {
                this.o.openSettingsFile();
            }
        });
    }

    /** Opens the screen (or brings it to the front); focusKey = scroll to that setting */
    open(focusKey?: string): void {
        this.focusKey = focusKey;
        if (this.win && !this.win.isDestroyed()) {
            if (this.win.isMinimized()) {
                this.win.restore();
            }
            this.win.show();
            this.win.focus();
            this.sendFocus();
            return;
        }
        const dark = this.o.isDark();
        const win = new BrowserWindow({
            width: 760,
            height: 720,
            minWidth: 520,
            minHeight: 360,
            show: false,
            title: this.texts().title,
            backgroundColor: surfaceColors(dark).app,
            webPreferences: {
                preload: this.o.preloadPath,
                session: this.ses,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                spellcheck: false,
                webviewTag: false,
                navigateOnDragDrop: false,
            },
        });
        this.win = win;
        const wc = win.webContents;
        wc.on('will-navigate', (e) => e.preventDefault());
        wc.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.once('ready-to-show', () => {
            if (!win.isDestroyed()) {
                win.show();
            }
        });
        wc.on('did-finish-load', () => this.sendFocus());
        win.on('closed', () => {
            if (this.win === win) {
                this.win = undefined;
            }
        });
        win.loadURL(`${UI_SCHEME}://settings/index.html`).catch((err: unknown) => {
            this.o.log.warn('[settings] load failed:', err);
        });
    }

    private sendFocus(): void {
        const win = this.win;
        const key = this.focusKey;
        if (key && win && !win.isDestroyed() && !win.webContents.isLoading()) {
            this.focusKey = undefined;
            win.webContents.send(SETTINGS_CH.focus, key);
        }
    }

    /** A setting / the theme / the language changed: show the new state */
    refresh(): void {
        const win = this.win;
        if (!win || win.isDestroyed()) {
            return;
        }
        const state = this.state();
        if (state) {
            win.setTitle(state.texts.title);
            win.webContents.send(SETTINGS_CH.state, state);
        }
    }

    private language(): string {
        let lang: unknown;
        try {
            lang = this.o.workspace()?.getConfiguration('fractal').get('language');
        } catch {
            lang = undefined;
        }
        return typeof lang === 'string' && lang && lang !== 'default' ? lang : this.o.systemLanguage();
    }

    private texts(): SettingsTexts {
        return settingsTexts(this.language());
    }

    private sections(): SettingSection[] {
        const root = this.o.extensionRoot;
        const pkg = readJson(path.join(root, 'package.json'));
        const en = (readJson(path.join(root, 'package.nls.json')) ?? {}) as Record<string, string>;
        const suffix = nlsSuffix(this.language());
        const nls = suffix ? ((readJson(path.join(root, `package.nls.${suffix}.json`)) ?? en) as Record<string, string>) : en;
        return buildSettingsSchema(pkg, nls, en);
    }

    private state(): SettingsPageState | null {
        const ws = this.o.workspace();
        const sections = this.sections();
        const values: Record<string, unknown> = {};
        const modified: string[] = [];
        if (ws) {
            const cfg = ws.getConfiguration('fractal');
            for (const s of sections) {
                for (const f of s.fields) {
                    values[f.key] = cfg.get(f.key);
                    if (cfg.inspect(f.key)?.globalValue !== undefined) {
                        modified.push(f.key);
                    }
                }
            }
        }
        const error = ws ? this.o.settingsError() : 'Fractal is starting…';
        return { dark: this.o.isDark(), texts: this.texts(), sections, values, modified, error };
    }

    private field(key: unknown): SettingField | undefined {
        return typeof key === 'string' ? findField(this.sections(), key) : undefined;
    }

    private async set(key: unknown, value: unknown): Promise<{ ok: boolean; error?: string }> {
        const ws = this.o.workspace();
        const field = this.field(key);
        if (!ws || !field) {
            return { ok: false, error: 'unknown setting' };
        }
        let next: unknown = undefined;
        if (value !== undefined) {
            const checked = checkSettingValue(field, value);
            if (!checked.ok) {
                return { ok: false, error: checked.error };
            }
            next = checked.value;
        }
        try {
            await ws.getConfiguration('fractal').update(field.key, next, 1 /* ConfigurationTarget.Global */);
            this.o.log.info(`[settings] ${next === undefined ? 'reset' : 'set'} fractal.${field.key}`);
            return { ok: true };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.o.log.warn(`[settings] could not write fractal.${field.key}:`, message);
            return { ok: false, error: message };
        } finally {
            this.refresh();
        }
    }

    private async pick(key: unknown): Promise<string | null> {
        const field = this.field(key);
        const win = this.win;
        if (!field?.pick || !win || win.isDestroyed()) {
            return null;
        }
        const opts: OpenDialogOptions = { title: field.title, message: field.title, properties: ['openFile'] };
        if (field.pick === 'folder') {
            opts.properties = ['openDirectory', 'createDirectory'];
        } else if (field.pick === 'css') {
            opts.filters = [{ name: 'CSS', extensions: ['css'] }];
        } else if (field.pick === 'terminology') {
            opts.filters = [{ name: 'CSV / TMX', extensions: ['csv', 'tmx', 'xml'] }];
        } else if (field.pick === 'browser' && process.platform === 'darwin') {
            opts.defaultPath = '/Applications';
            opts.filters = [{ name: 'Applications', extensions: ['app'] }];
        }
        const r = await dialog.showOpenDialog(win, opts);
        if (r.canceled || r.filePaths.length === 0) {
            return null;
        }
        const chosen = r.filePaths[0];
        return field.pick === 'browser' ? appExecutable(chosen) : chosen;
    }

    private isOurs(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
        const win = this.win;
        const url = e.senderFrame?.url ?? '';
        return !!win && !win.isDestroyed() && e.sender.id === win.webContents.id && !!e.senderFrame && e.senderFrame.parent === null
            && url.startsWith(`${UI_SCHEME}://settings/`);
    }

    private serve(req: Request): Response {
        let u: URL;
        try {
            u = new URL(req.url);
        } catch {
            return new Response('Not found', { status: 404 });
        }
        if (u.host !== 'settings' || req.method !== 'GET') {
            return new Response('Not found', { status: 404 });
        }
        switch (u.pathname) {
            case '/index.html':
                return textResponse(PAGE_HTML, 'text/html');
            case '/settings.css':
                return textResponse(`${this.o.designCss()}\n${PAGE_CSS}`, 'text/css');
            case '/settings.js': {
                let js = '';
                try {
                    js = fs.readFileSync(this.o.pageScriptPath, 'utf8');
                } catch (err) {
                    this.o.log.error('[settings] page script missing:', err);
                }
                return textResponse(js, 'text/javascript');
            }
            default:
                return new Response('Not found', { status: 404 });
        }
    }
}
