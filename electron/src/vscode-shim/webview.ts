/**
 * window.createWebviewPanel → WebviewPanel / Webview with the semantics of VS Code's
 * ExtHostWebviewPanel / ExtHostWebview. The window itself is the host's PanelBinding.
 *
 * - webview.asWebviewUri / cspSource return exactly VS Code's strings
 *   (https://file+.vscode-resource.vscode-cdn.net/<path>, "'self' https://*.vscode-cdn.net"):
 *   the extension's webview code builds and strips that form itself (editor.js, editor-utils.js
 *   cleanImageSrc on the md save path, outliner-cell.js, pdf-export-webview.js,
 *   paste-asset-handler.ts), so any other form would break images and could write app URLs into
 *   saved markdown (ADR-0014). The shell serves that host from local files only.
 * - html: an identical string is a no-op; otherwise the document reloads (generation + 1).
 * - postMessage: the payload is cloned at call time like VS Code (JSON semantics: toJSON honored,
 *   undefined / functions dropped; ArrayBuffers and typed arrays kept as binary). Messages wait in
 *   a FIFO until the page of the current generation reports DOMContentLoaded (VS Code's
 *   pendingMessages). After dispose it resolves false.
 * - onDidReceiveMessage: listeners run per message in arrival order and are not awaited; their
 *   promises are tracked so the shell can drain them before closing.
 * - options setter swaps localResourceRoots WITHOUT reloading the page (deliberate: VS Code reloads,
 *   which would re-run the extension's stale initial HTML). Resource roots also always include the
 *   app's read-only asset folders (out/webview, media, vendor) — in VS Code those are reachable only
 *   because ~/.vscode/extensions sits under the default $HOME root.
 * - dispose(): fires onDidDispose once (listeners in registration order), then destroys the window.
 *   After dispose, panel.webview / title / reveal and the html / options setters throw like VS Code.
 * - notesFolder(): the note folder a Notes panel shows, fixed when the panel is created (see
 *   identifyNotesFolder) — the shell remembers / reopens notes and matches panels with it.
 */
import * as path from 'path';
import { EventEmitter, reportListenerError } from './events';
import { Uri } from './uri';
import { ViewColumn } from './types';
import type { PanelBinding, PanelController, PanelViewState, ShimLogger, WebviewHostAdapter } from './adapters';

export const WEBVIEW_RESOURCE_BASE_HOST = 'vscode-cdn.net';
export const WEBVIEW_RESOURCE_AUTHORITY = `vscode-resource.${WEBVIEW_RESOURCE_BASE_HOST}`;
/** The host a browser sees for local files ('+' is not percent-encoded once the URL is parsed). */
export const WEBVIEW_FILE_RESOURCE_HOST = `file+.${WEBVIEW_RESOURCE_AUTHORITY}`;
export const WEBVIEW_CSP_SOURCE = `'self' https://*.${WEBVIEW_RESOURCE_BASE_HOST}`;

/** VS Code's encodeAuthority for the `<scheme>+<authority>.vscode-resource...` host. */
function encodeAuthority(authority: string): string {
    return authority.replace(/./g, (ch) => {
        const code = ch.charCodeAt(0);
        if ((code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57)) {
            return ch;
        }
        return '-' + code.toString(16).padStart(4, '0');
    });
}

/** VS Code's asWebviewUri (no remote): http(s) unchanged, everything else onto the resource host. */
export function asWebviewUri(resource: Uri): Uri {
    if (resource.scheme === 'http' || resource.scheme === 'https') {
        return resource;
    }
    return Uri.from({
        scheme: 'https',
        authority: `${resource.scheme}+${encodeAuthority(resource.authority)}.${WEBVIEW_RESOURCE_AUTHORITY}`,
        path: resource.path,
        fragment: resource.fragment,
        query: resource.query,
    });
}

const BUFFER_REF = '$$vscode_array_buffer_reference$$';

function copyView(v: ArrayBufferView): ArrayBufferView {
    const buf = (v.buffer as ArrayBuffer).slice(v.byteOffset, v.byteOffset + v.byteLength);
    if (v instanceof DataView) {
        return new DataView(buf);
    }
    const Ctor = (v as unknown as { constructor: new (b: ArrayBuffer) => ArrayBufferView }).constructor;
    return new Ctor(buf);
}

/**
 * Clones a webview message like VS Code's serializeWebviewMessage + deserialize: JSON semantics
 * (toJSON, so a Node Buffer becomes {type:'Buffer',data}), but ArrayBuffers / typed arrays survive.
 */
export function cloneWebviewMessage(message: unknown): unknown {
    const buffers: Array<ArrayBuffer | ArrayBufferView> = [];
    const json = JSON.stringify(message, (_key, value) => {
        if (value instanceof ArrayBuffer) {
            buffers.push(value.slice(0));
            return { [BUFFER_REF]: buffers.length - 1 };
        }
        if (ArrayBuffer.isView(value)) {
            buffers.push(copyView(value));
            return { [BUFFER_REF]: buffers.length - 1 };
        }
        return value;
    });
    if (json === undefined) {
        return undefined;
    }
    if (buffers.length === 0) {
        return JSON.parse(json);
    }
    return JSON.parse(json, (_key, value) => {
        if (value && typeof value === 'object' && typeof value[BUFFER_REF] === 'number' && Object.keys(value).length === 1) {
            return buffers[value[BUFFER_REF]];
        }
        return value;
    });
}

export interface WebviewOptions {
    enableScripts?: boolean;
    enableForms?: boolean;
    enableCommandUris?: boolean | readonly string[];
    localResourceRoots?: readonly Uri[];
    portMapping?: readonly unknown[];
}

export interface WebviewPanelOptions {
    enableFindWidget?: boolean;
    retainContextWhenHidden?: boolean;
}

function disposedError(): Error {
    return new Error('Webview is disposed');
}

function sameOptions(a: WebviewOptions, b: WebviewOptions): boolean {
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}

export class ShimWebview {
    private _html = '';
    private _options: WebviewOptions;
    private readonly _onDidReceiveMessage = new EventEmitter<unknown>();
    readonly onDidReceiveMessage = this._onDidReceiveMessage.event;

    constructor(private readonly panel: ShimWebviewPanel, options: WebviewOptions) {
        this._options = options;
    }

    get html(): string {
        this.panel._assertNotDisposed();
        return this._html;
    }

    set html(value: string) {
        this.panel._assertNotDisposed();
        const next = String(value);
        if (this._html !== next) {
            this._html = next;
            this.panel._onHtmlChanged();
        }
    }

    get options(): WebviewOptions {
        this.panel._assertNotDisposed();
        return this._options;
    }

    set options(newOptions: WebviewOptions) {
        this.panel._assertNotDisposed();
        const changed = !sameOptions(this._options, newOptions);
        this._options = newOptions;
        if (changed) {
            this.panel._onOptionsChanged();
        }
    }

    get cspSource(): string {
        return WEBVIEW_CSP_SOURCE;
    }

    asWebviewUri(resource: Uri): Uri {
        return asWebviewUri(resource);
    }

    postMessage(message: unknown): Promise<boolean> {
        if (this.panel.isDisposed) {
            return Promise.resolve(false);
        }
        let cloned: unknown;
        try {
            cloned = cloneWebviewMessage(message);
        } catch (err) {
            return Promise.reject(err);
        }
        return Promise.resolve(this.panel._post(cloned));
    }

    /** Shim-internal */
    _rawHtml(): string {
        return this._html;
    }

    /** Shim-internal */
    _rawOptions(): WebviewOptions {
        return this._options;
    }

    /** Shim-internal: deliver a webview → host message; returns the listeners' results. */
    _receive(message: unknown): unknown[] {
        return this._onDidReceiveMessage.fireCollect(message);
    }

    /** Shim-internal */
    _dispose(): void {
        this._onDidReceiveMessage.dispose();
    }
}

export interface PanelServices {
    host: WebviewHostAdapter;
    log: ShimLogger;
    /** Read-only app asset folders always allowed for resources. */
    implicitResourceRoots: readonly string[];
    /** The app's own folders (bundled media / vendor / out): never taken for a user's note folder. */
    appAssetRoots?: readonly string[];
    /**
     * The folder an earlier fractal.openNotesFolder(folder) call asked for, when it is one of
     * `candidates` (consumed: one request binds one panel).
     */
    claimRequestedNotesFolder?(candidates: readonly string[]): string | undefined;
    /** Called once the panel is created (controller hook). */
    onCreated(panel: ShimWebviewPanel): void;
    onRevealed(panel: ShimWebviewPanel): void;
    onDisposed(panel: ShimWebviewPanel): void;
}

let panelCounter = 0;

export const NOTES_VIEW_TYPE = 'fractal.notes';
const NOTES_TITLE = /^Notes: (.+)$/;

export function isSameOrInside(p: string, root: string): boolean {
    const rel = path.relative(path.resolve(root), path.resolve(p));
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/**
 * The note folder of a new Notes panel. The extension creates it as
 *   createWebviewPanel('fractal.notes', `Notes: ${basename(folder)}`, …,
 *     { localResourceRoots: [<ext>/media, <ext>/vendor, folder, ...fractal.resourceRoots] })
 * so the folder is a root named like the title, but so can be the app's own <ext>/media or
 * <ext>/vendor (a note called "media") or a resource root from the settings:
 * 1. the folder a pending fractal.openNotesFolder call asked for, when it is among those roots;
 * 2. else the first such root that is not one of the app's own folders (calls that do not go
 *    through the command, e.g. New Note).
 */
function identifyNotesFolder(title: string, roots: readonly Uri[] | undefined, services: PanelServices): string | undefined {
    const m = NOTES_TITLE.exec(title);
    if (!m) {
        return undefined;
    }
    const named = (roots ?? [])
        .filter((r) => !!r && typeof r === 'object' && (r as Uri).scheme === 'file')
        .map((r) => (r as Uri).fsPath)
        .filter((p) => path.basename(p) === m[1]);
    const requested = services.claimRequestedNotesFolder?.(named);
    if (requested) {
        return requested;
    }
    const appRoots = services.appAssetRoots ?? [];
    return named.find((p) => !appRoots.some((a) => isSameOrInside(p, a)));
}

export class ShimWebviewPanel {
    readonly panelId: string;
    readonly viewType: string;
    readonly options: WebviewPanelOptions;
    iconPath: unknown;

    private _title: string;
    private _viewColumn: number;
    private _active = true;
    private _visible = true;
    private _disposed = false;
    private readonly _notesFolder: string | undefined;
    private _generation = 0;
    private _readyGeneration = -1;
    private readonly _queue: unknown[] = [];
    private _state: unknown = undefined;
    private readonly _pendingHandlers = new Set<Promise<unknown>>();
    private readonly _webview: ShimWebview;
    private readonly _binding: PanelBinding;
    private readonly _onDidDispose = new EventEmitter<void>();
    private readonly _onDidChangeViewState = new EventEmitter<{ webviewPanel: ShimWebviewPanel }>();
    readonly onDidDispose = this._onDidDispose.event;
    readonly onDidChangeViewState = this._onDidChangeViewState.event;
    /** Handed to the host so the window can call back into the shim. */
    readonly controller: PanelController;

    constructor(
        viewType: string,
        title: string,
        showOptions: number | { viewColumn?: number; preserveFocus?: boolean } | undefined,
        options: (WebviewPanelOptions & WebviewOptions) | undefined,
        private readonly services: PanelServices
    ) {
        this.panelId = `panel-${++panelCounter}`;
        this.viewType = viewType;
        this._title = String(title);
        const viewColumn = typeof showOptions === 'number' ? showOptions : showOptions?.viewColumn ?? ViewColumn.Active;
        const preserveFocus = typeof showOptions === 'object' && !!showOptions?.preserveFocus;
        this._viewColumn = viewColumn === ViewColumn.Active || viewColumn === ViewColumn.Beside ? ViewColumn.One : viewColumn;
        const opts = options ?? {};
        this.options = { enableFindWidget: opts.enableFindWidget, retainContextWhenHidden: opts.retainContextWhenHidden };
        this._webview = new ShimWebview(this, {
            enableScripts: opts.enableScripts,
            enableForms: opts.enableForms,
            enableCommandUris: opts.enableCommandUris,
            localResourceRoots: opts.localResourceRoots,
            portMapping: opts.portMapping,
        });
        this._notesFolder = viewType === NOTES_VIEW_TYPE ? identifyNotesFolder(this._title, opts.localResourceRoots, services) : undefined;
        this.controller = this.createController();
        this._binding = services.host.createPanel({
            panelId: this.panelId,
            viewType,
            title: this._title,
            viewColumn: this._viewColumn,
            preserveFocus,
            enableScripts: !!opts.enableScripts,
            retainContextWhenHidden: !!opts.retainContextWhenHidden,
            notesFolder: this._notesFolder,
            controller: this.controller,
        });
        services.onCreated(this);
    }

    get isDisposed(): boolean {
        return this._disposed;
    }

    get webview(): ShimWebview {
        this._assertNotDisposed();
        return this._webview;
    }

    get title(): string {
        this._assertNotDisposed();
        return this._title;
    }

    set title(value: string) {
        this._assertNotDisposed();
        const next = String(value);
        if (this._title !== next) {
            this._title = next;
            this.callBinding(() => this._binding.setTitle(next));
        }
    }

    get viewColumn(): number | undefined {
        this._assertNotDisposed();
        return this._viewColumn;
    }

    get active(): boolean {
        this._assertNotDisposed();
        return this._active;
    }

    get visible(): boolean {
        this._assertNotDisposed();
        return this._visible;
    }

    reveal(viewColumn?: number, preserveFocus?: boolean): void {
        this._assertNotDisposed();
        if (typeof viewColumn === 'number' && viewColumn > 0) {
            this._viewColumn = viewColumn;
        }
        this.callBinding(() => this._binding.reveal(!!preserveFocus));
        this.services.onRevealed(this);
    }

    dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._queue.length = 0;
        try {
            this._onDidDispose.fire(undefined);
        } catch (err) {
            reportListenerError(err);
        }
        this.callBinding(() => this._binding.destroy());
        this._webview._dispose();
        this._onDidDispose.dispose();
        this._onDidChangeViewState.dispose();
        this.services.onDisposed(this);
    }

    /** Effective resource roots (absolute paths) for the resource resolver. */
    resourceRoots(): string[] {
        const roots: string[] = [];
        const local = this._webview._rawOptions().localResourceRoots;
        for (const r of local ?? []) {
            if (r && typeof r === 'object' && (r as Uri).scheme === 'file') {
                roots.push((r as Uri).fsPath);
            }
        }
        for (const r of this.services.implicitResourceRoots) {
            if (!roots.includes(r)) {
                roots.push(r);
            }
        }
        return roots;
    }

    /** The note folder of a Notes panel (fixed at creation, identifyNotesFolder); undefined for other panels. */
    notesFolder(): string | undefined {
        return this._notesFolder;
    }

    _assertNotDisposed(): void {
        if (this._disposed) {
            throw disposedError();
        }
    }

    _onHtmlChanged(): void {
        this._generation++;
        const gen = this._generation;
        this.callBinding(() => this._binding.load(gen));
    }

    _onOptionsChanged(): void {
        this.callBinding(() => this._binding.optionsChanged?.());
    }

    _post(message: unknown): boolean {
        if (this._disposed) {
            return false;
        }
        if (this._readyGeneration !== this._generation || this._queue.length > 0) {
            this._queue.push(message);
            return true;
        }
        return this.deliver(message);
    }

    private deliver(message: unknown): boolean {
        try {
            return this._binding.postMessage(message) !== false;
        } catch (err) {
            this.services.log.warn(`[vscode-shim] ${this.panelId}: postMessage failed:`, err);
            return false;
        }
    }

    private flushQueue(): void {
        while (this._queue.length > 0 && !this._disposed && this._readyGeneration === this._generation) {
            const msg = this._queue.shift();
            this.deliver(msg);
        }
    }

    private callBinding(fn: () => void): void {
        try {
            fn();
        } catch (err) {
            this.services.log.warn(`[vscode-shim] ${this.panelId}: host call failed:`, err);
        }
    }

    private createController(): PanelController {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const panel = this;
        return {
            get panelId() {
                return panel.panelId;
            },
            get viewType() {
                return panel.viewType;
            },
            get title() {
                return panel._title;
            },
            get html() {
                return panel._webview._rawHtml();
            },
            get generation() {
                return panel._generation;
            },
            get disposed() {
                return panel._disposed;
            },
            resourceRoots: () => panel.resourceRoots(),
            contentReady: (generation: number) => {
                if (panel._disposed || generation !== panel._generation) {
                    return; // a stale page (an older html) finished loading
                }
                panel._readyGeneration = generation;
                panel.flushQueue();
            },
            receiveMessage: (message: unknown) => {
                if (panel._disposed) {
                    return;
                }
                let cloned: unknown;
                try {
                    cloned = cloneWebviewMessage(message);
                } catch (err) {
                    panel.services.log.warn(`[vscode-shim] ${panel.panelId}: dropped a message that cannot be serialized:`, err);
                    return;
                }
                for (const r of panel._webview._receive(cloned)) {
                    if (r && typeof (r as Promise<unknown>).then === 'function') {
                        const p = Promise.resolve(r).then(
                            () => undefined,
                            (err) => panel.services.log.error(`[vscode-shim] ${panel.panelId}: message handler failed:`, err)
                        );
                        panel._pendingHandlers.add(p);
                        p.then(() => panel._pendingHandlers.delete(p));
                    }
                }
            },
            setViewState: (state: PanelViewState) => {
                if (panel._disposed) {
                    return;
                }
                const active = !!state.active;
                const visible = !!state.visible;
                if (active === panel._active && visible === panel._visible) {
                    return;
                }
                panel._active = active;
                panel._visible = visible;
                panel._onDidChangeViewState.fire({ webviewPanel: panel });
            },
            getState: () => panel._state,
            setState: (state: unknown) => {
                panel._state = state;
            },
            drainMessageHandlers: async (timeoutMs = 3000) => {
                const pending = Array.from(panel._pendingHandlers);
                if (pending.length === 0) {
                    return;
                }
                let timer: NodeJS.Timeout | undefined;
                await Promise.race([
                    Promise.allSettled(pending),
                    new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, timeoutMs);
                    }),
                ]);
                if (timer) {
                    clearTimeout(timer);
                }
            },
            disposeByUser: () => panel.dispose(),
        };
    }
}
