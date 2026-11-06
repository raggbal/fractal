/**
 * AC-4 (spec 20261106-1312-electron-vscode-shim, TASK 2): E2E of the BUILT desktop app.
 *
 *   build:  cd electron && npm run build:app-dir && npm run pack:e2e
 *           (→ electron/dist/mac-arm64/Fractal.app = the release build, electron/dist/e2e/mac-arm64/Fractal.app)
 *   run:    npx playwright test test/e2e-electron-app/notes-smoke.spec.ts
 *           (or: cd electron && npm run test:e2e — builds both, then runs)
 *   other:  FRACTAL_APP_EXECUTABLE=/path/to/Fractal.app/Contents/MacOS/Fractal to test another E2E build;
 *           FRACTAL_E2E_DEV=1 runs the unpackaged app instead (electron/ after `npm run build:shim`, repo out/)
 *
 * The E2E build is the release config (npm run build:mac / build:app-dir) plus only what the tests need
 * (electron/electron-builder.e2e.config.js): the --inspect fuse Playwright drives the main process with,
 * and the --fractal-user-data switch. A release build ignores that switch, so Playwright never starts one
 * (it would run on your own profile and notes) — see assertE2EBuild. The release build is still checked:
 * its fuses / signature, and one start of its own on a temp home (CFFIXED_USER_HOME), without Playwright.
 *
 * Opens real windows (needs a desktop session), so it is not part of the normal test run:
 * playwright.config.ts only includes test/e2e-electron-app when the command line names it.
 *
 * Every test gets its own temp HOME (the extension's ~/.fractal/default.fractal), userData
 * (--fractal-user-data) and note folder made with the extension's own NotesFileManager, and runs
 * with FRACTAL_NO_EXTERNAL=1 (links / Finder are logged, never opened).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';
// launch guard / environment / window-model helpers shared with sidebar.spec.ts (moved there unchanged,
// plus the BaseWindow + WebContentsView lookups of spec 20261107-0431 D1)
import {
    acceptPrompt,
    appExecutable,
    appExtensionRoot,
    builtExecutable,
    clickMenu,
    closeAllWindows,
    contentsOf,
    DEV_MODE,
    ELECTRON_DIR,
    launchApp,
    launchEnv,
    launchTarget,
    menuLabels,
    nextPanelPage,
    outTexts,
    packagedPackageJson,
    panelPages,
    REPO_ROOT,
    rmrf,
    waitForFile,
    windowTitles,
    type MenuItemLike,
} from './harness';

interface Fixture {
    tmp: string;
    home: string;
    userData: string;
    note: string;
    outPath: string;
    mdPath: string;
}

function makeFixture(noteName = 'smoke-note'): Fixture {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-e2e-app-')));
    const home = path.join(tmp, 'home');
    const userData = path.join(tmp, 'userData');
    const note = path.join(tmp, 'notes', noteName);
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(note, { recursive: true });
    // the note, made by the extension's own file manager (no hand-written format)
    const fm = new NotesFileManager(note);
    fm.loadStructure();
    const outPath = fm.createFile('Smoke Outline');
    const mdPath = fm.createMarkdownFile('Smoke Page');
    fm.dispose();
    // a 1x1 png inside the note (resource serving)
    fs.mkdirSync(path.join(note, 'images'), { recursive: true });
    fs.writeFileSync(
        path.join(note, 'images', 'dot.png'),
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    );
    // the notes list the extension reads on its first run (~/.fractal/default.fractal under the temp HOME)
    fs.mkdirSync(path.join(home, '.fractal'), { recursive: true });
    fs.writeFileSync(path.join(home, '.fractal', 'default.fractal'), JSON.stringify({ version: 1, notes: [note] }, null, 2) + '\n');
    return { tmp, home, userData, note, outPath, mdPath };
}

/**
 * The app on the fixture, and the page of the note it opened. The first page Playwright sees is now the
 * window's sidebar (spec 20261107-0431 D1), so the note's page is looked up by its fractal-res: URL.
 */
async function launch(fx: Fixture, extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; win: Page }> {
    const app = await launchApp(fx, extraEnv);
    const win = await nextPanelPage(app, [], 60000);
    await win.waitForSelector('.file-panel-item', { timeout: 30000 });
    return { app, win };
}

/** After a window close: shorter than the extension's 1 s save debounces (see the close test). */
const CLOSE_WRITE_MS = 500;

async function openTreeItem(win: Page, title: string): Promise<void> {
    await win.locator('.file-panel-item', { hasText: title }).first().click();
}

async function typeInFirstOutlinerNode(win: Page, text: string): Promise<void> {
    await expect(win.locator('.outliner-container')).toBeVisible();
    const node = win.locator('.outliner-node .outliner-text').first();
    await node.click();
    await win.keyboard.press('End');
    await win.keyboard.type(text);
}

async function typeAtEndOfMd(win: Page, text: string): Promise<void> {
    const editor = win.locator('.markdown-container #editor');
    await expect(editor).toBeVisible();
    await editor.click();
    await win.keyboard.press('Meta+ArrowDown');
    await win.keyboard.press('Enter');
    await win.keyboard.type(text);
}

test.describe('desktop app (Electron) — AC-4 Notes smoke', () => {
    test.skip(process.platform !== 'darwin', 'the desktop app is built for macOS only (spec D4)');
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(180000);

    test('AC-4 opens the note of ~/.fractal/default.fractal, shows the tree, and saves .out and md typing to disk', async () => {
        const fx = makeFixture();
        try {
            const { app, win } = await launch(fx);
            const pageErrors: string[] = [];
            win.on('pageerror', (e) => pageErrors.push(String(e)));
            try {
                // the Notes panel: one window titled like the VS Code panel (the window's title follows the note it
                // shows — BaseWindow since spec 20261107-0431 D1), the tree of the note
                expect(await windowTitles(app)).toEqual(['Notes: smoke-note']);
                await expect(win.locator('.notes-file-panel')).toBeVisible();
                await expect(win.locator('.file-panel-item', { hasText: 'Smoke Outline' })).toBeVisible();
                await expect(win.locator('.file-panel-item', { hasText: 'Smoke Page' })).toBeVisible();
                expect(new URL(win.url()).protocol).toBe('fractal-res:');
                // the --vscode-* theme variables VS Code injects (the webview CSS reads them): light or dark set
                const themeVars = await win.evaluate(() => {
                    const s = getComputedStyle(document.documentElement);
                    return ['--vscode-foreground', '--vscode-editor-background', '--vscode-font-family'].map((v) => s.getPropertyValue(v).trim());
                });
                expect(['#3b3b3b', '#cccccc']).toContain(themeVars[0]);
                expect(['#ffffff', '#1f1f1f']).toContain(themeVars[1]);
                expect(themeVars[2]).toContain('-apple-system');

                // .out: real typing in the outliner → the .out file on disk
                await openTreeItem(win, 'Smoke Outline');
                await typeInFirstOutlinerNode(win, 'Hello from Electron');
                await win.keyboard.press('Enter');
                await win.keyboard.type('Second node');
                const out = await waitForFile(fx.outPath, (s) => outTexts(s).includes('Second node'));
                expect(outTexts(out)).toEqual(expect.arrayContaining(['Hello from Electron', 'Second node']));

                // md: real typing in the md editor → the md file on disk (TextDocument path of the shim)
                await openTreeItem(win, 'Smoke Page');
                await typeAtEndOfMd(win, 'Typed in Electron');
                const md = await waitForFile(fx.mdPath, (s) => s.includes('Typed in Electron'));
                expect(md.startsWith('# Smoke Page\n')).toBe(true);
                expect(md).toContain('Typed in Electron');

                // File > Save (Cmd+S): the page's pending edit and the extension's 1 s debounce go to disk at once
                // (without it the earliest write is ~2 s after the last key: webview 1 s + host 1 s)
                await openTreeItem(win, 'Smoke Outline');
                await typeInFirstOutlinerNode(win, ' saved by Cmd+S');
                await clickMenu(app, 'File', 'Save');
                const afterSave = await waitForFile(fx.outPath, (s) => outTexts(s).some((t) => t.includes('saved by Cmd+S')), 900);
                expect(outTexts(afterSave).some((t) => t.includes('saved by Cmd+S'))).toBe(true);

                // File > Notes lists the notes of the active .fractal (from the extension's own tree provider)
                const notesMenu = await app.evaluate(({ Menu }) => {
                    const file = Menu.getApplicationMenu()?.items.find((i: MenuItemLike) => i.label === 'File');
                    const notes = file?.submenu?.items.find((i: MenuItemLike) => i.label === 'Notes');
                    return notes?.submenu?.items.map((i: MenuItemLike) => ({ label: i.label, checked: i.checked })) ?? [];
                });
                expect(notesMenu).toEqual([{ label: 'smoke-note', checked: true }]);

                // the extension's own state goes to the app's userData (not VS Code's)
                expect(fs.existsSync(path.join(fx.userData, 'User', 'globalState.json'))).toBe(true);
                expect(pageErrors).toEqual([]);
            } finally {
                await app.close();
            }
            // quit recorded the open note for the next start
            const state = JSON.parse(fs.readFileSync(path.join(fx.userData, 'desktop-state.json'), 'utf8'));
            expect(state.lastNoteFolder).toBe(fx.note);
            expect(state.openNoteFolders).toEqual([fx.note]);
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-4 closing the window right after typing still saves (page flush → handlers drained → onDidDispose), and so does quitting', async () => {
        const fx = makeFixture();
        try {
            let { app, win } = await launch(fx);
            try {
                // .out: type, then close at once (well inside the webview's 1 s + the host's 1 s debounce)
                await openTreeItem(win, 'Smoke Outline');
                await typeInFirstOutlinerNode(win, 'typed just before close');
                await closeAllWindows(app, win);
                // written by the close sequence itself, not by a debounce later: the host's .out debounce is 1 s,
                // so a 500 ms window after the close only sees what the flush + onDidDispose wrote
                const outAfterClose = await waitForFile(fx.outPath, (s) => outTexts(s).includes('typed just before close'), CLOSE_WRITE_MS);
                expect(outTexts(outAfterClose)).toContain('typed just before close');

                // the dock icon (activate) reopens the last note; md: type, close at once
                // (the reopened window's first page is its sidebar — spec 20261107-0431 D1 — so wait for the note's page)
                await app.evaluate(({ app: a }) => {
                    a.emit('activate');
                });
                win = await nextPanelPage(app, [], 60000);
                await win.waitForSelector('.file-panel-item', { timeout: 60000 });
                await openTreeItem(win, 'Smoke Page');
                await typeAtEndOfMd(win, 'md typed just before close');
                await closeAllWindows(app, win);
                expect(await waitForFile(fx.mdPath, (s) => s.includes('md typed just before close'), CLOSE_WRITE_MS)).toContain('md typed just before close');

                // quit (Cmd+Q → before-quit): every window closes with its flush, then the extension deactivates
                await app.evaluate(({ app: a }) => {
                    a.emit('activate');
                });
                win = await nextPanelPage(app, [], 60000);
                await win.waitForSelector('.file-panel-item', { timeout: 60000 });
                await openTreeItem(win, 'Smoke Outline');
                await typeInFirstOutlinerNode(win, ' + typed before quit');
            } finally {
                await app.close();
            }
            expect(outTexts(fs.readFileSync(fx.outPath, 'utf8')).some((t) => t.includes('typed before quit'))).toBe(true);
            const log = fs.readFileSync(path.join(fx.userData, 'logs', 'main.log'), 'utf8');
            expect(log).not.toMatch(/did not confirm its flush/);
            expect(log).toMatch(/\[shell\] bye/);
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-4 resources come only from inside the panel roots; the page has no Node and never leaves its document', async () => {
        const fx = makeFixture();
        fs.writeFileSync(path.join(fx.tmp, 'secret.txt'), 'not for the webview');
        fs.symlinkSync(path.join(fx.tmp, 'secret.txt'), path.join(fx.note, 'escape.txt'));
        try {
            const { app, win } = await launch(fx);
            try {
                const r = await win.evaluate(async ({ note, tmp }) => {
                    const base = 'https://file+.vscode-resource.vscode-cdn.net';
                    const status = async (u: string) => {
                        try {
                            return (await fetch(u)).status;
                        } catch (e) {
                            return `error: ${String(e)}`;
                        }
                    };
                    let second = 'no error';
                    try {
                        (window as unknown as { acquireVsCodeApi(): unknown }).acquireVsCodeApi();
                    } catch (e) {
                        second = (e as Error).message;
                    }
                    // a sandboxed iframe (opaque origin, like the html viewer) must not read note files
                    const nonce = (window as unknown as { __webviewNonce?: string }).__webviewNonce || '';
                    const fromSandbox = await new Promise<string>((resolve) => {
                        const iframe = document.createElement('iframe');
                        iframe.setAttribute('sandbox', 'allow-scripts');
                        const url = `${base}${note}/images/dot.png`;
                        iframe.srcdoc =
                            `<script nonce="${nonce}">onmessage = (e) => { const port = e.ports[0];` +
                            ` fetch(${JSON.stringify(url)}).then((r) => port.postMessage('status ' + r.status), (err) => port.postMessage('blocked ' + err)); };<\/script>`;
                        iframe.onload = () => {
                            const ch = new MessageChannel();
                            ch.port1.onmessage = (e) => resolve(String(e.data));
                            iframe.contentWindow?.postMessage('go', '*', [ch.port2]);
                        };
                        setTimeout(() => resolve('timeout'), 8000);
                        document.body.appendChild(iframe);
                    });
                    return {
                        origin: location.origin,
                        inside: await status(`${base}${note}/images/dot.png`),
                        insideType: (await fetch(`${base}${note}/images/dot.png`)).headers.get('content-type'),
                        outside: await status(`${base}${tmp}/secret.txt`),
                        dotdot: await status(`${base}${note}/../secret.txt`),
                        encodedDotdot: await status(`${base}${note}/%2e%2e/secret.txt`),
                        symlinkEscape: await status(`${base}${note}/escape.txt`),
                        etc: await status(`${base}/etc/hosts`),
                        otherCdnHost: await status('https://anything.vscode-cdn.net/x'),
                        second,
                        fromSandbox,
                        node: typeof (window as unknown as { require?: unknown }).require + '/' + typeof (window as unknown as { process?: unknown }).process,
                    };
                }, { note: fx.note, tmp: fx.tmp });
                expect(r.origin).toMatch(/^fractal-res:\/\/panel-\d+$/);
                expect(r.inside).toBe(200);
                expect(r.insideType).toBe('image/png');
                expect(r.outside).toBe(404);
                expect(r.dotdot).toBe(404);
                expect(r.encodedDotdot).toBe(404);
                expect(r.symlinkEscape).toBe(404);
                expect(r.etc).toBe(404);
                expect(r.otherCdnHost).toBe(404);
                expect(r.second).toBe('An instance of the VS Code API has already been acquired');
                expect(r.fromSandbox).toMatch(/^blocked/);
                expect(r.node).toBe('undefined/undefined');

                // window.open / top navigation never leave the document; http(s) goes to the OS browser (logged here).
                // Checked through the main process: Playwright keeps waiting for the navigation the app cancelled.
                // (windows are BaseWindows and the note is a WebContentsView in one since spec 20261107-0431 D1)
                const before = await app.evaluate(({ BaseWindow, webContents }) => ({
                    windows: BaseWindow.getAllWindows().length,
                    pages: webContents.getAllWebContents().length,
                }));
                await win.evaluate(() => {
                    window.open('https://example.com/opened');
                });
                await win.evaluate(() => {
                    location.href = 'https://example.com/navigated';
                });
                await win.waitForTimeout(1000);
                const after = await app.evaluate(async ({ BaseWindow, webContents }) => {
                    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('fractal-res:'));
                    return {
                        windows: BaseWindow.getAllWindows().length,
                        pages: webContents.getAllWebContents().length,
                        url: wc ? wc.getURL() : '',
                        layout: wc ? await wc.executeJavaScript('!!document.querySelector(".notes-layout")') : false,
                    };
                });
                expect(after.windows).toBe(before.windows);
                expect(after.pages).toBe(before.pages);
                expect(new URL(after.url).protocol).toBe('fractal-res:');
                expect(after.layout).toBe(true);
                const log = fs.readFileSync(path.join(fx.userData, 'logs', 'main.log'), 'utf8');
                expect(log).toContain('(no-external) openExternal https://example.com/opened');
                expect(log).toContain('(no-external) openExternal https://example.com/navigated');
                expect(log).toMatch(/refused a request .* origin null: https:\/\/file\+\.vscode-resource\.vscode-cdn\.net\//);

                // a second launch with the same profile hands over to the running app and exits (single instance)
                const target = launchTarget();
                const second = spawn(target.executablePath, [...target.args, `--fractal-user-data=${fx.userData}`], { env: launchEnv(fx), stdio: 'ignore' });
                const exit = await new Promise<number | string | null>((resolve) => {
                    second.on('exit', (code) => resolve(code));
                    setTimeout(() => resolve('still running'), 30000);
                });
                if (exit === 'still running') {
                    second.kill();
                }
                expect(exit).toBe(0);
                expect(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(1);
            } finally {
                await app.close();
            }
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-4 the panel document (it embeds the opened note) is readable only by the panel: a sandboxed viewer frame cannot fetch it', async () => {
        const fx = makeFixture();
        try {
            const { app, win } = await launch(fx);
            try {
                const r = await win.evaluate(async ({ note }) => {
                    const nonce = (window as unknown as { __webviewNonce?: string }).__webviewNonce || '';
                    // what file-viewer.js builds for an HTML file with scripts allowed (the default): a blob
                    // document carrying the page nonce, in an iframe sandboxed to allow-scripts (origin 'null').
                    // Its inherited CSP (connect-src 'self') still names the panel origin, which it can learn
                    // from location.ancestorOrigins.
                    const probe = (api: 'fetch' | 'xhr') =>
                        new Promise<string>((resolve) => {
                            const iframe = document.createElement('iframe');
                            iframe.setAttribute('sandbox', 'allow-scripts');
                            const script =
                                `onmessage = (e) => { const port = e.ports[0]; const note = e.data.note;` +
                                ` const url = location.ancestorOrigins[0] + '/index.html';` +
                                ` const report = (t) => port.postMessage('read ' + t.length + (t.includes(note) ? ' with the note path' : ''));` +
                                (api === 'fetch'
                                    ? ` fetch(url).then((r) => r.text()).then(report, (err) => port.postMessage('blocked ' + err));`
                                    : ` const x = new XMLHttpRequest(); x.open('GET', url); x.onload = () => report(x.responseText);` +
                                      ` x.onerror = () => port.postMessage('blocked xhr error'); x.send();`) +
                                ` };`;
                            const html = `<!DOCTYPE html><html><head><script nonce="${nonce}">${script}<\/script></head><body>viewer</body></html>`;
                            iframe.src = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
                            iframe.onload = () => {
                                const ch = new MessageChannel();
                                ch.port1.onmessage = (e) => resolve(String(e.data));
                                iframe.contentWindow?.postMessage({ note }, '*', [ch.port2]);
                            };
                            setTimeout(() => resolve('timeout'), 8000);
                            document.body.appendChild(iframe);
                        });
                    // the page itself (the panel origin) still reads its own document — and it does carry the note
                    const own = await fetch(`${location.origin}/index.html`);
                    const ownText = await own.text();
                    return { ownStatus: own.status, ownHasNote: ownText.includes(note), fetched: await probe('fetch'), xhr: await probe('xhr') };
                }, { note: fx.note });
                expect(r.ownStatus).toBe(200);
                expect(r.ownHasNote).toBe(true);
                expect(r.fetched).toMatch(/^blocked/);
                expect(r.xhr).toMatch(/^blocked/);
                const log = fs.readFileSync(path.join(fx.userData, 'logs', 'main.log'), 'utf8');
                expect(log).toMatch(/refused a request .* origin null: fractal-res:\/\/panel-\d+\/index\.html/);
            } finally {
                await app.close();
            }
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-4 the packaged app runs only its own code: FRACTAL_EXTENSION_ROOT is ignored, ELECTRON_RUN_AS_NODE / NODE_OPTIONS / DYLD_INSERT_LIBRARIES load nothing, the release build refuses --inspect too', async () => {
        test.skip(DEV_MODE, 'packaging only (an unpackaged dev run honors FRACTAL_EXTENSION_ROOT by design)');
        const fx = makeFixture();
        // planted code: an "extension" folder and a script that leave a marker if they ever run
        const planted = path.join(fx.tmp, 'planted');
        const script = path.join(planted, 'script.js');
        const marker = path.join(fx.tmp, 'planted-code-ran');
        const plantedJs = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran in ' + process.execPath);`;
        fs.mkdirSync(path.join(planted, 'out'), { recursive: true });
        fs.writeFileSync(path.join(planted, 'out', 'extension.js'), `${plantedJs}\nexports.activate = () => undefined;\n`);
        fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(planted, 'package.json'));
        fs.writeFileSync(script, plantedJs);
        try {
            // 1. the fuses of the built binaries (read from the files; nothing is launched)
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const fuses = require(path.join(ELECTRON_DIR, 'node_modules', '@electron', 'fuses')) as {
                getCurrentFuseWire(app: string): Promise<Record<number, number>>;
                FuseV1Options: Record<string, number>;
            };
            const O = fuses.FuseV1Options;
            const wire = async (exe: string) => {
                const w = await fuses.getCurrentFuseWire(exe);
                const st = (i: number) => (w[i] === 49 ? 'on' : w[i] === 48 ? 'off' : `state ${w[i]}`);
                return {
                    runAsNode: st(O.RunAsNode),
                    nodeOptions: st(O.EnableNodeOptionsEnvironmentVariable),
                    inspect: st(O.EnableNodeCliInspectArguments),
                    onlyLoadAppFromAsar: st(O.OnlyLoadAppFromAsar),
                    asarIntegrity: st(O.EnableEmbeddedAsarIntegrityValidation),
                    fileProtocolExtraPrivileges: st(O.GrantFileProtocolExtraPrivileges),
                };
            };
            const hardened = { runAsNode: 'off', nodeOptions: 'off', inspect: 'off', onlyLoadAppFromAsar: 'on', asarIntegrity: 'on', fileProtocolExtraPrivileges: 'off' };
            // the hardened runtime (DYLD_* ignored), without the entitlement that would let DYLD_* back in
            const signature = (exe: string) => {
                const app = path.dirname(contentsOf(exe));
                // codesign -d prints its report on stderr
                const info = spawnSync('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' });
                const ent = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', app], { encoding: 'utf8' });
                const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(`${info.stdout}${info.stderr}`)?.[1] ?? '';
                return {
                    runtime: flags.split(',').includes('runtime'),
                    dyldEnvAllowed: `${ent.stdout}${ent.stderr}`.includes('allow-dyld-environment-variables'),
                };
            };
            // the E2E build differs only in --inspect (Playwright drives the main process through it)
            expect(await wire(appExecutable())).toEqual({ ...hardened, inspect: 'on' });
            expect(signature(appExecutable())).toEqual({ runtime: true, dyldEnvAllowed: false });
            const release = builtExecutable(path.join(ELECTRON_DIR, 'dist'));
            if (release) {
                expect(await wire(release), `${release} (npm run build:app-dir / build:mac)`).toEqual(hardened);
                expect(signature(release), release).toEqual({ runtime: true, dyldEnvAllowed: false });
                expect(packagedPackageJson(release).fractalTestBuild).toBeUndefined();
            }

            // 2. FRACTAL_EXTENSION_ROOT pointing at the planted folder: the app still runs the extension it ships
            const { app, win } = await launch(fx, { FRACTAL_EXTENSION_ROOT: planted });
            try {
                await expect(win.locator('.file-panel-item', { hasText: 'Smoke Outline' })).toBeVisible();
            } finally {
                await app.close();
            }
            expect(fs.existsSync(marker)).toBe(false);
            const log = fs.readFileSync(path.join(fx.userData, 'logs', 'main.log'), 'utf8');
            expect(log).toContain(`extension=${appExtensionRoot()} `);
            expect(log).toMatch(/ignored FRACTAL_EXTENSION_ROOT: development \/ test switches are not honored/);

            // 3. ELECTRON_RUN_AS_NODE=1 / NODE_OPTIONS=--require / DYLD_INSERT_LIBRARIES: the binary starts as the
            //    app and the planted code never runs (the dylib case needs a C compiler: Xcode command line tools)
            const cases: Array<[string, Record<string, string>]> = [
                ['ELECTRON_RUN_AS_NODE', { ELECTRON_RUN_AS_NODE: '1' }],
                ['NODE_OPTIONS', { NODE_OPTIONS: `--require ${script}` }],
            ];
            const dylibSource = path.join(planted, 'inject.c');
            const dylib = path.join(planted, 'inject.dylib');
            fs.writeFileSync(
                dylibSource,
                '#include <stdio.h>\n#include <stdlib.h>\n__attribute__((constructor)) static void planted(void) {\n' +
                    '    const char *m = getenv("FX_PLANTED_MARKER"); FILE *f = m ? fopen(m, "w") : NULL; if (f) { fputs("dylib", f); fclose(f); }\n}\n'
            );
            // (xcode-select first: without the tools, /usr/bin/clang opens an install dialog)
            const hasCompiler = spawnSync('xcode-select', ['-p']).status === 0 && spawnSync('clang', ['-dynamiclib', '-o', dylib, dylibSource]).status === 0;
            if (hasCompiler) {
                cases.push(['DYLD_INSERT_LIBRARIES', { DYLD_INSERT_LIBRARIES: dylib, FX_PLANTED_MARKER: marker }]);
            } else {
                console.warn('[e2e] no clang: the DYLD_INSERT_LIBRARIES case is covered by the hardened-runtime signature check only');
            }
            for (const [name, extra] of cases) {
                const ud = path.join(fx.tmp, `userData-${name}`);
                const child = spawn(appExecutable(), [script, `--fractal-user-data=${ud}`], { env: launchEnv(fx, extra), stdio: 'ignore' });
                const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
                const started = () => {
                    try {
                        return fs.readFileSync(path.join(ud, 'logs', 'main.log'), 'utf8').includes('[shell] Fractal desktop');
                    } catch {
                        return false;
                    }
                };
                let outcome = 'timeout';
                for (const end = Date.now() + 60000; Date.now() < end; ) {
                    if (fs.existsSync(marker)) {
                        outcome = 'the planted script ran';
                        break;
                    }
                    if (started()) {
                        outcome = 'started as the app';
                        break;
                    }
                    await new Promise((r) => setTimeout(r, 100));
                }
                child.kill();
                await Promise.race([exited, new Promise((r) => setTimeout(r, 15000))]);
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill('SIGKILL');
                }
                expect(outcome, name).toBe('started as the app');
                expect(fs.existsSync(marker), name).toBe(false);
            }
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-4 the release build (the app you run) starts on its own, opens the note and ignores the test profile switch and the remote debugging switches (no DevTools endpoint)', async () => {
        test.skip(DEV_MODE, 'packaged build only');
        const release = builtExecutable(path.join(ELECTRON_DIR, 'dist'));
        test.skip(!release, 'no release build — run `cd electron && npm run build:app-dir`');
        const fx = makeFixture();
        // a release build always uses the OS profile folder (~/Library/Application Support/Fractal);
        // CFFIXED_USER_HOME moves that home (like HOME for the extension) into the fixture. Not Playwright:
        // the release build has no --inspect, and no --remote-debugging-port / -pipe either (spec
        // 20261106-1312 D4b: either would open every page of the app to the DevTools protocol).
        const profile = path.join(fx.home, 'Library', 'Application Support', 'Fractal');
        const asked = path.join(fx.tmp, 'asked-profile');
        const stateFile = path.join(profile, 'desktop-state.json');
        const mainLog = () => {
            try {
                return fs.readFileSync(path.join(profile, 'logs', 'main.log'), 'utf8');
            } catch {
                return '';
            }
        };
        const count = (re: RegExp) => (mainLog().match(re) ?? []).length;
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const children: ChildProcess[] = [];
        const startRelease = (args: string[]) => {
            // fd 3 / fd 4 are pipes: an app that honors --remote-debugging-pipe answers the DevTools protocol there
            const child = spawn(release, args, { env: launchEnv(fx, { CFFIXED_USER_HOME: fx.home }), stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
            children.push(child);
            const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
            let stderr = '';
            child.stderr?.setEncoding('utf8');
            child.stderr?.on('data', (d: string) => {
                stderr += d;
            });
            const toApp = child.stdio[3] as NodeJS.WritableStream & { on(ev: 'error', l: () => void): unknown };
            const fromApp = child.stdio[4] as NodeJS.ReadableStream & { on(ev: 'error', l: () => void): unknown };
            let reply = '';
            toApp.on('error', () => undefined);
            fromApp.on('error', () => undefined);
            fromApp.on('data', (d: Buffer | string) => {
                reply += d.toString();
            });
            return {
                stderr: () => stderr,
                /** Browser.getVersion on the pipe: whatever came back within 1.5 s */
                askOverPipe: async () => {
                    toApp.write('{"id":1,"method":"Browser.getVersion"}\0');
                    await sleep(1500);
                    return reply;
                },
                listening: () => spawnSync('lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim(),
                // SIGTERM quits like Cmd+Q (before-quit → every window flushed and closed → the extension deactivated)
                quit: async () => {
                    child.kill('SIGTERM');
                    await Promise.race([exited, sleep(20000)]);
                    if (child.exitCode === null && child.signalCode === null) {
                        child.kill('SIGKILL');
                    }
                },
            };
        };
        try {
            // 1. the test profile switch and --remote-debugging-port=0 (what Playwright passes the E2E build)
            const first = startRelease([`--fractal-user-data=${asked}`, '--remote-debugging-port=0']);
            const lastNote = () => {
                try {
                    return JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastNoteFolder as string | undefined;
                } catch {
                    return undefined;
                }
            };
            await expect.poll(lastNote, { timeout: 60000 }).toBe(fx.note);
            // no DevTools endpoint: no listening socket, no DevToolsActivePort file
            expect(first.listening(), 'listening TCP sockets of the release app').toBe('');
            expect(fs.existsSync(path.join(profile, 'DevToolsActivePort')), 'DevToolsActivePort').toBe(false);
            await first.quit();
            const log = mainLog();
            const started = /extension=(.*) userData=(.*)$/m.exec(log);
            expect(started?.[1]).toBe(path.join(contentsOf(release), 'Resources', 'ext'));
            // (macOS spells the temp folder /var/… or /private/var/…)
            expect(fs.realpathSync(started?.[2] ?? '')).toBe(fs.realpathSync(profile));
            expect(log).toMatch(/ignored --fractal-user-data, --remote-debugging-port: development \/ test switches are not honored/);
            expect(first.stderr()).not.toMatch(/DevTools listening/);
            expect(log).not.toMatch(/could not open the note|start failed|uncaught exception/);
            expect(log).toMatch(/\[shell\] bye/);
            expect(fs.existsSync(asked)).toBe(false);
            expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).openNoteFolders).toEqual([fx.note]);

            // 2. --remote-debugging-pipe (no socket at all: the protocol on fd 3 / fd 4): no answer there
            const second = startRelease(['--remote-debugging-pipe']);
            await expect.poll(() => count(/\[shell\] Fractal desktop/g), { timeout: 60000 }).toBe(2);
            expect(await second.askOverPipe(), 'a DevTools protocol reply on the pipe').toBe('');
            await second.quit();
            expect(count(/\[shell\] bye/g)).toBe(2);
            expect(mainLog()).toMatch(/ignored --remote-debugging-pipe: development \/ test switches are not honored/);
        } finally {
            // a failed check must not leave the app running (it is not Playwright's to close)
            for (const c of children) {
                if (c.exitCode === null && c.signalCode === null) {
                    c.kill('SIGKILL');
                }
            }
            rmrf(fx.tmp);
        }
    });

    test('AC-4 a note folder named "media" is remembered and reopened as itself, never as the app\'s own media folder', async () => {
        // dev runs use the repo as the extension root: a regression would write into the tracked media/
        test.skip(DEV_MODE, 'packaged build only');
        const fx = makeFixture('media');
        const appMedia = path.join(appExtensionRoot(), 'media');
        const appMediaBefore = fs.readdirSync(appMedia).sort();
        const stateFile = path.join(fx.userData, 'desktop-state.json');
        const mainLog = () => fs.readFileSync(path.join(fx.userData, 'logs', 'main.log'), 'utf8');
        try {
            let { app, win } = await launch(fx);
            try {
                expect(await windowTitles(app)).toEqual(['Notes: media']);
                await expect(win.locator('.file-panel-item', { hasText: 'Smoke Outline' })).toBeVisible();
            } finally {
                await app.close();
            }
            let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            expect(state.lastNoteFolder).toBe(fx.note);
            expect(state.openNoteFolders).toEqual([fx.note]);
            expect(mainLog()).not.toMatch(/could not open the note/);

            // the next start reopens that note
            ({ app, win } = await launch(fx));
            try {
                await expect(win.locator('.file-panel-item', { hasText: 'Smoke Page' })).toBeVisible();
            } finally {
                await app.close();
            }
            state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            expect(state.openNoteFolders).toEqual([fx.note]);

            // a remembered folder inside the app (an older build saved it) is skipped: the notes list's first note opens
            fs.writeFileSync(stateFile, JSON.stringify({ ...state, lastNoteFolder: appMedia, openNoteFolders: [appMedia] }));
            ({ app, win } = await launch(fx));
            try {
                await expect(win.locator('.file-panel-item', { hasText: 'Smoke Outline' })).toBeVisible();
            } finally {
                await app.close();
            }
            expect(mainLog()).toContain(`not reopening ${appMedia}: it is one of the app's own folders`);
            expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).openNoteFolders).toEqual([fx.note]);
            expect(fs.readdirSync(appMedia).sort()).toEqual(appMediaBefore);
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-4 showInputBox from the webview opens the prompt sheet, and its answer reaches the md (Link command)', async () => {
        const fx = makeFixture();
        try {
            const { app, win } = await launch(fx);
            try {
                await openTreeItem(win, 'Smoke Page');
                await typeAtEndOfMd(win, 'see ');
                const prompt1 = app.waitForEvent('window', { timeout: 20000 });
                await win.keyboard.press('Meta+/');
                await win.locator('.command-palette-item[data-action="link"]').first().click();
                const urlPrompt = await prompt1;
                const urlField = urlPrompt.locator('input.field');
                await expect(urlField).toBeVisible();
                expect(new URL(urlPrompt.url()).protocol).toBe('fractal-ui:');
                await urlField.fill('https://example.com/docs');
                const prompt2 = app.waitForEvent('window', { timeout: 20000 });
                await acceptPrompt(urlPrompt);
                const textPrompt = await prompt2;
                const textField = textPrompt.locator('input.field');
                await expect(textField).toHaveValue('link');
                await textField.fill('the docs');
                await acceptPrompt(textPrompt);
                const md = await waitForFile(fx.mdPath, (s) => s.includes('(https://example.com/docs)'));
                expect(md).toContain('[the docs](https://example.com/docs)');
                // (the sidebar is a fractal-ui: page too since spec 20261107-0431: only prompt pages count here)
                expect(app.windows().filter((p) => p.url().startsWith('fractal-ui://prompt/'))).toEqual([]);
            } finally {
                await app.close();
            }
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-4 menu: New Note… and Open Note Folder… open notes in the window (one window, spec 20261107-0431 D1); File > Notes switches without opening twice', async () => {
        const fx = makeFixture();
        const parent = path.dirname(fx.note);
        // a second note that is not in the notes list (made by the extension's own file manager)
        const other = path.join(parent, 'other-note');
        fs.mkdirSync(other, { recursive: true });
        const ofm = new NotesFileManager(other);
        ofm.loadStructure();
        ofm.createFile('Other Outline');
        ofm.dispose();
        const fresh = path.join(parent, 'fresh-note');
        try {
            const { app, win } = await launch(fx);
            try {
                // the native folder pickers answer with the fixture folders (both ElectronUi.showOpenDialog and
                // File > Open Note Folder… call dialog.showOpenDialog)
                await app.evaluate(({ dialog }, answers) => {
                    const queue = [...answers];
                    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
                }, [parent, other]);

                // File > New Note…: the extension's own flow — folder picker → name prompt (validateInput) → the new note opens
                const promptOpened = app.waitForEvent('window', { timeout: 20000 });
                await clickMenu(app, 'File', 'New Note…');
                const namePrompt = await promptOpened;
                const field = namePrompt.locator('input.field');
                await expect(field).toBeVisible();
                await field.fill('fresh-note');
                await acceptPrompt(namePrompt);
                const freshWin = await nextPanelPage(app, [win], 60000);
                expect(fs.existsSync(path.join(fresh, 'outline.note'))).toBe(true);
                const registry = JSON.parse(fs.readFileSync(path.join(fx.home, '.fractal', 'default.fractal'), 'utf8'));
                expect(registry.notes).toEqual([fx.note, fresh]);
                await expect.poll(() => menuLabels(app, 'File', 'Notes')).toEqual(['smoke-note', 'fresh-note']);

                // File > Open Note Folder…: a note folder outside the list opens too — in the same window since
                // spec 20261107-0431 D1 (one window shows one note at a time; the window title follows it)
                await clickMenu(app, 'File', 'Open Note Folder…');
                const otherWin = await nextPanelPage(app, [win, freshWin], 60000);
                await expect(otherWin.locator('.file-panel-item', { hasText: 'Other Outline' })).toBeVisible({ timeout: 60000 });
                await expect.poll(() => windowTitles(app)).toEqual(['Notes: other-note']);
                expect(panelPages(app).length).toBe(3);

                // File > Notes > smoke-note: the open note is brought forward (shown), not opened a second time
                await clickMenu(app, 'File', 'Notes', 'smoke-note');
                await expect.poll(() => windowTitles(app)).toEqual(['Notes: smoke-note']);
                await win.waitForTimeout(1000);
                expect(panelPages(app).length).toBe(3);
                expect(await windowTitles(app)).toEqual(['Notes: smoke-note']);
            } finally {
                await app.close();
            }
            // quit remembered every open note for the next start
            const state = JSON.parse(fs.readFileSync(path.join(fx.userData, 'desktop-state.json'), 'utf8'));
            expect([...state.openNoteFolders].sort()).toEqual([fx.note, fresh, other].sort());
        } finally {
            rmrf(fx.tmp);
        }
    });

    test('AC-4 a file dropped on the outliner reaches the note byte for byte (binary message: page → preload → shim → extension)', async () => {
        const fx = makeFixture();
        const pdf = fs.readFileSync(path.join(REPO_ROOT, 'test', 'fixtures', 'doc-search', 'fixture-ja-en.pdf'));
        try {
            const { app, win } = await launch(fx);
            try {
                await openTreeItem(win, 'Smoke Outline');
                await expect(win.locator('.outliner-node .outliner-text').first()).toBeVisible();
                // the drop the outliner gets from Finder (a File in the DataTransfer); its buffered import posts
                // { type: 'dropFilesImport', items: [{ kind: 'file', name, bytes: Uint8Array }] }
                await win.evaluate((b64) => {
                    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
                    const dt = new DataTransfer();
                    dt.items.add(new File([bytes], 'dropped.pdf', { type: 'application/pdf' }));
                    const target = document.querySelector('.outliner-node .outliner-text') as HTMLElement;
                    const r = target.getBoundingClientRect();
                    const opts = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + 10, clientY: r.bottom - 2 };
                    for (const type of ['dragenter', 'dragover', 'drop']) {
                        target.dispatchEvent(new DragEvent(type, opts));
                    }
                }, pdf.toString('base64'));
                const dropped = path.join(fx.note, 'files', 'dropped.pdf');
                await expect.poll(() => (fs.existsSync(dropped) ? fs.readFileSync(dropped).equals(pdf) : false), { timeout: 15000 }).toBe(true);
                const out = await waitForFile(fx.outPath, (s) => s.includes('files/dropped.pdf'));
                const filePaths = Object.values((JSON.parse(out) as { nodes: Record<string, { filePath?: string }> }).nodes).map((n) => n.filePath);
                expect(filePaths).toContain('files/dropped.pdf');
                await expect(win.locator('.outliner-node', { hasText: 'dropped.pdf' })).toBeVisible();
            } finally {
                await app.close();
            }
        } finally {
            rmrf(fx.tmp);
        }
    });
});
