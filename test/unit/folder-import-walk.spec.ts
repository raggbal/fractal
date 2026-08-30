/**
 * Sprint 20260827-172802 TASK-02 — FR-OIF-02/03: DOM-FolderImportWalk（pure 再帰列挙）
 * TC-OIF-01: 階層 entries 形・隠し/symlink 除外・件数集計
 * TC-OIF-02: 上限（maxFiles 2000 / maxDepth 20）超過は列挙段階で中断（コピー 0 = 原状不変）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { walkFolderForImport, FOLDER_IMPORT_MAX_FILES, FOLDER_IMPORT_MAX_DEPTH, FOLDER_IMPORT_CONFIRM_THRESHOLD } from '../../src/shared/folder-import';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fimp-'));

test.describe('DOM-FolderImportWalk（FR-OIF-02/03）', () => {

    test('TC-OIF-01: 階層 entries・隠し/symlink 除外・フォルダ先行名前昇順・件数', () => {
        const root = mk();
        fs.writeFileSync(path.join(root, 'a.md'), '# a');
        fs.writeFileSync(path.join(root, '.hidden'), 'x');
        fs.mkdirSync(path.join(root, '.hiddendir'));
        const outside = mk();
        fs.writeFileSync(path.join(outside, 'target.txt'), 'x');
        fs.symlinkSync(path.join(outside, 'target.txt'), path.join(root, 'link.txt'));
        fs.mkdirSync(path.join(root, 'sub', 'c'), { recursive: true });
        fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'B');
        fs.writeFileSync(path.join(root, 'zzz.pdf'), 'P');

        const r = walkFolderForImport(root);
        expect(r.ok).toBe(true);
        if (!r.ok) { return; }
        // root 直下: フォルダ先行・名前昇順 → [sub(dir), a.md, zzz.pdf]（隠し 2 + symlink は除外）
        expect(r.entries.map((e: any) => e.name)).toEqual(['sub', 'a.md', 'zzz.pdf']);
        expect(r.entries[0].kind).toBe('dir');
        const sub: any = r.entries[0];
        expect(sub.children.map((e: any) => e.name)).toEqual(['c', 'b.txt']);
        expect(sub.children[0].kind).toBe('dir');
        expect(sub.children[0].children).toEqual([]); // 空フォルダ
        expect(sub.children[1].kind).toBe('file');
        const md: any = r.entries[1];
        expect(md.kind).toBe('md');
        expect(md.absPath).toBe(path.join(root, 'a.md'));
        expect(r.fileCount, 'ファイル数（md 含む）').toBe(3);
        expect(r.totalCount, 'ファイル + フォルダ').toBe(5);
        // 定数の系譜 pin（fv-residual-refs と同値 + 200 閾値）
        expect(FOLDER_IMPORT_MAX_FILES).toBe(2000);
        expect(FOLDER_IMPORT_MAX_DEPTH).toBe(20);
        expect(FOLDER_IMPORT_CONFIRM_THRESHOLD).toBe(200);
    });

    test('TC-OIF-09: 読めないサブディレクトリは件数として可視化される（silent 消失させない）', () => {
        const root = mk();
        fs.writeFileSync(path.join(root, 'ok.txt'), 'OK');
        const locked = path.join(root, 'locked');
        fs.mkdirSync(locked);
        fs.writeFileSync(path.join(locked, 'inner.txt'), 'HIDDEN');
        fs.chmodSync(locked, 0o000);
        let listable = true;
        try { fs.readdirSync(locked); } catch { listable = false; }
        expect(listable, 'fixture 前提: chmod 000 の dir が列挙不能（root 実行では成立しない）').toBe(false);

        const r = walkFolderForImport(root);
        expect(r.ok, '読めない dir があっても列挙自体は成功扱い').toBe(true);
        if (!r.ok) { return; }
        // dir node 自体は残す（フォルダの存在は再現する）が、中身が落ちたことを件数で伝える
        expect(r.entries.map((e: any) => e.name)).toEqual(['locked', 'ok.txt']);
        expect((r.entries[0] as any).children, '読めない dir の children は空').toEqual([]);
        expect(r.unreadableDirs, '読めなかった dir を数える（skip 集計の材料）').toBe(1);

        // 読める構成では 0（カウンタが常時 1 になっていないことの pin）
        const clean = mk();
        fs.mkdirSync(path.join(clean, 'sub'));
        fs.writeFileSync(path.join(clean, 'sub', 'x.txt'), 'x');
        const c = walkFolderForImport(clean);
        expect(c.ok).toBe(true);
        if (c.ok) { expect(c.unreadableDirs).toBe(0); }
    });

    test('TC-OIF-09: 並びは fv listing（readFolderEntriesAt）と同じ case-insensitive 昇順', () => {
        // 素の ASCII 昇順なら ['B.txt','C.txt','a.txt'] になる（大文字が先）。
        // precedent（notes-message-handler.ts readFolderEntriesAt）は toLowerCase 比較なので a が先頭に来る。
        const root = mk();
        for (const n of ['B.txt', 'a.txt', 'C.txt']) { fs.writeFileSync(path.join(root, n), 'x'); }
        fs.mkdirSync(path.join(root, 'Zdir'));
        fs.mkdirSync(path.join(root, 'adir'));

        const r = walkFolderForImport(root);
        expect(r.ok).toBe(true);
        if (!r.ok) { return; }
        expect(r.entries.map((e: any) => e.name), 'フォルダ先行 + 大小文字を無視した昇順')
            .toEqual(['adir', 'Zdir', 'a.txt', 'B.txt', 'C.txt']);
    });

    test('TC-OIF-02: maxFiles/maxDepth 超過は {ok:false} で中断（entries を返さない）', () => {
        // too_many: 上限は注入可能（実 2001 ファイル生成を避ける — 既定値の pin は TC-OIF-01 で済み）
        const root = mk();
        for (let i = 0; i < 12; i++) { fs.writeFileSync(path.join(root, `f${String(i).padStart(2, '0')}.txt`), 'x'); }
        const many = walkFolderForImport(root, { maxFiles: 10 });
        expect(many.ok).toBe(false);
        if (!many.ok) { expect(many.error).toBe('too_many'); }

        // too_deep: 21 階層
        const droot = mk();
        let cur = droot;
        for (let d = 0; d < 21; d++) { cur = path.join(cur, `d${d}`); fs.mkdirSync(cur); }
        fs.writeFileSync(path.join(cur, 'deep.txt'), 'x');
        const deep = walkFolderForImport(droot, { maxDepth: FOLDER_IMPORT_MAX_DEPTH });
        expect(deep.ok).toBe(false);
        if (!deep.ok) { expect(deep.error).toBe('too_deep'); }

        // 既定上限でも実 2001 ファイルで too_many（統合の実測 1 本 — 生成は 1 dir フラット）
        const bigRoot = mk();
        for (let i = 0; i < 2001; i++) { fs.writeFileSync(path.join(bigRoot, `g${i}.txt`), ''); }
        const big = walkFolderForImport(bigRoot);
        expect(big.ok).toBe(false);
        if (!big.ok) { expect(big.error).toBe('too_many'); }
    });
});
