/**
 * FR-MV-01/02: NotesFileManager.moveFileItemToOtherNote — 別 note フォルダへの物理移動
 *
 * - .out: <src>/<id>.out + pageDir <src>/<id>/ を dst へ丸ごと移動
 * - .md : <src>/_notes_md/<id>.md + 参照 images/files を dst へ移動
 * - 移動先 rootIds 先頭に登録、src からは除去、両 outline.note 整合
 * - id 衝突は dst で採番し直す
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';

test.describe('NotesFileManager — cross-note move', () => {
    let srcDir: string;
    let dstDir: string;

    test.beforeEach(() => {
        srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-move-src-'));
        dstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-move-dst-'));
    });
    test.afterEach(() => {
        for (const d of [srcDir, dstDir]) {
            if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
        }
    });

    // TC-MV-01: .out フォルダ丸ごと移動
    test('TC-MV-01 .out 本体 + pageDir を dst へ移動、src から消える', () => {
        const src = new NotesFileManager(srcDir);
        const outPath = src.createFile('Doc A', null);
        const id = path.basename(outPath, '.out');
        // pageDir に page ファイルを 1 つ置く
        const pageDir = path.join(srcDir, id);
        fs.writeFileSync(path.join(pageDir, 'p1.md'), '# page', 'utf8');

        const dst = new NotesFileManager(dstDir);
        dst.createFile('Existing', null); // dst に既存 item

        const newId = src.moveFileItemToOtherNote(id, dstDir);
        expect(newId).toBeTruthy();

        // dst に物理ファイルが存在
        expect(fs.existsSync(path.join(dstDir, `${newId}.out`))).toBe(true);
        expect(fs.existsSync(path.join(dstDir, newId as string, 'p1.md'))).toBe(true);
        // src から消えた
        expect(fs.existsSync(outPath)).toBe(false);
        expect(fs.existsSync(pageDir)).toBe(false);

        // 構造: dst 先頭に入り、src からは除去
        const dst2 = new NotesFileManager(dstDir);
        expect(dst2.getStructure().rootIds[0]).toBe(newId);
        const src2 = new NotesFileManager(srcDir);
        expect(src2.getStructure().items[id]).toBeUndefined();
    });

    // TC-MV-02: .md + 参照 image/file を移動
    test('TC-MV-02 .md 本体 + 参照 images/files を dst へ移動', () => {
        const src = new NotesFileManager(srcDir);
        const mdPath = src.createMarkdownFile('Note MD', null);
        const id = path.basename(mdPath, '.md');
        // md 本文が参照する image / file を配置
        const imgDir = path.join(srcDir, '_notes_md', 'images');
        const fileDir = path.join(srcDir, '_notes_md', 'files');
        fs.mkdirSync(imgDir, { recursive: true });
        fs.mkdirSync(fileDir, { recursive: true });
        fs.writeFileSync(path.join(imgDir, 'pic.png'), 'PNG', 'utf8');
        fs.writeFileSync(path.join(fileDir, 'doc.pdf'), 'PDF', 'utf8');
        // md 本文で参照させる (moveFileItemToOtherNote は本文参照分のみ移動)
        fs.writeFileSync(mdPath, '![](images/pic.png)\n[doc](files/doc.pdf)\n', 'utf8');

        const dst = new NotesFileManager(dstDir);
        dst.createFile('Existing', null);

        const newId = src.moveFileItemToOtherNote(id, dstDir);
        expect(newId).toBeTruthy();

        // dst に md + 参照アセットが移動
        expect(fs.existsSync(path.join(dstDir, '_notes_md', `${newId}.md`))).toBe(true);
        expect(fs.existsSync(path.join(dstDir, '_notes_md', 'images', 'pic.png'))).toBe(true);
        expect(fs.existsSync(path.join(dstDir, '_notes_md', 'files', 'doc.pdf'))).toBe(true);
        // src から md は消える
        expect(fs.existsSync(mdPath)).toBe(false);

        // dst 構造に md item (ext:'md') が先頭で登録
        const dst2 = new NotesFileManager(dstDir);
        const rootFirst = dst2.getStructure().rootIds[0];
        expect(rootFirst).toBe(newId);
        expect((dst2.getStructure().items[newId as string] as any).ext).toBe('md');
    });

    // TC-MV-03: id 衝突時の採番
    test('TC-MV-03 dst に同 id が存在する場合は採番し直す', () => {
        const src = new NotesFileManager(srcDir);
        const outPath = src.createFile('Doc', null);
        const id = path.basename(outPath, '.out');

        // dst に同じ id の item を人工的に作る (衝突を強制)
        const dst = new NotesFileManager(dstDir);
        const dstStructure = dst.getStructure();
        dstStructure.version = dstStructure.version || 1;
        dstStructure.items[id] = { type: 'file', id, title: 'collision' };
        dstStructure.rootIds.unshift(id);
        dst.saveStructure();
        // 実ファイルも置く
        fs.writeFileSync(path.join(dstDir, `${id}.out`), '{"title":"collision","rootIds":[],"nodes":{}}', 'utf8');

        const newId = src.moveFileItemToOtherNote(id, dstDir);
        expect(newId).toBeTruthy();
        expect(newId).not.toBe(id); // 採番し直された
        // 衝突元は保持され、新 id が別に存在
        const dst2 = new NotesFileManager(dstDir);
        expect(dst2.getStructure().items[id]).toBeDefined();       // 既存 collision
        expect(dst2.getStructure().items[newId as string]).toBeDefined(); // 移動分
        expect(dst2.getStructure().rootIds[0]).toBe(newId);        // 先頭に移動分
        expect(fs.existsSync(path.join(dstDir, `${newId}.out`))).toBe(true);
    });

    // folder item は対象外 (file のみ)
    test('TC-MV-03b folder item は移動対象外 (null を返す)', () => {
        const src = new NotesFileManager(srcDir);
        src.createFolder('Folder1', null);
        const folderId = Object.keys(src.getStructure().items).find(
            k => src.getStructure().items[k].type === 'folder'
        )!;
        const r = src.moveFileItemToOtherNote(folderId, dstDir);
        expect(r).toBeNull();
    });
});
