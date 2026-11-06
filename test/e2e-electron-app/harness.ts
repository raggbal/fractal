/**
 * Shared by the desktop app E2E specs (notes-smoke.spec.ts, sidebar.spec.ts): which build to launch
 * (the E2E build only — a release build would run on your own profile), its environment (temp HOME,
 * no inherited switches, FRACTAL_NO_EXTERNAL=1), and the window model of spec 20261107-0431 D1: a
 * BaseWindow per window with the sidebar view (fractal-ui://sidebar/index.html) on the left and one
 * WebContentsView per note (fractal-res://panel-N/index.html) on the right. Playwright sees every
 * view's page in app.windows(); BrowserWindow.getAllWindows() no longer lists the app's windows
 * (they are BaseWindows), so window counts / titles go through BaseWindow.
 */
import { expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

export const REPO_ROOT = path.resolve(__dirname, '../..');
export const ELECTRON_DIR = path.join(REPO_ROOT, 'electron');
export const DEV_MODE = process.env.FRACTAL_E2E_DEV === '1';

/** <dist>/<mac-arm64|mac|…>/Fractal.app/Contents/MacOS/Fractal, or '' */
export function builtExecutable(dist: string): string {
    for (const dir of ['mac-arm64', 'mac', 'mac-universal', 'mac-x64']) {
        const exe = path.join(dist, dir, 'Fractal.app', 'Contents', 'MacOS', 'Fractal');
        if (fs.existsSync(exe)) {
            return exe;
        }
    }
    return '';
}

/** The E2E build (never the release build in electron/dist/mac-arm64: it would use your own profile). */
export function appExecutable(): string {
    return process.env.FRACTAL_APP_EXECUTABLE || builtExecutable(path.join(ELECTRON_DIR, 'dist', 'e2e'));
}

/** Contents/ of the .app of a Contents/MacOS/<name> executable */
export function contentsOf(exe: string): string {
    return path.resolve(exe, '..', '..');
}

/** package.json inside the app's app.asar */
export function packagedPackageJson(exe: string): Record<string, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const asar = require(path.join(ELECTRON_DIR, 'node_modules', '@electron', 'asar')) as { extractFile(archive: string, file: string): Buffer };
    return JSON.parse(asar.extractFile(path.join(contentsOf(exe), 'Resources', 'app.asar'), 'package.json').toString('utf8'));
}

/** Refuse to launch anything but the E2E build: a release build ignores --fractal-user-data. */
export function assertE2EBuild(exe: string): void {
    if (DEV_MODE) {
        return;
    }
    let marked = false;
    try {
        marked = packagedPackageJson(exe).fractalTestBuild === true;
    } catch {
        marked = false;
    }
    expect(marked, `${exe} is not the E2E build (it would run on your own profile) — run \`cd electron && npm run build:e2e\``).toBe(true);
}

export function launchTarget(): { executablePath: string; args: string[] } {
    if (DEV_MODE) {
        return {
            executablePath: path.join(ELECTRON_DIR, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
            args: [ELECTRON_DIR],
        };
    }
    return { executablePath: appExecutable(), args: [] };
}

/** The extension folder the app runs (packaged: Contents/Resources/ext; dev: the repo root). */
export function appExtensionRoot(): string {
    return DEV_MODE ? REPO_ROOT : path.join(contentsOf(appExecutable()), 'Resources', 'ext');
}

/** The app's environment: temp HOME, no inherited Fractal / Electron / Node switches, no external apps. */
export function launchEnv(fx: { home: string }, extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') {
            env[k] = v;
        }
    }
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    delete env.FRACTAL_USER_DATA;
    delete env.FRACTAL_OPEN_NOTE;
    delete env.FRACTAL_EXTENSION_ROOT;
    Object.assign(env, { HOME: fx.home, FRACTAL_NO_EXTERNAL: '1', FRACTAL_LANG: 'en' }, extra);
    return env;
}

/** Launches the E2E build on the fixture's temp HOME and profile; resolves once the app has a page. */
export async function launchApp(fx: { home: string; userData: string }, extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
    const target = launchTarget();
    expect(target.executablePath, 'the desktop app is not built — run `cd electron && npm run build:e2e`').not.toBe('');
    assertE2EBuild(target.executablePath);
    const app = await electron.launch({
        executablePath: target.executablePath,
        args: [...target.args, `--fractal-user-data=${fx.userData}`],
        env: launchEnv(fx, extraEnv),
        timeout: 90000,
    });
    await app.firstWindow({ timeout: 90000 });
    return app;
}

export function isPanelPage(p: Page): boolean {
    return p.url().startsWith('fractal-res:');
}

export function isSidebarPage(p: Page): boolean {
    return p.url().startsWith('fractal-ui://sidebar/');
}

/**
 * The page of a note view that is not one of `known` (a newly opened note), once its Notes layout is up.
 * Playwright's 'window' event fires for every view's page (the sidebar of a new window too), so this
 * polls by URL instead.
 */
export async function nextPanelPage(app: ElectronApplication, known: readonly Page[] = [], timeoutMs = 60000): Promise<Page> {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const page = app.windows().find((p) => isPanelPage(p) && !known.includes(p) && !p.isClosed());
        if (page) {
            await page.waitForSelector('.notes-layout', { timeout: Math.max(1000, end - Date.now()) });
            return page;
        }
        if (Date.now() > end) {
            throw new Error('no new note page appeared');
        }
        await new Promise((r) => setTimeout(r, 100));
    }
}

/** The open note pages. */
export function panelPages(app: ElectronApplication): Page[] {
    return app.windows().filter((p) => isPanelPage(p) && !p.isClosed());
}

/** The sidebar page(s), oldest window first (Playwright lists pages in creation order). */
export async function sidebarPages(app: ElectronApplication, count = 1, timeoutMs = 30000): Promise<Page[]> {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const pages = app.windows().filter((p) => isSidebarPage(p) && !p.isClosed());
        if (pages.length >= count) {
            for (const p of pages) {
                await p.waitForSelector('.app .sidebar, .app .bar', { timeout: Math.max(1000, end - Date.now()) });
            }
            return pages;
        }
        if (Date.now() > end) {
            throw new Error(`expected ${count} sidebar page(s), found ${pages.length}`);
        }
        await new Promise((r) => setTimeout(r, 100));
    }
}

export interface ViewInfo {
    url: string;
    webContentsId: number;
    bounds: { x: number; y: number; width: number; height: number };
    visible: boolean;
}

export interface WindowInfo {
    id: number;
    title: string;
    visible: boolean;
    content: { width: number; height: number };
    /** the sidebar view first, then the note views */
    views: ViewInfo[];
}

/** Every BaseWindow of the app (prompt sheets too) with its views. */
export async function appWindows(app: ElectronApplication): Promise<WindowInfo[]> {
    return app.evaluate(({ BaseWindow }) =>
        BaseWindow.getAllWindows().map((w) => {
            const c = w.getContentBounds();
            const views = (w.contentView.children as Array<{ webContents?: { id: number; getURL(): string; isDestroyed(): boolean }; getBounds(): { x: number; y: number; width: number; height: number }; getVisible(): boolean }>)
                .filter((v) => !!v.webContents && !v.webContents.isDestroyed())
                .map((v) => ({ url: v.webContents!.getURL(), webContentsId: v.webContents!.id, bounds: v.getBounds(), visible: v.getVisible() }));
            return { id: w.id, title: w.getTitle(), visible: w.isVisible(), content: { width: c.width, height: c.height }, views };
        })
    );
}

/** The titles of the app's windows (BaseWindow), sorted. */
export async function windowTitles(app: ElectronApplication): Promise<string[]> {
    const titles = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().map((w: { getTitle(): string }) => w.getTitle()));
    return titles.sort();
}

/** Close every window of the app the way the user does (red button / Close Window → 'close'). */
export async function closeAllWindows(app: ElectronApplication, page: Page): Promise<void> {
    const closed = page.waitForEvent('close', { timeout: 20000 });
    await app.evaluate(({ BaseWindow }) => {
        for (const w of BaseWindow.getAllWindows()) {
            w.close();
        }
    });
    await closed;
}

/** The part of Electron's MenuItem the tests read ('electron' types are not installed at the repo root). */
export interface MenuItemLike {
    label: string;
    enabled: boolean;
    checked: boolean;
    accelerator?: string | null;
    type?: string;
    click(): void;
    submenu?: { items: MenuItemLike[] } | null;
}

/** Runs an item of the application menu (what a click or its accelerator does): clickMenu(app, 'File', 'Notes', 'x'). */
export async function clickMenu(app: ElectronApplication, ...labels: string[]): Promise<void> {
    const found = await app.evaluate(({ Menu }, path) => {
        let items: MenuItemLike[] = Menu.getApplicationMenu()?.items ?? [];
        let it: MenuItemLike | undefined;
        for (const label of path) {
            it = items.find((i: MenuItemLike) => i.label === label);
            items = it?.submenu?.items ?? [];
        }
        if (!it || !it.enabled) {
            return false;
        }
        it.click();
        return true;
    }, labels);
    expect(found, `menu ${labels.join(' > ')}`).toBe(true);
}

/** Labels of a submenu of the application menu: menuLabels(app, 'File', 'Notes'). */
export async function menuLabels(app: ElectronApplication, ...labels: string[]): Promise<string[]> {
    return app.evaluate(({ Menu }, path) => {
        let items: MenuItemLike[] = Menu.getApplicationMenu()?.items ?? [];
        for (const label of path) {
            items = items.find((i: MenuItemLike) => i.label === label)?.submenu?.items ?? [];
        }
        return items.map((i: MenuItemLike) => i.label);
    }, labels);
}

/** Enter in a prompt sheet: it closes on keydown (like VS Code's quick input), so no keyup is sent. */
export async function acceptPrompt(prompt: Page): Promise<void> {
    const closed = prompt.waitForEvent('close', { timeout: 20000 });
    await prompt.keyboard.down('Enter').catch(() => undefined); // the page may be gone before the call returns
    await closed;
}

/** Polls a file until `pred` holds; returns the last content. */
export async function waitForFile(file: string, pred: (s: string) => boolean, timeoutMs = 10000): Promise<string> {
    const end = Date.now() + timeoutMs;
    let last = '';
    for (;;) {
        try {
            last = fs.readFileSync(file, 'utf8');
        } catch {
            last = '';
        }
        if (pred(last) || Date.now() > end) {
            return last;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
}

export function outTexts(json: string): string[] {
    try {
        const d = JSON.parse(json) as { nodes?: Record<string, { text?: string }> };
        return Object.values(d.nodes ?? {}).map((n) => n.text ?? '');
    } catch {
        return [];
    }
}

export function rmrf(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true });
    } catch {
        /* best effort */
    }
}
