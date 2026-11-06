/**
 * AC-2 / AC-2b (spec 20261107-0431-electron-sidebar): the sidebar of the BUILT desktop app (E2E build,
 * like notes-smoke.spec.ts — see there and harness.ts for how it is built and launched).
 *
 *   build:  cd electron && npm run build:app-dir && npm run pack:e2e   (or npm run test:e2e: builds both, runs all)
 *   run:    npx playwright test test/e2e-electron-app/sidebar.spec.ts
 *
 * Each test: a temp HOME whose ~/.fractal/default.fractal lists notes made by the extension's own
 * NotesFileManager, a temp profile (--fractal-user-data), FRACTAL_NO_EXTERNAL=1 (Finder / browser are
 * logged, never opened). The sidebar is the extension's own tree providers + package.json contributes
 * drawn by the shell; clicks / buttons run the extension's commands; the window model is BaseWindow +
 * WebContentsViews (D1).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';
import {
    acceptPrompt,
    appWindows,
    clickMenu,
    launchApp,
    menuLabels,
    nextPanelPage,
    outTexts,
    panelPages,
    rmrf,
    sidebarPages,
    waitForFile,
    type MenuItemLike,
    type WindowInfo,
} from './harness';

/** After a close: shorter than the extension's 1 s save debounce (only the close sequence writes in time). */
const CLOSE_WRITE_MS = 500;
const COLLAPSED = 28;
const DEFAULT_WIDTH = 260;

interface Fixture {
    tmp: string;
    home: string;
    userData: string;
    notes: Record<string, { dir: string; out: string }>;
    registry: string;
    log(): string;
    state(): Record<string, unknown>;
}

function makeFixture(names = ['note-a', 'note-b']): Fixture {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-e2e-sidebar-')));
    const home = path.join(tmp, 'home');
    const userData = path.join(tmp, 'userData');
    fs.mkdirSync(home, { recursive: true });
    const notes: Fixture['notes'] = {};
    for (const name of names) {
        const dir = path.join(tmp, 'notes', name);
        fs.mkdirSync(dir, { recursive: true });
        const fm = new NotesFileManager(dir);
        fm.loadStructure();
        const out = fm.createFile(`${name} outline`);
        fm.dispose();
        notes[name] = { dir, out };
    }
    const registry = path.join(home, '.fractal', 'default.fractal');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, JSON.stringify({ version: 1, notes: names.map((n) => notes[n].dir) }, null, 2) + '\n');
    return {
        tmp,
        home,
        userData,
        notes,
        registry,
        log: () => {
            try {
                return fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
            } catch {
                return '';
            }
        },
        state: () => JSON.parse(fs.readFileSync(path.join(userData, 'desktop-state.json'), 'utf8')),
    };
}

/** The app with its first sidebar and (when the list has notes) the first note's page. */
async function start(fx: Fixture, withNote = true): Promise<{ app: ElectronApplication; sidebar: Page; first?: Page }> {
    const app = await launchApp(fx);
    const [sidebar] = await sidebarPages(app);
    // the sidebar has its model (collapsed: only the bar)
    await expect(sidebar.locator('.app .bar, .pane[data-view="notesExplorer"] .pane-header').first()).toBeVisible({ timeout: 30000 });
    if (!withNote) {
        return { app, sidebar };
    }
    const first = await nextPanelPage(app);
    return { app, sidebar, first };
}

/** The row of a Notes / Fractal List item by its label. */
function row(sidebar: Page, view: 'notesExplorer' | 'notesLists', label: string) {
    return sidebar.locator(`.pane[data-view="${view}"] .row`, { has: sidebar.locator('.label', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
}

/** The single app window (asserts there is exactly one). */
async function onlyWindow(app: ElectronApplication): Promise<WindowInfo> {
    const wins = await appWindows(app);
    expect(wins.length, `windows: ${JSON.stringify(wins.map((w) => w.title))}`).toBe(1);
    return wins[0];
}

function sidebarView(w: WindowInfo) {
    const v = w.views.find((x) => x.url.startsWith('fractal-ui://sidebar/'));
    expect(v, 'the window has a sidebar view').toBeTruthy();
    return v!;
}

function shownNoteView(w: WindowInfo) {
    return w.views.filter((x) => x.url.startsWith('fractal-res:') && x.visible);
}

/** The panel id (panel-N) of a note page — its URL host. */
function panelId(p: Page): string {
    return new URL(p.url()).host;
}

/** Captures the next native popup menu (Menu.popup) instead of showing it; returns its labels. */
async function captureNextPopup(app: ElectronApplication): Promise<void> {
    await app.evaluate(({ Menu }) => {
        const g = globalThis as unknown as { __fxPopup?: unknown; __fxOrigPopup?: unknown };
        g.__fxPopup = undefined;
        if (!g.__fxOrigPopup) {
            g.__fxOrigPopup = Menu.prototype.popup;
        }
        Menu.prototype.popup = function (this: unknown) {
            g.__fxPopup = this;
        };
    });
}

async function popupLabels(app: ElectronApplication): Promise<string[]> {
    await expect.poll(() => app.evaluate(() => !!(globalThis as unknown as { __fxPopup?: unknown }).__fxPopup), { timeout: 10000 }).toBe(true);
    return app.evaluate(() => {
        const m = (globalThis as unknown as { __fxPopup: { items: MenuItemLike[] } }).__fxPopup;
        return m.items.map((i) => (i.type === 'separator' ? '---' : i.label));
    });
}

async function clickPopupItem(app: ElectronApplication, label: string): Promise<void> {
    const ok = await app.evaluate((_e, l) => {
        const m = (globalThis as unknown as { __fxPopup?: { items: MenuItemLike[] } }).__fxPopup;
        const it = m?.items.find((i) => i.label === l);
        if (!it) {
            return false;
        }
        it.click();
        return true;
    }, label);
    expect(ok, `popup item ${label}`).toBe(true);
}

async function typeInFirstOutlinerNode(page: Page, text: string): Promise<void> {
    const node = page.locator('.outliner-node .outliner-text').first();
    await expect(node).toBeVisible();
    await node.click();
    await page.keyboard.press('End');
    await page.keyboard.type(text);
}

/**
 * Makes the window with this title the key window, as a real click in it does (Playwright's input goes to the
 * page, not through the OS, so it never changes the key window). Through the OS when it lets the app come
 * forward; in a session where the app cannot become active (no key window at all — the shell then has no key
 * window to act on), by answering BaseWindow.getFocusedWindow() — all the shell reads of it — with that
 * window. Returns the undo.
 */
async function makeKeyWindow(app: ElectronApplication, title: string): Promise<() => Promise<void>> {
    await app.evaluate(({ BaseWindow }, t) => BaseWindow.getAllWindows().find((w: { getTitle(): string }) => w.getTitle() === t)?.focus(), title);
    for (const end = Date.now() + 3000; Date.now() < end; ) {
        if (await app.evaluate(({ BaseWindow }, t) => BaseWindow.getFocusedWindow()?.getTitle() === t, title)) {
            return async () => undefined;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    const stubbed = await app.evaluate(({ BaseWindow }, t) => {
        const target = BaseWindow.getAllWindows().find((w: { getTitle(): string }) => w.getTitle() === t);
        if (!target) {
            return false;
        }
        const g = globalThis as unknown as { __fxGetFocused?: unknown };
        g.__fxGetFocused = g.__fxGetFocused ?? BaseWindow.getFocusedWindow;
        BaseWindow.getFocusedWindow = () => (target.isDestroyed() ? null : target);
        return true;
    }, title);
    expect(stubbed, `a window titled "${title}"`).toBe(true);
    return async () => {
        await app.evaluate(({ BaseWindow }) => {
            const g = globalThis as unknown as { __fxGetFocused?: typeof BaseWindow.getFocusedWindow };
            if (g.__fxGetFocused) {
                BaseWindow.getFocusedWindow = g.__fxGetFocused;
                g.__fxGetFocused = undefined;
            }
        });
    };
}

/** Drags the sidebar's edge by dx (the pointer starts on the middle of the sash). */
async function dragSash(sidebar: Page, dx: number, during?: () => Promise<void>): Promise<void> {
    const box = (await sidebar.locator('.sidebar .sash').boundingBox())!;
    const x0 = box.x + box.width / 2;
    const y = box.y + 200;
    await sidebar.mouse.move(x0, y);
    await sidebar.mouse.down();
    if (during) {
        await sidebar.mouse.move(x0 + Math.round(dx * 0.4), y, { steps: 4 });
        await during();
    }
    await sidebar.mouse.move(x0 + dx, y, { steps: 6 });
    await sidebar.mouse.up();
}

test.describe('desktop app (Electron) — the sidebar (spec 20261107-0431)', () => {
    test.skip(process.platform !== 'darwin', 'the desktop app is built for macOS only');
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(240000);

    test('AC-2 Fractal List and Notes on the left; a chosen note switches in the same window and the previous one comes back as it was; the 28px bar; collapsed survives a restart; the buttons run the extension commands', async () => {
        const fx = makeFixture();
        try {
            let { app, sidebar, first } = await start(fx);
            try {
                // --- the two views of the extension, drawn from package.json contributes ---
                await expect(sidebar.locator('.topbar .title')).toHaveText('Fractal Note');
                await expect(sidebar.locator('.pane-header .name')).toHaveText(['Fractal List', 'Notes']);
                await expect(sidebar.locator('.pane[data-view="notesExplorer"] .pane-header .description')).toHaveText('default.fractal');
                await expect(row(sidebar, 'notesLists', 'default.fractal').locator('.description')).toHaveText('●');
                await expect(sidebar.locator('.pane[data-view="notesExplorer"] .row .label')).toHaveText(['note-a', 'note-b']);
                // view/title (navigation) buttons with the commands' titles; view/item/context inline buttons
                const titleButtons = (view: string) => sidebar.locator(`.pane[data-view="${view}"] .pane-header .title-action`);
                expect(await titleButtons('notesLists').evaluateAll((bs) => bs.map((b) => b.getAttribute('title')))).toEqual(['Create New .fractal…', 'Add Existing .fractal…']);
                expect(await titleButtons('notesExplorer').evaluateAll((bs) => bs.map((b) => b.getAttribute('title')))).toEqual(['New Note…', 'Add Existing Note Folder…']);
                expect(await row(sidebar, 'notesExplorer', 'note-b').locator('.inline-action').evaluateAll((bs) => bs.map((b) => b.getAttribute('title')))).toEqual([
                    'Reveal in Finder / Explorer',
                    'Remove from Notes (keeps the folder)',
                ]);
                // tooltip = the TreeItem's (the folder path), icons = the ThemeIcons as inline SVG
                await expect(row(sidebar, 'notesExplorer', 'note-a')).toHaveAttribute('title', fx.notes['note-a'].dir);
                expect(await row(sidebar, 'notesExplorer', 'note-a').locator('.item-icon svg').count()).toBe(1);

                // --- the first note is open and shown, right of the sidebar ---
                let win = await onlyWindow(app);
                expect(win.title).toBe('Notes: note-a');
                expect(sidebarView(win).bounds).toMatchObject({ x: 0, width: DEFAULT_WIDTH });
                expect(shownNoteView(win).map((v) => v.bounds)).toEqual([{ x: DEFAULT_WIDTH, y: 0, width: win.content.width - DEFAULT_WIDTH, height: win.content.height }]);
                await expect(row(sidebar, 'notesExplorer', 'note-a')).toHaveClass(/\bshown\b/);
                await expect(row(sidebar, 'notesExplorer', 'note-a').locator('.dot')).toBeVisible();
                const pageA = first!;
                await pageA.evaluate(() => {
                    (window as unknown as { __kept: string }).__kept = 'still the same page';
                });

                // --- choose note-b: the same window, a second view; note-a stays alive behind it ---
                await row(sidebar, 'notesExplorer', 'note-b').click();
                const pageB = await nextPanelPage(app, [pageA]);
                await expect.poll(async () => (await onlyWindow(app)).title).toBe('Notes: note-b');
                win = await onlyWindow(app);
                expect(win.views.filter((v) => v.url.startsWith('fractal-res:')).length).toBe(2);
                expect(shownNoteView(win).map((v) => new URL(v.url).host)).toEqual([panelId(pageB)]);
                await expect(row(sidebar, 'notesExplorer', 'note-b')).toHaveClass(/\bshown\b/);
                await expect(row(sidebar, 'notesExplorer', 'note-a')).not.toHaveClass(/\bshown\b/);
                await expect(row(sidebar, 'notesExplorer', 'note-a').locator('.dot')).toBeVisible(); // still open (kept)

                // --- choose note-a again: no new page, the same page as before (not reloaded) ---
                await row(sidebar, 'notesExplorer', 'note-a').click();
                await expect.poll(async () => (await onlyWindow(app)).title).toBe('Notes: note-a');
                expect(panelPages(app).length).toBe(2);
                expect(await pageA.evaluate(() => (window as unknown as { __kept?: string }).__kept)).toBe('still the same page');
                win = await onlyWindow(app);
                expect(shownNoteView(win).map((v) => new URL(v.url).host)).toEqual([panelId(pageA)]);

                // --- collapse: a 28px bar with only the expand button; the note gets the width ---
                await sidebar.locator('.topbar .collapse').click();
                await expect(sidebar.locator('.app .bar .expand')).toBeVisible();
                await expect(sidebar.locator('.app .sidebar')).toHaveCount(0);
                await expect.poll(async () => sidebarView(await onlyWindow(app)).bounds.width).toBe(COLLAPSED);
                win = await onlyWindow(app);
                expect(shownNoteView(win).map((v) => v.bounds)).toEqual([{ x: COLLAPSED, y: 0, width: win.content.width - COLLAPSED, height: win.content.height }]);
                expect(await sidebar.locator('.bar button').count()).toBe(1);
            } finally {
                await app.close();
            }
            expect(fx.state().sidebar).toMatchObject({ collapsed: true, width: DEFAULT_WIDTH });

            // --- the next start: still collapsed; expand; drag the edge; the title buttons ---
            ({ app, sidebar, first } = await start(fx));
            try {
                await expect(sidebar.locator('.app .bar .expand')).toBeVisible();
                await expect.poll(async () => sidebarView(await onlyWindow(app)).bounds.width).toBe(COLLAPSED);
                await sidebar.locator('.bar .expand').click();
                await expect(sidebar.locator('.app .sidebar')).toBeVisible();
                await expect.poll(async () => sidebarView(await onlyWindow(app)).bounds.width).toBe(DEFAULT_WIDTH);

                // the edge: drag 100px to the right → 360px, and never past 480
                const sash = sidebar.locator('.sidebar .sash');
                const box = (await sash.boundingBox())!;
                await sidebar.mouse.move(box.x + box.width / 2, box.y + 200);
                await sidebar.mouse.down();
                await sidebar.mouse.move(box.x + box.width / 2 + 50, box.y + 200, { steps: 4 });
                await sidebar.mouse.move(box.x + box.width / 2 + 100, box.y + 200, { steps: 4 });
                await sidebar.mouse.up();
                await expect.poll(async () => sidebarView(await onlyWindow(app)).bounds.width).toBe(DEFAULT_WIDTH + 100);
                const w2 = await onlyWindow(app);
                expect(shownNoteView(w2).map((v) => v.bounds.x)).toEqual([DEFAULT_WIDTH + 100]);
                await expect.poll(() => (fx.state().sidebar as { width?: number }).width, { timeout: 5000 }).toBe(DEFAULT_WIDTH + 100);
                const box2 = (await sash.boundingBox())!;
                await sidebar.mouse.move(box2.x + 2, box2.y + 200);
                await sidebar.mouse.down();
                await sidebar.mouse.move(box2.x + 600, box2.y + 200, { steps: 6 });
                await sidebar.mouse.up();
                await expect.poll(async () => sidebarView(await onlyWindow(app)).bounds.width).toBe(480);

                // Notes > Reveal in Finder / Explorer (inline) → the extension's fractal.revealNotesFolder → Finder (logged)
                await row(sidebar, 'notesExplorer', 'note-b').hover();
                await row(sidebar, 'notesExplorer', 'note-b').locator('.inline-action[title="Reveal in Finder / Explorer"]').click();
                await expect.poll(() => fx.log()).toContain(`(no-external) showItemInFolder ${fx.notes['note-b'].dir}`);
                // Fractal List > Reveal (inline) → fractal.revealNotesRegistry with the item → the .fractal file
                await row(sidebar, 'notesLists', 'default.fractal').hover();
                await row(sidebar, 'notesLists', 'default.fractal').locator('.inline-action[title="Reveal in Finder / Explorer"]').click();
                await expect.poll(() => fx.log()).toContain(`(no-external) showItemInFolder ${fx.registry}`);

                // Notes > New Note… (title button) → the extension's flow: folder picker → name prompt → opens in THIS window
                const parent = path.join(fx.tmp, 'notes');
                await app.evaluate(({ dialog }, answer) => {
                    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [answer] });
                }, parent);
                const before = panelPages(app);
                const promptOpened = app.waitForEvent('window', { timeout: 20000 });
                await sidebar.locator('.pane[data-view="notesExplorer"] .pane-header').hover();
                await sidebar.locator('.pane[data-view="notesExplorer"] .title-action[title="New Note…"]').click();
                const namePrompt = await promptOpened;
                await expect(namePrompt.locator('input.field')).toBeVisible();
                await namePrompt.locator('input.field').fill('note-c');
                await acceptPrompt(namePrompt);
                await nextPanelPage(app, before);
                await expect.poll(async () => (await onlyWindow(app)).title).toBe('Notes: note-c');
                const reg = JSON.parse(fs.readFileSync(fx.registry, 'utf8')) as { notes: string[] };
                expect(reg.notes).toEqual([fx.notes['note-a'].dir, fx.notes['note-b'].dir, path.join(parent, 'note-c')]);
                await expect(sidebar.locator('.pane[data-view="notesExplorer"] .row .label')).toHaveText(['note-a', 'note-b', 'note-c']);
                await expect(row(sidebar, 'notesExplorer', 'note-c')).toHaveClass(/\bshown\b/);
                // the menu still lists the notes too
                await expect.poll(() => menuLabels(app, 'File', 'Notes')).toEqual(['note-a', 'note-b', 'note-c']);
            } finally {
                await app.close();
            }
            const st = fx.state();
            expect(st.sidebar).toMatchObject({ collapsed: false, width: 480 });
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-2 right-click > Open in New Window: a second window with its own sidebar; an open note moves there; the menu has the non-inline entries; welcome content when the list is empty; a removed note stays open', async () => {
        const fx = makeFixture();
        try {
            const { app, sidebar, first } = await start(fx);
            try {
                // right-click a note: the shell's entries, then view/item/context outside `inline`
                await captureNextPopup(app);
                await row(sidebar, 'notesExplorer', 'note-b').click({ button: 'right' });
                expect(await popupLabels(app)).toEqual(['Open in New Window', '---', 'Migrate to Flat Layout']);
                await captureNextPopup(app);
                await row(sidebar, 'notesExplorer', 'note-a').click({ button: 'right' });
                expect(await popupLabels(app)).toEqual(['Open in New Window', 'Close Note', '---', 'Migrate to Flat Layout']);
                // the Fractal List rows have no non-inline entries: no menu
                await captureNextPopup(app);
                await row(sidebar, 'notesLists', 'default.fractal').click({ button: 'right' });
                await sidebar.waitForTimeout(500);
                expect(await app.evaluate(() => !!(globalThis as unknown as { __fxPopup?: unknown }).__fxPopup)).toBe(false);

                // Open in New Window on a note that is not open: a second window, its own sidebar, the note there
                await captureNextPopup(app);
                await row(sidebar, 'notesExplorer', 'note-b').click({ button: 'right' });
                await popupLabels(app);
                await clickPopupItem(app, 'Open in New Window');
                const pageB = await nextPanelPage(app, [first!]);
                await expect.poll(async () => (await appWindows(app)).map((w) => w.title).sort()).toEqual(['Notes: note-a', 'Notes: note-b']);
                const [, sidebar2] = await sidebarPages(app, 2);
                await expect(row(sidebar2, 'notesExplorer', 'note-b')).toHaveClass(/\bshown\b/);
                await expect(row(sidebar2, 'notesExplorer', 'note-a').locator('.dot')).toBeVisible(); // open (in the first window)
                await expect(row(sidebar, 'notesExplorer', 'note-b').locator('.dot')).toBeVisible();
                let wins = await appWindows(app);
                const holder = (id: string) => wins.find((w) => w.views.some((v) => v.url.startsWith(`fractal-res://${id}/`)));
                expect(holder(panelId(pageB))?.title).toBe('Notes: note-b');
                expect(holder(panelId(first!))?.title).toBe('Notes: note-a');

                // Open in New Window on an open note: its page (not a copy) moves into a new window
                await first!.evaluate(() => {
                    (window as unknown as { __kept: string }).__kept = 'moved, not reloaded';
                });
                await captureNextPopup(app);
                await row(sidebar, 'notesExplorer', 'note-a').click({ button: 'right' });
                await popupLabels(app);
                await clickPopupItem(app, 'Open in New Window');
                await expect.poll(async () => (await appWindows(app)).length).toBe(3);
                await expect.poll(async () => (await appWindows(app)).map((w) => w.title).sort()).toEqual(['Fractal', 'Notes: note-a', 'Notes: note-b']);
                expect(panelPages(app).length).toBe(2);
                expect(await first!.evaluate(() => (window as unknown as { __kept?: string }).__kept)).toBe('moved, not reloaded');
                wins = await appWindows(app);
                const emptied = wins.find((w) => w.title === 'Fractal')!;
                // the first window shows no note now: its sidebar view spans the window (the empty view)
                expect(sidebarView(emptied).bounds.width).toBe(emptied.content.width);
                await expect(sidebar.locator('.empty')).toBeVisible();

                // Notes > Remove from Notes (inline ×) → the extension's fractal.removeNotesFolder: the .fractal changes, the notes stay open
                for (const name of ['note-a', 'note-b']) {
                    await row(sidebar, 'notesExplorer', name).hover();
                    await row(sidebar, 'notesExplorer', name).locator('.inline-action[title="Remove from Notes (keeps the folder)"]').click();
                    await expect(row(sidebar, 'notesExplorer', name)).toHaveCount(0);
                }
                expect((JSON.parse(fs.readFileSync(fx.registry, 'utf8')) as { notes: string[] }).notes).toEqual([]);
                expect(panelPages(app).length).toBe(2);
                // the list is empty: viewsWelcome (when fractal.hasNotesRegistry), its links as buttons
                const welcome = sidebar.locator('.pane[data-view="notesExplorer"] .welcome');
                await expect(welcome.locator('p')).toHaveText(['This .fractal has no notes yet. A note is a folder.']);
                await expect(welcome.locator('.button')).toHaveText(['New Note', 'Add Existing Note Folder']);
                // a welcome button runs its command: Add Existing Note Folder → the extension's addFolder (folder picker answered)
                await app.evaluate(({ dialog }, answer) => {
                    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [answer] });
                }, fx.notes['note-b'].dir);
                await welcome.locator('.button', { hasText: 'Add Existing Note Folder' }).click();
                await expect(sidebar.locator('.pane[data-view="notesExplorer"] .row .label')).toHaveText(['note-b']);
                expect((JSON.parse(fs.readFileSync(fx.registry, 'utf8')) as { notes: string[] }).notes).toEqual([fx.notes['note-b'].dir]);
            } finally {
                await app.close();
            }
            // the quit remembered the notes by window
            const st = fx.state() as { openWindows?: string[][]; openNoteFolders?: string[] };
            expect([...(st.openNoteFolders ?? [])].sort()).toEqual([fx.notes['note-a'].dir, fx.notes['note-b'].dir].sort());
            expect((st.openWindows ?? []).map((g) => g.length).sort()).toEqual([1, 1]);
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-2 an empty Fractal List shows its welcome content; Notes asks to choose a .fractal (when !fractal.hasNotesRegistry)', async () => {
        const fx = makeFixture([]);
        // no .fractal registered: the extension creates ~/.fractal/default.fractal on its first run, so register none
        // by marking the first run done in the profile's globalState (the extension's own key) with no registries
        fs.mkdirSync(path.join(fx.userData, 'User'), { recursive: true });
        fs.writeFileSync(path.join(fx.userData, 'User', 'globalState.json'), JSON.stringify({ notesDefaultFractalCreated: true, notesRegistries: [] }));
        fs.rmSync(fx.registry, { force: true });
        try {
            const { app, sidebar } = await start(fx, false);
            try {
                const lists = sidebar.locator('.pane[data-view="notesLists"] .welcome');
                await expect(lists.locator('p')).toHaveText(['Add an existing .fractal, or create a new one.']);
                await expect(lists.locator('.button')).toHaveText(['Add Existing .fractal', 'Create New .fractal']);
                const notes = sidebar.locator('.pane[data-view="notesExplorer"] .welcome');
                await expect(notes.locator('p')).toHaveText(['Choose or create a .fractal in Fractal List above.']);
                await expect(notes.locator('.button')).toHaveCount(0);
                // the Notes title buttons need fractal.hasNotesRegistry
                expect(await sidebar.locator('.pane[data-view="notesExplorer"] .title-action').count()).toBe(0);
                // no note: the empty view (blank while the start still looks for a first note — up to 4 s on a
                // first run — then the hint), and the window shows the whole sidebar view
                await expect(sidebar.locator('.empty')).toHaveText('Select a note from the list on the left.', { timeout: 15000 });
                const w = await onlyWindow(app);
                expect(w.title).toBe('Fractal');
                expect(sidebarView(w).bounds.width).toBe(w.content.width);
                // Create New .fractal → the extension's createRegistry (folder picker + name prompt) → setContext → Notes switches welcome
                const dir = path.join(fx.tmp, 'lists');
                fs.mkdirSync(dir, { recursive: true });
                await app.evaluate(({ dialog }, answer) => {
                    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [answer] });
                }, dir);
                const promptOpened = app.waitForEvent('window', { timeout: 20000 });
                await lists.locator('.button', { hasText: 'Create New .fractal' }).click();
                const prompt = await promptOpened;
                await prompt.locator('input.field').fill('work');
                await acceptPrompt(prompt);
                await expect(row(sidebar, 'notesLists', 'work.fractal')).toBeVisible();
                await expect(sidebar.locator('.pane[data-view="notesExplorer"] .welcome p')).toHaveText(['This .fractal has no notes yet. A note is a folder.']);
                await expect(sidebar.locator('.pane[data-view="notesExplorer"] .title-action')).toHaveCount(2);
                expect(fs.existsSync(path.join(dir, 'work.fractal'))).toBe(true);
            } finally {
                await app.close();
            }
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-2 closing a window flushes and disposes every note it holds, the hidden ones too (typed text saved, every page gone)', async () => {
        const fx = makeFixture(['note-a', 'note-b']);
        try {
            const { app, sidebar, first } = await start(fx);
            try {
                const pageA = first!;
                await row(sidebar, 'notesExplorer', 'note-b').click();
                const pageB = await nextPanelPage(app, [pageA]);
                await typeInFirstOutlinerNode(pageB, 'typed in b');
                // back to note-a, type, hide it behind note-b and close the window at once (well inside the
                // outliner's own 1 s sync debounce and the host's 1 s write debounce)
                await row(sidebar, 'notesExplorer', 'note-a').click();
                await expect.poll(async () => (await onlyWindow(app)).title).toBe('Notes: note-a');
                await typeInFirstOutlinerNode(pageA, 'typed in a, then hidden');
                await row(sidebar, 'notesExplorer', 'note-b').click();
                const closed = Promise.all([pageA.waitForEvent('close', { timeout: 20000 }), pageB.waitForEvent('close', { timeout: 20000 })]);
                await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].close());
                await closed;
                const outA = await waitForFile(fx.notes['note-a'].out, (t) => outTexts(t).includes('typed in a, then hidden'), CLOSE_WRITE_MS);
                expect(outTexts(outA)).toContain('typed in a, then hidden');
                expect(outTexts(await waitForFile(fx.notes['note-b'].out, (t) => outTexts(t).includes('typed in b'), CLOSE_WRITE_MS))).toContain('typed in b');
                const left = () =>
                    app.evaluate(({ BaseWindow, webContents }) => ({
                        windows: BaseWindow.getAllWindows().length,
                        pages: webContents.getAllWebContents().filter((w) => !w.isDestroyed()).map((w) => `${w.getType()} ${w.getURL()}`),
                    }));
                // the sidebar page closes last (after every note): nothing is left of the window
                await expect.poll(left, { timeout: 10000 }).toEqual({ windows: 0, pages: [] });
            } finally {
                await app.close();
            }
            expect(fx.log()).not.toMatch(/did not confirm its flush|did not unload in time/);
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-2 the sidebar uses the same --vscode-* variables as the note views, light and dark (fractal.theme)', async () => {
        for (const [theme, bg, fg] of [
            ['dark', 'rgb(24, 24, 24)', 'rgb(204, 204, 204)'],
            ['light', 'rgb(248, 248, 248)', 'rgb(59, 59, 59)'],
        ] as const) {
            const fx = makeFixture(['note-a']);
            fs.mkdirSync(path.join(fx.userData, 'User'), { recursive: true });
            fs.writeFileSync(path.join(fx.userData, 'User', 'settings.json'), JSON.stringify({ 'fractal.theme': theme }));
            try {
                const { app, sidebar, first } = await start(fx);
                try {
                    await expect(sidebar.locator('html')).toHaveAttribute('data-fr-theme', theme);
                    const look = await sidebar.evaluate(() => {
                        const b = getComputedStyle(document.body);
                        const label = document.querySelector('.pane[data-view="notesExplorer"] .row:not(.shown) .label, .pane[data-view="notesLists"] .row .label') as HTMLElement;
                        return { bg: b.backgroundColor, fg: b.color, label: label ? getComputedStyle(label).color : '' };
                    });
                    expect(look, theme).toEqual({ bg, fg, label: fg });
                    // the very same variables (and values) the note page got
                    const vars = ['--vscode-sideBar-background', '--vscode-foreground', '--vscode-list-activeSelectionBackground', '--vscode-focusBorder'];
                    const read = (p: Page) => p.evaluate((names) => names.map((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()), vars);
                    const inSidebar = await read(sidebar);
                    expect(inSidebar.every((v) => v !== ''), JSON.stringify(inSidebar)).toBe(true);
                    expect(await read(first!)).toEqual(inSidebar);
                } finally {
                    await app.close();
                }
            } finally {
                rmrf(fx.tmp);
            }
        }
    });

    test('AC-2b open notes have a ●; on the ● it is a × that closes the note (flushed, its page gone); then the last viewed open note, else the empty view; right-click Close and Cmd+W do the same; the row × still removes from the list', async () => {
        const fx = makeFixture(['note-a', 'note-b', 'note-c']);
        try {
            const { app, sidebar, first } = await start(fx);
            try {
                const pageA = first!;
                await row(sidebar, 'notesExplorer', 'note-b').click();
                const pageB = await nextPanelPage(app, [pageA]);
                await expect.poll(async () => (await onlyWindow(app)).title).toBe('Notes: note-b');
                // ● on the open notes only; the shown one has the row color
                await expect(sidebar.locator('.pane[data-view="notesExplorer"] .row.open .label')).toHaveText(['note-a', 'note-b']);
                await expect(row(sidebar, 'notesExplorer', 'note-c').locator('.dot')).toHaveCount(0);
                await expect(row(sidebar, 'notesExplorer', 'note-b')).toHaveClass(/\bshown\b/);
                const bg = (label: string) => row(sidebar, 'notesExplorer', label).evaluate((el) => getComputedStyle(el).backgroundColor);
                await sidebar.mouse.move(5, 5);
                expect(await bg('note-b')).not.toBe(await bg('note-c'));

                // on the ●: × (and the ● hidden)
                const dotA = row(sidebar, 'notesExplorer', 'note-a').locator('.dot');
                const shownGlyph = () =>
                    dotA.evaluate((d) => ({
                        dot: getComputedStyle(d.querySelector('.dot-glyph') as Element).display !== 'none',
                        x: getComputedStyle(d.querySelector('.close-glyph') as Element).display !== 'none',
                    }));
                expect(await shownGlyph()).toEqual({ dot: true, x: false });
                await dotA.hover();
                expect(await shownGlyph()).toEqual({ dot: false, x: true });
                expect(await dotA.getAttribute('title')).toBe('Close Note');

                // type in note-b (shown), then its × at once: the close sequence saves it, its page goes, note-a (last viewed) is shown
                await typeInFirstOutlinerNode(pageB, 'typed just before the ×');
                const bClosed = pageB.waitForEvent('close', { timeout: 20000 });
                await row(sidebar, 'notesExplorer', 'note-b').locator('.dot').click();
                await bClosed;
                const outB = await waitForFile(fx.notes['note-b'].out, (s) => outTexts(s).includes('typed just before the ×'), CLOSE_WRITE_MS);
                expect(outTexts(outB)).toContain('typed just before the ×');
                await expect.poll(async () => (await onlyWindow(app)).title).toBe('Notes: note-a');
                expect(panelPages(app)).toEqual([pageA]);
                expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => w.getURL().startsWith('fractal-res:')).length)).toBe(1);
                await expect(row(sidebar, 'notesExplorer', 'note-b').locator('.dot')).toHaveCount(0);
                await expect(row(sidebar, 'notesExplorer', 'note-a')).toHaveClass(/\bshown\b/);

                // right-click > Close Note on the shown last open note: the empty view
                await captureNextPopup(app);
                await row(sidebar, 'notesExplorer', 'note-a').click({ button: 'right' });
                expect(await popupLabels(app)).toContain('Close Note');
                const aClosed = pageA.waitForEvent('close', { timeout: 20000 });
                await clickPopupItem(app, 'Close Note');
                await aClosed;
                await expect(sidebar.locator('.empty')).toHaveText('Select a note from the list on the left.');
                let w = await onlyWindow(app);
                expect(w.title).toBe('Fractal');
                expect(sidebarView(w).bounds.width).toBe(w.content.width);
                expect(panelPages(app)).toEqual([]);
                await expect(sidebar.locator('.pane[data-view="notesExplorer"] .row.open')).toHaveCount(0);

                // Cmd+W (File > Close Note): the shown note; File's item says Close Window when none is shown
                await row(sidebar, 'notesExplorer', 'note-c').click();
                const pageC = await nextPanelPage(app, []);
                await expect.poll(() => menuLabels(app, 'File')).toContain('Close Note');
                const closeItem = await app.evaluate(({ Menu }) => {
                    const file = Menu.getApplicationMenu()?.items.find((i: MenuItemLike) => i.label === 'File');
                    const it = file?.submenu?.items.find((i: MenuItemLike) => i.label === 'Close Note');
                    return it ? String(it.accelerator) : null;
                });
                expect(closeItem).toBe('CmdOrCtrl+W');
                await typeInFirstOutlinerNode(pageC, 'typed before Cmd+W');
                const cClosed = pageC.waitForEvent('close', { timeout: 20000 });
                // Cmd+W acts on the key window (the user presses it in this window)
                const unkey = await makeKeyWindow(app, 'Notes: note-c');
                await clickMenu(app, 'File', 'Close Note');
                await cClosed;
                await unkey();
                expect(outTexts(await waitForFile(fx.notes['note-c'].out, (s) => outTexts(s).includes('typed before Cmd+W'), CLOSE_WRITE_MS))).toContain(
                    'typed before Cmd+W'
                );
                await expect(sidebar.locator('.empty')).toBeVisible();
                await expect.poll(() => menuLabels(app, 'File')).not.toContain('Close Note');
                w = await onlyWindow(app);
                expect(w.views.filter((v) => v.url.startsWith('fractal-res:'))).toEqual([]);

                // the row's right-end × is still the extension's Remove from Notes (the list changes, nothing closes)
                await row(sidebar, 'notesExplorer', 'note-a').click();
                const pageA2 = await nextPanelPage(app, []);
                await row(sidebar, 'notesExplorer', 'note-a').hover();
                await row(sidebar, 'notesExplorer', 'note-a').locator('.inline-action[title="Remove from Notes (keeps the folder)"]').click();
                await expect(row(sidebar, 'notesExplorer', 'note-a')).toHaveCount(0);
                expect((JSON.parse(fs.readFileSync(fx.registry, 'utf8')) as { notes: string[] }).notes).toEqual([fx.notes['note-b'].dir, fx.notes['note-c'].dir]);
                expect(pageA2.isClosed()).toBe(false);
                expect((await onlyWindow(app)).title).toBe('Notes: note-a');
            } finally {
                await app.close();
            }
            expect(fx.log()).not.toMatch(/did not confirm its flush|uncaught exception|refused (item|action|menu|close)/);
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-2b Close Note (Cmd+W) and Close Window (Shift+Cmd+W) act on the key window only: with the window minimized (no key window) nothing closes', async () => {
        const fx = makeFixture(['note-a']);
        try {
            const { app, sidebar, first } = await start(fx);
            try {
                await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].minimize());
                await expect
                    .poll(() => app.evaluate(({ BaseWindow }) => ({ minimized: BaseWindow.getAllWindows()[0].isMinimized(), key: BaseWindow.getFocusedWindow() !== null })), {
                        timeout: 10000,
                    })
                    .toEqual({ minimized: true, key: false });
                // what the accelerators run (the app is frontmost, its only window minimized)
                await clickMenu(app, 'File', 'Close Note');
                await clickMenu(app, 'File', 'Close Window');
                await new Promise((r) => setTimeout(r, 1500));
                expect(first!.isClosed(), 'the note page').toBe(false);
                expect(sidebar.isClosed(), 'the sidebar page').toBe(false);
                expect(panelPages(app)).toEqual([first]);
                const wins = await appWindows(app);
                expect(wins.map((w) => w.title)).toEqual(['Notes: note-a']);
            } finally {
                await app.close();
            }
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-2b Open in New Window on a note whose close is still under way: the note opens in the new window once its close is done', async () => {
        const fx = makeFixture(['note-a', 'note-b']);
        try {
            const { app, sidebar, first } = await start(fx);
            try {
                const pageA = first!;
                await row(sidebar, 'notesExplorer', 'note-b').click();
                const pageB = await nextPanelPage(app, [pageA]);
                await row(sidebar, 'notesExplorer', 'note-a').click();
                await expect.poll(async () => (await onlyWindow(app)).title).toBe('Notes: note-a');
                // note-b is open behind note-a; its row menu (its Open in New Window is clicked once the close has begun)
                await captureNextPopup(app);
                await row(sidebar, 'notesExplorer', 'note-b').click({ button: 'right' });
                expect(await popupLabels(app)).toEqual(['Open in New Window', 'Close Note', '---', 'Migrate to Flat Layout']);
                // note-b's page is busy for 1.5 s, so its close waits for the page's flush that long
                const busy = pageB.evaluate(() => {
                    const end = Date.now() + 1500;
                    while (Date.now() < end) {
                        /* busy */
                    }
                });
                const bClosed = pageB.waitForEvent('close', { timeout: 20000 });
                await row(sidebar, 'notesExplorer', 'note-b').locator('.dot').click();
                await sidebar.waitForTimeout(250);
                await clickPopupItem(app, 'Open in New Window');
                await busy.catch(() => undefined);
                await bClosed;
                // the new window shows note-b (a new page); the first window still note-a
                await expect.poll(async () => (await appWindows(app)).map((w) => w.title).sort(), { timeout: 15000 }).toEqual(['Notes: note-a', 'Notes: note-b']);
                const pageB2 = await nextPanelPage(app, [pageA, pageB]);
                const wins = await appWindows(app);
                const holder = (p: Page) => wins.find((w) => w.views.some((v) => v.url.startsWith(`fractal-res://${panelId(p)}/`)));
                expect(holder(pageB2)?.title).toBe('Notes: note-b');
                expect(holder(pageA)?.title).toBe('Notes: note-a');
                expect(holder(pageB2)?.id).not.toBe(holder(pageA)?.id);
            } finally {
                await app.close();
            }
            expect(fx.log()).not.toMatch(/uncaught exception|refused (item|action|menu|close)/);
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-2 a non-modal message from a window that shows no note is a message box on it, never a toast in another window\'s note', async () => {
        const fx = makeFixture(['note-a', 'note-b']);
        try {
            const { app, sidebar, first } = await start(fx);
            try {
                // note-a (the only open note) moves to a new window: the first window shows the empty view
                await captureNextPopup(app);
                await row(sidebar, 'notesExplorer', 'note-a').click({ button: 'right' });
                await popupLabels(app);
                await clickPopupItem(app, 'Open in New Window');
                await expect.poll(async () => (await appWindows(app)).map((w) => w.title).sort()).toEqual(['Fractal', 'Notes: note-a']);
                await expect(sidebar.locator('.empty')).toBeVisible();
                // message boxes are recorded instead of shown; the folder picker answers a folder already in the list
                await app.evaluate(({ dialog }, answer) => {
                    const g = globalThis as unknown as { __fxBoxes: string[] };
                    g.__fxBoxes = [];
                    (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (...a: unknown[]) => {
                        g.__fxBoxes.push((a[a.length - 1] as { message: string }).message);
                        return { response: 0, checkboxChecked: false };
                    };
                    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [answer] });
                }, fx.notes['note-b'].dir);
                // the user works in the first window: Notes > Add Existing Note Folder… → the extension's "already registered"
                await makeKeyWindow(app, 'Fractal');
                await sidebar.locator('.pane[data-view="notesExplorer"] .pane-header').hover();
                await sidebar.locator('.pane[data-view="notesExplorer"] .title-action[title="Add Existing Note Folder…"]').click();
                await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __fxBoxes: string[] }).__fxBoxes)).toEqual(['This folder is already registered.']);
                // nothing appeared in note-a, shown in the other window
                expect(await first!.evaluate(() => document.querySelectorAll('fractal-desktop-toasts').length)).toBe(0);
            } finally {
                await app.close();
            }
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-2 a sidebar update during an edge drag does not end the drag: the edge keeps following and the width is saved', async () => {
        const fx = makeFixture(['note-a']);
        // desktop-state.json is written 400 ms after a change (absent before the first one)
        const saved = (): { width?: number; sections?: Record<string, boolean> } => {
            try {
                return (fx.state().sidebar as { width?: number; sections?: Record<string, boolean> }) ?? {};
            } catch {
                return {};
            }
        };
        try {
            const { app, sidebar } = await start(fx);
            try {
                await expect.poll(async () => sidebarView(await onlyWindow(app)).bounds.width).toBe(DEFAULT_WIDTH);
                await dragSash(sidebar, 100, async () => {
                    await expect.poll(async () => sidebarView(await onlyWindow(app)).bounds.width).toBe(DEFAULT_WIDTH + 40);
                    // mid-drag the main process pushes a new model to this sidebar (here: Fractal List collapsed)
                    await sidebar.evaluate(() => (window as unknown as { fractalSidebar: { setSectionExpanded(v: string, e: boolean): void } }).fractalSidebar.setSectionExpanded('notesLists', false));
                    await expect.poll(() => saved().sections?.notesLists, { timeout: 5000 }).toBe(false);
                    await sidebar.waitForTimeout(300);
                });
                await expect.poll(async () => sidebarView(await onlyWindow(app)).bounds.width).toBe(DEFAULT_WIDTH + 100);
                await expect.poll(() => saved().width, { timeout: 5000 }).toBe(DEFAULT_WIDTH + 100);
                expect(await sidebar.evaluate(() => document.body.classList.contains('resizing'))).toBe(false);
                // the update is drawn once the drag is over
                await expect(sidebar.locator('.pane[data-view="notesLists"]')).not.toHaveClass(/\bexpanded\b/);
                await expect(sidebar.locator('.pane[data-view="notesExplorer"]')).toHaveClass(/\bexpanded\b/);
            } finally {
                await app.close();
            }
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-2 in a window too narrow for the saved width, the edge drag starts from the width on screen', async () => {
        const fx = makeFixture(['note-a']);
        fs.mkdirSync(fx.userData, { recursive: true });
        fs.writeFileSync(path.join(fx.userData, 'desktop-state.json'), JSON.stringify({ version: 1, sidebar: { collapsed: false, width: 480, sections: {} } }));
        try {
            const { app, sidebar } = await start(fx);
            try {
                await expect.poll(async () => sidebarView(await onlyWindow(app)).bounds.width).toBe(480);
                // 700px of content: the note keeps its 320px, so the sidebar is drawn 380px wide (480 stays saved)
                await app.evaluate(({ BaseWindow }) => {
                    const w = BaseWindow.getAllWindows()[0];
                    w.setContentSize(700, w.getContentSize()[1]);
                });
                await expect.poll(async () => sidebarView(await onlyWindow(app)).bounds.width).toBe(380);
                // 50px to the left: the edge follows the pointer from where it is drawn
                await dragSash(sidebar, -50);
                await expect.poll(async () => sidebarView(await onlyWindow(app)).bounds.width).toBe(330);
                await expect.poll(() => (fx.state().sidebar as { width?: number }).width, { timeout: 5000 }).toBe(330);
            } finally {
                await app.close();
            }
        } finally {
            rmrf(fx.tmp);
        }
    });
});
