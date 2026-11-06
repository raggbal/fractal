/**
 * WebviewHostAdapter for the desktop app: one WebviewPanel = one BrowserWindow (spec D2).
 *
 * Per panel:
 * - its own in-memory session (pooled): fractal-res://<panelId>/index.html serves the panel's HTML as
 *   the extension set it (CSP / nonce untouched); https is intercepted in that session only and
 *   https://file+.vscode-resource.vscode-cdn.net/<path> is answered from local files inside
 *   controller.resourceRoots() (resolveResourceRequest: '..' / symlink escapes / outside → 404), other
 *   *.vscode-cdn.net hosts → 404, any other host → the network (ADR-0014). Intercepted requests carry
 *   no Origin header and get no CORS check, so a webRequest guard (request-guard.ts) decides first:
 *   the document only for this window's own navigation or frames with the panel's origin (it embeds
 *   the opened note), resources only for frames with the panel's origin. Sandboxed viewer iframes
 *   (origin 'null') get neither. ACAO is the panel origin only, never '*'.
 * - contextIsolation + sandbox, no Node; the preload exposes acquireVsCodeApi() only (src/renderer).
 * - IPC is accepted only from the top frame of that window showing its own fractal-res page.
 * - the window never navigates away: http(s) / mailto open in the OS browser, everything else is dropped.
 * - close (user / quit): hide → the page flushes its pending edits (webview's own flush paths) →
 *   in-flight message handlers drain → the window unloads → onDidDispose fires (VS Code order) →
 *   the shell flushes documents. When the extension disposes the panel, the window goes at once.
 */
import {
    BrowserWindow,
    ipcMain,
    Menu,
    screen,
    session,
    type IpcMainEvent,
    type MenuItemConstructorOptions,
    type OnBeforeRequestListenerDetails,
    type Rectangle,
    type Session,
} from 'electron';
import * as fs from 'fs';
import { Readable } from 'stream';
import { contentTypeFor, resolveResourceRequest, webviewResourcePath } from '../vscode-shim/resource-resolver';
import type { PanelBinding, PanelController, PanelInit, ShimLogger, WebviewHostAdapter } from '../vscode-shim/adapters';
import { PANEL_CH, PANEL_SCHEME } from './ipc';
import { GUARDED_URL_PATTERNS, mayLoadInPanelSession, WEBVIEW_RESOURCE_BASE_HOST } from './request-guard';
import type { WindowBounds } from './app-state';
const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
const FLUSH_TIMEOUT_MS = 3000;
const DRAIN_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 2000;
const DEFAULT_SIZE = { width: 1280, height: 860 };

export interface ToastOptions {
    severity: 'info' | 'warning' | 'error';
    message: string;
    detail?: string;
    items: string[];
    /** 0 = stays until clicked */
    timeoutMs: number;
    progress?: boolean;
}

export interface PanelHostOptions {
    log: ShimLogger;
    preloadPath: string;
    themeCss(): string;
    isDark(): boolean;
    /** Saved bounds for a new window (cascaded when other windows are open). */
    savedBounds(): WindowBounds | undefined;
    onBoundsChanged(bounds: WindowBounds): void;
    onFocused(panel: PanelWindow): void;
    /** After a user / quit close finished (window gone, onDidDispose fired). */
    afterClose(panel: PanelWindow): Promise<void> | void;
    /** The page's renderer process died. */
    onRendererGone(panel: PanelWindow, reason: string): void;
    openExternal(url: string): void;
}

function notFound(extra: Record<string, string> = {}): Response {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', ...extra } });
}

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** A local file as an HTTP response (GET / HEAD, single byte ranges for media / pdf.js). */
async function fileResponse(real: string, req: Request, extra: Record<string, string>): Promise<Response> {
    let size: number;
    try {
        size = (await fs.promises.stat(real)).size;
    } catch {
        return notFound(extra);
    }
    const headers: Record<string, string> = {
        ...extra,
        'content-type': contentTypeFor(real),
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache',
        'cross-origin-resource-policy': 'cross-origin',
    };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers.get('range');
    if (range && size > 0) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m && (m[1] !== '' || m[2] !== '')) {
            if (m[1] === '') {
                start = Math.max(0, size - Number(m[2]));
            } else {
                start = Number(m[1]);
                if (m[2] !== '') {
                    end = Math.min(Number(m[2]), size - 1);
                }
            }
        }
        if (!m || (m[1] === '' && m[2] === '') || start > end || start >= size) {
            return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
        }
        status = 206;
        headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = String(size === 0 ? 0 : end - start + 1);
    if (req.method === 'HEAD' || size === 0) {
        return new Response(null, { status, headers });
    }
    const body = Readable.toWeb(fs.createReadStream(real, { start, end })) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, { status, headers });
}

/** The requesting frame's origin; null without a frame (WebFrameMain throws once the frame is gone). */
function frameOrigin(details: OnBeforeRequestListenerDetails): string | null {
    try {
        return details.frame ? details.frame.origin : null;
    } catch {
        return null;
    }
}

/**
 * Pool of in-memory sessions (a session lives as long as the app): cleared and reused per panel.
 *
 * Who may read the panel's document and its webview resources: requests handled by protocol.handle
 * carry no Origin header and get no CORS check, so the boundary is enforced here, before the handler
 * runs (request-guard.ts). Sandboxed (viewer) iframes have the origin 'null': they can read neither
 * the panel's document (it embeds the opened note) nor note files.
 */
class SessionPool {
    private readonly free: Session[] = [];
    private readonly owners = new Map<Session, PanelWindow>();
    private count = 0;
    private refused = 0;

    constructor(private readonly log: ShimLogger) {}

    acquire(): Session {
        return this.free.pop() ?? this.create();
    }

    bind(ses: Session, panel: PanelWindow): void {
        this.owners.set(ses, panel);
    }

    async release(ses: Session): Promise<void> {
        this.owners.delete(ses);
        for (const scheme of ['https', PANEL_SCHEME]) {
            try {
                if (ses.protocol.isProtocolHandled(scheme)) {
                    ses.protocol.unhandle(scheme);
                }
            } catch {
                /* not handled */
            }
        }
        try {
            await ses.clearStorageData();
            await ses.clearCache();
        } catch {
            /* best effort */
        }
        this.free.push(ses);
    }

    private create(): Session {
        const ses = session.fromPartition(`fractal-panel-${++this.count}`, { cache: false });
        ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
        ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
        ses.setDevicePermissionHandler(() => false);
        ses.setSpellCheckerEnabled(false);
        ses.webRequest.onBeforeRequest({ urls: [...GUARDED_URL_PATTERNS] }, (details, callback) => {
            let allowed = false;
            let origin: string | null = null;
            try {
                origin = frameOrigin(details);
                const panel = this.owners.get(ses);
                allowed = !!panel && panel.mayLoad(details, origin);
            } catch {
                allowed = false;
            }
            if (!allowed && (this.refused++ < 30 || this.refused % 100 === 0)) {
                this.log.warn(
                    `[panel-host] refused a request (#${this.refused}, ${details.resourceType}) from ${origin !== null ? `a frame with origin ${origin}` : 'no frame'}: ${details.url.slice(0, 160)}`
                );
            }
            callback({ cancel: !allowed });
        });
        return ses;
    }
}

export class PanelWindow {
    readonly panelId: string;
    readonly viewType: string;
    /** URL host of the panel page (the panel id). */
    readonly host: string;
    /** fractal-res://<host> — the page origin (VS Code's vscode-webview://<id>). */
    readonly origin: string;
    readonly controller: PanelController;
    readonly win: BrowserWindow;
    /** win.webContents.id (kept: the webContents cannot be read once the window is destroyed) */
    readonly webContentsId: number;
    readonly binding: PanelBinding;
    lastFocusedAt = 0;

    private readonly ses: Session;
    private closing: Promise<void> | null = null;
    private isClosing = false;
    private allowClose = false;
    private gone = false;
    private rendererGone = false;
    private shown = false;
    private flushSeq = 0;
    private readonly flushWaiters = new Map<number, (ok: boolean) => void>();
    private toastSeq = 0;
    private readonly toastWaiters = new Map<number, (index: number | undefined) => void>();
    private boundsTimer: NodeJS.Timeout | null = null;

    constructor(init: PanelInit, private readonly owner: PanelHost, ses: Session, bounds: WindowBounds) {
        const o = owner.options;
        this.panelId = init.panelId;
        this.viewType = init.viewType;
        this.controller = init.controller;
        this.host = init.panelId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        this.origin = `${PANEL_SCHEME}://${this.host}`;
        this.ses = ses;
        this.win = new BrowserWindow({
            ...bounds,
            minWidth: 560,
            minHeight: 360,
            title: init.title,
            show: false,
            backgroundColor: o.isDark() ? '#1f1f1f' : '#ffffff',
            webPreferences: {
                preload: o.preloadPath,
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
                devTools: true,
            },
        });
        this.webContentsId = this.win.webContents.id;
        this.installProtocols();
        this.wire(init.preserveFocus);
        this.binding = {
            load: (generation) => this.load(generation),
            postMessage: (message) => this.post(message),
            setTitle: (title) => {
                if (!this.win.isDestroyed()) {
                    this.win.setTitle(title);
                }
            },
            reveal: (preserveFocus) => this.reveal(preserveFocus),
            optionsChanged: () => undefined, // the resource handler reads controller.resourceRoots() per request
            destroy: () => this.destroyNow(),
        };
    }

    get isGone(): boolean {
        return this.gone || this.win.isDestroyed();
    }

    get isClosingOrGone(): boolean {
        return this.isClosing || this.isGone;
    }

    /** The URL of this panel's own page (anything else in the window is not trusted). */
    isOwnUrl(url: string): boolean {
        try {
            const u = new URL(url);
            return u.protocol === `${PANEL_SCHEME}:` && u.host === this.host && u.pathname === '/index.html';
        } catch {
            return false;
        }
    }

    /** webRequest guard (request-guard.ts): this window's own navigation, frames with the panel's origin. */
    mayLoad(details: OnBeforeRequestListenerDetails, origin: string | null): boolean {
        return mayLoadInPanelSession(
            { url: details.url, resourceType: details.resourceType, webContentsId: details.webContentsId, frameOrigin: origin },
            { origin: this.origin, webContentsId: this.webContentsId, alive: !this.isGone && !this.controller.disposed }
        );
    }

    // --- shim → window -----------------------------------------------------------------------

    private load(generation: number): void {
        if (this.isGone) {
            return;
        }
        this.win.loadURL(`${this.origin}/index.html?gen=${generation}`).catch((err: unknown) => {
            if (!/ERR_ABORTED/.test(String(err))) {
                this.owner.options.log.warn(`[panel ${this.panelId}] load failed:`, err);
            }
        });
    }

    private post(message: unknown): boolean {
        if (this.isGone || this.rendererGone) {
            return false;
        }
        try {
            this.win.webContents.send(PANEL_CH.message, message);
            return true;
        } catch (err) {
            this.owner.options.log.warn(`[panel ${this.panelId}] postMessage failed:`, err);
            return false;
        }
    }

    private reveal(preserveFocus: boolean): void {
        if (this.isClosingOrGone) {
            return;
        }
        if (this.win.isMinimized()) {
            this.win.restore();
        }
        if (preserveFocus) {
            this.win.showInactive();
        } else {
            this.win.show();
            this.win.focus();
        }
        this.shown = true;
    }

    /** The extension disposed the panel: the window goes at once (no flush — VS Code drops it too). */
    private destroyNow(): void {
        if (this.win.isDestroyed()) {
            return;
        }
        this.allowClose = true;
        this.gone = true;
        this.win.destroy();
    }

    // --- window → shim -----------------------------------------------------------------------

    receive(message: unknown): void {
        this.controller.receiveMessage(message);
    }

    /** `result` is what the page's flush returned ({ error } when it could not run). */
    flushDone(token: unknown, result?: unknown): void {
        if (typeof token !== 'number') {
            return;
        }
        const error = result && typeof result === 'object' ? (result as { error?: unknown }).error : undefined;
        if (typeof error === 'string') {
            this.owner.options.log.warn(`[panel ${this.panelId}] the page flush did not run: ${error.slice(0, 300)}`);
        }
        const w = this.flushWaiters.get(token);
        if (w) {
            this.flushWaiters.delete(token);
            w(true);
        }
    }

    toastDone(id: unknown, index: unknown): void {
        if (typeof id !== 'number') {
            return;
        }
        const w = this.toastWaiters.get(id);
        if (w) {
            this.toastWaiters.delete(id);
            w(typeof index === 'number' && index >= 0 ? index : undefined);
        }
    }

    /**
     * Asks the page to run its own flush paths; resolves true once every message the flush produced
     * has reached the host (the ack travels on the same IPC pipe, after them), false on timeout.
     */
    flushRenderer(mode: 'close' | 'save', timeoutMs = FLUSH_TIMEOUT_MS): Promise<boolean> {
        if (this.isGone || this.rendererGone || this.win.webContents.isDestroyed() || this.win.webContents.isCrashed()) {
            return Promise.resolve(false);
        }
        const token = ++this.flushSeq;
        return new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
                if (this.flushWaiters.delete(token)) {
                    resolve(false);
                }
            }, timeoutMs);
            this.flushWaiters.set(token, (ok) => {
                clearTimeout(timer);
                resolve(ok);
            });
            try {
                this.win.webContents.send(PANEL_CH.flush, token, mode);
            } catch {
                this.flushWaiters.delete(token);
                clearTimeout(timer);
                resolve(false);
            }
        });
    }

    /** File > Save: the page's pending edits now, then the extension's own 'save' (flushes its debounce). */
    async saveNow(): Promise<boolean> {
        if (this.isClosingOrGone || this.controller.disposed) {
            return false;
        }
        const ok = await this.flushRenderer('save');
        await this.controller.drainMessageHandlers(DRAIN_TIMEOUT_MS);
        if (this.viewType === 'fractal.notes' && !this.controller.disposed) {
            // the same message the md editor's host.save() posts: NotesFileManager.flushSave()
            this.controller.receiveMessage({ type: 'save' });
            await this.controller.drainMessageHandlers(DRAIN_TIMEOUT_MS);
        }
        return ok;
    }

    /** User / quit close with VS Code's order and the page's pending edits saved. Idempotent. */
    closeGracefully(): Promise<void> {
        if (!this.closing) {
            this.isClosing = true;
            this.closing = this.runClose().catch((err) => {
                this.owner.options.log.error(`[panel ${this.panelId}] close failed:`, err);
                this.destroyNow();
                if (!this.controller.disposed) {
                    this.controller.disposeByUser();
                }
            });
            this.owner.trackClosing(this.closing);
        }
        return this.closing;
    }

    private async runClose(): Promise<void> {
        const log = this.owner.options.log;
        if (!this.controller.disposed && !this.rendererGone && !this.isGone) {
            try {
                this.win.hide(); // gone for the user at once; the page keeps running until flushed
            } catch {
                /* ignore */
            }
            const flushed = await this.flushRenderer('close');
            if (!flushed) {
                log.warn(`[panel ${this.panelId}] the page did not confirm its flush in time; closing anyway`);
            }
            await this.controller.drainMessageHandlers(DRAIN_TIMEOUT_MS);
        }
        await this.unloadWindow();
        if (!this.controller.disposed) {
            this.controller.disposeByUser(); // onDidDispose → the extension writes what it holds
        }
        await this.owner.options.afterClose(this);
    }

    /** Let the page unload normally (close), falling back to destroy. */
    private unloadWindow(): Promise<void> {
        if (this.win.isDestroyed()) {
            this.gone = true;
            return Promise.resolve();
        }
        const closed = new Promise<void>((resolve) => this.win.once('closed', () => resolve()));
        this.allowClose = true;
        try {
            this.win.close();
        } catch {
            /* destroyed meanwhile */
        }
        return Promise.race([closed, delay(CLOSE_TIMEOUT_MS)]).then(() => {
            if (!this.win.isDestroyed()) {
                this.win.destroy();
            }
            this.gone = true;
        });
    }

    showToast(t: ToastOptions): { id: number; result: Promise<number | undefined> } {
        const id = ++this.toastSeq;
        if (this.isClosingOrGone || this.rendererGone) {
            return { id, result: Promise.resolve(undefined) };
        }
        const result = new Promise<number | undefined>((resolve) => {
            this.toastWaiters.set(id, resolve);
        });
        try {
            this.win.webContents.send(PANEL_CH.toast, { id, ...t, dark: this.owner.options.isDark() });
        } catch {
            this.toastDone(id, -1);
        }
        return { id, result };
    }

    updateToast(id: number, t: ToastOptions): void {
        if (!this.isGone && this.toastWaiters.has(id)) {
            try {
                this.win.webContents.send(PANEL_CH.toast, { id, ...t, dark: this.owner.options.isDark() });
            } catch {
                /* ignore */
            }
        }
    }

    closeToast(id: number): void {
        if (!this.isGone) {
            try {
                this.win.webContents.send(PANEL_CH.toastClose, id);
            } catch {
                /* ignore */
            }
        }
        this.toastDone(id, -1);
    }

    /** VS Code semantics: active = the last focused panel; visible = shown and not minimized. */
    updateViewState(): void {
        if (this.isClosingOrGone || this.controller.disposed) {
            return;
        }
        const visible = this.win.isVisible() && !this.win.isMinimized();
        this.controller.setViewState({ active: visible && this.owner.isLastFocused(this), visible });
    }

    // --- wiring ------------------------------------------------------------------------------

    private installProtocols(): void {
        this.ses.protocol.handle(PANEL_SCHEME, (req) => this.serveDocument(req));
        this.ses.protocol.handle('https', (req) => this.serveHttps(req));
    }

    private serveDocument(req: Request): Response {
        let u: URL;
        try {
            u = new URL(req.url);
        } catch {
            return notFound();
        }
        if (u.host !== this.host || u.pathname !== '/index.html' || req.method !== 'GET' || this.controller.disposed) {
            return notFound();
        }
        return new Response(this.controller.html, {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
        });
    }

    private async serveHttps(req: Request): Promise<Response> {
        const resourcePath = webviewResourcePath(req.url);
        if (resourcePath === null) {
            let host = '';
            try {
                host = new URL(req.url).hostname.toLowerCase();
            } catch {
                return notFound();
            }
            if (host === WEBVIEW_RESOURCE_BASE_HOST || host.endsWith(`.${WEBVIEW_RESOURCE_BASE_HOST}`)) {
                return notFound(); // never to the network
            }
            return this.ses.fetch(req, { bypassCustomProtocolHandlers: true });
        }
        // The requester's origin is checked by the webRequest guard (SessionPool) — the handler sees no
        // Origin header today; if one ever appears it must be the panel's own.
        const origin = req.headers.get('origin');
        if (origin !== null && origin !== this.origin) {
            return new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }
        const cors: Record<string, string> = {
            'access-control-allow-origin': this.origin,
            'access-control-expose-headers': 'Accept-Ranges, Content-Range, Content-Length, Content-Type',
            vary: 'Origin',
        };
        if (req.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: { ...cors, 'access-control-allow-methods': 'GET, HEAD', 'access-control-allow-headers': 'range', 'access-control-max-age': '600' },
            });
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return new Response(null, { status: 405, headers: cors });
        }
        if (this.controller.disposed) {
            return notFound(cors);
        }
        const real = resolveResourceRequest(resourcePath, this.controller.resourceRoots());
        if (!real) {
            return notFound(cors);
        }
        return fileResponse(real, req, cors);
    }

    private wire(preserveFocus: boolean): void {
        const win = this.win;
        const wc = win.webContents;
        const log = this.owner.options.log;

        win.on('page-title-updated', (e) => e.preventDefault()); // the window title is the panel title
        win.once('ready-to-show', () => this.showFirstTime(preserveFocus));
        // never stay invisible if the page is slow to paint
        setTimeout(() => this.showFirstTime(preserveFocus), 5000).unref?.();

        win.on('focus', () => {
            if (this.isClosingOrGone) {
                return;
            }
            this.lastFocusedAt = Date.now();
            this.owner.panelFocused(this);
        });
        for (const ev of ['show', 'hide', 'minimize', 'restore'] as const) {
            win.on(ev as 'show', () => this.updateViewState());
        }
        const boundsChanged = () => {
            if (this.boundsTimer) {
                clearTimeout(this.boundsTimer);
            }
            this.boundsTimer = setTimeout(() => {
                this.boundsTimer = null;
                if (!win.isDestroyed() && !win.isMinimized() && !win.isFullScreen()) {
                    this.owner.options.onBoundsChanged(win.getNormalBounds());
                }
            }, 500);
        };
        win.on('resize', boundsChanged);
        win.on('move', boundsChanged);

        win.on('close', (e) => {
            if (this.allowClose) {
                return;
            }
            e.preventDefault();
            void this.closeGracefully();
        });
        win.on('closed', () => this.onClosed());

        // --- the page never leaves its document ---
        wc.on('will-navigate', (e) => {
            if (this.isOwnUrl(e.url)) {
                return;
            }
            e.preventDefault();
            this.owner.options.openExternal(e.url);
        });
        wc.on('will-redirect', (e) => {
            if (e.isMainFrame && !this.isOwnUrl(e.url)) {
                e.preventDefault();
            }
        });
        wc.setWindowOpenHandler(({ url }) => {
            this.owner.options.openExternal(url);
            return { action: 'deny' };
        });
        wc.on('will-attach-webview', (e) => e.preventDefault());
        // a beforeunload handler must not keep a closing window alive
        wc.on('will-prevent-unload', (e) => e.preventDefault());
        // The page's own context menus (md editor, outliner, folder view) cancel the DOM event, so this
        // fires only where the page leaves the right-click alone (search fields, source mode, a text
        // selection): the plain edit menu VS Code shows in a webview there. No undo / redo — the page
        // runs its own undo stacks.
        wc.on('context-menu', (_e, params) => {
            if (this.isClosingOrGone) {
                return;
            }
            const f = params.editFlags;
            const items: MenuItemConstructorOptions[] = params.isEditable
                ? [
                      { role: 'cut', enabled: f.canCut },
                      { role: 'copy', enabled: f.canCopy },
                      { role: 'paste', enabled: f.canPaste },
                      { type: 'separator' },
                      { role: 'selectAll', enabled: f.canSelectAll },
                  ]
                : params.selectionText
                  ? [{ role: 'copy', enabled: f.canCopy }]
                  : [];
            if (items.length > 0) {
                Menu.buildFromTemplate(items).popup({ window: win });
            }
        });

        wc.on('render-process-gone', (_e, details) => {
            this.rendererGone = true;
            for (const w of this.flushWaiters.values()) {
                w(false);
            }
            this.flushWaiters.clear();
            if (this.isClosing || details.reason === 'clean-exit') {
                return;
            }
            log.error(`[panel ${this.panelId}] renderer gone: ${details.reason} (exit ${details.exitCode})`);
            this.owner.options.onRendererGone(this, details.reason);
        });
        wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
            if (isMainFrame && code !== -3) {
                log.warn(`[panel ${this.panelId}] did-fail-load ${code} ${description} ${url}`);
            }
        });
        wc.on('console-message', (e) => {
            if (e.level === 'error') {
                log.warn(`[webview ${this.panelId}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
            }
        });
    }

    private showFirstTime(preserveFocus: boolean): void {
        if (this.shown || this.isClosingOrGone) {
            return;
        }
        this.shown = true;
        if (preserveFocus) {
            this.win.showInactive();
        } else {
            this.win.show();
        }
    }

    private onClosed(): void {
        this.gone = true;
        for (const w of this.flushWaiters.values()) {
            w(false);
        }
        this.flushWaiters.clear();
        for (const w of this.toastWaiters.values()) {
            w(undefined);
        }
        this.toastWaiters.clear();
        if (this.boundsTimer) {
            clearTimeout(this.boundsTimer);
            this.boundsTimer = null;
        }
        this.owner.forget(this, this.ses);
        if (!this.isClosing && !this.controller.disposed) {
            // closed by something other than the user / extension (e.g. the app exiting): dispose now
            this.controller.disposeByUser();
        }
    }
}

export class PanelHost implements WebviewHostAdapter {
    private readonly panels = new Map<string, PanelWindow>();
    private readonly byWebContents = new Map<number, PanelWindow>();
    private readonly pool: SessionPool;
    private lastFocused: PanelWindow | undefined;
    private rejectedLogged = 0;
    private readonly inflight = new Set<Promise<void>>();

    constructor(readonly options: PanelHostOptions) {
        this.pool = new SessionPool(options.log);
        this.registerIpc();
    }

    createPanel(init: PanelInit): PanelBinding {
        const ses = this.pool.acquire();
        const panel = new PanelWindow(init, this, ses, this.nextBounds());
        this.pool.bind(ses, panel);
        this.panels.set(panel.panelId, panel);
        this.byWebContents.set(panel.win.webContents.id, panel);
        if (!init.preserveFocus) {
            this.lastFocused = panel;
        }
        return panel.binding;
    }

    all(): PanelWindow[] {
        return Array.from(this.panels.values()).filter((p) => !p.isGone);
    }

    get(panelId: string): PanelWindow | undefined {
        return this.panels.get(panelId);
    }

    fromWindow(win: BrowserWindow | null | undefined): PanelWindow | undefined {
        if (!win || win.isDestroyed()) {
            return undefined;
        }
        return this.byWebContents.get(win.webContents.id);
    }

    /** The focused panel window, else the most recently focused one still open. */
    current(): PanelWindow | undefined {
        const focused = this.fromWindow(BrowserWindow.getFocusedWindow());
        if (focused && !focused.isClosingOrGone) {
            return focused;
        }
        if (this.lastFocused && !this.lastFocused.isClosingOrGone) {
            return this.lastFocused;
        }
        return this.all()
            .filter((p) => !p.isClosingOrGone)
            .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)[0];
    }

    isLastFocused(panel: PanelWindow): boolean {
        return this.lastFocused === panel;
    }

    panelFocused(panel: PanelWindow): void {
        this.lastFocused = panel;
        for (const p of this.all()) {
            p.updateViewState();
        }
        this.options.onFocused(panel);
    }

    /** Closes every panel window (each with its flush) and waits for closes already under way. */
    async closeAll(): Promise<void> {
        const closes = this.all().map((p) => p.closeGracefully());
        await Promise.allSettled([...closes, ...this.inflight]);
    }

    trackClosing(p: Promise<void>): void {
        this.inflight.add(p);
        void p.finally(() => this.inflight.delete(p));
    }

    /** Called from the window's 'closed' event. */
    forget(panel: PanelWindow, ses: Session): void {
        this.panels.delete(panel.panelId);
        for (const [id, p] of this.byWebContents) {
            if (p === panel) {
                this.byWebContents.delete(id);
            }
        }
        if (this.lastFocused === panel) {
            this.lastFocused = undefined;
        }
        void this.pool.release(ses);
    }

    private nextBounds(): WindowBounds {
        const saved = this.options.savedBounds();
        const width = saved?.width ?? DEFAULT_SIZE.width;
        const height = saved?.height ?? DEFAULT_SIZE.height;
        const open = this.all().length;
        if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
            const rect: Rectangle = { x: saved.x + open * 26, y: saved.y + open * 26, width, height };
            const area = screen.getDisplayMatching(rect).workArea;
            const visible =
                rect.x < area.x + area.width - 80 && rect.x + rect.width > area.x + 80 && rect.y >= area.y - 10 && rect.y < area.y + area.height - 80;
            if (visible) {
                return rect;
            }
        }
        const area = screen.getPrimaryDisplay().workArea;
        const w = Math.min(width, area.width);
        const h = Math.min(height, area.height);
        return {
            width: w,
            height: h,
            x: Math.round(area.x + (area.width - w) / 2) + open * 26,
            y: Math.round(area.y + (area.height - h) / 2) + open * 26,
        };
    }

    /** Only the top frame of a panel window showing its own page may talk to the shim. */
    private panelFor(e: IpcMainEvent): PanelWindow | undefined {
        const panel = this.byWebContents.get(e.sender.id);
        const frame = e.senderFrame;
        if (!panel || panel.isGone || !frame || frame.parent !== null || !panel.isOwnUrl(frame.url)) {
            // the window's initial empty document runs the preload too (url '' / about:blank): expected, not logged
            const url = frame?.url ?? '';
            if (url !== '' && url !== 'about:blank' && this.rejectedLogged++ < 20) {
                this.options.log.warn(`[panel-host] rejected IPC from webContents ${e.sender.id} (${url})`);
            }
            return undefined;
        }
        return panel;
    }

    private registerIpc(): void {
        ipcMain.on(PANEL_CH.init, (e) => {
            const panel = this.panelFor(e);
            if (!panel || panel.controller.disposed) {
                e.returnValue = { ok: false };
                return;
            }
            let state: unknown;
            try {
                state = structuredClone(panel.controller.getState());
            } catch {
                state = undefined;
            }
            e.returnValue = { ok: true, state, themeCss: this.options.themeCss() };
        });
        ipcMain.on(PANEL_CH.post, (e, message: unknown) => {
            this.panelFor(e)?.receive(message);
        });
        ipcMain.on(PANEL_CH.setState, (e, state: unknown) => {
            this.panelFor(e)?.controller.setState(state);
        });
        ipcMain.on(PANEL_CH.ready, (e, generation: unknown) => {
            const panel = this.panelFor(e);
            if (panel && typeof generation === 'number' && Number.isInteger(generation)) {
                panel.controller.contentReady(generation);
            }
        });
        ipcMain.on(PANEL_CH.flushDone, (e, token: unknown, result: unknown) => {
            this.panelFor(e)?.flushDone(token, result);
        });
        ipcMain.on(PANEL_CH.toastResult, (e, id: unknown, index: unknown) => {
            this.panelFor(e)?.toastDone(id, index);
        });
    }
}
