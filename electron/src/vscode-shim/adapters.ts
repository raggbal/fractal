/**
 * The shim's boundary to the outside world. Everything that needs Electron (dialogs, notifications,
 * clipboard, shell, the windows that show webview panels) goes through these interfaces, so the shim
 * core never imports 'electron' and the unit tests run in plain Node. TASK 2 implements them with
 * Electron; createHeadlessHost() is the safe default used by tests and smoke runs.
 */
import type { Uri } from './uri';

export interface ShimLogger {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

export type MessageSeverity = 'info' | 'warning' | 'error';

export interface MessageRequest {
    severity: MessageSeverity;
    message: string;
    /** `{ modal: true }` — a blocking dialog. VS Code adds a Cancel button unless an item is a close affordance. */
    modal: boolean;
    detail?: string;
    /** Buttons in the order the extension passed them. Titles may contain `$(codicon)` tokens. */
    items: Array<{ title: string; isCloseAffordance: boolean }>;
}

export interface FileFilter {
    name: string;
    extensions: string[];
}

export interface OpenDialogRequest {
    title?: string;
    openLabel?: string;
    defaultPath?: string;
    canSelectFiles: boolean;
    canSelectFolders: boolean;
    canSelectMany: boolean;
    filters?: FileFilter[];
}

export interface SaveDialogRequest {
    title?: string;
    saveLabel?: string;
    defaultPath?: string;
    filters?: FileFilter[];
}

export interface InputBoxRequest {
    title?: string;
    prompt?: string;
    placeHolder?: string;
    value?: string;
    valueSelection?: [number, number];
    password: boolean;
    ignoreFocusOut: boolean;
    /** Runs the extension's validateInput: resolves to a message that blocks accepting, or undefined. */
    validate(value: string): Promise<string | undefined>;
}

export interface QuickPickRequestItem {
    label: string;
    description?: string;
    detail?: string;
    /** QuickPickItemKind.Separator rows: shown as a group header, never pickable. */
    separator: boolean;
    picked: boolean;
}

export interface QuickPickRequest {
    title?: string;
    placeHolder?: string;
    canPickMany: boolean;
    items: QuickPickRequestItem[];
    /** Titles of the extension's QuickInputButtons (createQuickPick). */
    buttons?: string[];
}

export interface ProgressRequest {
    title?: string;
    location: number;
    cancellable: boolean;
}

export interface ProgressHandle {
    report(value: { message?: string; increment?: number }): void;
    done(): void;
}

export interface UiAdapter {
    /** Resolves to the index of the clicked item in `req.items`, or undefined (dismissed / no items). */
    showMessage(req: MessageRequest): Promise<number | undefined>;
    /** Resolves to absolute paths, or undefined when cancelled. */
    showOpenDialog(req: OpenDialogRequest): Promise<string[] | undefined>;
    /** Resolves to an absolute path, or undefined when cancelled. */
    showSaveDialog(req: SaveDialogRequest): Promise<string | undefined>;
    /** Resolves to the accepted text ('' is valid), or undefined on Esc / focus loss. */
    showInputBox(req: InputBoxRequest): Promise<string | undefined>;
    /** Resolves to the picked indices into `req.items` (never separators), or undefined when dismissed. */
    showQuickPick(req: QuickPickRequest): Promise<number[] | undefined>;
    /** Optional progress UI (dock / window progress bar). The callback cancels the task's token. */
    startProgress?(req: ProgressRequest, onCancel: () => void): ProgressHandle;
}

export interface ClipboardAdapter {
    readText(): Promise<string>;
    writeText(text: string): Promise<void>;
}

export interface ShellAdapter {
    /** Opens an http/https/mailto URL in the OS browser / mail client (the shim filters schemes first). */
    openExternal(url: string): Promise<void>;
    /** Opens a local file or folder with the OS default app. Resolves to '' on success, else an error text. */
    openPath(fsPath: string): Promise<string>;
    /** Shows the item selected in Finder. */
    showItemInFolder(fsPath: string): void;
    /** Moves the item to the OS trash; rejects on failure. */
    trashItem(fsPath: string): Promise<void>;
}

export interface EnvAdapter {
    /** Display language, e.g. 'en' / 'ja' (Electron: app.getLocale(), valid after app 'ready'). */
    language(): string;
}

/** vscode.open / vscode.openWith (spec D6): open in Notes when it can, else with the OS. */
export interface OpenerAdapter {
    open(req: { command: 'vscode.open' | 'vscode.openWith'; uri: Uri; viewType?: string }): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Webview panels (one panel = one window in the Electron shell)
// ---------------------------------------------------------------------------------------------

export interface PanelViewState {
    active: boolean;
    visible: boolean;
}

/** The shim side of one panel, handed to the host so the window can call back into the shim. */
export interface PanelController {
    readonly panelId: string;
    readonly viewType: string;
    readonly title: string;
    /** The current document; the host serves it as the panel's page. */
    readonly html: string;
    /** Increases on every html assignment that changes the document. */
    readonly generation: number;
    readonly disposed: boolean;
    /** Effective resource roots (absolute paths): localResourceRoots + the app's read-only asset folders. */
    resourceRoots(): string[];
    /** The page of `generation` finished loading (DOMContentLoaded): delivers the queued host messages. */
    contentReady(generation: number): void;
    /** webview → host message (the host has validated the sender). */
    receiveMessage(message: unknown): void;
    setViewState(state: PanelViewState): void;
    /** acquireVsCodeApi().getState() / setState() storage, kept per panel across reloads. */
    getState(): unknown;
    setState(state: unknown): void;
    /** Resolves when the in-flight onDidReceiveMessage handlers have settled (or after `timeoutMs`). */
    drainMessageHandlers(timeoutMs?: number): Promise<void>;
    /** The user closed the window (after the shell's flush): fires onDidDispose like VS Code. */
    disposeByUser(): void;
}

export interface PanelInit {
    readonly panelId: string;
    readonly viewType: string;
    readonly title: string;
    readonly viewColumn: number;
    readonly preserveFocus: boolean;
    readonly enableScripts: boolean;
    readonly retainContextWhenHidden: boolean;
    readonly controller: PanelController;
}

/** The host side of one panel. */
export interface PanelBinding {
    /** Load the document of `generation` (read controller.html). */
    load(generation: number): void;
    /** Deliver one host→webview message (already cloned like VS Code). Return false if the page is gone. */
    postMessage(message: unknown): boolean;
    setTitle(title: string): void;
    reveal(preserveFocus: boolean): void;
    /** Resource roots changed (no reload — the resolver reads controller.resourceRoots() per request). */
    optionsChanged?(): void;
    /** The extension disposed the panel (or the user close finished): destroy the window. Idempotent. */
    destroy(): void;
}

export interface WebviewHostAdapter {
    createPanel(init: PanelInit): PanelBinding;
}

export interface ShimHost {
    ui: UiAdapter;
    clipboard: ClipboardAdapter;
    shell: ShellAdapter;
    env: EnvAdapter;
    webviewHost: WebviewHostAdapter;
    /** Defaults to: file → shell.openPath, http(s) → shell.openExternal. */
    opener?: OpenerAdapter;
    /** workbench.* commands. Default: no-op (spec D6). */
    workbench?(id: string, args: unknown[]): Promise<unknown> | unknown;
    log?: ShimLogger;
}

export const consoleLogger: ShimLogger = {
    // eslint-disable-next-line no-console
    info: (...a) => console.log(...a),
    // eslint-disable-next-line no-console
    warn: (...a) => console.warn(...a),
    // eslint-disable-next-line no-console
    error: (...a) => console.error(...a),
};

/** A recording host with no UI: messages/dialogs resolve as dismissed, panels record what they get. */
export interface HeadlessHost extends ShimHost {
    readonly records: {
        messages: MessageRequest[];
        openExternal: string[];
        openPath: string[];
        showItemInFolder: string[];
        trashed: string[];
        clipboard: string;
        panels: Array<{
            init: PanelInit;
            loads: number[];
            delivered: unknown[];
            titles: string[];
            reveals: boolean[];
            destroyed: boolean;
        }>;
    };
}

export function createHeadlessHost(overrides: Partial<ShimHost> = {}): HeadlessHost {
    const records: HeadlessHost['records'] = {
        messages: [],
        openExternal: [],
        openPath: [],
        showItemInFolder: [],
        trashed: [],
        clipboard: '',
        panels: [],
    };
    const host: HeadlessHost = {
        records,
        log: overrides.log ?? {
            info: () => undefined,
            warn: () => undefined,
            error: (...a: unknown[]) => consoleLogger.error(...a),
        },
        ui: overrides.ui ?? {
            showMessage: async (req) => {
                records.messages.push(req);
                return undefined;
            },
            showOpenDialog: async () => undefined,
            showSaveDialog: async () => undefined,
            showInputBox: async () => undefined,
            showQuickPick: async () => undefined,
        },
        clipboard: overrides.clipboard ?? {
            readText: async () => records.clipboard,
            writeText: async (text: string) => {
                records.clipboard = text;
            },
        },
        shell: overrides.shell ?? {
            openExternal: async (url: string) => {
                records.openExternal.push(url);
            },
            openPath: async (p: string) => {
                records.openPath.push(p);
                return '';
            },
            showItemInFolder: (p: string) => {
                records.showItemInFolder.push(p);
            },
            trashItem: async (p: string) => {
                records.trashed.push(p);
                throw new Error('trash is not available in the headless host');
            },
        },
        env: overrides.env ?? { language: () => 'en' },
        webviewHost: overrides.webviewHost ?? {
            createPanel: (init: PanelInit): PanelBinding => {
                const rec = { init, loads: [] as number[], delivered: [] as unknown[], titles: [] as string[], reveals: [] as boolean[], destroyed: false };
                records.panels.push(rec);
                return {
                    load: (generation) => rec.loads.push(generation),
                    postMessage: (message) => {
                        if (rec.destroyed) {
                            return false;
                        }
                        rec.delivered.push(message);
                        return true;
                    },
                    setTitle: (title) => rec.titles.push(title),
                    reveal: (preserveFocus) => rec.reveals.push(preserveFocus),
                    destroy: () => {
                        rec.destroyed = true;
                    },
                };
            },
        },
        opener: overrides.opener,
        workbench: overrides.workbench,
    };
    return host;
}
