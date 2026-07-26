/**
 * FR-TH-01/02/03: NotesFileManager の tree title ↔ md 先頭 H1 同期
 *
 * - renameTitle('<id>.md', t): items[id].title 更新 + md 先頭 H1 を t に同期（本文保持・H1 無ければ挿入）
 * - syncTitleFromH1(filePath, content): content 先頭 H1 を items[id].title に反映（冪等・H1 無しは維持）
 * - .out は従来通り（H1 挿入しない）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';

test.describe('NotesFileManager — title ↔ H1', () => {
    let tempDir: string;
    test.beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-title-h1-')); });
    test.afterEach(() => { if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); });

    // TC-TH-03: rename → items title + md 先頭 H1 書換（本文保持）
    test('TC-TH-03 renameTitle(.md) で items.title と md 先頭 H1 が New に', () => {
        const fm = new NotesFileManager(tempDir);
        const filePath = fm.createMarkdownFile('Old'); // # Old\n
        const id = path.basename(filePath, '.md');
        // 本文を足す（保持されることを確認するため）
        fs.writeFileSync(filePath, '# Old\n\nbody line\n## Sub', 'utf8');

        fm.renameTitle(filePath, 'New');

        // (a) tree title
        expect((fm.getStructure().items[id] as any).title).toBe('New');
        // (b) md 先頭 H1 が書き換わり、本文と ## Sub は保持
        const body = fs.readFileSync(filePath, 'utf8');
        expect(body).toBe('# New\n\nbody line\n## Sub');
    });

    // TC-TH-03b: H1 無し md → 先頭に挿入 + 本文保持
    test('TC-TH-03b renameTitle H1 無しは先頭に # New 挿入・本文保持', () => {
        const fm = new NotesFileManager(tempDir);
        const filePath = fm.createMarkdownFile('X');
        const id = path.basename(filePath, '.md');
        fs.writeFileSync(filePath, 'body only\nno heading', 'utf8');

        fm.renameTitle(filePath, 'New');

        expect((fm.getStructure().items[id] as any).title).toBe('New');
        expect(fs.readFileSync(filePath, 'utf8')).toBe('# New\n\nbody only\nno heading');
    });

    // TC-TH-03c: .out は H1 挿入しない（JSON title のみ・回帰）
    test('TC-TH-03c renameTitle(.out) は JSON title のみ更新・H1 挿入しない', () => {
        const fm = new NotesFileManager(tempDir);
        const outPath = fm.createFile('OutOld'); // .out 作成
        const id = path.basename(outPath, '.out');

        fm.renameTitle(outPath, 'OutNew');

        const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        expect(data.title).toBe('OutNew');
        // JSON なので markdown H1 (# ...) の行は入らない
        expect(fs.readFileSync(outPath, 'utf8')).not.toContain('\n# OutNew');
        expect((fm.getStructure().items[id] as any).title).toBe('OutNew');
    });

    // TC-TH-04: syncTitleFromH1 で items.title 更新 + return true / H1 無しは維持+false
    test('TC-TH-04 syncTitleFromH1 先頭 H1 を title に反映（H1 無しは維持）', () => {
        const fm = new NotesFileManager(tempDir);
        const filePath = fm.createMarkdownFile('Init');
        const id = path.basename(filePath, '.md');

        expect(fm.syncTitleFromH1(filePath, '# H1Title\n\nbody')).toBe(true);
        expect((fm.getStructure().items[id] as any).title).toBe('H1Title');

        // H1 消失 content → title 維持 + false
        expect(fm.syncTitleFromH1(filePath, 'body without heading')).toBe(false);
        expect((fm.getStructure().items[id] as any).title).toBe('H1Title');
    });

    // TC-TH-04b: 冪等 — title が既に H1 と同じなら false
    test('TC-TH-04b syncTitleFromH1 冪等: 同じなら false', () => {
        const fm = new NotesFileManager(tempDir);
        const filePath = fm.createMarkdownFile('Same');
        expect(fm.syncTitleFromH1(filePath, '# Same\n\nbody')).toBe(false); // 既に Same
    });

    // TC-TH-04c: structure.items に無い id（subpage/pages 配下）→ false
    test('TC-TH-04c tree item でない md は対象外 (false)', () => {
        const fm = new NotesFileManager(tempDir);
        fm.createMarkdownFile('Real'); // bootstrap structure
        const orphan = path.join(tempDir, 'not-a-tree-item.md');
        fs.writeFileSync(orphan, '# Ghost\n', 'utf8');
        expect(fm.syncTitleFromH1(orphan, '# Ghost\n')).toBe(false);
    });

    // TC-TH-22: syncOutTitleToTree — .out の title 変更を tree（items[id].title）へ即反映
    // （outliner title 変更が md H1 編集と同様に tree へすぐ反映される。手動テスト起因の非対称是正）
    test('TC-TH-22 syncOutTitleToTree で .out title を items.title に反映（冪等・変化時 true）', () => {
        const fm = new NotesFileManager(tempDir);
        const outPath = fm.createFile('OldOut'); // .out 作成 + currentFilePath セット
        const id = path.basename(outPath, '.out');
        // openFile で currentFilePath を対象 .out にする（syncData は開いている .out が対象）
        fm.openFile(outPath);

        // outliner が title 変更して送る syncData を模擬: saveCurrentFile（debounce 1000ms）→ disk はまだ旧 title
        const newJson = JSON.stringify({ rootIds: [], nodes: {}, title: 'NewOut' });
        fm.saveCurrentFile(newJson);
        // outliner が送る .out JSON（title 変更あり）
        const changed = fm.syncOutTitleToTree(newJson);
        expect(changed).toBe(true);
        expect((fm.getStructure().items[id] as any).title).toBe('NewOut');
        // ★1テンポ遅れの真因修正: main tree の表示元 listFiles()（.out disk title を読む）が
        // flush 済みで即 NewOut を返す（items[id].title ではなく listFiles が表示元）。
        const listed = fm.listFiles().find((f) => f.id === id);
        expect(listed?.title, 'listFiles（main tree 表示元）が flush 後の新 title を返す').toBe('NewOut');

        // 冪等: 同じ title なら false（再描画しない）
        expect(fm.syncOutTitleToTree(JSON.stringify({ title: 'NewOut' }))).toBe(false);

        // title フィールドが無い JSON → false（title 変更なし）
        expect(fm.syncOutTitleToTree(JSON.stringify({ rootIds: [], nodes: {} }))).toBe(false);
    });

    // TC-TH-22b: 開いているのが .md の時は syncOutTitleToTree 対象外（.out 専用経路）
    test('TC-TH-22b .md を開いている時は syncOutTitleToTree は false', () => {
        const fm = new NotesFileManager(tempDir);
        const mdPath = fm.createMarkdownFile('MdFile');
        fm.openFile(mdPath);
        expect(fm.syncOutTitleToTree(JSON.stringify({ title: 'X' }))).toBe(false);
    });
});
