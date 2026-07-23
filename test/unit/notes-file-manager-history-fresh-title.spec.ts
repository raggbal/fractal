/**
 * FR-HP（手動テスト起因・実装レベル）: 履歴パネルの表示 title を送出時に最新解決する。
 *
 * recordFileHistory は entry.title を記録時スナップショットで保存するため、
 * その後 title/H1 を変えると stale になる。getHistoryWithFreshTitles() は保存値を変えずに
 * 現在の title で再解決する。★reopen 2026-07-23: page-md kind 廃止。
 * note-md は items[id].title 優先、items に無い絶対パス md（page md / 他 note）は先頭 H1、out は .out data.title。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';

test.describe('NotesFileManager — getHistoryWithFreshTitles', () => {
    let tempDir: string;
    test.beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-hist-fresh-')); });
    test.afterEach(() => { if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); });

    // TC-HP-30: 記録後に title/H1 を変更 → fresh 解決で最新 title を返す（kind 別）
    test('TC-HP-30 note-md / out の title を最新解決', () => {
        const fm = new NotesFileManager(tempDir);

        // --- .out: 記録後に .out disk title を変更 ---
        const outPath = fm.createFile('OutOld');
        fm.recordFileHistory(outPath); // entry.title = 'OutOld'（スナップショット）
        fm.renameTitle(outPath, 'OutNew'); // .out disk data.title = 'OutNew'
        // --- note md: 記録後に items[id].title を変更 ---
        const mdPath = fm.createMarkdownFile('MdOld');
        fm.recordFileHistory(mdPath); // entry.title = 'MdOld'
        const mdId = path.basename(mdPath, '.md');
        (fm.getStructure().items[mdId] as any).title = 'MdNew';
        fm.saveStructure();

        const stored = fm.getHistory();
        const fresh = fm.getHistoryWithFreshTitles();

        // stored（保存値）は記録時のまま = 非破壊確認
        const storedOut = stored.find((e) => e.id === outPath)!;
        const storedMd = stored.find((e) => e.id === mdPath)!;
        expect(storedOut.title).toBe('OutOld');
        expect(storedMd.title).toBe('MdOld');

        // fresh は最新解決
        const freshOut = fresh.find((e) => e.id === outPath)!;
        const freshMd = fresh.find((e) => e.id === mdPath)!;
        expect(freshOut.title, '.out は disk data.title で最新解決').toBe('OutNew');
        expect(freshMd.title, 'note-md は items[id].title で最新解決').toBe('MdNew');
    });

    // TC-HP-30b（改訂 → TC-U-02）: items に無い絶対パス md（page md 相当）は md 先頭 H1 で最新解決
    // ★reopen 2026-07-23: page md も note-md（絶対パス）で記録。items に無いので H1 で live 再解決される
    //   （旧 page-md 分岐が持っていた live H1 解決を維持）。
    test('TC-U-02 items 外の絶対パス md（page md 相当）は md H1 で最新解決', () => {
        const fm = new NotesFileManager(tempDir);
        const outPath = fm.createFile('Host'); // page を持つ .out
        fm.openFile(outPath);
        // page md を用意（pageId=p1）→ note-md（絶対パス）で記録
        const pagePath = fm.getPageFilePath('p1');
        fs.mkdirSync(path.dirname(pagePath), { recursive: true });
        fs.writeFileSync(pagePath, '# PageOld\n\nbody', 'utf8');
        fm.recordFileHistory(pagePath); // kind='note-md'・id=絶対パス・entry.title = 'PageOld'
        // H1 を変更
        fs.writeFileSync(pagePath, '# PageNew\n\nbody', 'utf8');

        const fresh = fm.getHistoryWithFreshTitles().find((e) => e.kind === 'note-md' && e.id === pagePath)!;
        expect(fresh.title, 'items 外 md は md H1 で最新解決').toBe('PageNew');
        // 保存値は非破壊
        expect(fm.getHistory().find((e) => e.id === pagePath)!.title).toBe('PageOld');
    });

    // TC-U-02b（items 優先の順序）: tree item として存在する note-md は items[id].title を返し、H1 で上書きしない
    test('TC-U-02b tree item の note-md は items title 優先（H1 で上書きしない）', () => {
        const fm = new NotesFileManager(tempDir);
        const mdPath = fm.createMarkdownFile('TreeTitle'); // items に載る note md
        fm.recordFileHistory(mdPath);
        const mdId = path.basename(mdPath, '.md');
        (fm.getStructure().items[mdId] as any).title = 'TreeTitle';
        fm.saveStructure();
        // 本文 H1 を items title と違う値にしても、items 優先で tree title を返す
        fs.writeFileSync(mdPath, '# DifferentH1\n\nbody', 'utf8');

        const fresh = fm.getHistoryWithFreshTitles().find((e) => e.id === mdPath)!;
        expect(fresh.title, 'items ヒットは tree title を優先（H1 で誤上書きしない）').toBe('TreeTitle');
    });

    // TC-HP-32: getStructureForWebview() は history を fresh 解決した非破壊 clone を返す
    // （notesFileListChanged 全送出経路が使う単一ヘルパ。送出経路の取りこぼし防止）
    test('TC-HP-32 getStructureForWebview は fresh history + 非破壊', () => {
        const fm = new NotesFileManager(tempDir);
        const outPath = fm.createFile('SOld');
        fm.recordFileHistory(outPath);
        fm.renameTitle(outPath, 'SNew');
        const sfw = fm.getStructureForWebview();
        const entry = (sfw.history || []).find((e) => e.id === outPath)!;
        expect(entry.title, 'getStructureForWebview.history が fresh').toBe('SNew');
        // 保存値（getStructure().history）は非破壊
        expect(fm.getStructure().history!.find((e) => e.id === outPath)!.title).toBe('SOld');
        // items 等 structure の他フィールドは保持
        expect(sfw.items).toBeTruthy();
        expect(sfw.rootIds).toBeTruthy();
    });

    // TC-HP-31: 解決不可（ファイル無し等）は stored title / id にフォールバック
    test('TC-HP-31 解決不可は stored title フォールバック（非破壊）', () => {
        const fm = new NotesFileManager(tempDir);
        fm.createFile('Bootstrap'); // structure 初期化
        // 実在しない .out / md を履歴に手で積む（記録済みだがファイルが消えた状況）
        fm.pushHistory({ kind: 'out', id: path.join(tempDir, 'gone.out'), title: 'GoneTitle', ts: 1 });
        fm.pushHistory({ kind: 'note-md', id: path.join(tempDir, 'gone-page.md'), title: 'PageFallback', ts: 2 });

        const fresh = fm.getHistoryWithFreshTitles();
        expect(fresh.find((e) => e.id.endsWith('gone.out'))!.title, '解決不可 out は stored title').toBe('GoneTitle');
        expect(fresh.find((e) => e.id.endsWith('gone-page.md'))!.title, '解決不可 note-md は stored title').toBe('PageFallback');
    });
});
