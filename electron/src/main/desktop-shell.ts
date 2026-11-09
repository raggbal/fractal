/**
 * The desktop shell around the extension (ADR-0013): builds the ShimHost with Electron adapters, boots
 * the extension's own bundle on the vscode shim, and runs the app's windows (spec
 * 20261107-0431-electron-sidebar): each window has the sidebar on the left — the extension's own tree
 * views (Fractal List = notesLists, Notes = notesExplorer) drawn with package.json contributes — and
 * the notes it holds on the right (one shown, the others kept alive). A note chosen in a window's
 * sidebar opens in that window; "Open in New Window" (right-click) opens a second window.
 *
 * Start: a window at once, then the notes that were open (by window), else the first note of the
 * active .fractal (~/.fractal/default.fractal on the first run, created by the extension), else the
 * sidebar's welcome content. Quit in VS Code's order: every window closes every note it holds (each
 * flushed) → extension deactivate → state flush.
 */
import { app, BaseWindow, clipboard, dialog, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { bootExtension, type BootedExtension } from '../vscode-shim/boot';
import type { PanelInit, ShellAdapter, ShimHost } from '../vscode-shim/adapters';
import { appAssetRoots, isSameOrInside } from '../vscode-shim/index';
import type { ShimWebviewPanel } from '../vscode-shim/webview';
import { AppStateStore, notesToReopen } from './app-state';
import { AppWindow, WindowManager, type AppWindowDelegate, type SidebarUiState } from './app-window';
import { createFileLogger, type FileLogger } from './log';
import { buildMenu, type ListMenuEntry, type MenuActions, type NoteMenuEntry, type OpenNoteMenuEntry } from './menu';
import { createOpener } from './opener';
import { PanelHost, type PanelContainer, type PanelView } from './panel-host';
import { PromptService } from './prompt-window';
import { SettingsWindow, type SettingsWorkspace } from './settings-window';
import { readSidebarContributes, type SidebarContributes } from './sidebar-contributes';
import {
    buildSidebarSnapshot,
    decorateSidebar,
    hasSection,
    SIDEBAR_DEFAULT_WIDTH,
    SnapshotHistory,
    type ResolvedCommand,
    type SidebarPageModel,
    type TreeSource,
} from './sidebar-model';
import { readDesignCss } from './design-tokens';
import { SidebarService } from './sidebar-view';
import { isDarkTheme, useDesignTokens, webviewThemeCss } from './theme';
import { ElectronUi } from './ui';

export interface DesktopShellOptions {
    extensionRoot: string;
    /** Electron's userData; the extension's settings / state live in <userData>/User. */
    userData: string;
    /** Note folders asked for on the command line / by the OS (open-file). */
    requestedNotes: string[];
    /** Log instead of launching other apps (automated tests). */
    noExternal: boolean;
    /** Development / test switches this build does not honor (launch-options.ts): logged at start. */
    ignoredSwitches?: readonly string[];
}

type QuitPhase = 'running' | 'closing' | 'done';

/** How long an "open this note in that window" request waits for the extension to create the panel. */
const PLACEMENT_TTL_MS = 60000;

function isDir(p: string | undefined): p is string {
    if (!p) {
        return false;
    }
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function uniqueResolved(paths: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of paths) {
        const r = path.resolve(p);
        if (!seen.has(r)) {
            seen.add(r);
            out.push(r);
        }
    }
    return out;
}

function treeLabel(item: { label?: unknown }, fallback: string): string {
    const l = item.label;
    if (typeof l === 'string') {
        return l;
    }
    if (l && typeof l === 'object' && typeof (l as { label?: unknown }).label === 'string') {
        return (l as { label: string }).label;
    }
    return fallback;
}

function samePath(a: string, b: string): boolean {
    return path.resolve(a) === path.resolve(b);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DesktopShell implements AppWindowDelegate {
    readonly log: FileLogger;
    private readonly state: AppStateStore;
    private readonly sidebars: SidebarService;
    private readonly windows: WindowManager;
    private readonly panels: PanelHost;
    private readonly prompts: PromptService;
    /** Fractal ▸ Settings…: the settings screen (settings-window.ts) */
    private readonly settingsWindow: SettingsWindow;
    private readonly ui: ElectronUi;
    /** The extension's tokens.css + fr-base.css: the look of the sidebar and the prompt sheet (design-tokens.ts) */
    private readonly designCss: string;
    private ext: BootedExtension | undefined;
    private contributes: SidebarContributes = readSidebarContributes(undefined);
    private readonly snapshots = new SnapshotHistory();
    private snapshotRev = 0;
    private sidebarTimer: NodeJS.Timeout | null = null;
    private sidebarBuilding = false;
    private sidebarQueued = false;
    private quitPhase: QuitPhase = 'running';
    private started = false;
    private menuTimer: NodeJS.Timeout | null = null;
    private treeSubscriptions: Array<{ dispose(): unknown }> = [];
    private startupOpening: Promise<void> | null = null;
    /** note folder → the window its panel goes to, while that open is under way (openInWindow) */
    private readonly placements = new Map<string, { win: AppWindow; at: number }>();
    private refusedLogged = 0;

    constructor(private readonly o: DesktopShellOptions) {
        this.log = createFileLogger(path.join(o.userData, 'logs'));
        this.state = new AppStateStore(path.join(o.userData, 'desktop-state.json'), (err) => this.log.warn('[shell] state write failed:', err));
        this.designCss = readDesignCss(o.extensionRoot, (file, err) => this.log.error(`[shell] design file missing (the sidebar / prompts are unstyled): ${file}`, err));
        useDesignTokens(this.designCss);
        const rendererDir = path.join(__dirname, '..', 'renderer');
        this.sidebars = new SidebarService({
            log: this.log,
            preloadPath: path.join(rendererDir, 'sidebar-preload.js'),
            pageScriptPath: path.join(rendererDir, 'sidebar-page.js'),
            designCss: () => this.designCss,
        });
        this.windows = new WindowManager({
            delegate: this,
            sidebars: this.sidebars,
            savedBounds: () => this.state.get().windowBounds,
            sidebarDefaults: () => this.sidebarDefaults(),
        });
        this.panels = new PanelHost({
            log: this.log,
            preloadPath: path.join(rendererDir, 'panel-preload.js'),
            themeCss: () => webviewThemeCss(),
            isDark: () => this.isDark(),
            placePanel: (init) => this.placePanel(init),
            currentContainer: () => this.windows.current(),
            onFocused: (p) => this.onPanelFocused(p),
            afterClose: async () => {
                await this.ext?.controller.flush();
                this.scheduleMenu();
                this.pushSidebars();
            },
            onRendererGone: (p, reason) => void this.onRendererGone(p, reason),
            openExternal: (url) => void this.openExternalUrl(url),
        });
        this.prompts = new PromptService({
            log: this.log,
            preloadPath: path.join(rendererDir, 'prompt-preload.js'),
            pageScriptPath: path.join(rendererDir, 'prompt-page.js'),
            parentWindow: () => this.ui.parentWindow(),
            isDark: () => this.isDark(),
            designCss: () => this.designCss,
        });
        this.ui = new ElectronUi({ panels: this.panels, prompts: this.prompts, log: this.log, currentWindow: () => this.windows.current()?.win });
        this.settingsWindow = new SettingsWindow({
            log: this.log,
            preloadPath: path.join(rendererDir, 'settings-preload.js'),
            pageScriptPath: path.join(rendererDir, 'settings-page.js'),
            extensionRoot: o.extensionRoot,
            designCss: () => this.designCss,
            isDark: () => this.isDark(),
            workspace: () => this.ext?.api.workspace as SettingsWorkspace | undefined,
            systemLanguage: () => this.systemLanguage(),
            settingsError: () => this.ext?.controller.settingsError(),
            openSettingsFile: () => void this.openSettingsFile(),
        });
    }

    /** The language the extension follows while fractal.language is "default" (the shim's env.language) */
    private systemLanguage(): string {
        return process.env.FRACTAL_LANG || app.getLocale() || 'en';
    }

    // --- start -------------------------------------------------------------------------------

    async start(): Promise<void> {
        this.log.info(`[shell] Fractal desktop ${app.getVersion()} (Electron ${process.versions.electron}) extension=${this.o.extensionRoot} userData=${this.o.userData}`);
        if (this.o.ignoredSwitches && this.o.ignoredSwitches.length > 0) {
            this.log.warn(`[shell] ignored ${this.o.ignoredSwitches.join(', ')}: development / test switches are not honored by this build`);
        }
        this.contributes = readSidebarContributes(this.readExtensionPackageJson());
        const shellAdapter: ShellAdapter = {
            openExternal: (url) => this.openExternalUrl(url),
            openPath: async (p) => {
                if (this.o.noExternal) {
                    this.log.info(`[shell] (no-external) openPath ${p}`);
                    return '';
                }
                return shell.openPath(p);
            },
            showItemInFolder: (p) => {
                if (this.o.noExternal) {
                    this.log.info(`[shell] (no-external) showItemInFolder ${p}`);
                    return;
                }
                shell.showItemInFolder(p);
            },
            trashItem: (p) => shell.trashItem(p),
        };
        const host: ShimHost = {
            ui: this.ui,
            clipboard: {
                readText: async () => clipboard.readText(),
                writeText: async (text) => clipboard.writeText(text),
            },
            shell: shellAdapter,
            env: { language: () => this.systemLanguage() },
            webviewHost: this.panels,
            opener: createOpener({
                shell: shellAdapter,
                log: this.log,
                executeCommand: (id, ...args) => this.command(id, ...args),
                registeredNotes: async () => (await this.noteEntries()).map((n) => n.folderPath),
            }),
            workbench: (id, args) => this.workbench(id, args),
            log: this.log,
        };
        const userDir = path.join(this.o.userData, 'User');
        this.ext = await bootExtension({ extensionRoot: this.o.extensionRoot, userDataDir: userDir, host });
        const ctl = this.ext.controller;
        ctl.onDidCreateWebviewPanel((p) => this.onPanelCreated(p));
        ctl.onDidRevealWebviewPanel((p) => this.rememberNote(p));
        ctl.onDidDisposeWebviewPanel(() => {
            this.scheduleMenu();
            this.pushSidebars();
        });
        ctl.onDidChangeTreeViews(() => this.watchTrees());
        ctl.onDidChangeTreeView(() => this.scheduleSidebar());
        ctl.onDidChangeContextKeys(() => this.scheduleSidebar());
        const ws = this.ext.api.workspace as { onDidChangeConfiguration?: (l: (e: { affectsConfiguration(s: string): boolean }) => void) => unknown };
        ws.onDidChangeConfiguration?.((e) => {
            if (e.affectsConfiguration('fractal.theme')) {
                this.onThemeChanged();
            }
            if (e.affectsConfiguration('fractal')) {
                this.settingsWindow.refresh();
            }
        });
        nativeTheme.on('updated', () => this.onThemeChanged());
        this.watchTrees();
        this.setAboutPanel();
        this.refreshMenu();
        this.started = true;
        await this.openStartupNotes(this.o.requestedNotes);
    }

    private readExtensionPackageJson(): unknown {
        try {
            return JSON.parse(fs.readFileSync(path.join(this.o.extensionRoot, 'package.json'), 'utf8'));
        } catch (err) {
            this.log.warn('[shell] could not read the extension package.json (the sidebar has no buttons / welcome):', err);
            return undefined;
        }
    }

    private setAboutPanel(): void {
        let version = '';
        try {
            version = JSON.parse(fs.readFileSync(path.join(this.o.extensionRoot, 'package.json'), 'utf8')).version || '';
        } catch {
            version = '';
        }
        app.setAboutPanelOptions({
            applicationName: 'Fractal',
            applicationVersion: version,
            version: `Electron ${process.versions.electron}`,
        });
    }

    /** One at a time: a second dock click while the notes are still opening must not open them twice. */
    private openStartupNotes(requested: string[]): Promise<void> {
        if (!this.startupOpening) {
            this.startupOpening = this.doOpenStartupNotes(requested).finally(() => {
                this.startupOpening = null;
            });
        }
        return this.startupOpening;
    }

    /** Remembered note folders that still exist and are not the app's own folders. */
    private usableNotes(dirs: string[]): string[] {
        return uniqueResolved(dirs.filter(isDir)).filter((dir) => {
            const own = this.isAppFolder(dir);
            if (own) {
                // opening one would write outline.note into the app
                this.log.warn(`[shell] not reopening ${dir}: it is one of the app's own folders, not a note`);
            }
            return !own;
        });
    }

    private async doOpenStartupNotes(requested: string[]): Promise<void> {
        // a window at once: its sidebar shows the lists while the notes open
        const first = this.windows.all()[0] ?? this.windows.create();
        const endFirst = first.beginOpening();
        try {
            await this.openStartupGroups(first, requested);
        } finally {
            endFirst();
        }
    }

    private async openStartupGroups(first: AppWindow, requested: string[]): Promise<void> {
        let groups: string[][] = [];
        const asked = uniqueResolved(requested.filter(isDir));
        if (asked.length > 0) {
            groups = [asked];
        } else {
            groups = notesToReopen(this.state.get())
                .map((g) => this.usableNotes(g))
                .filter((g) => g.length > 0);
        }
        if (groups.length === 0) {
            const firstNote = await this.firstNoteOfActiveList(4000);
            if (firstNote) {
                groups = [[firstNote]];
            }
        }
        // nothing to open: the window shows the sidebar's welcome content (viewsWelcome) and the empty view
        for (let i = 0; i < groups.length; i++) {
            const win = i === 0 ? first : this.windows.create();
            const end = win.beginOpening();
            try {
                for (const dir of groups[i]) {
                    if (!win.alive) {
                        break;
                    }
                    const panel = await this.openInWindow(dir, win);
                    if (!panel) {
                        this.log.warn(`[shell] could not open the note ${dir}`);
                    }
                }
            } finally {
                end();
            }
        }
    }

    private async firstNoteOfActiveList(timeoutMs: number): Promise<string | undefined> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const entries = await this.noteEntries();
            const first = entries.find((e) => isDir(e.folderPath));
            if (first || Date.now() > deadline) {
                return first?.folderPath;
            }
            // the extension creates / activates ~/.fractal/default.fractal asynchronously on the first run
            await sleep(100);
        }
    }

    private isAppFolder(dir: string): boolean {
        return appAssetRoots(this.o.extensionRoot).some((root) => isSameOrInside(dir, root));
    }

    // --- windows (AppWindowDelegate) -------------------------------------------------------

    /** The window a new panel goes to: one asked for this note, else the window the user works in, else a new one. */
    private placePanel(init: PanelInit): PanelContainer {
        const folder = init.notesFolder ? path.resolve(init.notesFolder) : undefined;
        if (folder) {
            const asked = this.placements.get(folder);
            this.placements.delete(folder);
            if (asked && asked.win.alive && Date.now() - asked.at < PLACEMENT_TTL_MS) {
                return asked.win;
            }
        }
        return this.windows.current() ?? this.windows.create();
    }

    /**
     * Opens a note folder into `win` (start, Open in New Window, View > Reload Note, Reopen after a crash):
     * the panel the extension creates for it goes there (placePanel). The request ends with the open: one
     * answered without a new panel (the extension revealed the note where it is, or could not open it) leaves
     * nothing behind that would send a later panel of that note to `win`.
     */
    private async openInWindow(folder: string, win: AppWindow): Promise<ShimWebviewPanel | undefined> {
        const key = path.resolve(folder);
        const placement = { win, at: Date.now() };
        this.placements.set(key, placement);
        try {
            return await this.ext?.controller.openNotesFolder(folder);
        } finally {
            if (this.placements.get(key) === placement) {
                this.placements.delete(key);
            }
        }
    }

    private sidebarDefaults(): SidebarUiState {
        const s = this.state.get().sidebar;
        return { collapsed: s?.collapsed ?? false, width: s?.width ?? SIDEBAR_DEFAULT_WIDTH, sections: { ...(s?.sections ?? {}) } };
    }

    isDark(): boolean {
        let theme: unknown = 'auto';
        try {
            const ws = this.ext?.api.workspace as { getConfiguration(s: string): { get(k: string): unknown } } | undefined;
            theme = ws?.getConfiguration('fractal').get('theme') ?? 'auto';
        } catch {
            theme = 'auto';
        }
        return isDarkTheme(theme);
    }

    private themeSetting(): 'light' | 'dark' | 'auto' {
        try {
            const ws = this.ext?.api.workspace as { getConfiguration(s: string): { get(k: string): unknown } } | undefined;
            const t = ws?.getConfiguration('fractal').get('theme');
            return t === 'light' || t === 'dark' ? t : 'auto';
        } catch {
            return 'auto';
        }
    }

    private onThemeChanged(): void {
        const dark = this.isDark();
        for (const w of this.windows.all()) {
            w.applyTheme(dark);
        }
        this.pushSidebars();
        this.settingsWindow.refresh();
    }

    sidebarModel(w: AppWindow): SidebarPageModel | null {
        if (!this.snapshots.current) {
            return null;
        }
        const open = new Set(this.openPanels().map((p) => p.notesFolder).filter((f): f is string => !!f));
        return decorateSidebar(this.snapshots.current, {
            collapsed: w.collapsed,
            width: w.width,
            sections: w.sections,
            openNotes: open,
            shownNote: w.activePanel?.notesFolder,
            opening: w.opening,
            theme: this.themeSetting(),
            platform: process.platform,
        });
    }

    isSection(viewId: unknown): boolean {
        return hasSection(this.snapshots.current, viewId);
    }

    /** Click on a row: the TreeItem.command of an item this snapshot gave the page (D4). */
    runItem(w: AppWindow, handle: unknown): void {
        const item = this.snapshots.resolveItem(handle);
        if (!item) {
            this.refused('item', handle);
            return;
        }
        const rec = this.ext?.controller.treeViews().get(item.viewId);
        (rec?.view as { _setSelection?(e: unknown[]): void } | undefined)?._setSelection?.([item.element]);
        if (item.command) {
            void this.runIn(w, item.command);
        }
    }

    /** A header / row button or a welcome link: a command package.json declares for that view (D4). */
    runAction(w: AppWindow, token: unknown): void {
        const action = this.snapshots.resolveAction(token);
        if (!action) {
            this.refused('action', token);
            return;
        }
        if (action.kind === 'external') {
            void this.openExternalUrl(action.url);
            return;
        }
        void this.runIn(w, action.command);
    }

    showItemMenu(w: AppWindow, handle: unknown): void {
        const item = this.snapshots.resolveItem(handle);
        if (!item) {
            this.refused('menu', handle);
            return;
        }
        const template: MenuItemConstructorOptions[] = [];
        if (item.noteFolder) {
            const folder = item.noteFolder;
            const open = this.panelForFolder(folder);
            template.push({ label: 'Open in New Window', click: () => this.openInNewWindow(folder) });
            if (open) {
                template.push({ label: 'Close Note', click: () => void open.closeGracefully() });
            }
        }
        for (const group of item.menu) {
            if (template.length > 0) {
                template.push({ type: 'separator' });
            }
            for (const entry of group) {
                const cmd = entry.command;
                template.push({ label: entry.title, click: () => void this.runIn(w, cmd) });
            }
        }
        if (template.length > 0 && !w.isDestroyed) {
            Menu.buildFromTemplate(template).popup({ window: w.win });
        }
    }

    showTitleMenu(w: AppWindow, viewId: unknown): void {
        const groups = hasSection(this.snapshots.current, viewId) ? this.snapshots.current?.titleMenus.get(viewId) : undefined;
        if (!groups || groups.length === 0 || w.isDestroyed) {
            return;
        }
        const template: MenuItemConstructorOptions[] = [];
        for (const group of groups) {
            if (template.length > 0) {
                template.push({ type: 'separator' });
            }
            for (const entry of group) {
                const cmd = entry.command;
                template.push({ label: entry.title, click: () => void this.runIn(w, cmd) });
            }
        }
        Menu.buildFromTemplate(template).popup({ window: w.win });
    }

    /** The ● → × of a row (D6): close that note's view (flushed first), wherever it is open. */
    closeNote(_w: AppWindow, handle: unknown): void {
        const item = this.snapshots.resolveItem(handle);
        const open = item?.noteFolder ? this.panelForFolder(item.noteFolder) : undefined;
        if (!open) {
            if (!item) {
                this.refused('close', handle);
            }
            return;
        }
        void open.closeGracefully();
    }

    sidebarStateChanged(w: AppWindow, persist: boolean): void {
        if (!persist) {
            return; // a drag step: the window re-laid itself out; the page draws its own width meanwhile
        }
        this.state.update({ sidebar: { collapsed: w.collapsed, width: w.width, sections: { ...w.sections } } });
        const m = this.sidebarModel(w);
        if (m) {
            w.sidebar.push(m);
        }
        this.updateTreeVisibility();
    }

    shownPanelChanged(w: AppWindow): void {
        this.panels.updateViewStates();
        const folder = w.activePanel?.notesFolder;
        if (folder && w === this.windows.current()) {
            this.state.update({ lastNoteFolder: folder });
        }
        this.pushSidebars();
        this.scheduleMenu();
    }

    focused(w: AppWindow): void {
        this.windows.noteFocused(w);
        this.panels.updateViewStates();
        const folder = w.activePanel?.notesFolder;
        if (folder) {
            this.state.update({ lastNoteFolder: folder });
        }
        this.scheduleMenu();
    }

    boundsChanged(bounds: { x?: number; y?: number; width: number; height: number }): void {
        this.state.update({ windowBounds: bounds });
    }

    closeRequested(w: AppWindow): void {
        void this.closeWindow(w);
    }

    closed(w: AppWindow): void {
        this.windows.forget(w);
        this.updateTreeVisibility();
        this.scheduleMenu();
    }

    private async closeWindow(w: AppWindow): Promise<void> {
        await w.closeGracefully();
        await this.ext?.controller.flush();
        this.scheduleMenu();
        this.pushSidebars();
    }

    /** Runs a command for a window's sidebar: the notes it opens go to that window (it is the one the user works in). */
    private async runIn(w: AppWindow, c: ResolvedCommand): Promise<void> {
        this.windows.noteFocused(w);
        await this.command(c.command, ...c.args);
    }

    private refused(what: string, value: unknown): void {
        if (this.refusedLogged++ < 20) {
            this.log.warn(`[sidebar] refused ${what} ${typeof value === 'string' ? value.slice(0, 40) : typeof value} (not in the current sidebar)`);
        }
    }

    /** Right-click > Open in New Window: a second window with its own sidebar shows the note (an open note moves there). */
    private openInNewWindow(folder: string): void {
        const w = this.windows.create();
        const end = w.beginOpening();
        void (async () => {
            // a close of this note still under way (its ● / Close Note was just clicked): the extension still
            // holds that panel and would only reveal it, so the note opens once it is closed
            await Promise.allSettled(this.closesOf(folder));
            if (!w.alive) {
                return; // the new window was closed meanwhile
            }
            const open = this.panelForFolder(folder);
            if (open) {
                this.panels.move(open, w); // page and all
                this.pushSidebars();
                return;
            }
            await this.openInWindow(folder, w);
        })()
            .catch((err: unknown) => this.log.warn('[shell] Open in New Window failed:', err))
            .finally(end);
    }

    /** The closes under way of a note folder's panels. */
    private closesOf(folder: string): Promise<void>[] {
        return this.panels
            .closing()
            .filter(({ panel }) => !!panel.notesFolder && samePath(panel.notesFolder, folder))
            .map(({ done }) => done);
    }

    // --- sidebar model -------------------------------------------------------------------------

    private treeSources(): Map<string, TreeSource> {
        const out = new Map<string, TreeSource>();
        for (const [id, rec] of this.ext?.controller.treeViews() ?? []) {
            out.set(id, { provider: rec.provider, view: rec.view });
        }
        return out;
    }

    private scheduleSidebar(): void {
        if (this.sidebarTimer) {
            clearTimeout(this.sidebarTimer);
        }
        this.sidebarTimer = setTimeout(() => {
            this.sidebarTimer = null;
            void this.rebuildSidebar();
        }, 40);
    }

    /** One build at a time; a change during a build builds once more after it. */
    private async rebuildSidebar(): Promise<void> {
        if (this.sidebarBuilding) {
            this.sidebarQueued = true;
            return;
        }
        this.sidebarBuilding = true;
        try {
            const ctl = this.ext?.controller;
            if (!ctl) {
                return;
            }
            const snapshot = await buildSidebarSnapshot({
                rev: ++this.snapshotRev,
                contributes: this.contributes,
                trees: this.treeSources(),
                contextKeys: ctl.contextKeys(),
                log: this.log,
            });
            this.snapshots.push(snapshot);
            this.pushSidebars();
            this.updateTreeVisibility();
        } catch (err) {
            this.log.warn('[shell] sidebar update failed:', err);
        } finally {
            this.sidebarBuilding = false;
            if (this.sidebarQueued) {
                this.sidebarQueued = false;
                this.scheduleSidebar();
            }
        }
    }

    private pushSidebars(): void {
        if (!this.snapshots.current) {
            return;
        }
        for (const w of this.windows.all()) {
            const m = this.sidebarModel(w);
            if (m) {
                w.sidebar.push(m);
            }
        }
    }

    /** TreeView.visible: some open window shows the sidebar with that section expanded. */
    private updateTreeVisibility(): void {
        const windows = this.windows.all();
        for (const [id, rec] of this.ext?.controller.treeViews() ?? []) {
            const visible = windows.some((w) => !w.collapsed && w.sections[id] !== false) && hasSection(this.snapshots.current, id);
            (rec.view as { _setVisible?(v: boolean): void })._setVisible?.(visible);
        }
    }

    // --- panels ------------------------------------------------------------------------------

    private openPanels(): PanelView[] {
        return this.panels.all().filter((p) => !p.isClosingOrGone);
    }

    private panelForFolder(folder: string): PanelView | undefined {
        return this.openPanels().find((p) => !!p.notesFolder && samePath(p.notesFolder, folder));
    }

    private onPanelCreated(p: ShimWebviewPanel): void {
        this.rememberNote(p);
        this.scheduleMenu();
        this.pushSidebars();
    }

    private rememberNote(p: ShimWebviewPanel): void {
        const folder = p.notesFolder();
        if (folder) {
            this.state.update({ lastNoteFolder: folder });
        }
    }

    private onPanelFocused(p: PanelView): void {
        if (p.container instanceof AppWindow) {
            this.windows.noteFocused(p.container);
        }
        if (p.notesFolder) {
            this.state.update({ lastNoteFolder: p.notesFolder });
        }
        this.scheduleMenu();
    }

    /** Note folders of the open notes, least recently shown first. */
    private openNoteFolders(): string[] {
        return this.openPanels()
            .sort((a, b) => a.lastShownAt - b.lastShownAt || a.lastFocusedAt - b.lastFocusedAt)
            .map((p) => p.notesFolder)
            .filter((f): f is string => !!f);
    }

    /** The open notes by window (each least recently shown first). */
    private openNotesByWindow(): string[][] {
        return this.windows
            .all()
            .sort((a, b) => a.lastFocusedAt - b.lastFocusedAt)
            .map((w) => w.heldPanels().filter((p) => !p.isClosingOrGone).map((p) => p.notesFolder).filter((f): f is string => !!f))
            .filter((g) => g.length > 0);
    }

    private async onRendererGone(p: PanelView, reason: string): Promise<void> {
        const folder = p.notesFolder;
        const container = p.container instanceof AppWindow ? p.container : undefined;
        const parent = container && !container.isDestroyed ? container.win : undefined;
        const opts = {
            type: 'warning' as const,
            message: 'This note stopped unexpectedly.',
            detail: `${folder ?? p.panelId} (${reason}). What was already saved is on disk; reopen the note to continue.`,
            buttons: ['Reopen', 'Close'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
        };
        const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
        await p.closeGracefully();
        if (r.response === 0 && folder) {
            if (container?.alive) {
                await this.openInWindow(folder, container);
            } else {
                await this.ext?.controller.openNotesFolder(folder);
            }
        }
    }

    // --- menu --------------------------------------------------------------------------------

    private async noteEntries(): Promise<NoteMenuEntry[]> {
        const provider = this.ext?.controller.treeViews().get('notesExplorer')?.provider as { getChildren?: (e?: unknown) => unknown } | undefined;
        if (!provider || typeof provider.getChildren !== 'function') {
            return [];
        }
        let children: unknown;
        try {
            children = await Promise.resolve(provider.getChildren(undefined));
        } catch (err) {
            this.log.warn('[shell] notesExplorer.getChildren failed:', err);
            return [];
        }
        const open = new Set(this.openNoteFolders().map((f) => path.resolve(f)));
        return (Array.isArray(children) ? children : [])
            .map((c) => c as { folderPath?: unknown; label?: unknown })
            .filter((c) => typeof c.folderPath === 'string' && !!c.folderPath)
            .map((c) => {
                const folderPath = c.folderPath as string;
                return { label: treeLabel(c, path.basename(folderPath)), folderPath, open: open.has(path.resolve(folderPath)) };
            });
    }

    private async listEntries(): Promise<ListMenuEntry[]> {
        const provider = this.ext?.controller.treeViews().get('notesLists')?.provider as { getChildren?: (e?: unknown) => unknown } | undefined;
        if (!provider || typeof provider.getChildren !== 'function') {
            return [];
        }
        let children: unknown;
        try {
            children = await Promise.resolve(provider.getChildren(undefined));
        } catch (err) {
            this.log.warn('[shell] notesLists.getChildren failed:', err);
            return [];
        }
        return (Array.isArray(children) ? children : [])
            .map((c) => c as { file?: unknown; label?: unknown; description?: unknown; tooltip?: unknown; iconPath?: { id?: unknown } })
            .filter((c) => typeof c.file === 'string')
            .map((c) => {
                const file = c.file as string;
                const isError = c.iconPath?.id === 'warning';
                return {
                    label: treeLabel(c, path.basename(file)),
                    file,
                    active: c.description === '●',
                    error: isError && typeof c.tooltip === 'string' ? c.tooltip.split('\n')[0] : undefined,
                };
            });
    }

    private watchTrees(): void {
        for (const s of this.treeSubscriptions.splice(0)) {
            try {
                s.dispose();
            } catch {
                /* ignore */
            }
        }
        for (const [, rec] of this.ext?.controller.treeViews() ?? []) {
            const provider = rec.provider as { onDidChangeTreeData?: (l: () => void) => { dispose(): unknown } } | undefined;
            if (provider && typeof provider.onDidChangeTreeData === 'function') {
                this.treeSubscriptions.push(
                    provider.onDidChangeTreeData(() => {
                        this.scheduleMenu();
                        this.scheduleSidebar();
                    })
                );
            }
        }
        this.scheduleMenu();
        this.scheduleSidebar();
    }

    private scheduleMenu(): void {
        if (this.menuTimer) {
            clearTimeout(this.menuTimer);
        }
        this.menuTimer = setTimeout(() => {
            this.menuTimer = null;
            this.refreshMenu();
        }, 80);
    }

    private openNoteMenuEntries(): OpenNoteMenuEntry[] {
        const shown = this.windows.current()?.activePanel;
        return this.openPanels()
            .sort((a, b) => (a.notesFolder ?? a.title).localeCompare(b.notesFolder ?? b.title))
            .map((p) => ({ label: p.notesFolder ? path.basename(p.notesFolder) : p.title, panelId: p.panelId, shown: p === shown }));
    }

    private refreshMenu(): void {
        void (async () => {
            const [notes, lists] = await Promise.all([this.noteEntries(), this.listEntries()]);
            const current = this.windows.current();
            const hasPanel = !!current?.activePanel && !current.activePanel.isClosingOrGone;
            const model = { notes, lists, hasPanel, hasWindow: this.windows.all().length > 0, openNotes: this.openNoteMenuEntries() };
            Menu.setApplicationMenu(buildMenu(model, this.menuActions()));
        })().catch((err) => this.log.warn('[shell] menu update failed:', err));
    }

    /**
     * The key window, for File > Close Note / Close Window: they act on it only (like role 'close'), never on
     * the window last used — one of ours, another window of the app (a prompt sheet), or none (the window is
     * minimized / hidden, or a window that is not Electron's is key, such as About).
     */
    private keyWindow(): { app?: AppWindow; other?: BaseWindow } {
        const focused = BaseWindow.getFocusedWindow();
        if (!focused) {
            return {};
        }
        const appWin = this.windows.fromBaseWindow(focused);
        if (!appWin) {
            return { other: focused };
        }
        return appWin.alive ? { app: appWin } : {};
    }

    /** No Electron window is key: what role 'close' does — the key window (About…) closes; with none, nothing. */
    private closeOtherKeyWindow(): void {
        if (process.platform === 'darwin') {
            Menu.sendActionToFirstResponder('performClose:');
        }
    }

    private menuActions(): MenuActions {
        const current = () => this.panels.current();
        return {
            newNote: () => void this.command('fractal.newNote'),
            openNoteFolder: () => void this.openNoteFolderDialog(),
            addNoteFolderToList: () => void this.command('fractal.addNotesFolder'),
            openNote: (folder) => void this.command('fractal.openNotesFolder', folder),
            activateList: (file) => void this.command('fractal.activateNotesRegistry', file),
            addExistingList: () => void this.command('fractal.openNotesRegistry'),
            createList: () => void this.command('fractal.createNotesRegistry'),
            removeList: () => void this.command('fractal.removeNotesRegistry'),
            save: () => {
                const p = current();
                if (p) {
                    void p.saveNow().then(() => this.ext?.controller.flush());
                }
            },
            revealNote: () => {
                const p = current();
                const folder = p?.notesFolder;
                if (folder) {
                    if (this.o.noExternal) {
                        this.log.info(`[shell] (no-external) showItemInFolder ${folder}`);
                    } else {
                        shell.showItemInFolder(folder);
                    }
                }
            },
            closeNote: () => {
                const key = this.keyWindow();
                if (key.other) {
                    key.other.close(); // a prompt sheet: dismissed
                    return;
                }
                if (!key.app) {
                    this.closeOtherKeyWindow();
                    return;
                }
                const shown = key.app.activePanel;
                if (shown && !shown.isClosingOrGone) {
                    void shown.closeGracefully();
                } else {
                    void this.closeWindow(key.app);
                }
            },
            closeWindow: () => {
                const key = this.keyWindow();
                if (key.other) {
                    key.other.close();
                } else if (key.app) {
                    void this.closeWindow(key.app);
                } else {
                    this.closeOtherKeyWindow();
                }
            },
            toggleSidebar: () => this.windows.current()?.toggleSidebar(),
            toggleSidePanel: () => void this.command('fractal.toggleSidebar'),
            reloadNote: () => {
                const p = current();
                if (p) {
                    void this.reloadNote(p);
                }
            },
            toggleDevTools: () => {
                const w = this.windows.current();
                const wc = w?.activePanel && !w.activePanel.isGone ? w.activePanel.wc : w && !w.sidebar.isDestroyed ? w.sidebar.view.webContents : undefined;
                if (!wc) {
                    return;
                }
                if (wc.isDevToolsOpened()) {
                    wc.closeDevTools();
                } else {
                    wc.openDevTools({ mode: 'detach' });
                }
            },
            showOpenNote: (panelId) => {
                const p = this.panels.get(panelId);
                if (p && !p.isClosingOrGone) {
                    this.panels.reveal(p, false);
                }
            },
            openSettings: () => this.settingsWindow.open(),
            openSettingsFile: () => void this.openSettingsFile(),
            openLogs: () => void shell.openPath(path.dirname(this.log.file)),
        };
    }

    /** View > Reload: reopen the note from disk in its window (a raw page reload would re-run the stale initial HTML). */
    private async reloadNote(p: PanelView): Promise<void> {
        const folder = p.notesFolder;
        const container = p.container instanceof AppWindow ? p.container : undefined;
        await p.closeGracefully();
        if (folder) {
            if (container?.alive) {
                await this.openInWindow(folder, container);
            } else {
                await this.ext?.controller.openNotesFolder(folder);
            }
        }
    }

    async openNoteFolderDialog(): Promise<void> {
        const parent = this.ui.parentWindow();
        const opts = {
            title: 'Open Note Folder',
            message: 'Choose a note folder (a folder with outline.note), or an empty folder to start a new note in.',
            buttonLabel: 'Open',
            properties: ['openDirectory' as const, 'createDirectory' as const],
            defaultPath: this.state.get().lastNoteFolder ? path.dirname(this.state.get().lastNoteFolder as string) : undefined,
        };
        const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
        if (r.canceled || r.filePaths.length === 0) {
            return;
        }
        const dir = r.filePaths[0];
        if (!(await this.confirmNoteFolder(dir, parent))) {
            return;
        }
        await this.command('fractal.openNotesFolder', dir);
    }

    /** Opening a folder that is not a note yet turns it into one (outline.note + a first outline): ask first. */
    private async confirmNoteFolder(dir: string, parent: BaseWindow | undefined): Promise<boolean> {
        if (fs.existsSync(path.join(dir, 'outline.note'))) {
            return true;
        }
        let entries: string[] = [];
        try {
            entries = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
        } catch {
            entries = [];
        }
        if (entries.length === 0) {
            return true;
        }
        const opts = {
            type: 'question' as const,
            message: `“${path.basename(dir)}” is not a note folder yet.`,
            detail: 'Fractal will add outline.note and a first outline to this folder. Your other files stay as they are.',
            buttons: ['Make It a Note', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
        };
        const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
        return r.response === 0;
    }

    /** Help ▸ Open Settings File / the settings screen's "Open settings.json": the JSON in the OS's editor */
    private async openSettingsFile(): Promise<void> {
        const file = this.ext?.controller.settingsPath ?? path.join(this.o.userData, 'User', 'settings.json');
        try {
            if (!fs.existsSync(file)) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, '// Fractal settings (same keys as the VS Code extension, e.g. "fractal.theme": "dark")\n{\n}\n', 'utf8');
            }
        } catch (err) {
            this.log.warn('[shell] could not create settings.json:', err);
        }
        if (this.o.noExternal) {
            this.log.info(`[shell] (no-external) open settings ${file}`);
            return;
        }
        const err = await shell.openPath(file);
        if (err) {
            shell.showItemInFolder(file);
        }
    }

    private workbench(id: string, args: unknown[] = []): unknown {
        if (id === 'workbench.action.openSettingsJson') {
            void this.openSettingsFile();
            return undefined;
        }
        if (/^workbench\.action\.(openSettings|openSettings2|openGlobalSettings)$/.test(id)) {
            // openSettings('fractal.resourceRoots'): the screen, at that setting
            const query = typeof args[0] === 'string' ? args[0] : '';
            this.settingsWindow.open(query.startsWith('fractal.') ? query.slice('fractal.'.length) : undefined);
            return undefined;
        }
        this.log.info(`[shell] ${id}: no-op in the desktop app`);
        return undefined;
    }

    private async openExternalUrl(url: string): Promise<void> {
        if (!/^(https?:|mailto:)/i.test(url)) {
            this.log.warn(`[shell] refusing to open ${url.slice(0, 80)} outside the app`);
            return;
        }
        if (this.o.noExternal) {
            this.log.info(`[shell] (no-external) openExternal ${url}`);
            return;
        }
        await shell.openExternal(url);
    }

    async command(id: string, ...args: unknown[]): Promise<unknown> {
        if (!this.ext) {
            return undefined;
        }
        try {
            return await (this.ext.api.commands as { executeCommand(id: string, ...a: unknown[]): Promise<unknown> }).executeCommand(id, ...args);
        } catch (err) {
            this.log.error(`[shell] ${id} failed:`, err);
            void this.ui.showMessage({ severity: 'error', message: `${id} failed: ${err instanceof Error ? err.message : String(err)}`, modal: false, items: [] });
            return undefined;
        }
    }

    // --- app events --------------------------------------------------------------------------

    /** A note folder from a second launch / the OS (dock drop, open-file). */
    async openRequested(paths: string[]): Promise<void> {
        const dirs = uniqueResolved(paths.filter(isDir));
        if (!this.started) {
            this.o.requestedNotes.push(...dirs);
            return;
        }
        if (dirs.length === 0) {
            this.focusSomething();
            return;
        }
        for (const d of dirs) {
            await this.ext?.controller.openNotesFolder(d);
        }
    }

    focusSomething(): void {
        const w = this.windows.current() ?? this.windows.all()[0];
        if (w) {
            w.bringForward();
            const shown = w.activePanel;
            if (shown && !shown.isGone) {
                shown.wc.focus();
            }
            return;
        }
        if (this.started && this.quitPhase === 'running') {
            void this.openStartupNotes([]);
        }
    }

    /** Dock icon click: reopen the last notes when no window is open, or bring a minimized one back. */
    onActivate(): void {
        if (!this.started || this.quitPhase !== 'running') {
            return;
        }
        const open = this.windows.all();
        if (open.length === 0) {
            void this.openStartupNotes([]);
        } else if (!open.some((w) => w.isOnScreen())) {
            this.focusSomething();
        }
    }

    onBeforeQuit(e: { preventDefault(): void }): void {
        if (this.quitPhase === 'done') {
            return;
        }
        e.preventDefault();
        if (this.quitPhase === 'closing') {
            return;
        }
        this.quitPhase = 'closing';
        const hardStop = setTimeout(() => {
            this.log.error('[shell] quit timed out; exiting');
            this.finalSync();
            app.exit(0);
        }, 20000);
        void (async () => {
            try {
                const open = this.openNoteFolders();
                this.state.update({
                    openNoteFolders: open,
                    openWindows: this.openNotesByWindow(),
                    ...(open.length > 0 ? { lastNoteFolder: open[open.length - 1] } : {}),
                });
                await this.windows.closeAll();
                await this.panels.closeAll();
                await this.ext?.deactivate();
            } catch (err) {
                this.log.error('[shell] quit sequence failed:', err);
            } finally {
                clearTimeout(hardStop);
                this.finalSync();
                this.quitPhase = 'done';
                app.quit();
            }
        })();
    }

    private finalSync(): void {
        try {
            this.ext?.controller.flushSync();
        } catch (err) {
            this.log.error('[shell] final state write failed:', err);
        }
        this.state.flushSync();
        this.log.info('[shell] bye');
        this.log.close();
    }
}
