/**
 * 2026-09-05 裁定 R37（reviewer iteration 8 / SEC-9 / SEC-10） — host 側の上限番人
 * TC-FRL-01 2001 ファイル → too_many で 0 件中断（部分登録なし）
 * TC-FRL-02 深さ 20 超 → too_deep で 0 件中断
 * TC-FRL-03 symlink 循環 → 有限停止（無限再帰でスタックオーバーフローしない）＝ 番人
 * TC-FRL-04 counterfactual: 上限内（200 ファイル / 深さ 19）は全件登録される
 * TC-FRL-05 dir URI 経路（registerExternalDroppedUris）は理由を failed[] に載せる
 * TC-FRL-06 expandDroppedPathsToFiles: 打ち切り / 深すぎを out で告知（黙って落とさない）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purge(): void { for (const k of Object.keys(require.cache)) { if (k.startsWith(SRC_PREFIX)) { delete require.cache[k]; } } }
function req(m: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module'); const o = Module._load; purge();
    Module._load = function (r: string) {
        if (r === 'vscode') { return { workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } }, Uri: { file: (p: string) => ({ fsPath: p }) }, commands: { executeCommand: () => {} }, window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: async () => undefined }, env: {}, ViewColumn: {}, EventEmitter: class {} }; }
        // eslint-disable-next-line prefer-rest-params
        return o.apply(this, arguments as any);
    };
    try { return require(m); } finally { Module._load = o; purge(); }
}
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
/** root 直下から dirs 段のディレクトリ鎖を作り、最深に 1 ファイル置く */
function chain(root: string, dirs: number): string {
    let cur = root;
    for (let i = 0; i < dirs; i++) { cur = path.join(cur, `d${i}`); }
    fs.mkdirSync(cur, { recursive: true });
    fs.writeFileSync(path.join(cur, 'leaf.txt'), 'x');
    return cur;
}

test('TC-FRL-01 registerFolderIntoTree: 2000 超のファイルは列挙段階で中断（0 件・部分登録なし）', () => {
    const mh = req('../../src/shared/notes-message-handler');
    const { NotesFileManager } = req('../../src/shared/notes-file-manager');
    const note = tmp('frl-note1-'); const src = tmp('frl-src1-');
    const big = path.join(src, 'big'); fs.mkdirSync(big);
    for (let i = 0; i < 2001; i++) { fs.writeFileSync(path.join(big, `f${i}.txt`), 'x'); }
    try {
        expect(mh.checkFolderRegisterLimits(big)).toBe('too_many');
        const fm = new NotesFileManager(note); fm.loadStructure();
        const itemsBefore = Object.keys(fm.getStructure().items).length;
        const out: any = {};
        const made = mh.registerFolderIntoTree(fm, big, null, 0, out);
        expect(made, '上限超過は 1 件も作らない（コピー 0 = 原状不変）').toBe(0);
        expect(out.limit).toBe('too_many');
        expect(Object.keys(fm.getStructure().items).length).toBe(itemsBefore);
        expect(fm.getStructure().rootIds).toEqual([]);
        expect(fs.existsSync(path.join(note, 'files')) ? fs.readdirSync(path.join(note, 'files')) : []).toEqual([]);
    } finally { fs.rmSync(note, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
});

test('TC-FRL-02 registerFolderIntoTree: 深さ 20 超は too_deep で 0 件中断', () => {
    const mh = req('../../src/shared/notes-message-handler');
    const { NotesFileManager } = req('../../src/shared/notes-file-manager');
    const note = tmp('frl-note2-'); const src = tmp('frl-src2-');
    const deep = path.join(src, 'deep'); fs.mkdirSync(deep);
    chain(deep, 20);   // deep 直下から 20 段 → walk 深さ 21 = 上限超過
    try {
        expect(mh.checkFolderRegisterLimits(deep)).toBe('too_deep');
        const fm = new NotesFileManager(note); fm.loadStructure();
        const out: any = {};
        expect(mh.registerFolderIntoTree(fm, deep, null, 0, out)).toBe(0);
        expect(out.limit).toBe('too_deep');
        expect(fm.getStructure().rootIds).toEqual([]);
    } finally { fs.rmSync(note, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
});

test('TC-FRL-03 番人: 祖先を指す symlink（循環）でも有限停止する — 無限再帰でクラッシュしない', () => {
    const mh = req('../../src/shared/notes-message-handler');
    const { NotesFileManager } = req('../../src/shared/notes-file-manager');
    const note = tmp('frl-note3-'); const src = tmp('frl-src3-');
    const root = path.join(src, 'cyc'); fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.md'), '# A\n');
    // sub/loop → cyc（祖先）。statSync は symlink を追うので、深さ上限が無いと無限再帰になる
    fs.symlinkSync(root, path.join(root, 'sub', 'loop'), 'dir');
    try {
        expect(mh.checkFolderRegisterLimits(root), '循環は深さが単調増加するので too_deep で停止').toBe('too_deep');
        const fm = new NotesFileManager(note); fm.loadStructure();
        const out: any = {};
        expect(mh.registerFolderIntoTree(fm, root, null, 0, out)).toBe(0);
        expect(out.limit).toBe('too_deep');
        expect(fm.getStructure().rootIds).toEqual([]);
    } finally { fs.rmSync(note, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
});

test('TC-FRL-04 counterfactual: 上限内（200 ファイル / 深さ 19）は全件そのまま登録される', () => {
    const mh = req('../../src/shared/notes-message-handler');
    const { NotesFileManager } = req('../../src/shared/notes-file-manager');
    const note = tmp('frl-note4-'); const src = tmp('frl-src4-');
    const flat = path.join(src, 'flat'); fs.mkdirSync(flat);
    for (let i = 0; i < 200; i++) { fs.writeFileSync(path.join(flat, `f${i}.txt`), 'x'); }
    const deep = path.join(src, 'ok-deep'); fs.mkdirSync(deep); chain(deep, 19);
    try {
        expect(mh.checkFolderRegisterLimits(flat)).toBe('ok');
        expect(mh.checkFolderRegisterLimits(deep)).toBe('ok');
        const fm = new NotesFileManager(note); fm.loadStructure();
        const out: any = {};
        expect(mh.registerFolderIntoTree(fm, flat, null, 0, out), 'フォルダ 1 + 200 ファイル').toBe(201);
        expect(out.limit).toBeUndefined();
        expect(mh.registerFolderIntoTree(fm, deep, null, 0, out), 'フォルダ 1 + 19 段 + leaf 1').toBe(21);
        expect(out.limit).toBeUndefined();
    } finally { fs.rmSync(note, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
});

test('TC-FRL-05 registerExternalDroppedUris(dir): 上限超過は failed[] に理由を載せる（無反応に見せない）', () => {
    const mh = req('../../src/shared/notes-message-handler');
    const { NotesFileManager } = req('../../src/shared/notes-file-manager');
    const note = tmp('frl-note5-'); const src = tmp('frl-src5-');
    const deep = path.join(src, 'deep'); fs.mkdirSync(deep); chain(deep, 20);
    try {
        const fm = new NotesFileManager(note); fm.loadStructure();
        const posted: any[] = [];
        const r = mh.registerExternalDroppedUris(fm, [`file://${deep}`], null, 0, { postMessage: (x: any) => posted.push(x) });
        expect(r.registered).toBe(0);
        expect(r.failed.length).toBe(1);
        expect(r.failed[0]).toContain('too deep');
        expect(fm.getStructure().rootIds).toEqual([]);
    } finally { fs.rmSync(note, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
});

test('TC-FRL-06 expandDroppedPathsToFiles: 打ち切り / 深すぎを out で告知する（黙って落とさない）', () => {
    const { expandDroppedPathsToFiles } = req('../../src/shared/drop-import');
    const d = tmp('frl-exp-');
    const many = path.join(d, 'many'); fs.mkdirSync(many);
    for (let i = 0; i < 5; i++) { fs.writeFileSync(path.join(many, `f${i}.txt`), 'x'); }
    const cyc = path.join(d, 'cyc'); fs.mkdirSync(path.join(cyc, 'sub'), { recursive: true });
    fs.symlinkSync(cyc, path.join(cyc, 'sub', 'loop'), 'dir');
    try {
        const o1: any = {};
        const files = expandDroppedPathsToFiles([many], 3, 20, o1);
        expect(files.length).toBe(3);
        expect(o1.truncated, '打ち切ったことを呼び出し側に返す').toBe(true);
        const o2: any = {};
        const okFiles = expandDroppedPathsToFiles([many], 2000, 20, o2);
        expect(okFiles.length).toBe(5); expect(o2.truncated).toBeUndefined(); expect(o2.tooDeep).toBeUndefined();
        const o3: any = {};
        expect(expandDroppedPathsToFiles([cyc], 2000, 20, o3), 'symlink 循環でも有限停止').toEqual([]);
        expect(o3.tooDeep).toBe(true);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
