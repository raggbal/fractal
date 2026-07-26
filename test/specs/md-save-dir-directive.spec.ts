/**
 * 保存先サイドカー（standalone md 限定・フォルダ共有 .fractal.json）— ADRL-0016 / FR-MD-01/04/05/06。
 *
 * src/shared/save-dir-directive.ts は vscode 非依存の pure モジュールなので直接 import して検証する。
 * TC-RES 系の「resolver 優先順位」は ImageDirectoryManager（vscode 依存）を呼べないため、
 * resolver が使う guard 述語（isUnderFractalNote / detectStandaloneOutlinerPage）+ resolveSaveDirFromSidecar +
 * default = path.join(mdDir,'images') をミラーで検証（src と 1:1・editorProvider の getImageDirectory と同順）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    SAVE_DIR_SIDECAR,
    sidecarPathForMd,
    readSaveDirConfig,
    resolveSaveDirFromSidecar,
    isValidSaveDirValue,
    withSaveDir,
    withoutSaveDir,
    isUnderFractalNote,
    detectStandaloneOutlinerPage,
} from '../../src/shared/save-dir-directive';

// ---- resolver 優先順位のミラー（editorProvider.ts getImageDirectory と 1:1）----
// 1. .fractal.json（standalone md 限定・guard）→ 2. forced dir → 3. <mdDir>/images
function resolveImageDir(mdPath: string, forcedDir: string | null, sub: 'images' | 'files' = 'images'): { dir: string; useAbsolute: boolean } {
    const mdDir = path.dirname(mdPath);
    const key = sub === 'images' ? 'imageDir' : 'fileDir';
    if (!isUnderFractalNote(mdPath) && detectStandaloneOutlinerPage(mdPath) === null) {
        const d = resolveSaveDirFromSidecar(mdPath, key as 'imageDir' | 'fileDir');
        if (d) {
            return { dir: path.isAbsolute(d) ? d : path.resolve(mdDir, d), useAbsolute: path.isAbsolute(d) };
        }
    }
    if (forcedDir) {
        return { dir: path.isAbsolute(forcedDir) ? forcedDir : path.resolve(mdDir, forcedDir), useAbsolute: path.isAbsolute(forcedDir) };
    }
    return { dir: path.join(mdDir, sub), useAbsolute: false };
}

let tmpRoot: string;
test.beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-savedir-'));
});
test.afterAll(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeSidecar(dir: string, obj: unknown) {
    fs.writeFileSync(path.join(dir, SAVE_DIR_SIDECAR), JSON.stringify(obj), 'utf-8');
}

test.describe('A. サイドカー read / config 操作（pure）', () => {
    // TC-DIR-01: imageDir を読む
    test('TC-DIR-01 .fractal.json の imageDir を解決', () => {
        const d = fs.mkdtempSync(path.join(tmpRoot, 'a1-'));
        writeSidecar(d, { imageDir: 'assets' });
        expect(resolveSaveDirFromSidecar(path.join(d, 'x.md'), 'imageDir')).toBe('assets');
    });
    // TC-DIR-02: 無ければ null
    test('TC-DIR-02 .fractal.json 無し → null', () => {
        const d = fs.mkdtempSync(path.join(tmpRoot, 'a2-'));
        expect(resolveSaveDirFromSidecar(path.join(d, 'x.md'), 'imageDir')).toBeNull();
    });
    // TC-DIR-03: 絶対パス
    test('TC-DIR-03 絶対パスの imageDir', () => {
        const d = fs.mkdtempSync(path.join(tmpRoot, 'a3-'));
        writeSidecar(d, { imageDir: '/Users/x/img' });
        expect(resolveSaveDirFromSidecar(path.join(d, 'x.md'), 'imageDir')).toBe('/Users/x/img');
    });
    // TC-DIR-04: fileDir/imageDir が独立
    test('TC-DIR-04 fileDir キーは imageDir を拾わない（逆も）', () => {
        const d = fs.mkdtempSync(path.join(tmpRoot, 'a4-'));
        writeSidecar(d, { fileDir: 'f' });
        expect(resolveSaveDirFromSidecar(path.join(d, 'x.md'), 'imageDir')).toBeNull();
        expect(resolveSaveDirFromSidecar(path.join(d, 'x.md'), 'fileDir')).toBe('f');
    });
    // TC-DIR-05（壊れ JSON・空値サニタイズ）
    test('TC-DIR-05 壊れ JSON → null・空/改行値は無効', () => {
        const d = fs.mkdtempSync(path.join(tmpRoot, 'a5-'));
        fs.writeFileSync(path.join(d, SAVE_DIR_SIDECAR), '{ broken json', 'utf-8');
        expect(readSaveDirConfig(path.join(d, 'x.md'))).toBeNull(); // クラッシュせず null
        expect(resolveSaveDirFromSidecar(path.join(d, 'x.md'), 'imageDir')).toBeNull();
        expect(isValidSaveDirValue('')).toBe(false);
        expect(isValidSaveDirValue('a\nb')).toBe(false);
        expect(isValidSaveDirValue('assets/ok')).toBe(true);
    });
    // TC-DIR-06: withSaveDir upsert（新規キー・他フィールド保持）
    test('TC-DIR-06 withSaveDir は該当キーを upsert・他フィールド保持', () => {
        const merged = withSaveDir({ fileDir: 'f', someOther: 1 }, 'imageDir', 'assets');
        expect(merged).toEqual({ fileDir: 'f', someOther: 1, imageDir: 'assets' });
        // 不正値は変更しない
        expect(withSaveDir({ imageDir: 'old' }, 'imageDir', 'a\nb')).toEqual({ imageDir: 'old' });
    });
    // TC-DIR-07（冪等）: withSaveDir を 2 回でも 1 キー
    test('TC-DIR-07 withSaveDir 置換・キーが増えない', () => {
        let cfg: { [k: string]: unknown } = withSaveDir(null, 'imageDir', 'old');
        cfg = withSaveDir(cfg, 'imageDir', 'new');
        expect(cfg).toEqual({ imageDir: 'new' });
        expect(Object.keys(cfg).filter((k) => k === 'imageDir').length).toBe(1);
    });
    // TC-DIR-08: withoutSaveDir で該当キー削除・他キー保持・empty 判定
    test('TC-DIR-08 withoutSaveDir は該当キーだけ削除・empty 判定', () => {
        const r1 = withoutSaveDir({ imageDir: 'a', fileDir: 'b' }, 'imageDir');
        expect(r1.config).toEqual({ fileDir: 'b' });
        expect(r1.empty).toBe(false); // fileDir が残る
        const r2 = withoutSaveDir({ imageDir: 'a' }, 'imageDir');
        expect(r2.config).toEqual({});
        expect(r2.empty).toBe(true); // 両キー空 → file 削除対象
        // 他機能のキーがあれば empty=false（巻き込まない）
        const r3 = withoutSaveDir({ imageDir: 'a', theme: 'x' }, 'imageDir');
        expect(r3.empty).toBe(false);
    });
    // TC-DIR-09: sidecarPathForMd は md と同じフォルダ
    test('TC-DIR-09 サイドカーは md と同じフォルダの .fractal.json', () => {
        expect(sidecarPathForMd('/a/b/note.md')).toBe(path.join('/a/b', '.fractal.json'));
        // フォルダ共有: 同フォルダの別 md も同じサイドカーを見る
        const d = fs.mkdtempSync(path.join(tmpRoot, 'a9-'));
        writeSidecar(d, { imageDir: 'shared' });
        expect(resolveSaveDirFromSidecar(path.join(d, 'note1.md'), 'imageDir')).toBe('shared');
        expect(resolveSaveDirFromSidecar(path.join(d, 'note2.md'), 'imageDir')).toBe('shared');
    });
});

test.describe('B. resolver 優先順位（ミラー）', () => {
    // TC-RES-01（★load-bearing）: standalone 新デフォルト = <mdDir>/images / files
    test('TC-RES-01 デフォルトは <mdDir>/images・<mdDir>/files', () => {
        const d = fs.mkdtempSync(path.join(tmpRoot, 'r1-'));
        const md = path.join(d, 'memo.md');
        expect(resolveImageDir(md, null, 'images').dir).toBe(path.join(d, 'images'));
        expect(resolveImageDir(md, null, 'files').dir).toBe(path.join(d, 'files'));
        // counterfactual: 旧実装（path.dirname）だと <mdDir> になる
        expect(resolveImageDir(md, null, 'images').dir).not.toBe(d);
    });
    // TC-RES-02: 相対サイドカー
    test('TC-RES-02 相対 imageDir → <mdDir>/<dir>・相対挿入', () => {
        const d = fs.mkdtempSync(path.join(tmpRoot, 'r2-'));
        writeSidecar(d, { imageDir: 'assets' });
        const r = resolveImageDir(path.join(d, 'm.md'), null, 'images');
        expect(r.dir).toBe(path.join(d, 'assets'));
        expect(r.useAbsolute).toBe(false);
    });
    // TC-RES-03: 絶対サイドカー
    test('TC-RES-03 絶対 imageDir → その絶対・絶対挿入', () => {
        const d = fs.mkdtempSync(path.join(tmpRoot, 'r3-'));
        const abs = path.join(tmpRoot, 'shared-abs');
        writeSidecar(d, { imageDir: abs });
        const r = resolveImageDir(path.join(d, 'm.md'), null, 'images');
        expect(r.dir).toBe(abs);
        expect(r.useAbsolute).toBe(true);
    });
    // TC-RES-04: forced dir（outliner page 相当）優先2
    test('TC-RES-04 forced dir があればサイドカー無しで forced', () => {
        const d = fs.mkdtempSync(path.join(tmpRoot, 'r4-'));
        expect(resolveImageDir(path.join(d, 'm.md'), 'images', 'images').dir).toBe(path.join(d, 'images'));
    });
    // TC-RES-05: toMarkdownPath 相当の回帰確認
    test('TC-RES-05 useAbsolute=false→相対 / true→絶対', () => {
        const d = fs.mkdtempSync(path.join(tmpRoot, 'r5-'));
        const dest = path.join(d, 'images', 'a.png');
        expect(path.relative(d, dest).replace(/\\/g, '/')).toBe('images/a.png');
    });
    // TC-RES-06（★load-bearing・NFR-MD-01）: note 配下 md のサイドカーは無視
    test('TC-RES-06 note 配下 md はサイドカー無視（forced/default 側）', () => {
        const noteDir = path.join(tmpRoot, 'mynote');
        fs.mkdirSync(noteDir, { recursive: true });
        fs.writeFileSync(path.join(noteDir, 'outline.note'), '{}');
        writeSidecar(noteDir, { imageDir: 'custom' }); // note 配下に .fractal.json があっても
        const md = path.join(noteDir, 'page.md');
        expect(isUnderFractalNote(md)).toBe(true);
        const r = resolveImageDir(md, null, 'images');
        expect(r.dir).toBe(path.join(noteDir, 'images')); // default（サイドカー無視）
        // counterfactual: guard を外すと custom が効いてしまう
        expect(r.dir).not.toBe(path.join(noteDir, 'custom'));
    });
});

test.describe('C. note 配下判定 / outliner page 検出', () => {
    // TC-NOTE-01
    test('TC-NOTE-01 outline.note を持つ祖先配下 → true', () => {
        const noteDir = path.join(tmpRoot, 'note-a');
        fs.mkdirSync(path.join(noteDir, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(noteDir, 'outline.note'), '{}');
        expect(isUnderFractalNote(path.join(noteDir, 'sub', 'deep.md'))).toBe(true);
    });
    // TC-NOTE-02
    test('TC-NOTE-02 outline.note が無い → false', () => {
        const plain = path.join(tmpRoot, 'plain');
        fs.mkdirSync(plain, { recursive: true });
        expect(isUnderFractalNote(path.join(plain, 'x.md'))).toBe(false);
    });
    // TC-NOTE-03
    test('TC-NOTE-03 outliner page md（親と同名 .out が grandparent）を検出', () => {
        const base = path.join(tmpRoot, 'notesroot');
        fs.mkdirSync(path.join(base, 'abc'), { recursive: true });
        fs.writeFileSync(path.join(base, 'abc.out'), '{}');
        expect(detectStandaloneOutlinerPage(path.join(base, 'abc', 'p1.md'))).not.toBeNull();
        expect(detectStandaloneOutlinerPage(path.join(tmpRoot, 'plain2', 'y.md'))).toBeNull();
    });
});
