/**
 * FR-HP-03: history クリックで sidepanel md (page-md) も最上位へ移動する
 *
 * バグ: history の page-md をクリックして再度開いても最上位に来なかった。
 * 原因: openPageFromHistory 経路が recordPageHistory を呼んでいなかった
 *       (openPageInSidePanel / notesOpenFile は呼んでいた)。
 * ここでは FileManager 層で「同一 page-md の再記録が最上位への移動になる (重複しない)」
 * を検証する。message-handler の openPageFromHistory 経路がこの API を呼ぶよう修正済み。
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';

test.describe('NotesFileManager — history bump (page-md 再クリック)', () => {
    let tempDir: string;

    test.beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-hist-bump-'));
    });
    test.afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    // TC-HP-15: page-md を記録 → 別種を記録して押し下げ → 同 page-md を再記録すると最上位へ戻る
    test('TC-HP-15 同一 page-md の再記録は重複せず最上位へ移動する', () => {
        const fm = new NotesFileManager(tempDir);
        fm.createFile('A', null); // outline.note bootstrap

        // page-md を記録（最上位）
        fm.recordPageHistory('p1', 'Page One');
        // 別のファイルを記録して p1 を押し下げる
        fm.recordFileHistory(fm.getPageFilePath('p1').replace(/pages.*$/, 'other.md')); // 任意の別 id
        fm.recordPageHistory('p2', 'Page Two');

        let hist = fm.getHistory();
        // p1 は最上位ではない
        expect(hist[0].id).not.toBe('p1');
        expect(hist.filter((e) => e.kind === 'page-md' && e.id === 'p1').length).toBe(1);

        // p1 を再記録（= history から再クリック）→ 最上位へ、重複しない
        fm.recordPageHistory('p1', 'Page One');
        hist = fm.getHistory();
        expect(hist[0].kind).toBe('page-md');
        expect(hist[0].id).toBe('p1');
        // 重複していない（p1 は 1 件のみ）
        expect(hist.filter((e) => e.kind === 'page-md' && e.id === 'p1').length).toBe(1);
    });

    // TC-HP-16: 別インスタンス再読込でも順序が保持される（永続化）
    test('TC-HP-16 再記録後の順序が outline.note に永続化される', () => {
        const fm1 = new NotesFileManager(tempDir);
        fm1.createFile('A', null);
        fm1.recordPageHistory('p1', 'One');
        fm1.recordPageHistory('p2', 'Two');
        fm1.recordPageHistory('p1', 'One'); // p1 を最上位へ

        const fm2 = new NotesFileManager(tempDir);
        const hist = fm2.getHistory();
        expect(hist[0].id).toBe('p1');
        expect(hist.filter((e) => e.kind === 'page-md' && e.id === 'p1').length).toBe(1);
    });
});
