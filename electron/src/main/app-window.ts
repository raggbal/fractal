/**
 * A window of the desktop app (spec 20261107-0431-electron-sidebar D1 / D3 / D6): a BaseWindow with
 * the sidebar (a WebContentsView, sidebar-view.ts) on the left and the note views (one WebContentsView
 * per WebviewPanel, panel-host.ts) on the right. Every note the window holds stays alive; only the
 * shown one is visible, so choosing it again shows it at once.
 *
 * Layout: sidebar [0, w) with w = its width (180–480, never leaving the note less than 320px) or 28
 * when collapsed; the shown note [w, content width). With no note shown, the sidebar view spans the
 * whole window and its page draws the empty view right of the sidebar (one renderer, no extra view).
 *
 * Closing the window closes every note it holds — the shown one and the hidden ones — each with the
 * flush → drain → unload → onDidDispose order (PanelView.closeGracefully), then the sidebar, then the
 * window. Closing the shown note shows the last viewed other one (MRU), or the empty view.
 */
import { BaseWindow, screen, type Rectangle } from 'electron';
import type { WindowBounds } from './app-state';
import type { PanelContainer, PanelView } from './panel-host';
import { clampSidebarWidth, SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_DEFAULT_WIDTH, type SidebarPageModel } from './sidebar-model';
import type { SidebarOwner, SidebarService, SidebarView } from './sidebar-view';
import { surfaceColors } from './theme';

const DEFAULT_SIZE = { width: 1280, height: 860 };
/** The note never gets narrower than this because of the sidebar. */
const MIN_NOTE_WIDTH = 320;
const MIN_WINDOW = { width: 640, height: 360 };
const SHOW_FALLBACK_MS = 3000;

export interface SidebarUiState {
    collapsed: boolean;
    width: number;
    sections: Record<string, boolean>;
}

/** The shell's side of a window (desktop-shell.ts). */
export interface AppWindowDelegate {
    isDark(): boolean;
    sidebarModel(w: AppWindow): SidebarPageModel | null;
    runItem(w: AppWindow, handle: unknown): void;
    runAction(w: AppWindow, token: unknown): void;
    showItemMenu(w: AppWindow, handle: unknown): void;
    showTitleMenu(w: AppWindow, viewId: unknown): void;
    closeNote(w: AppWindow, handle: unknown): void;
    /** Valid section ids (the sidebar shows them). */
    isSection(viewId: unknown): boolean;
    /** collapsed / width / sections changed (`persist`: the end of a change, not a drag step). */
    sidebarStateChanged(w: AppWindow, persist: boolean): void;
    /** The window shows another note (or none): title, sidebar marks, view states, menu. */
    shownPanelChanged(w: AppWindow): void;
    focused(w: AppWindow): void;
    boundsChanged(bounds: WindowBounds): void;
    /** The user closes the window (red button, Close Window): the shell runs closeGracefully. */
    closeRequested(w: AppWindow): void;
    closed(w: AppWindow): void;
}

/** The sidebar view before its page paints: the design's panel color (tokens.css). */
export function sidebarBackground(dark: boolean): string {
    return surfaceColors(dark).panel;
}

export class AppWindow implements PanelContainer, SidebarOwner {
    readonly win: BaseWindow;
    readonly sidebar: SidebarView;
    collapsed: boolean;
    width: number;
    sections: Record<string, boolean>;
    lastFocusedAt = 0;
    /** the notes this window holds, least recently shown first */
    private panels: PanelView[] = [];
    /** notes of this window whose close is under way (they left `panels`) */
    private readonly closingPanels = new Set<PanelView>();
    private shown: PanelView | undefined;
    private closing: Promise<void> | null = null;
    private allowClose = false;
    private destroyed = false;
    private everShown = false;
    private boundsTimer: NodeJS.Timeout | null = null;
    private openingCount = 0;

    constructor(private readonly d: AppWindowDelegate, sidebars: SidebarService, bounds: Rectangle, ui: SidebarUiState) {
        this.collapsed = ui.collapsed;
        this.width = clampSidebarWidth(ui.width) ?? SIDEBAR_DEFAULT_WIDTH;
        this.sections = { ...ui.sections };
        const dark = d.isDark();
        this.win = new BaseWindow({
            ...bounds,
            minWidth: MIN_WINDOW.width,
            minHeight: MIN_WINDOW.height,
            title: 'Fractal',
            show: false,
            backgroundColor: surfaceColors(dark).app,
        });
        this.sidebar = sidebars.create(this, sidebarBackground(dark));
        this.win.contentView.addChildView(this.sidebar.view);
        this.layout();
        this.wire();
    }

    get alive(): boolean {
        return !this.destroyed && !this.closing;
    }

    get isClosing(): boolean {
        return this.closing !== null;
    }

    get isDestroyed(): boolean {
        return this.destroyed || this.win.isDestroyed();
    }

    // --- PanelContainer ----------------------------------------------------------------------

    get activePanel(): PanelView | undefined {
        return this.shown;
    }

    /** The notes this window holds, least recently shown first. */
    heldPanels(): PanelView[] {
        return this.panels.slice();
    }

    isOnScreen(): boolean {
        return !this.isDestroyed && this.win.isVisible() && !this.win.isMinimized();
    }

    addPanel(panel: PanelView, show: boolean, focus: boolean): void {
        if (this.isDestroyed) {
            return;
        }
        panel.container = this;
        if (!this.panels.includes(panel)) {
            this.panels.unshift(panel);
        }
        this.win.contentView.addChildView(panel.view);
        panel.view.setVisible(false);
        if (show) {
            this.showPanel(panel, focus);
        } else {
            this.layout();
        }
    }

    showPanel(panel: PanelView, focus: boolean): void {
        if (panel.container !== this || this.isClosing || this.isDestroyed || panel.isClosingOrGone) {
            return;
        }
        this.panels = [...this.panels.filter((p) => p !== panel), panel];
        const changed = this.shown !== panel;
        this.shown = panel;
        panel.lastShownAt = Date.now();
        this.layout();
        this.updateTitle();
        if (focus) {
            this.bringForward();
            panel.wc.focus();
        }
        if (changed || focus) {
            this.d.shownPanelChanged(this);
        }
    }

    hidePanel(panel: PanelView): void {
        if (!this.panels.includes(panel) && this.shown !== panel) {
            return;
        }
        const hadFocus = !panel.isGone && panel.wc.isFocused();
        this.panels = this.panels.filter((p) => p !== panel);
        this.closingPanels.add(panel);
        try {
            panel.view.setVisible(false);
        } catch {
            /* view gone */
        }
        if (this.shown === panel) {
            this.shown = this.lastViewed();
            if (!this.isClosing && !this.isDestroyed) {
                this.layout();
                this.updateTitle();
                if (this.shown) {
                    this.shown.lastShownAt = Date.now();
                    if (hadFocus) {
                        this.shown.wc.focus();
                    }
                }
                this.d.shownPanelChanged(this);
            }
        }
    }

    removePanel(panel: PanelView): void {
        this.panels = this.panels.filter((p) => p !== panel);
        this.closingPanels.delete(panel);
        if (panel.container === this) {
            panel.container = undefined;
        }
        if (!this.isDestroyed) {
            try {
                this.win.contentView.removeChildView(panel.view);
            } catch {
                /* already removed */
            }
        }
        if (this.shown === panel) {
            this.shown = this.lastViewed();
            if (!this.isClosing && !this.isDestroyed) {
                this.layout();
                this.updateTitle();
                this.d.shownPanelChanged(this);
            }
        }
    }

    panelTitleChanged(panel: PanelView): void {
        if (panel === this.shown) {
            this.updateTitle();
        }
    }

    private lastViewed(): PanelView | undefined {
        for (let i = this.panels.length - 1; i >= 0; i--) {
            if (!this.panels[i].isClosingOrGone) {
                return this.panels[i];
            }
        }
        return undefined;
    }

    // --- SidebarOwner (the page's requests; the sender was checked by SidebarService) ------

    sidebarModel(): SidebarPageModel | null {
        return this.alive ? this.d.sidebarModel(this) : null;
    }

    runItem(handle: unknown): void {
        this.markInteraction();
        this.d.runItem(this, handle);
    }

    runAction(token: unknown): void {
        this.markInteraction();
        this.d.runAction(this, token);
    }

    showItemMenu(handle: unknown): void {
        this.markInteraction();
        this.d.showItemMenu(this, handle);
    }

    showTitleMenu(viewId: unknown): void {
        this.markInteraction();
        this.d.showTitleMenu(this, viewId);
    }

    closeNote(handle: unknown): void {
        this.markInteraction();
        this.d.closeNote(this, handle);
    }

    setCollapsed(collapsed: unknown): void {
        if (typeof collapsed !== 'boolean' || !this.alive) {
            return;
        }
        this.collapsed = collapsed;
        this.layout();
        this.d.sidebarStateChanged(this, true);
    }

    setSidebarWidth(width: unknown, done: unknown): void {
        const w = clampSidebarWidth(width);
        if (w === undefined || !this.alive) {
            return;
        }
        this.width = w;
        this.layout();
        this.d.sidebarStateChanged(this, done === true);
    }

    setSectionExpanded(viewId: unknown, expanded: unknown): void {
        if (typeof expanded !== 'boolean' || !this.d.isSection(viewId) || !this.alive) {
            return;
        }
        this.sections = { ...this.sections, [viewId as string]: expanded };
        this.d.sidebarStateChanged(this, true);
    }

    toggleSidebar(): void {
        this.setCollapsed(!this.collapsed);
    }

    /** Notes are being opened into this window (its empty view stays blank meanwhile). */
    get opening(): boolean {
        return this.openingCount > 0;
    }

    /** Marks an open under way; call the returned function once it is done (or failed). */
    beginOpening(): () => void {
        this.openingCount++;
        let ended = false;
        return () => {
            if (ended) {
                return;
            }
            ended = true;
            this.openingCount--;
            if (this.alive) {
                this.d.shownPanelChanged(this);
            }
        };
    }

    /** The user works in this window (placement of the notes it opens). */
    private markInteraction(): void {
        this.lastFocusedAt = Date.now();
        this.d.focused(this);
    }

    // --- layout ------------------------------------------------------------------------------

    /** The sidebar's width on screen for a content width. */
    sidebarWidthFor(contentWidth: number): number {
        if (this.collapsed) {
            return SIDEBAR_COLLAPSED_WIDTH;
        }
        const w = clampSidebarWidth(this.width) ?? SIDEBAR_DEFAULT_WIDTH;
        return Math.max(SIDEBAR_COLLAPSED_WIDTH, Math.min(w, contentWidth - MIN_NOTE_WIDTH));
    }

    layout(): void {
        if (this.isDestroyed) {
            return;
        }
        const { width, height } = this.win.getContentBounds();
        const side = this.sidebarWidthFor(width);
        const shown = this.shown;
        this.sidebar.view.setBounds({ x: 0, y: 0, width: shown ? side : width, height });
        for (const p of [...this.panels, ...this.closingPanels]) {
            if (p === shown && !p.isClosingOrGone) {
                p.view.setBounds({ x: side, y: 0, width: Math.max(0, width - side), height });
                p.view.setVisible(true);
            } else {
                p.view.setVisible(false);
            }
        }
    }

    updateTitle(): void {
        if (!this.isDestroyed) {
            this.win.setTitle(this.shown ? this.shown.title : 'Fractal');
        }
    }

    applyTheme(dark: boolean): void {
        if (!this.isDestroyed) {
            this.win.setBackgroundColor(surfaceColors(dark).app);
            this.sidebar.setBackground(sidebarBackground(dark));
        }
    }

    bringForward(): void {
        if (this.isDestroyed) {
            return;
        }
        if (this.win.isMinimized()) {
            this.win.restore();
        }
        this.everShown = true;
        this.win.show();
        this.win.focus();
    }

    // --- close -------------------------------------------------------------------------------

    /** Closes every note it holds (shown and hidden, each flushed), then the sidebar and the window. Idempotent. */
    closeGracefully(): Promise<void> {
        if (!this.closing) {
            // set before anything runs: the window's own 'hide' event must already see it closing
            this.closing = Promise.resolve().then(() => this.runClose());
        }
        return this.closing;
    }

    private async runClose(): Promise<void> {
        try {
            this.win.hide(); // gone for the user at once; the pages keep running until flushed
        } catch {
            /* destroyed */
        }
        await this.closeHeldPanels();
        this.sidebar.close();
        this.allowClose = true;
        if (!this.win.isDestroyed()) {
            this.win.destroy();
        }
    }

    /** Every note it holds — shown, hidden and those already closing — each with its flush. */
    private async closeHeldPanels(): Promise<void> {
        const panels = [...this.panels, ...this.closingPanels];
        await Promise.allSettled(panels.map((p) => p.closeGracefully()));
    }

    // --- wiring ------------------------------------------------------------------------------

    private wire(): void {
        const win = this.win;
        const showFirst = () => {
            if (!this.everShown && !this.isClosing && !this.isDestroyed) {
                this.bringForward();
            }
        };
        this.sidebar.view.webContents.once('did-finish-load', showFirst);
        setTimeout(showFirst, SHOW_FALLBACK_MS).unref?.();

        win.on('resize', () => {
            this.layout();
            this.scheduleBounds();
        });
        win.on('move', () => this.scheduleBounds());
        win.on('focus', () => {
            if (this.isClosing) {
                return;
            }
            this.lastFocusedAt = Date.now();
            this.d.focused(this);
        });
        for (const ev of ['show', 'hide', 'minimize', 'restore'] as const) {
            win.on(ev as 'show', () => {
                if (!this.isClosing && !this.isDestroyed) {
                    this.d.shownPanelChanged(this);
                }
            });
        }
        win.on('close', (e) => {
            if (this.allowClose) {
                return;
            }
            e.preventDefault();
            this.d.closeRequested(this);
        });
        win.on('closed', () => {
            this.destroyed = true;
            if (this.boundsTimer) {
                clearTimeout(this.boundsTimer);
                this.boundsTimer = null;
            }
            this.sidebar.close();
            // destroyed without closeGracefully (not expected): the notes it held still flush and dispose
            void this.closeHeldPanels();
            this.d.closed(this);
        });
    }

    private scheduleBounds(): void {
        if (this.boundsTimer) {
            clearTimeout(this.boundsTimer);
        }
        this.boundsTimer = setTimeout(() => {
            this.boundsTimer = null;
            if (!this.isDestroyed && !this.win.isMinimized() && !this.win.isFullScreen()) {
                this.d.boundsChanged(this.win.getNormalBounds());
            }
        }, 500);
    }
}

export interface WindowManagerOptions {
    delegate: AppWindowDelegate;
    sidebars: SidebarService;
    /** Saved bounds for a new window (cascaded when other windows are open). */
    savedBounds(): WindowBounds | undefined;
    /** The sidebar state a new window starts with (the last one saved). */
    sidebarDefaults(): SidebarUiState;
}

export class WindowManager {
    private readonly list: AppWindow[] = [];
    private lastFocused: AppWindow | undefined;

    constructor(private readonly o: WindowManagerOptions) {}

    create(): AppWindow {
        const w = new AppWindow(this.o.delegate, this.o.sidebars, this.nextBounds(), this.o.sidebarDefaults());
        this.list.push(w);
        this.lastFocused = w;
        w.lastFocusedAt = Date.now();
        return w;
    }

    /** Open windows (not closing), oldest first. */
    all(): AppWindow[] {
        return this.list.filter((w) => w.alive);
    }

    /** Every window not yet destroyed (closing ones too). */
    existing(): AppWindow[] {
        return this.list.filter((w) => !w.isDestroyed);
    }

    fromBaseWindow(win: BaseWindow | null | undefined): AppWindow | undefined {
        return win ? this.list.find((w) => w.win === win && !w.isDestroyed) : undefined;
    }

    focused(): AppWindow | undefined {
        const w = this.fromBaseWindow(BaseWindow.getFocusedWindow());
        return w && w.alive ? w : undefined;
    }

    /** The window the user works in: the focused one, else the last focused one still open. */
    current(): AppWindow | undefined {
        const focused = this.focused();
        if (focused) {
            return focused;
        }
        if (this.lastFocused && this.lastFocused.alive) {
            return this.lastFocused;
        }
        return this.all().sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)[0];
    }

    noteFocused(w: AppWindow): void {
        if (w.alive) {
            this.lastFocused = w;
        }
    }

    forget(w: AppWindow): void {
        const i = this.list.indexOf(w);
        if (i >= 0) {
            this.list.splice(i, 1);
        }
        if (this.lastFocused === w) {
            this.lastFocused = undefined;
        }
    }

    /** Closes every window (each note flushed). */
    async closeAll(): Promise<void> {
        await Promise.allSettled(this.existing().map((w) => w.closeGracefully()));
    }

    private nextBounds(): Rectangle {
        const saved = this.o.savedBounds();
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
}
