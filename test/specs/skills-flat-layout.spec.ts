/**
 * ai_skills のフラットレイアウト対応（sprint 20260726-013730 / FR-SK）。
 *
 * fractal-search.mjs は main() に import.meta.url ガードが入ったので直接 import できる（design §B5）。
 * 書き込み（旧 fractal-md.mjs / fractal-attach.mjs）は spec 20261027-1700 で MCP（正典 src/shared）へ置き換えたので、
 * bundle の tool を通して正典と同じ置き場になることを確かめる。
 * tmp fixture（flat / legacy / hint）で解決順を検証。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { McpTestClient } from '../utils/mcp-client';
import { resolvePagesDir, resolveImagesDir, resolveFilesDir, isFlatOut } from '../../src/shared/flat-layout';

const searchMjs = path.resolve(__dirname, '../../mcp/scripts/fractal-search.mjs');

let tmpRoot: string;
test.beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-skills-'));
});
test.afterAll(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mkNote(name: string, opts: { flatMd?: boolean; legacyStemMd?: string; legacyPagesMd?: boolean } = {}): string {
    const dir = fs.mkdtempSync(path.join(tmpRoot, name + '-'));
    if (opts.flatMd) fs.writeFileSync(path.join(dir, 'p1.md'), '# flat');
    if (opts.legacyStemMd) {
        fs.mkdirSync(path.join(dir, opts.legacyStemMd), { recursive: true });
        fs.writeFileSync(path.join(dir, opts.legacyStemMd, 'p2.md'), '# legacy');
    }
    if (opts.legacyPagesMd) {
        fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'pages', 'p3.md'), '# pages');
    }
    return dir;
}

test.describe('C. skills パス解決（MCP の書き込み / search）', () => {
    // spec 20261027-1700-mcp-full-ops D1: MCP の書き込み（旧 fractal-md.mjs / fractal-attach.mjs）の pageDir / images / files の
    // 解決は mjs ミラー（resolvePagesDirMjs / resolveOutlinerAssetDir = 新フラット前提）をやめ、正典 src/shared/flat-layout を呼ぶ。
    // MCP が返す pagesDir（fractal_get）と、page / 画像 / 添付の実際の置き場が正典と一致することを確かめる。
    // 変更: 未移行の note（pageDir ヒント無し + legacy dir に md あり）では、正典と同じく legacy dir を使う
    //（旧ミラーは常に note 直下 = UI が読む場所とずれていた）。
    const withClient = async <T>(fn: (c: McpTestClient) => Promise<T>): Promise<T> => {
        const c = new McpTestClient({ FRACTAL_TRASH_DIR: path.join(tmpRoot, '_trash') });
        try { await c.init(); return await fn(c); } finally { c.close(); }
    };
    const mkOut = (noteDir: string, stem: string, hints: Record<string, string> = {}) => {
        const p = path.join(noteDir, `${stem}.out`);
        fs.writeFileSync(p, JSON.stringify({ version: 1, title: stem, ...hints, rootIds: ['n1'], nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'a', tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: null } } }));
        fs.writeFileSync(path.join(noteDir, 'outline.note'), JSON.stringify({ version: 1, rootIds: [stem], items: { [stem]: { type: 'file', id: stem, title: stem } } }));
        return p;
    };

    test('TC-SK-01 page の置き場は正典 resolvePagesDir と一致（flat = note 直下）', async () => {
        const noteDir = mkNote('flat', { flatMd: true, legacyStemMd: 'myout' });
        const out = mkOut(noteDir, 'myout');
        await withClient(async (c) => {
            const got = (await c.call('fractal_get', { path: out })).json;
            expect(got.pagesDir).toBe(resolvePagesDir(out, noteDir, {}));
            expect(got.pagesDir).toBe(noteDir); // flat md がある = 直下
            const mp = (await c.call('fractal_modify', { note: out, target: 'n1', op: 'make-page' })).json;
            expect(path.dirname(mp.pageMdPath)).toBe(noteDir);
        });
    });

    test('TC-SK-02 未移行（legacy dir に md・ヒント無し）は正典と同じく legacy dir（UI が読む場所）', async () => {
        const noteDir = mkNote('legacy', { legacyStemMd: 'myout' });
        const out = mkOut(noteDir, 'myout');
        await withClient(async (c) => {
            const got = (await c.call('fractal_get', { path: out })).json;
            expect(got.pagesDir).toBe(resolvePagesDir(out, noteDir, {}));
            expect(got.pagesDir).toBe(path.join(noteDir, 'myout'));
        });
    });

    test('TC-SK-03 pageDir hint（"." / 相対 / 絶対）', async () => {
        const noteDir = mkNote('hint', { legacyStemMd: 'myout' });
        await withClient(async (c) => {
            for (const pageDir of ['.', './sub']) {
                const out = mkOut(noteDir, 'myout', { pageDir });
                const got = (await c.call('fractal_get', { path: out })).json;
                expect(got.pagesDir).toBe(resolvePagesDir(out, noteDir, { pageDir }));
            }
            expect((await c.call('fractal_get', { path: mkOut(noteDir, 'myout', { pageDir: '.' }) })).json.pagesDir).toBe(noteDir);
        });
        expect(isFlatOut('.')).toBe(true);
        expect(isFlatOut('./sub')).toBe(false);
    });

    test('TC-SK-04 画像 / 添付の置き場は正典 resolveImagesDir / resolveFilesDir（共有 <note>/images・files）', async () => {
        const n3 = mkNote('a3');
        const out = mkOut(n3, 'o', { pageDir: '.', imageDir: './images', fileDir: './files' });
        const png = path.join(tmpRoot, 'sk.png');
        fs.writeFileSync(png, 'PNG');
        const pdf = path.join(tmpRoot, 'sk.pdf');
        fs.writeFileSync(pdf, 'PDF');
        await withClient(async (c) => {
            const img = (await c.call('fractal_attach', { note: out, images: [png] })).json;
            expect(path.dirname(path.resolve(n3, img.images[0]))).toBe(resolveImagesDir(out, n3, { imageDir: './images' }));
            const f = (await c.call('fractal_attach', { note: out, files: [pdf] })).json;
            expect(path.dirname(f.files[0].fileAbsPath)).toBe(resolveFilesDir(out, n3, { fileDir: './files' }));
            expect(path.dirname(f.files[0].fileAbsPath)).toBe(path.join(n3, 'files'));
        });
    });

    // TC-SK-05（FR-SK-03）: search の pageDir 解決 — hint 尊重・無ければ直下
    test('TC-SK-05 fractal-search resolvePagesDirForSearch', async () => {
        const { resolvePagesDirForSearch } = await import(searchMjs);
        const flatN = mkNote('s1', { flatMd: true });
        expect(resolvePagesDirForSearch(flatN, path.join(flatN, 'o.out'), undefined)).toBe(flatN);
        // legacy dir が残っていても直下（fallback 廃止）
        const legacyN = mkNote('s2', { legacyStemMd: 'o' });
        expect(resolvePagesDirForSearch(legacyN, path.join(legacyN, 'o.out'), undefined)).toBe(legacyN);
        // hint 尊重
        expect(resolvePagesDirForSearch(legacyN, path.join(legacyN, 'o.out'), '.')).toBe(legacyN);
        expect(resolvePagesDirForSearch(legacyN, path.join(legacyN, 'o.out'), './sub')).toBe(path.resolve(legacyN, 'sub'));
    });
});
