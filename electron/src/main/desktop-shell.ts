/**
 * The desktop shell around the extension (ADR-0013): builds the ShimHost with Electron adapters, boots
 * the extension's own bundle on the vscode shim, opens the Notes panel for the last used note (or the
 * first note of the active .fractal — ~/.fractal/default.fractal on the first run, created by the
 * extension itself), keeps the menu in sync with the extension's notes tree providers, and quits in
 * VS Code's order (close every panel with its flush → extension deactivate → state flush).
 */
import { app, clipboard, dialog, Menu, shell, type BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { bootExtension, type BootedExtension } from '../vscode-shim/boot';
import type { ShellAdapter, ShimHost } from '../vscode-shim/adapters';
import { appAssetRoots, isSameOrInside } from '../vscode-shim/index';
import type { ShimWebviewPanel } from '../vscode-shim/webview';
import { AppStateStore } from './app-state';
import { createFileLogger, type FileLogger } from './log';
import { buildMenu, type ListMenuEntry, type MenuActions, type NoteMenuEntry } from './menu';
import { createOpener } from './opener';
import { PanelHost, type PanelWindow } from './panel-host';
import { PromptService } from './prompt-window';
import { isDarkTheme, webviewThemeCss } from './theme';
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DesktopShell {
    readonly log: FileLogger;
    private readonly state: AppStateStore;
    private readonly panels: PanelHost;
    private readonly prompts: PromptService;
    private readonly ui: ElectronUi;
    private ext: BootedExtension | undefined;
    private quitPhase: QuitPhase = 'running';
    private started = false;
    private menuTimer: NodeJS.Timeout | null = null;
    private treeSubscriptions: Array<{ dispose(): unknown }> = [];
    private startupOpening: Promise<void> | null = null;

    constructor(private readonly o: DesktopShellOptions) {
        this.log = createFileLogger(path.join(o.userData, 'logs'));
        this.state = new AppStateStore(path.join(o.userData, 'desktop-state.json'), (err) => this.log.warn('[shell] state write failed:', err));
        const rendererDir = path.join(__dirname, '..', 'renderer');
        this.panels = new PanelHost({
            log: this.log,
            preloadPath: path.join(rendererDir, 'panel-preload.js'),
            themeCss: () => webviewThemeCss(),
            isDark: () => this.isDark(),
            savedBounds: () => this.state.get().windowBounds,
            onBoundsChanged: (b) => this.state.update({ windowBounds: b }),
            onFocused: (p) => this.onPanelFocused(p),
            afterClose: async () => {
                await this.ext?.controller.flush();
                this.scheduleMenu();
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
        });
        this.ui = new ElectronUi({ panels: this.panels, prompts: this.prompts, log: this.log });
    }

    // --- start -------------------------------------------------------------------------------

    async start(): Promise<void> {
        this.log.info(`[shell] Fractal desktop ${app.getVersion()} (Electron ${process.versions.electron}) extension=${this.o.extensionRoot} userData=${this.o.userData}`);
        if (this.o.ignoredSwitches && this.o.ignoredSwitches.length > 0) {
            this.log.warn(`[shell] ignored ${this.o.ignoredSwitches.join(', ')}: development / test switches are not honored by this build`);
        }
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
            env: { language: () => process.env.FRACTAL_LANG || app.getLocale() || 'en' },
            webviewHost: this.panels,
            opener: createOpener({
                shell: shellAdapter,
                log: this.log,
                executeCommand: (id, ...args) => this.command(id, ...args),
                registeredNotes: async () => (await this.noteEntries()).map((n) => n.folderPath),
            }),
            workbench: (id) => this.workbench(id),
            log: this.log,
        };
        const userDir = path.join(this.o.userData, 'User');
        this.ext = await bootExtension({ extensionRoot: this.o.extensionRoot, userDataDir: userDir, host });
        const ctl = this.ext.controller;
        ctl.onDidCreateWebviewPanel((p) => this.onPanelCreated(p));
        ctl.onDidRevealWebviewPanel((p) => this.rememberNote(p));
        ctl.onDidDisposeWebviewPanel(() => this.scheduleMenu());
        ctl.onDidChangeTreeViews(() => this.watchTrees());
        this.watchTrees();
        this.setAboutPanel();
        this.refreshMenu();
        this.started = true;
        await this.openStartupNotes(this.o.requestedNotes);
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

    /** One at a time: a second dock click while the note is still opening must not open it twice. */
    private openStartupNotes(requested: string[]): Promise<void> {
        if (!this.startupOpening) {
            this.startupOpening = this.doOpenStartupNotes(requested).finally(() => {
                this.startupOpening = null;
            });
        }
        return this.startupOpening;
    }

    private async doOpenStartupNotes(requested: string[]): Promise<void> {
        let targets = uniqueResolved(requested.filter(isDir));
        if (targets.length === 0) {
            const st = this.state.get();
            const remembered = st.openNoteFolders && st.openNoteFolders.length > 0 ? st.openNoteFolders : st.lastNoteFolder ? [st.lastNoteFolder] : [];
            // the app's own folders are never reopened as notes (opening one writes outline.note into the app)
            targets = uniqueResolved(remembered.filter(isDir)).filter((dir) => {
                const own = this.isAppFolder(dir);
                if (own) {
                    this.log.warn(`[shell] not reopening ${dir}: it is one of the app's own folders, not a note`);
                }
                return !own;
            });
        }
        if (targets.length === 0) {
            const first = await this.firstNoteOfActiveList(4000);
            if (first) {
                targets = [first];
            }
        }
        if (targets.length === 0) {
            await this.welcome();
            return;
        }
        for (const dir of targets) {
            const panel = await this.ext?.controller.openNotesFolder(dir);
            if (!panel) {
                this.log.warn(`[shell] could not open the note ${dir}`);
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

    private async welcome(): Promise<void> {
        const r = await dialog.showMessageBox({
            type: 'info',
            message: 'Welcome to Fractal',
            detail: 'There is no note in the active notes list yet. Open an existing note folder, or create a new note.',
            buttons: ['New Note…', 'Open Note Folder…', 'Not Now'],
            defaultId: 0,
            cancelId: 2,
            noLink: true,
        });
        if (r.response === 0) {
            await this.command('fractal.newNote');
        } else if (r.response === 1) {
            await this.openNoteFolderDialog();
        }
    }

    private isAppFolder(dir: string): boolean {
        return appAssetRoots(this.o.extensionRoot).some((root) => isSameOrInside(dir, root));
    }

    // --- panels ------------------------------------------------------------------------------

    private shimPanel(panelId: string): ShimWebviewPanel | undefined {
        return this.ext?.controller.panels().find((p) => p.panelId === panelId);
    }

    private noteFolderOf(panelId: string): string | undefined {
        const p = this.shimPanel(panelId);
        return p?.notesFolder();
    }

    private onPanelCreated(p: ShimWebviewPanel): void {
        this.rememberNote(p);
        this.scheduleMenu();
    }

    private rememberNote(p: ShimWebviewPanel): void {
        const folder = p.notesFolder();
        if (folder) {
            this.state.update({ lastNoteFolder: folder });
        }
    }

    private onPanelFocused(p: PanelWindow): void {
        const folder = this.noteFolderOf(p.panelId);
        if (folder) {
            this.state.update({ lastNoteFolder: folder });
        }
    }

    /** Note folders of the open Notes windows, least recently focused first. */
    private openNoteFolders(): string[] {
        return this.panels
            .all()
            .filter((p) => !p.isClosingOrGone)
            .sort((a, b) => a.lastFocusedAt - b.lastFocusedAt)
            .map((p) => this.noteFolderOf(p.panelId))
            .filter((f): f is string => !!f);
    }

    private async onRendererGone(p: PanelWindow, reason: string): Promise<void> {
        const folder = this.noteFolderOf(p.panelId);
        const parent = p.win.isDestroyed() ? undefined : p.win;
        const opts = {
            type: 'warning' as const,
            message: 'This note window stopped unexpectedly.',
            detail: `${folder ?? p.panelId} (${reason}). What was already saved is on disk; reopen the note to continue.`,
            buttons: ['Reopen', 'Close'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
        };
        const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
        await p.closeGracefully();
        if (r.response === 0 && folder) {
            await this.ext?.controller.openNotesFolder(folder);
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
        for (const id of ['notesExplorer', 'notesLists']) {
            const provider = this.ext?.controller.treeViews().get(id)?.provider as { onDidChangeTreeData?: (l: () => void) => { dispose(): unknown } } | undefined;
            if (provider && typeof provider.onDidChangeTreeData === 'function') {
                this.treeSubscriptions.push(provider.onDidChangeTreeData(() => this.scheduleMenu()));
            }
        }
        this.scheduleMenu();
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

    private refreshMenu(): void {
        void (async () => {
            const [notes, lists] = await Promise.all([this.noteEntries(), this.listEntries()]);
            const hasPanel = this.panels.all().some((p) => !p.isClosingOrGone);
            Menu.setApplicationMenu(buildMenu({ notes, lists, hasPanel }, this.menuActions()));
        })().catch((err) => this.log.warn('[shell] menu update failed:', err));
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
                const folder = p && this.noteFolderOf(p.panelId);
                if (folder) {
                    shell.showItemInFolder(folder);
                }
            },
            toggleSidePanel: () => void this.command('fractal.toggleSidebar'),
            reloadNote: () => {
                const p = current();
                if (p) {
                    void this.reloadNote(p);
                }
            },
            toggleDevTools: () => {
                const p = current();
                if (p && !p.isGone) {
                    p.win.webContents.toggleDevTools();
                }
            },
            openSettings: () => void this.openSettings(),
            openLogs: () => void shell.openPath(path.dirname(this.log.file)),
        };
    }

    /** View > Reload: reopen the note from disk (a raw page reload would re-run the stale initial HTML). */
    private async reloadNote(p: PanelWindow): Promise<void> {
        const folder = this.noteFolderOf(p.panelId);
        await p.closeGracefully();
        if (folder) {
            await this.ext?.controller.openNotesFolder(folder);
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
    private async confirmNoteFolder(dir: string, parent: BrowserWindow | undefined): Promise<boolean> {
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

    private async openSettings(): Promise<void> {
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

    private workbench(id: string): unknown {
        if (/^workbench\.action\.(openSettings|openSettings2|openSettingsJson|openGlobalSettings)$/.test(id)) {
            void this.openSettings();
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

    private isDark(): boolean {
        let theme: unknown = 'auto';
        try {
            const ws = this.ext?.api.workspace as { getConfiguration(s: string): { get(k: string): unknown } } | undefined;
            theme = ws?.getConfiguration('fractal').get('theme') ?? 'auto';
        } catch {
            theme = 'auto';
        }
        return isDarkTheme(theme);
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
        const p = this.panels.current() ?? this.panels.all()[0];
        if (p && !p.isClosingOrGone) {
            if (p.win.isMinimized()) {
                p.win.restore();
            }
            p.win.show();
            p.win.focus();
            return;
        }
        if (this.started && this.quitPhase === 'running') {
            void this.openStartupNotes([]);
        }
    }

    /** Dock icon click: reopen the last note when no window is open, or bring a minimized one back. */
    onActivate(): void {
        if (!this.started || this.quitPhase !== 'running') {
            return;
        }
        const open = this.panels.all().filter((p) => !p.isClosingOrGone);
        if (open.length === 0) {
            void this.openStartupNotes([]);
        } else if (!open.some((p) => p.win.isVisible() && !p.win.isMinimized())) {
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
                this.state.update({ openNoteFolders: open, ...(open.length > 0 ? { lastNoteFolder: open[open.length - 1] } : {}) });
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
