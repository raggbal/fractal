/**
 * The sidebar of a window (spec 20261107-0431-electron-sidebar): a WebContentsView left of the note
 * views, showing the app's own page fractal-ui://sidebar/index.html (src/renderer/sidebar-page.ts) from
 * a dedicated in-memory session that serves only that host.
 *
 * D4: sandbox + contextIsolation, no Node; the preload exposes the list model, handle / token based
 * calls and the sidebar's UI state only. Every IPC message is answered only for the top frame of a
 * window's own sidebar page (acceptSidebarSender) — anything else is dropped (and logged). The page
 * never navigates and opens nothing; its CSP allows only its own script and style.
 */
import { ipcMain, session, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent, type Session } from 'electron';
import * as fs from 'fs';
import type { ShimLogger } from '../vscode-shim/adapters';
import { SIDEBAR_CH, UI_SCHEME } from './ipc';
import { SIDEBAR_CSP, SIDEBAR_PAGE_CSS, SIDEBAR_PAGE_HTML } from './sidebar-assets';
import { acceptSidebarSender, SIDEBAR_PAGE_URL, type SidebarPageModel } from './sidebar-model';

function textResponse(body: string, type: string, extra: Record<string, string> = {}): Response {
    return new Response(body, {
        status: 200,
        headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra },
    });
}

function notFound(): Response {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** The window side of one sidebar (AppWindow implements it). */
export interface SidebarOwner {
    /** false once the window is closing / gone */
    readonly alive: boolean;
    sidebarModel(): SidebarPageModel | null;
    runItem(handle: unknown): void;
    runAction(token: unknown): void;
    showItemMenu(handle: unknown): void;
    showTitleMenu(viewId: unknown): void;
    closeNote(handle: unknown): void;
    setCollapsed(collapsed: unknown): void;
    setSidebarWidth(width: unknown, done: unknown): void;
    setSectionExpanded(viewId: unknown, expanded: unknown): void;
}

export interface SidebarServiceOptions {
    log: ShimLogger;
    preloadPath: string;
    /** out/renderer/sidebar-page.js */
    pageScriptPath: string;
    /** The --vscode-* variables of the note views (theme.ts) */
    themeCss(): string;
}

export class SidebarView {
    readonly view: WebContentsView;
    readonly webContentsId: number;
    private destroyed = false;

    constructor(readonly owner: SidebarOwner, ses: Session, preloadPath: string, background: string, private readonly log: ShimLogger) {
        this.view = new WebContentsView({
            webPreferences: {
                preload: preloadPath,
                session: ses,
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
                nodeIntegrationInWorker: false,
                nodeIntegrationInSubFrames: false,
                webSecurity: true,
                allowRunningInsecureContent: false,
                webviewTag: false,
                navigateOnDragDrop: false,
                spellcheck: false,
                safeDialogs: true,
            },
        });
        this.view.setBackgroundColor(background);
        const wc = this.view.webContents;
        this.webContentsId = wc.id;
        wc.on('will-navigate', (e) => {
            if (e.url !== SIDEBAR_PAGE_URL) {
                e.preventDefault();
            }
        });
        wc.on('will-redirect', (e) => e.preventDefault());
        wc.setWindowOpenHandler(() => ({ action: 'deny' }));
        wc.on('will-attach-webview', (e) => e.preventDefault());
        wc.on('will-prevent-unload', (e) => e.preventDefault());
        wc.on('destroyed', () => {
            this.destroyed = true;
        });
        wc.on('render-process-gone', (_e, details) => {
            if (this.destroyed || !this.owner.alive || details.reason === 'clean-exit') {
                return;
            }
            this.log.error(`[sidebar] renderer gone: ${details.reason}; reloading the sidebar`);
            setTimeout(() => this.load(), 500);
        });
        wc.on('console-message', (e) => {
            if (e.level === 'error') {
                this.log.warn(`[sidebar page] ${e.message} (${e.sourceId}:${e.lineNumber})`);
            }
        });
        this.load();
    }

    get isDestroyed(): boolean {
        return this.destroyed || this.view.webContents.isDestroyed();
    }

    load(): void {
        if (this.isDestroyed) {
            return;
        }
        this.view.webContents.loadURL(SIDEBAR_PAGE_URL).catch((err: unknown) => {
            if (!/ERR_ABORTED/.test(String(err))) {
                this.log.warn('[sidebar] load failed:', err);
            }
        });
    }

    push(model: SidebarPageModel): void {
        if (this.isDestroyed) {
            return;
        }
        try {
            this.view.webContents.send(SIDEBAR_CH.model, model);
        } catch (err) {
            this.log.warn('[sidebar] model push failed:', err);
        }
    }

    setBackground(color: string): void {
        if (!this.isDestroyed) {
            this.view.setBackgroundColor(color);
        }
    }

    close(): void {
        if (!this.isDestroyed) {
            try {
                this.view.webContents.close();
            } catch {
                /* already gone */
            }
        }
    }
}

/** The sidebar session (shared by every window's sidebar) and the IPC handlers. */
export class SidebarService {
    private readonly ses: Session;
    private readonly views = new Map<number, SidebarView>();
    private rejected = 0;

    constructor(private readonly o: SidebarServiceOptions) {
        this.ses = session.fromPartition('fractal-sidebar', { cache: false });
        this.ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
        this.ses.setPermissionCheckHandler(() => false);
        this.ses.setDevicePermissionHandler(() => false);
        this.ses.setSpellCheckerEnabled(false);
        this.ses.protocol.handle(UI_SCHEME, (req) => this.serve(req));
        this.registerIpc();
    }

    create(owner: SidebarOwner, background: string): SidebarView {
        const v = new SidebarView(owner, this.ses, this.o.preloadPath, background, this.o.log);
        this.views.set(v.webContentsId, v);
        v.view.webContents.once('destroyed', () => this.views.delete(v.webContentsId));
        return v;
    }

    private serve(req: Request): Response {
        let u: URL;
        try {
            u = new URL(req.url);
        } catch {
            return notFound();
        }
        if (u.host !== 'sidebar' || req.method !== 'GET') {
            return notFound();
        }
        switch (u.pathname) {
            case '/index.html':
                return textResponse(SIDEBAR_PAGE_HTML, 'text/html', { 'content-security-policy': SIDEBAR_CSP });
            case '/sidebar.css':
                return textResponse(`${this.o.themeCss()}\n${SIDEBAR_PAGE_CSS}`, 'text/css');
            case '/sidebar.js': {
                let js = '';
                try {
                    js = fs.readFileSync(this.o.pageScriptPath, 'utf8');
                } catch (err) {
                    this.o.log.error('[sidebar] page script missing:', err);
                }
                return textResponse(js, 'text/javascript');
            }
            default:
                return notFound();
        }
    }

    /** The sidebar whose page sent this: its window's own top frame only (D4, L-20261106-electron-shell-guards). */
    private ownerFor(e: IpcMainEvent | IpcMainInvokeEvent): SidebarOwner | undefined {
        const v = this.views.get(e.sender.id);
        const frame = e.senderFrame;
        let frameUrl: string | undefined;
        let isTopFrame = false;
        try {
            frameUrl = frame?.url;
            isTopFrame = !!frame && frame.parent === null;
        } catch {
            frameUrl = undefined;
        }
        const ok = acceptSidebarSender(
            { senderId: e.sender.id, frameUrl, isTopFrame },
            v ? { webContentsId: v.webContentsId, alive: v.owner.alive && !v.isDestroyed } : undefined
        );
        if (!ok) {
            if (frameUrl && frameUrl !== 'about:blank' && this.rejected++ < 20) {
                this.o.log.warn(`[sidebar] rejected IPC from webContents ${e.sender.id} (${frameUrl.slice(0, 120)})`);
            }
            return undefined;
        }
        return v?.owner;
    }

    private registerIpc(): void {
        ipcMain.handle(SIDEBAR_CH.getModel, (e) => this.ownerFor(e)?.sidebarModel() ?? null);
        ipcMain.on(SIDEBAR_CH.runItem, (e, handle: unknown) => this.ownerFor(e)?.runItem(handle));
        ipcMain.on(SIDEBAR_CH.runAction, (e, token: unknown) => this.ownerFor(e)?.runAction(token));
        ipcMain.on(SIDEBAR_CH.itemMenu, (e, handle: unknown) => this.ownerFor(e)?.showItemMenu(handle));
        ipcMain.on(SIDEBAR_CH.titleMenu, (e, viewId: unknown) => this.ownerFor(e)?.showTitleMenu(viewId));
        ipcMain.on(SIDEBAR_CH.closeNote, (e, handle: unknown) => this.ownerFor(e)?.closeNote(handle));
        ipcMain.on(SIDEBAR_CH.setCollapsed, (e, collapsed: unknown) => this.ownerFor(e)?.setCollapsed(collapsed));
        ipcMain.on(SIDEBAR_CH.setWidth, (e, width: unknown, done: unknown) => this.ownerFor(e)?.setSidebarWidth(width, done));
        ipcMain.on(SIDEBAR_CH.setSection, (e, viewId: unknown, expanded: unknown) => this.ownerFor(e)?.setSectionExpanded(viewId, expanded));
    }
}
