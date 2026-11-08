/**
 * showInputBox / showQuickPick: a small sheet on the window the user works in (or a centered window
 * when none is open) showing fractal-ui://prompt/index.html. The page is the app's own code
 * (src/renderer/prompt-page.ts) served from a dedicated session; it gets the request over IPC and
 * renders it with textContent only. Like VS Code's quick input, a new prompt replaces an open one
 * (the old one resolves as dismissed). Its look is the Fractal design (docs/design/modern-2026.md
 * §7.4 / §7.5 / §7.7): prompt.css is the extension's tokens.css + fr-base.css, then the page's own CSS.
 */
import { BrowserWindow, ipcMain, session, type BaseWindow, type IpcMainEvent, type IpcMainInvokeEvent, type Session } from 'electron';
import * as fs from 'fs';
import type { InputBoxRequest, QuickPickRequest, ShimLogger } from '../vscode-shim/adapters';
import { PROMPT_CH, UI_SCHEME } from './ipc';
import { plainLabel } from './labels';
import { surfaceColors } from './theme';

interface PromptPayload {
    kind: 'input' | 'pick';
    title?: string;
    prompt?: string;
    placeHolder?: string;
    value?: string;
    valueSelection?: [number, number];
    password?: boolean;
    items?: Array<{ label: string; description?: string; detail?: string; separator: boolean; picked: boolean }>;
    canPickMany?: boolean;
    dark: boolean;
}

interface Pending {
    payload: PromptPayload;
    validate?: (value: string) => Promise<string | undefined>;
    win: BrowserWindow;
    finish(result: unknown): void;
}

export interface PromptServiceOptions {
    log: ShimLogger;
    preloadPath: string;
    /** out/renderer/prompt-page.js */
    pageScriptPath: string;
    parentWindow(): BaseWindow | undefined;
    isDark(): boolean;
    /** The extension's tokens.css + fr-base.css (design-tokens.ts) */
    designCss(): string;
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en" data-fr-theme="auto">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'">
<title>Fractal</title>
<link rel="stylesheet" href="prompt.css">
</head>
<body><div id="root"></div><script src="prompt.js"></script></body>
</html>
`;

/**
 * After tokens.css + fr-base.css: the sheet on bg-elevated; title 14px / 600, text 13px; the input
 * 28px on fill-subtle (no frame until focus: focus-ring + halo); the items 28px, corners 6px, the
 * active one fill-active (not blue); group names 11px / 600 tertiary, not uppercased; the buttons 28px,
 * Cancel secondary, OK primary (the right one).
 */
const PAGE_CSS = `
html, body { margin: 0; height: 100%; background: var(--fr-color-bg-elevated); color: var(--fr-color-text-primary);
  font-family: var(--fr-font-sans); font-size: var(--fr-text-base); line-height: 1.4; }
#root { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; height: 100%; }
.title { font-size: var(--fr-text-md); font-weight: 600; }
.prompt { color: var(--fr-color-text-secondary); line-height: 1.5; white-space: pre-wrap; }
.field { width: 100%; height: 28px; flex: none; padding: 0 8px; border: 1px solid transparent; border-radius: var(--fr-radius-sm);
  background: var(--fr-color-fill-subtle); color: var(--fr-color-text-primary); font: inherit; outline: none; }
.field::placeholder { color: var(--fr-color-text-tertiary); }
.field:hover:not(:focus) { background: var(--fr-color-fill-hover); }
.field:focus { background: var(--fr-color-bg-elevated); border-color: var(--fr-color-focus-ring); box-shadow: var(--fr-shadow-focus); }
.field.invalid { border-color: var(--fr-color-danger); box-shadow: 0 0 0 3px var(--fr-color-danger-soft); }
.validation { color: var(--fr-color-danger); font-size: var(--fr-text-sm); white-space: pre-wrap; }
.list { flex: 1; overflow-y: auto; min-height: 60px; }
.row { display: flex; align-items: flex-start; gap: 8px; min-height: 28px; padding: 5px 10px; border-radius: var(--fr-radius-sm); cursor: default; }
.row.active { background: var(--fr-color-fill-active); }
.row .text { min-width: 0; flex: 1; }
.row .line { display: flex; gap: 8px; align-items: baseline; }
.row .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .description, .row .detail { color: var(--fr-color-text-tertiary); font-size: var(--fr-text-sm); white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.row.active .description, .row.active .detail { color: var(--fr-color-text-secondary); }
.row .check { margin: 2px 0 0; }
.separator { padding: 6px 10px 2px; color: var(--fr-color-text-tertiary); font-size: var(--fr-text-xs); font-weight: 600; }
.separator.rule { padding: 0; margin: 4px 10px; border-top: 1px solid var(--fr-color-border); }
.empty { padding: 8px 10px; color: var(--fr-color-text-tertiary); }
.buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: auto; }
button { appearance: none; height: 28px; padding: 0 12px; border-radius: var(--fr-radius-sm); font: inherit; font-weight: 500; cursor: pointer; }
button.secondary { border: 1px solid var(--fr-color-border-strong); background: var(--fr-color-bg-elevated); color: var(--fr-color-text-primary); }
button.secondary:hover { background-image: linear-gradient(var(--fr-color-fill-hover), var(--fr-color-fill-hover)); }
button.secondary:active { background-image: linear-gradient(var(--fr-color-fill-active), var(--fr-color-fill-active)); }
button.primary { border: 1px solid transparent; background: var(--fr-color-primary); color: var(--fr-color-primary-fg); }
button.primary:hover { background: var(--fr-color-primary-hover); }
button.primary:active { background: var(--fr-color-primary-active); }
`;

function textResponse(body: string, type: string): Response {
    return new Response(body, {
        status: 200,
        headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
}

export class PromptService {
    private readonly pending = new Map<number, Pending>();
    private current: Pending | undefined;
    private readonly ses: Session;

    constructor(private readonly o: PromptServiceOptions) {
        this.ses = session.fromPartition('fractal-ui', { cache: false });
        this.ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
        this.ses.setPermissionCheckHandler(() => false);
        this.ses.protocol.handle(UI_SCHEME, (req) => this.serve(req));
        ipcMain.handle(PROMPT_CH.get, (e) => this.forEvent(e)?.payload ?? null);
        ipcMain.handle(PROMPT_CH.validate, async (e, value: unknown) => {
            const p = this.forEvent(e);
            if (!p || !p.validate) {
                return undefined;
            }
            try {
                return await p.validate(String(value ?? ''));
            } catch {
                return undefined;
            }
        });
        ipcMain.on(PROMPT_CH.done, (e, result: unknown) => {
            this.forEvent(e)?.finish(result);
        });
    }

    async input(req: InputBoxRequest): Promise<string | undefined> {
        const result = (await this.open(
            {
                kind: 'input',
                title: req.title ? plainLabel(req.title) : undefined,
                prompt: req.prompt,
                placeHolder: req.placeHolder,
                value: req.value,
                valueSelection: req.valueSelection,
                password: req.password,
                dark: this.o.isDark(),
            },
            req.prompt ? 168 : 146,
            (v) => req.validate(v)
        )) as { value?: unknown } | null;
        return result && typeof result.value === 'string' ? result.value : undefined;
    }

    async pick(req: QuickPickRequest): Promise<number[] | undefined> {
        const items = req.items.map((it) => ({
            label: plainLabel(it.label),
            description: it.description ? plainLabel(it.description) : undefined,
            detail: it.detail ? plainLabel(it.detail) : undefined,
            separator: it.separator,
            picked: it.picked,
        }));
        const rows = items.reduce((h, it) => h + (it.separator ? 22 : it.detail ? 44 : 28), 0);
        const height = Math.max(170, Math.min(560, (req.title ? 104 : 82) + rows + (req.canPickMany ? 44 : 0)));
        const result = (await this.open(
            { kind: 'pick', title: req.title ? plainLabel(req.title) : undefined, placeHolder: req.placeHolder, items, canPickMany: req.canPickMany, dark: this.o.isDark() },
            height
        )) as { indices?: unknown } | null;
        if (!result || !Array.isArray(result.indices)) {
            return undefined;
        }
        const picked = result.indices.filter((i): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < items.length && !items[i].separator);
        if (!req.canPickMany && picked.length === 0) {
            return undefined;
        }
        return req.canPickMany ? picked : picked.slice(0, 1);
    }

    private open(payload: PromptPayload, height: number, validate?: (value: string) => Promise<string | undefined>): Promise<unknown> {
        this.current?.finish(null);
        const parent = this.o.parentWindow();
        const win = new BrowserWindow({
            parent,
            modal: !!parent,
            width: 560,
            height,
            useContentSize: true,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            alwaysOnTop: !parent,
            show: false,
            title: payload.title || 'Fractal',
            backgroundColor: surfaceColors(payload.dark).elevated,
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
        const wc = win.webContents;
        wc.on('will-navigate', (e) => e.preventDefault());
        wc.setWindowOpenHandler(() => ({ action: 'deny' }));
        return new Promise<unknown>((resolve) => {
            let done = false;
            const wcId = wc.id;
            const pending: Pending = {
                payload,
                validate,
                win,
                finish: (result) => {
                    if (done) {
                        return;
                    }
                    done = true;
                    this.pending.delete(wcId);
                    if (this.current === pending) {
                        this.current = undefined;
                    }
                    resolve(result);
                    if (!win.isDestroyed()) {
                        win.destroy();
                    }
                },
            };
            this.pending.set(wcId, pending);
            this.current = pending;
            win.on('closed', () => pending.finish(null));
            win.once('ready-to-show', () => {
                if (!win.isDestroyed()) {
                    win.show();
                }
            });
            win.loadURL(`${UI_SCHEME}://prompt/index.html`).catch((err: unknown) => {
                this.o.log.warn('[prompt] load failed:', err);
                pending.finish(null);
            });
        });
    }

    private forEvent(e: IpcMainEvent | IpcMainInvokeEvent): Pending | undefined {
        const p = this.pending.get(e.sender.id);
        const url = e.senderFrame?.url ?? '';
        if (!p || !e.senderFrame || e.senderFrame.parent !== null || !url.startsWith(`${UI_SCHEME}://prompt/`)) {
            return undefined;
        }
        return p;
    }

    private serve(req: Request): Response {
        let u: URL;
        try {
            u = new URL(req.url);
        } catch {
            return new Response('Not found', { status: 404 });
        }
        if (u.host !== 'prompt' || req.method !== 'GET') {
            return new Response('Not found', { status: 404 });
        }
        switch (u.pathname) {
            case '/index.html':
                return textResponse(PAGE_HTML, 'text/html');
            case '/prompt.css':
                return textResponse(`${this.o.designCss()}\n${PAGE_CSS}`, 'text/css');
            case '/prompt.js': {
                let js = '';
                try {
                    js = fs.readFileSync(this.o.pageScriptPath, 'utf8');
                } catch (err) {
                    this.o.log.error('[prompt] page script missing:', err);
                }
                return textResponse(js, 'text/javascript');
            }
            default:
                return new Response('Not found', { status: 404 });
        }
    }
}
