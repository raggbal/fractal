/**
 * The `window` namespace. UI calls go through the injectable UiAdapter; their argument / result
 * handling follows VS Code's ExtHostMessageService / ExtHostDialogs / ExtHostQuickOpen:
 * - show*Message(message, ...items) / (message, options, ...items): the 2nd argument is options unless
 *   it is a string or has a `title`; resolves to the SAME item object that was clicked, or undefined.
 * - showOpenDialog defaults: canSelectFiles true, folders false, many false → Uri[] | undefined.
 * - showQuickPick returns the picked item object(s); separators are never picked.
 * - createQuickPick: hide() fires onDidHide asynchronously (VS Code round-trips to the UI), so an
 *   onDidAccept handler that calls hide() and then resolves still wins.
 * - withProgress runs the task synchronously and returns its promise.
 * - createTreeView / registerTreeDataProvider register { id, treeDataProvider, dragAndDropController }
 *   and return a TreeView (title / description / message / badge, visible, selection, reveal, events):
 *   the desktop shell draws these views in its sidebar (spec 20261107-0431 D2) from the registry.
 * Other views VS Code draws itself (status bar, custom editors) are inert objects.
 */
import * as path from 'path';
import { CancellationTokenSource, Disposable, EventEmitter, NoneEvent } from './events';
import { Uri } from './uri';
import { ColorThemeKind, InputBoxValidationSeverity, QuickPickItemKind, Selection, Position, ThemeIcon, ViewColumn } from './types';
import { ShimWebviewPanel, type PanelServices, type WebviewOptions, type WebviewPanelOptions } from './webview';
import type { FileFilter, MessageSeverity, QuickPickRequestItem, ShimLogger, UiAdapter } from './adapters';
import type { ShimTextDocument, TextDocumentRegistry } from './text-document';

type MessageItemLike = string | { title: string; isCloseAffordance?: boolean };

function isMessageItem(item: unknown): item is { title: string } {
    return !!item && typeof item === 'object' && !!(item as { title?: unknown }).title;
}

function parseMessageArgs(optionsOrFirstItem: unknown, rest: unknown[]): { modal: boolean; detail?: string; items: MessageItemLike[] } {
    let items: unknown[];
    let modal = false;
    let detail: string | undefined;
    if (typeof optionsOrFirstItem === 'string' || isMessageItem(optionsOrFirstItem)) {
        items = [optionsOrFirstItem, ...rest];
    } else {
        const o = (optionsOrFirstItem ?? {}) as { modal?: boolean; detail?: string };
        modal = !!o.modal;
        detail = typeof o.detail === 'string' ? o.detail : undefined;
        items = rest;
    }
    return { modal, detail, items: items as MessageItemLike[] };
}

/** VS Code never rejects these UI calls: a failing UI is logged and reads as "dismissed". */
async function uiCall<T>(log: ShimLogger, what: string, fn: () => Promise<T> | T): Promise<T | undefined> {
    try {
        return await fn();
    } catch (err) {
        log.warn(`[vscode-shim] ${what} UI failed:`, err);
        return undefined;
    }
}

function toFilters(filters: unknown): FileFilter[] | undefined {
    if (!filters || typeof filters !== 'object') {
        return undefined;
    }
    return Object.entries(filters as Record<string, unknown>).map(([name, ext]) => ({
        name,
        extensions: Array.isArray(ext) ? ext.map(String) : [],
    }));
}

function fsPathOf(uri: unknown): string | undefined {
    if (uri && typeof uri === 'object' && (uri as Uri).scheme === 'file') {
        return (uri as Uri).fsPath;
    }
    return undefined;
}

interface QuickPickItemLike {
    label: string;
    description?: string;
    detail?: string;
    kind?: number;
    picked?: boolean;
}

function toRequestItem(item: unknown, picked: boolean): QuickPickRequestItem {
    if (typeof item === 'string') {
        return { label: item, separator: false, picked };
    }
    const i = (item ?? {}) as QuickPickItemLike;
    return {
        label: String(i.label ?? ''),
        description: typeof i.description === 'string' ? i.description : undefined,
        detail: typeof i.detail === 'string' ? i.detail : undefined,
        separator: i.kind === QuickPickItemKind.Separator,
        picked,
    };
}

/** What createTreeView / registerTreeDataProvider registered for a view id (the shell draws it — spec 20261107-0431 D2). */
export interface TreeViewRecord {
    viewId: string;
    /** options.treeDataProvider (getChildren / getTreeItem / onDidChangeTreeData) */
    provider: unknown;
    /** options.dragAndDropController (kept for completeness: the desktop sidebar does no D&D yet, D5) */
    dragAndDropController: unknown;
    options: Readonly<Record<string, unknown>>;
    view: ShimTreeView;
}

export interface ShimTreeViewHooks {
    /** The name contributed in package.json (VS Code's default TreeView.title). */
    contributedName?: string;
    /** title / description / message / badge changed (the shell redraws its view). */
    onDidChangeProperties(viewId: string): void;
    onDispose(): void;
}

/**
 * VS Code's TreeView<T> as far as an extension can observe it. The shell (not VS Code) draws the view:
 * it reads the record's provider, sets `visible` / `selection` through the shim-only _set* methods,
 * and listens to onDidChangeProperties for title / description / message / badge.
 */
export class ShimTreeView {
    private _title: string | undefined;
    private _description: string | undefined;
    private _message: string | undefined;
    private _badge: unknown;
    private _visible = false;
    private _selection: readonly unknown[] = [];
    private _disposed = false;
    private readonly _onDidChangeVisibility = new EventEmitter<{ visible: boolean }>();
    private readonly _onDidChangeSelection = new EventEmitter<{ selection: readonly unknown[] }>();
    private readonly _onDidExpandElement = new EventEmitter<unknown>();
    private readonly _onDidCollapseElement = new EventEmitter<unknown>();
    private readonly _onDidChangeCheckboxState = new EventEmitter<unknown>();
    readonly onDidChangeVisibility = this._onDidChangeVisibility.event;
    readonly onDidChangeSelection = this._onDidChangeSelection.event;
    readonly onDidExpandElement = this._onDidExpandElement.event;
    readonly onDidCollapseElement = this._onDidCollapseElement.event;
    readonly onDidChangeCheckboxState = this._onDidChangeCheckboxState.event;

    constructor(readonly viewId: string, private readonly hooks: ShimTreeViewHooks) {
        this._title = undefined;
        this._description = undefined;
        this._message = undefined;
        this._badge = undefined;
    }

    get title(): string | undefined {
        return this._title ?? this.hooks.contributedName;
    }

    set title(value: string | undefined) {
        this.setProperty('_title', value === undefined ? undefined : String(value));
    }

    get description(): string | undefined {
        return this._description;
    }

    set description(value: string | undefined) {
        this.setProperty('_description', value === undefined ? undefined : String(value));
    }

    get message(): string | undefined {
        return this._message;
    }

    set message(value: string | undefined) {
        this.setProperty('_message', value === undefined ? undefined : String(value));
    }

    get badge(): unknown {
        return this._badge;
    }

    set badge(value: unknown) {
        this.setProperty('_badge', value);
    }

    get visible(): boolean {
        return this._visible;
    }

    get selection(): readonly unknown[] {
        return this._selection;
    }

    /** VS Code selects (and focuses) the element unless `select: false`; the shell may show it. */
    reveal(element?: unknown, options?: { select?: boolean; focus?: boolean; expand?: boolean | number }): Promise<void> {
        if (!this._disposed && element !== undefined && options?.select !== false) {
            this._setSelection([element]);
        }
        return Promise.resolve();
    }

    dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._onDidChangeVisibility.dispose();
        this._onDidChangeSelection.dispose();
        this._onDidExpandElement.dispose();
        this._onDidCollapseElement.dispose();
        this._onDidChangeCheckboxState.dispose();
        this.hooks.onDispose();
    }

    get isDisposed(): boolean {
        return this._disposed;
    }

    /** Shell → view: the view is shown (an open sidebar with this section expanded) or not. */
    _setVisible(visible: boolean): void {
        if (this._disposed || this._visible === !!visible) {
            return;
        }
        this._visible = !!visible;
        this._onDidChangeVisibility.fire({ visible: this._visible });
    }

    /** Shell → view: the user selected these elements (a click in the sidebar). */
    _setSelection(elements: readonly unknown[]): void {
        if (this._disposed) {
            return;
        }
        const next = elements.slice();
        if (next.length === this._selection.length && next.every((e, i) => e === this._selection[i])) {
            return;
        }
        this._selection = next;
        this._onDidChangeSelection.fire({ selection: next });
    }

    private setProperty(key: '_title' | '_description' | '_message' | '_badge', value: unknown): void {
        if (this[key] === value) {
            return;
        }
        (this as unknown as Record<string, unknown>)[key] = value;
        if (!this._disposed) {
            this.hooks.onDidChangeProperties(this.viewId);
        }
    }
}

function createStatusBarItem(): Record<string, unknown> {
    return {
        id: undefined,
        name: undefined,
        alignment: 1,
        priority: undefined,
        text: '',
        tooltip: undefined,
        color: undefined,
        backgroundColor: undefined,
        command: undefined,
        accessibilityInformation: undefined,
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
    };
}

function createOutputChannel(name: string, log: ShimLogger): Record<string, unknown> {
    const write = (level: 'info' | 'warn' | 'error', args: unknown[]) => log[level](`[${name}]`, ...args);
    return {
        name,
        logLevel: 3,
        onDidChangeLogLevel: NoneEvent,
        append: (v: string) => write('info', [v]),
        appendLine: (v: string) => write('info', [v]),
        replace: (v: string) => write('info', [v]),
        clear: () => undefined,
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
        trace: (...a: unknown[]) => write('info', a),
        debug: (...a: unknown[]) => write('info', a),
        info: (...a: unknown[]) => write('info', a),
        warn: (...a: unknown[]) => write('warn', a),
        error: (...a: unknown[]) => write('error', a),
    };
}

export interface WindowServices {
    ui: UiAdapter;
    log: ShimLogger;
    documents: TextDocumentRegistry;
    panelServices: PanelServices;
    /** A tree view was registered / replaced / disposed. */
    onDidChangeTreeViews: EventEmitter<void>;
    /** A tree view's title / description / message / badge changed (the view id). */
    onDidChangeTreeView: EventEmitter<string>;
    /** package.json contributes.views names (VS Code's default TreeView.title). */
    contributedViewNames?: ReadonlyMap<string, string>;
}

export function createWindowNamespace(s: WindowServices) {
    const { ui, log } = s;
    const treeViews = new Map<string, TreeViewRecord>();
    const customEditors = new Map<string, { provider: unknown; options: unknown }>();
    const onDidChangeActiveTextEditor = new EventEmitter<unknown>();
    const onDidChangeVisibleTextEditors = new EventEmitter<unknown>();
    const onDidChangeWindowState = new EventEmitter<unknown>();
    const onDidChangeActiveColorTheme = new EventEmitter<unknown>();
    const onDidChangeTabs = new EventEmitter<unknown>();
    const onDidChangeTabGroups = new EventEmitter<unknown>();

    /** One record per view id; a second registration for the same id replaces the first (it stays usable but unseen). */
    function registerTreeView(viewId: string, options: Record<string, unknown>): ShimTreeView {
        const view = new ShimTreeView(viewId, {
            contributedName: s.contributedViewNames?.get(viewId),
            onDidChangeProperties: (id) => {
                if (treeViews.get(id)?.view === view) {
                    s.onDidChangeTreeView.fire(id);
                }
            },
            onDispose: () => {
                if (treeViews.get(viewId)?.view === view) {
                    treeViews.delete(viewId);
                    s.onDidChangeTreeViews.fire(undefined);
                }
            },
        });
        treeViews.set(viewId, {
            viewId,
            provider: options.treeDataProvider,
            dragAndDropController: options.dragAndDropController,
            options: { ...options },
            view,
        });
        s.onDidChangeTreeViews.fire(undefined);
        return view;
    }

    function showMessage(severity: MessageSeverity, message: unknown, optionsOrFirstItem: unknown, rest: unknown[]): Promise<unknown> {
        const { modal, detail, items } = parseMessageArgs(optionsOrFirstItem, rest);
        const buttons: Array<{ title: string; isCloseAffordance: boolean }> = [];
        const handles: number[] = [];
        items.forEach((item, handle) => {
            if (typeof item === 'string') {
                buttons.push({ title: item, isCloseAffordance: false });
                handles.push(handle);
            } else if (item && typeof item === 'object' && typeof item.title === 'string') {
                buttons.push({ title: item.title, isCloseAffordance: !!item.isCloseAffordance });
                handles.push(handle);
            } else if (item !== undefined) {
                log.warn('[vscode-shim] invalid message item:', item);
            }
        });
        const text = String(message ?? '');
        const logLine = `[${severity}] ${text}${detail ? ` — ${detail}` : ''}`;
        if (severity === 'error') {
            log.error(logLine);
        } else if (severity === 'warning') {
            log.warn(logLine);
        } else {
            log.info(logLine);
        }
        let pending: Promise<number | undefined>;
        try {
            pending = Promise.resolve(ui.showMessage({ severity, message: text, modal, detail, items: buttons }));
        } catch (err) {
            pending = Promise.reject(err);
        }
        return pending.then(
            (index) => (typeof index === 'number' && index >= 0 && index < handles.length ? items[handles[index]] : undefined),
            (err) => {
                log.warn('[vscode-shim] message UI failed:', err);
                return undefined;
            }
        );
    }

    async function showQuickPick(itemsOrPromise: unknown, options?: Record<string, unknown>): Promise<unknown> {
        const items = (await Promise.resolve(itemsOrPromise)) as unknown[] | undefined;
        if (!Array.isArray(items) || items.length === 0) {
            return undefined;
        }
        const canPickMany = !!options?.canPickMany;
        const reqItems = items.map((it) => toRequestItem(it, canPickMany && !!(it as QuickPickItemLike)?.picked));
        const picked = await uiCall(log, 'quick pick', () =>
            ui.showQuickPick({
                title: typeof options?.title === 'string' ? options.title : undefined,
                placeHolder: typeof options?.placeHolder === 'string' ? options.placeHolder : undefined,
                canPickMany,
                items: reqItems,
            })
        );
        if (!picked) {
            return undefined;
        }
        const chosen = picked.filter((i) => i >= 0 && i < items.length && !reqItems[i].separator).map((i) => items[i]);
        return canPickMany ? chosen : chosen[0];
    }

    function createQuickPick(): Record<string, unknown> {
        const onDidChangeValue = new EventEmitter<string>();
        const onDidAccept = new EventEmitter<void>();
        const onDidChangeActive = new EventEmitter<unknown[]>();
        const onDidChangeSelection = new EventEmitter<unknown[]>();
        const onDidHide = new EventEmitter<void>();
        const onDidTriggerButton = new EventEmitter<unknown>();
        const onDidTriggerItemButton = new EventEmitter<unknown>();
        let visible = false;
        let disposed = false;
        let session = 0;
        const qp: Record<string, unknown> & { items: unknown[]; selectedItems: unknown[]; activeItems: unknown[]; buttons: unknown[] } = {
            title: undefined,
            step: undefined,
            totalSteps: undefined,
            enabled: true,
            busy: false,
            ignoreFocusOut: false,
            value: '',
            placeholder: undefined,
            buttons: [],
            items: [],
            canSelectMany: false,
            matchOnDescription: false,
            matchOnDetail: false,
            keepScrollPosition: false,
            activeItems: [],
            selectedItems: [],
            onDidChangeValue: onDidChangeValue.event,
            onDidAccept: onDidAccept.event,
            onDidChangeActive: onDidChangeActive.event,
            onDidChangeSelection: onDidChangeSelection.event,
            onDidHide: onDidHide.event,
            onDidTriggerButton: onDidTriggerButton.event,
            onDidTriggerItemButton: onDidTriggerItemButton.event,
            show: () => {
                if (disposed || visible) {
                    return;
                }
                visible = true;
                const mySession = ++session;
                const items = qp.items.slice();
                const selected = new Set(qp.selectedItems);
                const canPickMany = !!qp.canSelectMany;
                const reqItems = items.map((it) => toRequestItem(it, canPickMany ? selected.has(it) : false));
                const buttons = (qp.buttons as Array<{ tooltip?: string; iconPath?: unknown }>).map((b) =>
                    String(b?.tooltip ?? (b?.iconPath instanceof ThemeIcon ? b.iconPath.id : 'button'))
                );
                Promise.resolve()
                    .then(() =>
                        ui.showQuickPick({
                            title: typeof qp.title === 'string' ? qp.title : undefined,
                            placeHolder: typeof qp.placeholder === 'string' ? qp.placeholder : undefined,
                            canPickMany,
                            items: reqItems,
                            buttons,
                        })
                    )
                    .then(
                        (picked) => {
                            if (disposed || mySession !== session || !visible) {
                                return;
                            }
                            if (!picked) {
                                hide();
                                return;
                            }
                            const chosen = picked.filter((i) => i >= 0 && i < items.length && !reqItems[i].separator).map((i) => items[i]);
                            qp.selectedItems = chosen;
                            qp.activeItems = chosen.slice(0, 1);
                            onDidChangeSelection.fire(chosen);
                            onDidAccept.fire(undefined);
                        },
                        (err) => {
                            log.warn('[vscode-shim] quick pick UI failed:', err);
                            hide();
                        }
                    );
            },
            hide: () => hide(),
            dispose: () => {
                if (disposed) {
                    return;
                }
                hide();
                setTimeout(() => {
                    disposed = true;
                    for (const e of [onDidChangeValue, onDidAccept, onDidChangeActive, onDidChangeSelection, onDidHide, onDidTriggerButton, onDidTriggerItemButton]) {
                        e.dispose();
                    }
                }, 0);
            },
        };
        function hide(): void {
            if (!visible) {
                return;
            }
            visible = false;
            session++;
            setTimeout(() => {
                if (!disposed) {
                    onDidHide.fire(undefined);
                }
            }, 0);
        }
        return qp;
    }

    function createInputBox(): Record<string, unknown> {
        const onDidChangeValue = new EventEmitter<string>();
        const onDidAccept = new EventEmitter<void>();
        const onDidHide = new EventEmitter<void>();
        const onDidTriggerButton = new EventEmitter<unknown>();
        let visible = false;
        const box: Record<string, unknown> = {
            value: '',
            valueSelection: undefined,
            placeholder: undefined,
            password: false,
            prompt: undefined,
            validationMessage: undefined,
            title: undefined,
            step: undefined,
            totalSteps: undefined,
            enabled: true,
            busy: false,
            ignoreFocusOut: false,
            buttons: [],
            onDidChangeValue: onDidChangeValue.event,
            onDidAccept: onDidAccept.event,
            onDidHide: onDidHide.event,
            onDidTriggerButton: onDidTriggerButton.event,
            show: () => {
                if (visible) {
                    return;
                }
                visible = true;
                Promise.resolve(
                    ui.showInputBox({
                        title: box.title as string | undefined,
                        prompt: box.prompt as string | undefined,
                        placeHolder: box.placeholder as string | undefined,
                        value: box.value as string,
                        password: !!box.password,
                        ignoreFocusOut: !!box.ignoreFocusOut,
                        validate: async () => undefined,
                    })
                ).then(
                    (value) => {
                        if (!visible) {
                            return;
                        }
                        if (value === undefined) {
                            hide();
                            return;
                        }
                        box.value = value;
                        onDidChangeValue.fire(value);
                        onDidAccept.fire(undefined);
                    },
                    () => hide()
                );
            },
            hide: () => hide(),
            dispose: () => {
                hide();
            },
        };
        function hide(): void {
            if (!visible) {
                return;
            }
            visible = false;
            setTimeout(() => onDidHide.fire(undefined), 0);
        }
        return box;
    }

    function withProgress<R>(
        options: { location?: unknown; title?: string; cancellable?: boolean },
        task: (progress: { report(value: { message?: string; increment?: number }): void }, token: unknown) => R | PromiseLike<R>
    ): Promise<R> {
        const cts = new CancellationTokenSource();
        const location = typeof options?.location === 'number' ? options.location : 15;
        let handle: { report(v: { message?: string; increment?: number }): void; done(): void } | undefined;
        try {
            handle = ui.startProgress?.({ title: options?.title, location, cancellable: !!options?.cancellable }, () => cts.cancel());
        } catch (err) {
            log.warn('[vscode-shim] progress UI failed:', err);
        }
        if (options?.title) {
            log.info(`[progress] ${options.title}`);
        }
        const progress = {
            report: (value: { message?: string; increment?: number }) => {
                try {
                    handle?.report(value ?? {});
                } catch {
                    /* progress UI is best effort */
                }
            },
        };
        const finish = () => {
            try {
                handle?.done();
            } catch {
                /* ignore */
            }
            cts.dispose();
        };
        let result: R | PromiseLike<R>;
        try {
            result = task(progress, cts.token);
        } catch (err) {
            finish();
            return Promise.reject(err);
        }
        return Promise.resolve(result).finally(finish);
    }

    function stubTextEditor(document: ShimTextDocument, viewColumn: number): Record<string, unknown> {
        let selections: Selection[] = [new Selection(new Position(0, 0), new Position(0, 0))];
        return {
            document,
            get selection() {
                return selections[0];
            },
            set selection(v: Selection) {
                selections = [v];
            },
            get selections() {
                return selections;
            },
            set selections(v: Selection[]) {
                selections = v.length > 0 ? v : selections;
            },
            visibleRanges: [],
            options: { tabSize: 4, insertSpaces: true },
            viewColumn,
            edit: async () => false,
            insertSnippet: async () => false,
            setDecorations: () => undefined,
            revealRange: () => undefined,
            show: () => undefined,
            hide: () => undefined,
        };
    }

    const tabGroups = {
        all: [] as unknown[],
        activeTabGroup: { isActive: true, viewColumn: ViewColumn.One, activeTab: undefined, tabs: [] as unknown[] },
        onDidChangeTabs: onDidChangeTabs.event,
        onDidChangeTabGroups: onDidChangeTabGroups.event,
        close: async () => false,
    };

    const windowNs = {
        // --- messages ---
        showInformationMessage: (message: unknown, optionsOrFirstItem?: unknown, ...rest: unknown[]) =>
            showMessage('info', message, optionsOrFirstItem, rest),
        showWarningMessage: (message: unknown, optionsOrFirstItem?: unknown, ...rest: unknown[]) =>
            showMessage('warning', message, optionsOrFirstItem, rest),
        showErrorMessage: (message: unknown, optionsOrFirstItem?: unknown, ...rest: unknown[]) =>
            showMessage('error', message, optionsOrFirstItem, rest),
        setStatusBarMessage: (text: string) => {
            log.info(`[status] ${text}`);
            return new Disposable(() => undefined);
        },

        // --- dialogs / quick input ---
        showOpenDialog: async (options?: Record<string, unknown>): Promise<Uri[] | undefined> => {
            const o = options ?? {};
            const paths = await uiCall(log, 'open dialog', () =>
                ui.showOpenDialog({
                    title: typeof o.title === 'string' ? o.title : undefined,
                    openLabel: typeof o.openLabel === 'string' ? o.openLabel : undefined,
                    defaultPath: fsPathOf(o.defaultUri),
                    canSelectFiles: o.canSelectFiles === undefined ? true : !!o.canSelectFiles,
                    canSelectFolders: !!o.canSelectFolders,
                    canSelectMany: !!o.canSelectMany,
                    filters: toFilters(o.filters),
                })
            );
            return paths && paths.length > 0 ? paths.map((p) => Uri.file(p)) : undefined;
        },
        showSaveDialog: async (options?: Record<string, unknown>): Promise<Uri | undefined> => {
            const o = options ?? {};
            let defaultPath = fsPathOf(o.defaultUri);
            // Uri.file('name.ext') → '/name.ext': pass just the name so the dialog does not open at '/'
            if (defaultPath && path.dirname(defaultPath) === '/') {
                defaultPath = path.basename(defaultPath);
            }
            const p = await uiCall(log, 'save dialog', () =>
                ui.showSaveDialog({
                    title: typeof o.title === 'string' ? o.title : undefined,
                    saveLabel: typeof o.saveLabel === 'string' ? o.saveLabel : undefined,
                    defaultPath,
                    filters: toFilters(o.filters),
                })
            );
            return p ? Uri.file(p) : undefined;
        },
        showInputBox: async (options?: Record<string, unknown>): Promise<string | undefined> => {
            const o = options ?? {};
            const validateInput = typeof o.validateInput === 'function' ? (o.validateInput as (v: string) => unknown) : undefined;
            return uiCall(log, 'input box', () => ui.showInputBox({
                title: typeof o.title === 'string' ? o.title : undefined,
                prompt: typeof o.prompt === 'string' ? o.prompt : undefined,
                placeHolder: typeof o.placeHolder === 'string' ? o.placeHolder : undefined,
                value: typeof o.value === 'string' ? o.value : undefined,
                valueSelection: Array.isArray(o.valueSelection) ? (o.valueSelection as [number, number]) : undefined,
                password: !!o.password,
                ignoreFocusOut: !!o.ignoreFocusOut,
                validate: async (value: string) => {
                    if (!validateInput) {
                        return undefined;
                    }
                    let r: unknown;
                    try {
                        r = await validateInput(value);
                    } catch (err) {
                        log.warn('[vscode-shim] validateInput threw:', err);
                        return undefined;
                    }
                    if (typeof r === 'string') {
                        return r.length > 0 ? r : undefined;
                    }
                    if (r && typeof r === 'object' && typeof (r as { message?: unknown }).message === 'string') {
                        const { message, severity } = r as { message: string; severity?: number };
                        return severity === undefined || severity === InputBoxValidationSeverity.Error ? message || undefined : undefined;
                    }
                    return undefined;
                },
            }));
        },
        showQuickPick,
        createQuickPick,
        createInputBox,
        showWorkspaceFolderPick: async () => undefined,
        withProgress,

        // --- webviews / editors ---
        createWebviewPanel: (
            viewType: string,
            title: string,
            showOptions?: number | { viewColumn?: number; preserveFocus?: boolean },
            options?: WebviewPanelOptions & WebviewOptions
        ) => new ShimWebviewPanel(viewType, title, showOptions, options, s.panelServices),
        registerWebviewPanelSerializer: () => new Disposable(() => undefined),
        registerWebviewViewProvider: () => new Disposable(() => undefined),
        registerCustomEditorProvider: (viewType: string, provider: unknown, options?: unknown) => {
            customEditors.set(viewType, { provider, options });
            return new Disposable(() => {
                if (customEditors.get(viewType)?.provider === provider) {
                    customEditors.delete(viewType);
                }
            });
        },
        showTextDocument: async (docOrUri: unknown, columnOrOptions?: unknown): Promise<unknown> => {
            const doc = (docOrUri && typeof (docOrUri as ShimTextDocument).getText === 'function'
                ? docOrUri
                : await s.documents.openTextDocument(docOrUri as Uri)) as ShimTextDocument;
            const viewColumn = typeof columnOrOptions === 'number' ? columnOrOptions : ViewColumn.One;
            log.info(`[vscode-shim] showTextDocument(${doc.fileName}): no text editor in the desktop app`);
            return stubTextEditor(doc, viewColumn);
        },
        get activeTextEditor() {
            return undefined;
        },
        get visibleTextEditors() {
            return [] as unknown[];
        },
        get activeNotebookEditor() {
            return undefined;
        },
        get visibleNotebookEditors() {
            return [] as unknown[];
        },
        onDidChangeActiveTextEditor: onDidChangeActiveTextEditor.event,
        onDidChangeVisibleTextEditors: onDidChangeVisibleTextEditors.event,
        onDidChangeTextEditorSelection: NoneEvent,
        onDidChangeTextEditorVisibleRanges: NoneEvent,
        onDidChangeTextEditorOptions: NoneEvent,
        onDidChangeTextEditorViewColumn: NoneEvent,
        tabGroups,

        // --- tree views: registered for the shell's sidebar (spec 20261107-0431 D2) ---
        createTreeView: (viewId: string, options: { treeDataProvider?: unknown; dragAndDropController?: unknown }) =>
            registerTreeView(String(viewId), options ?? {}),
        registerTreeDataProvider: (viewId: string, provider: unknown) => {
            const view = registerTreeView(String(viewId), { treeDataProvider: provider });
            return new Disposable(() => view.dispose());
        },
        createStatusBarItem: () => createStatusBarItem(),
        createOutputChannel: (name: string) => createOutputChannel(String(name), log),
        createTextEditorDecorationType: () => ({ key: 'shim-decoration', dispose: () => undefined }),
        registerUriHandler: () => new Disposable(() => undefined),
        registerFileDecorationProvider: () => new Disposable(() => undefined),
        registerTerminalLinkProvider: () => new Disposable(() => undefined),
        registerTerminalProfileProvider: () => new Disposable(() => undefined),
        get terminals() {
            return [] as unknown[];
        },
        get activeTerminal() {
            return undefined;
        },
        onDidOpenTerminal: NoneEvent,
        onDidCloseTerminal: NoneEvent,
        onDidChangeActiveTerminal: NoneEvent,
        state: { focused: true, active: true },
        onDidChangeWindowState: onDidChangeWindowState.event,
        activeColorTheme: { kind: ColorThemeKind.Light },
        onDidChangeActiveColorTheme: onDidChangeActiveColorTheme.event,
    };

    return { windowNs, treeViews, customEditors };
}
