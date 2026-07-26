/**
 * ai_skills のフラットレイアウト対応（sprint 20260726-013730 / FR-SK）。
 *
 * fractal-md.mjs / fractal-attach.mjs / fractal-search.mjs は main() に
 * import.meta.url ガードが入ったので直接 import できる（design §B5）。
 * tmp fixture（flat / legacy / hint）で解決順を検証。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mdMjs = path.resolve(__dirname, '../../ai_skills/fractal-edit/scripts/fractal-md.mjs');
const attachMjs = path.resolve(__dirname, '../../ai_skills/fractal-edit/scripts/fractal-attach.mjs');
const searchMjs = path.resolve(__dirname, '../../ai_skills/fractal-search/scripts/fractal-search.mjs');

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

test.describe('C. skills パス解決（fractal-md / attach / search）— 新フラット前提（legacy fallback 廃止 = ユーザー決定 2026-07-26）', () => {
    // TC-SK-01（★load-bearing・FR-SK-01）: 常に note 直下（旧 <basename>/ デフォルト廃止）
    test('TC-SK-01 fractal-md resolvePagesDirMjs — 常に直下', async () => {
        const { resolvePagesDirMjs } = await import(mdMjs);
        const noteDir = mkNote('flat', { flatMd: true, legacyStemMd: 'myout' }); // legacy dir が残っていても直下
        expect(resolvePagesDirMjs(noteDir, 'myout', {})).toBe(noteDir);
        // counterfactual: 旧実装は <noteDir>/myout を返していた
        expect(resolvePagesDirMjs(noteDir, 'myout', {})).not.toBe(path.join(noteDir, 'myout'));
        // 空 note（新規）も直下
        const empty = mkNote('empty');
        expect(resolvePagesDirMjs(empty, 'x', {})).toBe(empty);
    });

    // TC-SK-02: legacy dir が残っていても新フラット前提で直下（fallback しない）
    test('TC-SK-02 legacy dir 実在でも直下（fallback 廃止）', async () => {
        const { resolvePagesDirMjs } = await import(mdMjs);
        const noteDir = mkNote('legacy', { legacyStemMd: 'myout' });
        expect(resolvePagesDirMjs(noteDir, 'myout', {})).toBe(noteDir);
        const pagesDir = mkNote('pages', { legacyPagesMd: true });
        expect(resolvePagesDirMjs(pagesDir, 'other', {})).toBe(pagesDir);
    });

    // TC-SK-03: hint 尊重
    test('TC-SK-03 pageDir hint（"." / 相対 / 絶対）', async () => {
        const { resolvePagesDirMjs, isFlatOut } = await import(mdMjs);
        const noteDir = mkNote('hint', { legacyStemMd: 'myout' });
        expect(resolvePagesDirMjs(noteDir, 'myout', { pageDir: '.' })).toBe(noteDir); // flat hint 最優先
        expect(resolvePagesDirMjs(noteDir, 'myout', { pageDir: './sub' })).toBe(path.resolve(noteDir, 'sub'));
        const abs = path.join(tmpRoot, 'abs-pages');
        expect(resolvePagesDirMjs(noteDir, 'myout', { pageDir: abs })).toBe(abs);
        expect(isFlatOut('.')).toBe(true);
        expect(isFlatOut('./sub')).toBe(false);
    });

    // TC-SK-04（FR-SK-02）: attach の asset dir — 共有 default（legacy fallback 廃止）
    test('TC-SK-04 fractal-attach resolveOutlinerAssetDir', async () => {
        const { resolveOutlinerAssetDir } = await import(attachMjs);
        // 常に共有 <outDir>/<subdir>（legacy dir が残っていても）
        const n2 = mkNote('a2');
        fs.mkdirSync(path.join(n2, 'o', 'images'), { recursive: true });
        expect(resolveOutlinerAssetDir(path.join(n2, 'o.out'), null, 'images')).toBe(path.resolve(n2, 'images'));
        const n3 = mkNote('a3');
        expect(resolveOutlinerAssetDir(path.join(n3, 'o.out'), null, 'images')).toBe(path.resolve(n3, 'images'));
        // 明示指定
        expect(resolveOutlinerAssetDir(path.join(n3, 'o.out'), './custom', 'images')).toBe(path.resolve(n3, 'custom'));
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
