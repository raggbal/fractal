/**
 * The web clipper loaded into a real Chromium (a copy of chrome-extension/ with host access to a loopback test page, so
 * the clip can run without the shortcut's activeTab): Settings → choose the .fractal → the notes say they are not enabled
 * yet, with the folder to choose → enable them → ☆ → the popup (★ first, 📌 Bookmark saves, each note keeps its last
 * destination) → the quick clip (Alt+Shift+F's handler) saves to the place saved to last → a note Fractal adds later is
 * ready; one outside the enabled folder asks to be enabled and can't be picked. And an upgrade from 0.4 (a note
 * registered by itself, with a ★default preset) carries over.
 *
 * The "disk" is the extension's origin-private file system (real FileSystemHandles, storable in IDB) and the file /
 * folder pickers return handles from it — the OS dialogs can't be driven. The notes in it are made by Fractal's own
 * NotesFileManager.
 */
import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { NotesFileManager } from '../../src/shared/notes-file-manager';

const EXT = path.resolve(__dirname, '../../chrome-extension');
const W = '/Users/me/workspace/fractal';
const ARTICLE = '<!doctype html><html><head><title>Keeping notes close</title></head><body><article><h1>Keeping notes close</h1>' +
    '<p>' + 'Notes work best next to the work they describe. '.repeat(12) + '</p><p>' + 'Second paragraph of the article. '.repeat(10) + '</p></article></body></html>';

/** notes made by Fractal → { '<note>/<file>': text } */
function noteFiles(names: string[]): Record<string, string> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-clipper-ext-notes-'));
    const files: Record<string, string> = {};
    try {
        for (const n of names) {
            const dir = path.join(tmp, n);
            fs.mkdirSync(dir);
            const fm = new NotesFileManager(dir);
            fm.loadStructure();
            fm.createFile(n + ' clips');
            fm.dispose();
            for (const f of fs.readdirSync(dir)) {
                if (fs.statSync(path.join(dir, f)).isFile()) files[n + '/' + f] = fs.readFileSync(path.join(dir, f), 'utf8');
            }
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    return files;
}

interface Session { ctx: BrowserContext; sw: Worker; id: string; errors: string[]; close(): Promise<void> }

async function launch(): Promise<Session> {
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-clipper-ext-'));
    fs.cpSync(EXT, ext, { recursive: true });
    const mf = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
    mf.host_permissions = ['http://127.0.0.1/*'];
    fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(mf, null, 2));
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-clipper-ext-ud-'));
    const ctx = await chromium.launchPersistentContext(ud, {
        headless: true, channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    });
    const errors: string[] = [];
    ctx.on('page', (p) => {
        p.on('pageerror', (e) => errors.push(`${p.url()}: ${e}`));
        p.on('console', (m) => { if (m.type() === 'error') errors.push(`${p.url()}: ${m.text()}`); });
    });
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
    return {
        ctx, sw, id: new URL(sw.url()).host, errors,
        close: async () => {
            await ctx.close();
            fs.rmSync(ud, { recursive: true, force: true });
            fs.rmSync(ext, { recursive: true, force: true });
        },
    };
}

/** OPFS helpers on an extension page: window.__opfs.dir(rel) / write(rel, text); the pickers return OPFS handles */
async function installDisk(page: Page): Promise<void> {
    await page.evaluate(() => {
        const w = window as any;
        const dir = async (rel: string) => {
            let d = await navigator.storage.getDirectory();
            for (const s of rel.split('/').filter(Boolean)) d = await d.getDirectoryHandle(s, { create: true });
            return d;
        };
        const write = async (rel: string, text: string) => {
            const parts = rel.split('/');
            const d = await dir(parts.slice(0, -1).join('/'));
            const wr = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
            await wr.write(text);
            await wr.close();
        };
        w.__opfs = { dir, write };
        w.__pick = 'Users/me/workspace/fractal'; // the folder the user "chooses" in the folder dialog
        w.showOpenFilePicker = async () => [await (await dir('Users/me/.fractal')).getFileHandle('default.fractal')];
        w.showDirectoryPicker = async () => dir(w.__pick);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => { w.__copied = t; } } });
    });
}

async function writeDisk(page: Page, files: Record<string, string>, list: string[]): Promise<void> {
    await page.evaluate(async ({ files, list }) => {
        const opfs = (window as any).__opfs;
        for (const [rel, text] of Object.entries(files)) await opfs.write('Users/me/workspace/fractal/' + rel, text);
        await opfs.write('Users/me/.fractal/default.fractal', JSON.stringify({ version: 1, notes: list }, null, 2) + '\n');
    }, { files, list });
}

const texts = (page: Page, sel: string) => page.$$eval(sel, (els) => els.map((e) => (e.textContent || '').trim()));

test.describe('web clipper in Chromium', () => {
    test.setTimeout(90000);

    test('TC-CE-01 choose the .fractal, enable the notes once, ★, save from the popup and with the quick clip; notes Fractal adds later', async () => {
        const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(ARTICLE); });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as AddressInfo).port;
        const s = await launch();
        try {
            expect(await s.sw.evaluate(() => typeof (self as any).FractalFolders === 'object' && typeof (self as any).FractalClipWriter === 'object')).toBe(true);
            const opts = await s.ctx.newPage();
            await opts.goto(`chrome-extension://${s.id}/options.html`);
            await opts.waitForSelector('#chooseListBtn');
            await installDisk(opts);
            const files = noteFiles(['alpha', 'beta', 'gamma']);
            const two = Object.fromEntries(Object.entries(files).filter(([k]) => !k.startsWith('gamma/')));
            const EC2 = '/home/ec2-user/repos/fractal/doc/ttt'; // a note of another machine in the same .fractal
            await writeDisk(opts, two, [`${W}/alpha`, EC2, `${W}/beta`]);

            // the .fractal → its notes, not enabled yet: each row has Enable…, the banner has a row per folder to choose
            // (path, how many notes, Choose…); the other machine's note says so, has no button, and is not counted
            await opts.click('#chooseListBtn');
            await expect(opts.locator('#listSummary')).toHaveText('default.fractal — 3 notes');
            await expect(opts.locator('#noteList li')).toHaveCount(3);
            // the rows only say how each note is (no buttons but ☆); what to do is in the banner, once per folder
            await expect(opts.locator('#noteList li button:not(.fav)')).toHaveCount(0);
            await expect(opts.locator('#noteList li > span:last-child')).toHaveText(['Not enabled yet', 'Not enabled yet', 'Not on this computer']);
            await expect(opts.locator('#noteList li').nth(2)).toContainText('ttt');
            await expect(opts.locator('#enableBannerText')).toContainText('2 notes cannot be saved to yet');
            await expect(opts.locator('#enableRows .suggest code')).toHaveText([W]);
            await expect(opts.locator('#enableRows .suggest .meta')).toHaveText(['2 notes']);
            await expect(opts.locator('#enableHint')).toContainText('⌘⇧G');
            expect(await opts.$('#rootList')).toBeNull(); // no "Allowed folders" list, no presets
            expect(await opts.$('#presetList')).toBeNull();

            // Choose… copies the path (to paste in the dialog) and opens it → both notes ready
            await opts.click('#enableRows .suggest button');
            await expect(opts.locator('#accessStatus')).toHaveText(`✅ Enabled 2 notes in ${W}`);
            expect(await opts.evaluate(() => (window as any).__copied)).toBe(W);
            await expect(opts.locator('#noteList li .ok')).toHaveText(['✓ Ready', '✓ Ready']);
            await expect(opts.locator('#enableBanner')).toBeHidden();

            // Chrome forgot the permission (e.g. after a restart): the rows say so, and the banner has one Allow again for the folder
            await opts.evaluate(() => {
                const w = window as any;
                const P = w.FileSystemHandle.prototype;
                const q = P.queryPermission;
                const r = P.requestPermission;
                w.__asked = 0;
                P.queryPermission = async () => 'prompt';
                P.requestPermission = async () => { w.__asked++; P.queryPermission = q; P.requestPermission = r; return 'granted'; };
            });
            await opts.evaluate(() => (window as any).refresh());
            await expect(opts.locator('#noteList li > span:last-child')).toHaveText(['Needs permission again', 'Needs permission again', 'Not on this computer']);
            await expect(opts.locator('#enableBannerText')).toHaveText('2 notes need your permission again (Chrome can forget it, for example after a restart). Press Allow again.');
            await expect(opts.locator('#enableRows .suggest code')).toHaveText([W]);
            await expect(opts.locator('#enableRows .suggest button')).toHaveText(['Allow again']);
            await expect(opts.locator('#enableHint')).toBeHidden(); // no folder dialog for this
            await opts.click('#enableRows .suggest button');
            await expect(opts.locator('#noteList li .ok')).toHaveText(['✓ Ready', '✓ Ready']);
            await expect(opts.locator('#enableBanner')).toBeHidden();
            expect(await opts.evaluate(() => (window as any).__asked)).toBe(1); // one request for the folder, not one per note

            // ☆ beta → ★
            await opts.locator('#noteList li').nth(1).locator('.fav').click();
            await expect(opts.locator('#noteList li').nth(1).locator('.fav')).toHaveText('★');

            // the popup: ★ beta first and selected; 📌 Bookmark saves into the tab's page (the active tab = the test page)
            const article = await s.ctx.newPage();
            await article.goto(`http://127.0.0.1:${port}/article.html`);
            const popup = await s.ctx.newPage();
            await popup.goto(`chrome-extension://${s.id}/popup.html`);
            await expect(popup.locator('#outSelect')).toContainText('beta clips');
            expect(await texts(popup, '#folderSelect option')).toEqual(['★ beta', 'alpha']);
            expect(await popup.$('#presetSelect')).toBeNull();
            await popup.evaluate(async () => {
                const tabs = (globalThis as any).chrome.tabs;
                const [tab] = await tabs.query({ url: 'http://127.0.0.1/*' });
                tabs.query = async () => [tab];
            });
            await popup.click('#clipBtn');
            await expect(popup.locator('#status')).toContainText('✅ Clip done: Keeping notes close →', { timeout: 20000 });
            const betaOut = await opts.evaluate(async () => {
                const beta = await (window as any).__opfs.dir('Users/me/workspace/fractal/beta');
                for await (const [n] of beta.entries()) if (n.endsWith('.out')) return n.replace(/\.out$/, '');
            });
            expect(await opts.evaluate(() => (window as any).FractalIdb.get('lastSelection'))).toEqual({ folderId: `${W}/beta`, targetId: betaOut, targetKind: 'out' });
            // each note keeps its own destination
            await popup.selectOption('#folderSelect', `${W}/alpha`);
            await expect(popup.locator('#outSelect')).toContainText('alpha clips');
            await popup.selectOption('#folderSelect', `${W}/beta`);
            await expect(popup.locator('#outSelect')).toContainText('beta clips');
            expect(await popup.$eval('#outSelect', (e) => (e as HTMLSelectElement).value)).toBe(betaOut);
            await popup.close();

            // the quick clip → the place saved to last (beta)
            await article.bringToFront();
            expect(await s.sw.evaluate(async () => {
                const [tab] = await (globalThis as any).chrome.tabs.query({ url: 'http://127.0.0.1/*' });
                try { await (self as any).quickClip(tab); return 'ok'; } catch (e) { return 'ERR ' + ((e as Error).message || e); }
            })).toBe('ok');
            const disk = await opts.evaluate(async () => {
                const opfs = (window as any).__opfs;
                const names = async (d: any) => { const a: string[] = []; for await (const [n] of d.entries()) a.push(n); return a.sort(); };
                const beta = await opfs.dir('Users/me/workspace/fractal/beta');
                const out = JSON.parse(await (await (await beta.getFileHandle((await names(beta)).find((n: string) => n.endsWith('.out')))).getFile()).text());
                const tops = out.rootIds.slice(0, 2).map((id: string) => out.nodes[id]);
                const mds: string[] = [];
                for (const n of tops) mds.push((await (await (await beta.getFileHandle(n.pageId + '.md')).getFile()).text()).split('\n')[0]);
                return { tops: tops.map((n: any) => [n.text, n.isPage]), mds, alpha: await names(await opfs.dir('Users/me/workspace/fractal/alpha')) };
            });
            expect(disk.tops).toEqual([['Keeping notes close', true], ['Keeping notes close', true]]); // the popup's clip and the quick clip
            expect(disk.mds).toEqual(['# Keeping notes close', '# Keeping notes close']);
            expect(disk.alpha.filter((n: string) => n.endsWith('.md'))).toEqual([]); // the other note is untouched

            // Fractal adds gamma (inside the enabled folder) and delta (outside it)
            const gamma = Object.fromEntries(Object.entries(files).filter(([k]) => k.startsWith('gamma/')));
            await writeDisk(opts, gamma, [`${W}/alpha`, EC2, `${W}/beta`, `${W}/gamma`, '/Users/me/Documents/delta']);
            await opts.reload();
            await installDisk(opts);
            await expect(opts.locator('#listSummary')).toHaveText('default.fractal — 5 notes');
            await expect(opts.locator('#noteList li')).toHaveCount(5);
            await expect(opts.locator('#noteList li').nth(2)).toContainText('✓ Ready'); // gamma
            await expect(opts.locator('#noteList li').nth(3)).toContainText('Not enabled yet'); // delta
            await expect(opts.locator('#noteList li').nth(4)).toContainText('Not on this computer'); // the other machine's, last
            await expect(opts.locator('#enableBannerText')).toContainText('1 note cannot be saved to yet');
            await expect(opts.locator('#enableRows .suggest code')).toHaveText(['/Users/me/Documents/delta']);
            await expect(opts.locator('#enableRows .suggest .meta')).toHaveText(['1 note']);
            // Choose… copies that folder; choosing a folder with none of the notes says so
            await opts.evaluate(() => { (window as any).__pick = 'Users/me/elsewhere'; });
            await opts.click('#enableRows .suggest button');
            await expect(opts.locator('#accessStatus')).toHaveText('❌ That folder has none of the notes in the .fractal. Choose the folder that holds them');
            expect(await opts.evaluate(() => (window as any).__copied)).toBe('/Users/me/Documents/delta');
            const popup2 = await s.ctx.newPage();
            await popup2.goto(`chrome-extension://${s.id}/popup.html`);
            await expect(popup2.locator('#folderSelect option')).toHaveCount(4); // the other machine's note is not offered
            expect(await popup2.$$eval('#folderSelect option', (os) => os.map((o) => [o.textContent, (o as HTMLOptionElement).disabled])))
                .toEqual([['★ beta', false], ['alpha', false], ['gamma', false], ['delta — not enabled yet (Settings)', true]]);
            await popup2.close();

            // 日本語
            await opts.selectOption('#langSelect', 'ja');
            await expect(opts.locator('#listSummary')).toHaveText('default.fractal — note 5 件');
            await expect(opts.locator('#noteList li').nth(3)).toContainText('まだ有効ではありません');
            await expect(opts.locator('#noteList li').nth(4)).toContainText('このコンピューターにはありません');
            await expect(opts.locator('#noteList li').nth(0)).toContainText('✓ 保存できます');
            await expect(opts.locator('#enableRows .suggest button')).toHaveText(['選ぶ…']);
            await expect(opts.locator('#enableHint')).toContainText('⌘⇧G を押し、⌘V で貼り付けて Enter');
            expect(s.errors).toEqual([]);
        } finally {
            await s.close();
            server.close();
        }
    });

    test('TC-CE-02 upgrade from 0.4: a note registered by itself and its ★default preset carry over when the .fractal is chosen', async () => {
        const s = await launch();
        try {
            const opts = await s.ctx.newPage();
            await opts.goto(`chrome-extension://${s.id}/options.html`);
            await opts.waitForSelector('#chooseListBtn');
            await installDisk(opts);
            const files = noteFiles(['alpha', 'beta']);
            await writeDisk(opts, files, [`${W}/alpha`, `${W}/beta`]);
            const outAlpha = Object.keys(files).find((k) => k.startsWith('alpha/') && k.endsWith('.out'))!.split('/')[1].replace(/\.out$/, '');
            await opts.evaluate(async (outAlpha) => {
                const w = window as any;
                await w.FractalIdb.set('notesFolders', [{ id: 'fold1', name: 'alpha', handle: await w.__opfs.dir('Users/me/workspace/fractal/alpha') }]);
                await w.FractalIdb.set('presets', [{ id: 'pold', name: 'Old', folderId: 'fold1', targetId: outAlpha, targetKind: 'out', targetTitle: 'alpha clips' }]);
                await w.FractalIdb.set('defaultPresetId', 'pold');
            }, outAlpha);
            await opts.reload();
            await expect(opts.locator('#folderList li')).toHaveCount(1); // "Registered before"
            await installDisk(opts);
            await opts.click('#chooseListBtn');
            await expect(opts.locator('#accessStatus')).toHaveText('✅ Moved 1 note registered before over to the .fractal');
            await expect(opts.locator('#legacySection')).toBeHidden();
            await expect(opts.locator('#noteList li').nth(0)).toContainText('✓ Ready'); // with the old permission
            await expect(opts.locator('#noteList li').nth(1)).toContainText('Not enabled yet');
            await expect(opts.locator('#noteList li').nth(0).locator('.fav')).toHaveText('★'); // the ★default preset's note
            const stored = await opts.evaluate(async () => {
                const idb = (window as any).FractalIdb;
                return { presets: await idb.get('presets'), favs: await idb.get('favoriteNotes'), last: await idb.get('lastSelection'), legacy: await idb.get('notesFolders') };
            });
            expect(stored).toEqual({ presets: undefined, favs: [`${W}/alpha`], last: { folderId: `${W}/alpha`, targetId: outAlpha, targetKind: 'out' }, legacy: [] });
            const popup = await s.ctx.newPage();
            await popup.goto(`chrome-extension://${s.id}/popup.html`);
            await expect(popup.locator('#outSelect')).toContainText('alpha clips');
            expect(await popup.$eval('#folderSelect', (e) => (e as HTMLSelectElement).selectedOptions[0].textContent)).toBe('★ alpha');
            expect(await popup.$eval('#outSelect', (e) => (e as HTMLSelectElement).value)).toBe(outAlpha);
            expect(s.errors).toEqual([]);
        } finally {
            await s.close();
        }
    });
});
