/**
 * The `vscode` module for the desktop app (ADR-0013): createVscodeShim() builds a plain object with
 * every namespace, class and enum the extension bundle uses as an OWN property (esbuild's __toESM
 * copies only the own property names present at the first require('vscode')), plus a controller
 * with shell-only hooks (panels, tree providers, context keys, flush / dispose).
 *
 * Nothing here imports 'electron': the shell passes a ShimHost (adapters.ts).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    CancellationError,
    CancellationTokenSource,
    Disposable,
    EventEmitter,
    NoneEvent,
    setListenerErrorReporter,
    type Event,
} from './events';
import { Uri } from './uri';
import * as T from './types';
import { ShimFileSystem } from './fs';
import { ConfigurationStore } from './configuration';
import { FileMemento } from './memento';
import { TextDocumentRegistry } from './text-document';
import { FileWatcherService } from './file-watcher';
import { createWindowNamespace, type TreeViewRecord } from './window';
import { CommandRegistry, createDefaultOpener } from './commands';
import { createEnvNamespace } from './env';
import { createExtensionContext, type ShimExtensionContext } from './extension-context';
import { NOTES_VIEW_TYPE, ShimWebviewPanel } from './webview';
import { consoleLogger, type ShimHost, type ShimLogger } from './adapters';

export * from './adapters';
export { resolveResourceRequest, webviewResourcePath, contentTypeFor } from './resource-resolver';
export {
    asWebviewUri,
    cloneWebviewMessage,
    isSameOrInside,
    NOTES_VIEW_TYPE,
    WEBVIEW_CSP_SOURCE,
    WEBVIEW_FILE_RESOURCE_HOST,
    WEBVIEW_RESOURCE_AUTHORITY,
    ShimWebviewPanel,
} from './webview';
export { ShimTextDocument } from './text-document';
export type { ShimExtensionContext } from './extension-context';
export type { TreeViewRecord } from './window';
export { ShimTreeView } from './window';

export const DEFAULT_EXTENSION_ID = 'imaken.fractal';

/**
 * The app's own folders inside the extension root (bundled, read-only in a packaged app): never a
 * user's note, so never remembered or reopened as one.
 */
export function appAssetRoots(extensionRoot: string): string[] {
    const root = path.resolve(extensionRoot);
    return [path.join(root, 'media'), path.join(root, 'vendor'), path.join(root, 'out')];
}

/** How long a fractal.openNotesFolder request waits for its panel (the folder was already open / missing otherwise). */
const NOTE_REQUEST_TTL_MS = 60000;

/** contributes.views[*][*] id → name (VS Code's default TreeView.title); empty when package.json is unreadable. */
function readContributedViewNames(packageJsonPath: string): Map<string, string> {
    const names = new Map<string, string>();
    try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { contributes?: { views?: Record<string, unknown> } };
        for (const list of Object.values(pkg.contributes?.views ?? {})) {
            for (const v of Array.isArray(list) ? list : []) {
                const { id, name } = (v ?? {}) as { id?: unknown; name?: unknown };
                if (typeof id === 'string' && typeof name === 'string') {
                    names.set(id, name);
                }
            }
        }
    } catch {
        /* no names: titles stay undefined until the extension sets them */
    }
    return names;
}

export interface ShimOptions {
    /** Folder with out/extension.js, out/webview, media/, vendor/ and package.json. */
    extensionRoot: string;
    /** App data folder: settings.json, globalState.json, workspaceState.json, globalStorage/. */
    userDataDir: string;
    host: ShimHost;
    extensionId?: string;
}

export interface ShimController {
    readonly extensionRoot: string;
    readonly userDataDir: string;
    readonly settingsPath: string;
    readonly onDidCreateWebviewPanel: Event<ShimWebviewPanel>;
    readonly onDidRevealWebviewPanel: Event<ShimWebviewPanel>;
    readonly onDidDisposeWebviewPanel: Event<ShimWebviewPanel>;
    /** A tree view was registered, replaced or disposed (re-read treeViews()). */
    readonly onDidChangeTreeViews: Event<void>;
    /** A registered tree view's title / description / message / badge changed (its view id). */
    readonly onDidChangeTreeView: Event<string>;
    /** A setContext key changed (the key). */
    readonly onDidChangeContextKeys: Event<string>;
    readonly onWillExecuteCommand: Event<{ command: string; args: readonly unknown[] }>;
    panels(): ShimWebviewPanel[];
    /** createTreeView / registerTreeDataProvider registrations by view id (the shell's sidebar draws them). */
    treeViews(): ReadonlyMap<string, TreeViewRecord>;
    customEditors(): ReadonlyMap<string, { provider: unknown; options: unknown }>;
    contextKeys(): ReadonlyMap<string, unknown>;
    /** The user settings file currently has syntax errors (its last good values are used). */
    settingsError(): string | undefined;
    /**
     * Runs fractal.openNotesFolder(folderPath) and resolves with the Notes panel that was created or
     * revealed for it (undefined when the folder is missing or nothing appears within `timeoutMs`).
     */
    openNotesFolder(folderPath: string, timeoutMs?: number): Promise<ShimWebviewPanel | undefined>;
    /** Waits for pending state / settings writes and in-flight document saves. */
    flush(): Promise<void>;
    /** Synchronous last-chance write of the state files. */
    flushSync(): void;
    /** Closes file watchers and the settings watcher (after the extension was deactivated). */
    dispose(): void;
}

export interface VscodeShim {
    /** The object require('vscode') returns. */
    api: Record<string, unknown>;
    controller: ShimController;
    context: ShimExtensionContext;
}

export function createVscodeShim(options: ShimOptions): VscodeShim {
    const extensionRoot = path.resolve(options.extensionRoot);
    const userDataDir = path.resolve(options.userDataDir);
    const extensionId = options.extensionId ?? DEFAULT_EXTENSION_ID;
    const host = options.host;
    const log: ShimLogger = host.log ?? consoleLogger;
    setListenerErrorReporter((err) => log.error('[vscode-shim] listener threw:', err));

    const settingsPath = path.join(userDataDir, 'settings.json');
    const watchers = new FileWatcherService(log);
    const configuration = new ConfigurationStore({
        packageJsonPath: path.join(extensionRoot, 'package.json'),
        settingsPath,
        log,
    });
    configuration.watchExternalEdits((filePath, onEvent) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const w = watchers.createFileSystemWatcher(new T.RelativePattern(path.dirname(filePath), path.basename(filePath)));
        const subs = [w.onDidChange(onEvent), w.onDidCreate(onEvent), w.onDidDelete(onEvent)];
        return new Disposable(() => {
            subs.forEach((s) => s.dispose());
            w.dispose();
        });
    });

    const globalState = new FileMemento(path.join(userDataDir, 'globalState.json'), log);
    const workspaceState = new FileMemento(path.join(userDataDir, 'workspaceState.json'), log);

    // window.showErrorMessage is defined below; documents report save failures through it
    let showError: (message: string) => void = (m) => log.error(m);
    const documents = new TextDocumentRegistry(log, (m) => showError(m));
    const fileSystem = new ShimFileSystem((p) => host.shell.trashItem(p));

    const onDidCreateWebviewPanel = new EventEmitter<ShimWebviewPanel>();
    const onDidRevealWebviewPanel = new EventEmitter<ShimWebviewPanel>();
    const onDidDisposeWebviewPanel = new EventEmitter<ShimWebviewPanel>();
    const onDidChangeTreeViews = new EventEmitter<void>();
    const onDidChangeTreeView = new EventEmitter<string>();
    const livePanels = new Set<ShimWebviewPanel>();

    const implicitResourceRoots = [
        path.join(extensionRoot, 'out', 'webview'),
        path.join(extensionRoot, 'media'),
        path.join(extensionRoot, 'vendor'),
    ];

    // fractal.openNotesFolder(folder) creates its panel later (the command does not return the
    // extension's promise): remember what was asked for, and bind it to the Notes panel created for it.
    const requestedNoteFolders: Array<{ folder: string; at: number }> = [];
    const forgetRequests = (pred: (r: { folder: string; at: number }) => boolean) => {
        for (let i = requestedNoteFolders.length - 1; i >= 0; i--) {
            if (pred(requestedNoteFolders[i])) {
                requestedNoteFolders.splice(i, 1);
            }
        }
    };
    const claimRequestedNotesFolder = (candidates: readonly string[]): string | undefined => {
        const now = Date.now();
        forgetRequests((r) => now - r.at > NOTE_REQUEST_TTL_MS);
        for (let i = requestedNoteFolders.length - 1; i >= 0; i--) {
            const hit = candidates.find((c) => path.resolve(c) === requestedNoteFolders[i].folder);
            if (hit) {
                requestedNoteFolders.splice(i, 1);
                return hit;
            }
        }
        return undefined;
    };

    const { windowNs, treeViews, customEditors } = createWindowNamespace({
        ui: host.ui,
        log,
        documents,
        onDidChangeTreeViews,
        onDidChangeTreeView,
        contributedViewNames: readContributedViewNames(path.join(extensionRoot, 'package.json')),
        panelServices: {
            host: host.webviewHost,
            log,
            implicitResourceRoots,
            appAssetRoots: appAssetRoots(extensionRoot),
            claimRequestedNotesFolder,
            onCreated: (p) => {
                livePanels.add(p);
                onDidCreateWebviewPanel.fire(p);
            },
            onRevealed: (p) => {
                // the folder was open already: its request is answered by this reveal
                const folder = p.notesFolder();
                if (folder) {
                    forgetRequests((r) => r.folder === path.resolve(folder));
                }
                onDidRevealWebviewPanel.fire(p);
            },
            onDisposed: (p) => {
                livePanels.delete(p);
                onDidDisposeWebviewPanel.fire(p);
            },
        },
    });
    showError = (m) => {
        void windowNs.showErrorMessage(m);
    };

    const commands = new CommandRegistry({
        log,
        shell: host.shell,
        opener: host.opener ?? createDefaultOpener(host.shell, log),
        workbench: host.workbench,
    });
    commands.onWillExecuteCommand.event(({ command, args }) => {
        if (command === 'fractal.openNotesFolder' && typeof args[0] === 'string' && args[0]) {
            requestedNoteFolders.push({ folder: path.resolve(args[0]), at: Date.now() });
        }
    });

    const env = createEnvNamespace({ env: host.env, clipboard: host.clipboard, shell: host.shell, log, appRoot: extensionRoot });

    const onDidChangeWorkspaceFolders = new EventEmitter<unknown>();
    const onDidGrantWorkspaceTrust = new EventEmitter<void>();
    const fileEvents = {
        onDidCreateFiles: new EventEmitter<unknown>(),
        onDidDeleteFiles: new EventEmitter<unknown>(),
        onDidRenameFiles: new EventEmitter<unknown>(),
        onWillCreateFiles: new EventEmitter<unknown>(),
        onWillDeleteFiles: new EventEmitter<unknown>(),
        onWillRenameFiles: new EventEmitter<unknown>(),
    };

    const workspace = {
        fs: fileSystem,
        getConfiguration: (section?: string, _scope?: unknown) => configuration.getConfiguration(section),
        onDidChangeConfiguration: configuration.onDidChangeConfiguration,
        openTextDocument: (arg?: unknown) => documents.openTextDocument(arg as never),
        get textDocuments() {
            return documents.textDocuments;
        },
        applyEdit: (edit: T.WorkspaceEdit, _metadata?: unknown) => documents.applyEdit(edit),
        saveAll: (_includeUntitled?: boolean) => documents.saveAll(),
        save: async (uri: Uri) => {
            const doc = documents.get(uri);
            if (!doc) {
                return undefined;
            }
            return (await doc.save()) ? uri : undefined;
        },
        onDidOpenTextDocument: documents.onDidOpen.event,
        onDidCloseTextDocument: documents.onDidClose.event,
        onDidChangeTextDocument: documents.onDidChange.event,
        onDidSaveTextDocument: documents.onDidSave.event,
        onWillSaveTextDocument: documents.onWillSave.event,
        createFileSystemWatcher: (globPattern: unknown, ignoreCreate?: boolean, ignoreChange?: boolean, ignoreDelete?: boolean) =>
            watchers.createFileSystemWatcher(globPattern, ignoreCreate, ignoreChange, ignoreDelete),
        // no workspace folder is open in the desktop app
        workspaceFolders: undefined as unknown,
        name: undefined as string | undefined,
        rootPath: undefined as string | undefined,
        workspaceFile: undefined as Uri | undefined,
        isTrusted: true,
        onDidGrantWorkspaceTrust: onDidGrantWorkspaceTrust.event,
        onDidChangeWorkspaceFolders: onDidChangeWorkspaceFolders.event,
        getWorkspaceFolder: (_uri: Uri) => undefined,
        asRelativePath: (pathOrUri: string | Uri) => (typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath),
        updateWorkspaceFolders: () => false,
        findFiles: async () => [] as Uri[],
        registerTextDocumentContentProvider: () => new Disposable(() => undefined),
        registerFileSystemProvider: () => new Disposable(() => undefined),
        registerTaskProvider: () => new Disposable(() => undefined),
        registerNotebookSerializer: () => new Disposable(() => undefined),
        notebookDocuments: [] as unknown[],
        onDidOpenNotebookDocument: NoneEvent,
        onDidCloseNotebookDocument: NoneEvent,
        onDidChangeNotebookDocument: NoneEvent,
        onDidSaveNotebookDocument: NoneEvent,
        onDidCreateFiles: fileEvents.onDidCreateFiles.event,
        onDidDeleteFiles: fileEvents.onDidDeleteFiles.event,
        onDidRenameFiles: fileEvents.onDidRenameFiles.event,
        onWillCreateFiles: fileEvents.onWillCreateFiles.event,
        onWillDeleteFiles: fileEvents.onWillDeleteFiles.event,
        onWillRenameFiles: fileEvents.onWillRenameFiles.event,
    };

    const noopRegistration = () => new Disposable(() => undefined);
    const languages = {
        getLanguages: async () => ['markdown', 'plaintext', 'json'],
        setTextDocumentLanguage: async (doc: { languageId: string }, languageId: string) => {
            doc.languageId = languageId;
            return doc;
        },
        match: () => 0,
        getDiagnostics: () => [] as unknown[],
        onDidChangeDiagnostics: NoneEvent,
        createDiagnosticCollection: (name?: string) => ({
            name: name ?? 'shim',
            set: () => undefined,
            delete: () => undefined,
            clear: () => undefined,
            forEach: () => undefined,
            get: () => undefined,
            has: () => false,
            dispose: () => undefined,
        }),
        createLanguageStatusItem: () => ({ dispose: () => undefined }),
        registerCompletionItemProvider: noopRegistration,
        registerHoverProvider: noopRegistration,
        registerDefinitionProvider: noopRegistration,
        registerDocumentLinkProvider: noopRegistration,
        registerCodeActionsProvider: noopRegistration,
        registerCodeLensProvider: noopRegistration,
        registerDocumentSymbolProvider: noopRegistration,
        registerFoldingRangeProvider: noopRegistration,
        registerDocumentFormattingEditProvider: noopRegistration,
        registerDocumentRangeFormattingEditProvider: noopRegistration,
        registerInlayHintsProvider: noopRegistration,
        registerColorProvider: noopRegistration,
        setLanguageConfiguration: noopRegistration,
    };

    const context = createExtensionContext({ extensionRoot, userDataDir, extensionId, globalState, workspaceState });

    const extensions = {
        getExtension: (id: string) => (id === extensionId ? context.extension : undefined),
        get all() {
            return [context.extension];
        },
        onDidChange: NoneEvent,
    };

    const l10n = {
        bundle: undefined,
        uri: undefined,
        t: (message: string | { message: string; args?: unknown[] }, ...args: unknown[]) => {
            const text = typeof message === 'string' ? message : message.message;
            const params = typeof message === 'string' ? args : message.args ?? [];
            const flat = params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])
                ? (params[0] as Record<string, unknown>)
                : (params as unknown[]);
            return text.replace(/\{(\w+)\}/g, (m, key) => {
                const v = Array.isArray(flat) ? flat[Number(key)] : (flat as Record<string, unknown>)[key];
                return v === undefined ? m : String(v);
            });
        },
    };

    const api: Record<string, unknown> = {
        version: '1.108.0',
        env,
        window: windowNs,
        workspace,
        commands: {
            registerCommand: (id: string, callback: (...a: unknown[]) => unknown, thisArg?: unknown) =>
                commands.registerCommand(id, callback, thisArg),
            // there is no text editor to pass to the callback: registered, but running it only logs
            registerTextEditorCommand: (id: string) =>
                commands.registerCommand(id, () => {
                    log.warn(`[vscode-shim] ${id}: text editor commands have no editor in the desktop app`);
                }),
            executeCommand: (id: string, ...args: unknown[]) => commands.executeCommand(id, ...args),
            getCommands: (filterInternal?: boolean) => commands.getCommands(filterInternal),
        },
        languages,
        extensions,
        l10n,
        // value classes
        Uri,
        EventEmitter,
        Disposable,
        CancellationTokenSource,
        CancellationError,
        Position: T.Position,
        Range: T.Range,
        Selection: T.Selection,
        TextEdit: T.TextEdit,
        WorkspaceEdit: T.WorkspaceEdit,
        RelativePattern: T.RelativePattern,
        TreeItem: T.TreeItem,
        ThemeIcon: T.ThemeIcon,
        ThemeColor: T.ThemeColor,
        MarkdownString: T.MarkdownString,
        DataTransfer: T.DataTransfer,
        DataTransferItem: T.DataTransferItem,
        FileSystemError: T.FileSystemError,
        // enums
        ViewColumn: T.ViewColumn,
        ConfigurationTarget: T.ConfigurationTarget,
        ProgressLocation: T.ProgressLocation,
        QuickPickItemKind: T.QuickPickItemKind,
        TextEditorRevealType: T.TextEditorRevealType,
        TreeItemCollapsibleState: T.TreeItemCollapsibleState,
        EndOfLine: T.EndOfLine,
        FileType: T.FileType,
        FilePermission: T.FilePermission,
        ExtensionMode: T.ExtensionMode,
        ExtensionKind: T.ExtensionKind,
        UIKind: T.UIKind,
        TextDocumentChangeReason: T.TextDocumentChangeReason,
        TextDocumentSaveReason: T.TextDocumentSaveReason,
        StatusBarAlignment: T.StatusBarAlignment,
        InputBoxValidationSeverity: T.InputBoxValidationSeverity,
        ColorThemeKind: T.ColorThemeKind,
        LogLevel: T.LogLevel,
        DiagnosticSeverity: T.DiagnosticSeverity,
        TextEditorSelectionChangeKind: T.TextEditorSelectionChangeKind,
    };

    const controller: ShimController = {
        extensionRoot,
        userDataDir,
        settingsPath,
        onDidCreateWebviewPanel: onDidCreateWebviewPanel.event,
        onDidRevealWebviewPanel: onDidRevealWebviewPanel.event,
        onDidDisposeWebviewPanel: onDidDisposeWebviewPanel.event,
        onDidChangeTreeViews: onDidChangeTreeViews.event,
        onDidChangeTreeView: onDidChangeTreeView.event,
        onDidChangeContextKeys: commands.onDidChangeContext.event,
        onWillExecuteCommand: commands.onWillExecuteCommand.event,
        panels: () => Array.from(livePanels),
        treeViews: () => treeViews,
        customEditors: () => customEditors,
        contextKeys: () => commands.contextKeys,
        settingsError: () => configuration.settingsError,
        openNotesFolder: (folderPath: string, timeoutMs = 20000) => {
            const target = path.resolve(folderPath);
            let isDir = false;
            try {
                isDir = fs.statSync(target).isDirectory();
            } catch {
                isDir = false;
            }
            if (!isDir) {
                return Promise.resolve(undefined);
            }
            return new Promise<ShimWebviewPanel | undefined>((resolve) => {
                let settled = false;
                const matches = (p: ShimWebviewPanel) => {
                    const f = p.viewType === NOTES_VIEW_TYPE ? p.notesFolder() : undefined;
                    return !!f && path.resolve(f) === target;
                };
                const finish = (p: ShimWebviewPanel | undefined) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    created.dispose();
                    revealed.dispose();
                    resolve(p);
                };
                const created = onDidCreateWebviewPanel.event((p) => matches(p) && finish(p));
                const revealed = onDidRevealWebviewPanel.event((p) => matches(p) && finish(p));
                const timer = setTimeout(() => finish(undefined), timeoutMs);
                commands.executeCommand('fractal.openNotesFolder', folderPath).catch((err) => {
                    log.error('[vscode-shim] fractal.openNotesFolder failed:', err);
                    finish(undefined);
                });
            });
        },
        flush: async () => {
            await Promise.allSettled([globalState.flush(), workspaceState.flush(), configuration.flush(), documents.flush()]);
        },
        flushSync: () => {
            for (const m of [globalState, workspaceState]) {
                try {
                    m.flushSync();
                } catch (err) {
                    log.error('[vscode-shim] state flush failed:', err);
                }
            }
        },
        dispose: () => {
            watchers.dispose();
            configuration.dispose();
            documents.dispose();
            onDidChangeWorkspaceFolders.dispose();
            onDidGrantWorkspaceTrust.dispose();
            Object.values(fileEvents).forEach((e) => e.dispose());
        },
    };

    return { api, controller, context };
}
