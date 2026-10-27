/**
 * FR-HP-03: history クリックで再度開いた md が最上位に積まれる。
 * spec 20261027-1142-recent-history-nav D1: 旧「重複先頭移動」を supersede — 開いた順に積む（古い entry も残す）。
 *
 * ★reopen 2026-07-23: page-md kind 廃止。page md も note-md（絶対パス）で recordFileHistory 記録に統一。
 * ここでは FileManager 層で「同一 md（絶対パス）の再記録が最上位に積まれる（直前と同じときだけまとまる）」を検証する。
 * Recent クリックはメインペイン openFile → notesOpenFile → recordFileHistory を通る（旧 openPageFromHistory は廃止）。
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';

test.describe('NotesFileManager — history bump (md 再クリック)', () => {
    let tempDir: string;

    test.beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-hist-bump-'));
    });
    test.afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    // TC-HP-15: page md（絶対パス note-md）を記録 → 別種を記録して押し下げ → 同 md を再記録すると最上位へ戻る
    test('TC-HP-15 同一 md（絶対パス）の再記録は最上位に積まれる（D1）', () => {
        const fm = new NotesFileManager(tempDir);
        fm.createFile('A', null); // outline.note bootstrap

        const p1 = fm.getPageFilePath('p1'); // page md の絶対パス
        fs.mkdirSync(path.dirname(p1), { recursive: true });
        fs.writeFileSync(p1, '# Page One', 'utf8');
        const other = path.join(tempDir, 'other.md');
        fs.writeFileSync(other, '# Other', 'utf8');
        const p2 = fm.getPageFilePath('p2');
        fs.writeFileSync(p2, '# Page Two', 'utf8');

        // p1（page md）を記録（最上位）
        fm.recordFileHistory(p1, 'main');
        // 別のファイルを記録して p1 を押し下げる
        fm.recordFileHistory(other, 'main');
        fm.recordFileHistory(p2, 'main');

        let hist = fm.getHistory();
        // p1 は最上位ではない
        expect(hist[0].id).not.toBe(p1);
        expect(hist.filter((e) => e.kind === 'note-md' && e.id === p1).length).toBe(1);

        // p1 を再記録（= history から再クリック）→ 最上位に積まれる。
        // spec 20261027-1142-recent-history-nav D1（FR-HP-02 の重複先頭移動を supersede）: 開いた順の記録なので
        // 古い p1 も残る（p1 > p2 > other > p1）。直前と同じときだけ 1 件にまとまる
        fm.recordFileHistory(p1, 'main');
        hist = fm.getHistory();
        expect(hist[0].kind).toBe('note-md');
        expect(hist[0].id).toBe(p1);
        expect(hist.map((e) => e.id)).toEqual([p1, p2, other, p1]);
        fm.recordFileHistory(p1, 'main'); // 直前と同じ → まとまる
        expect(fm.getHistory().length).toBe(4);
    });

    // TC-HP-16: 別インスタンス再読込でも順序が保持される（永続化）
    test('TC-HP-16 再記録後の順序が outline.note に永続化される', () => {
        const fm1 = new NotesFileManager(tempDir);
        fm1.createFile('A', null);
        const p1 = fm1.getPageFilePath('p1');
        const p2 = fm1.getPageFilePath('p2');
        fs.mkdirSync(path.dirname(p1), { recursive: true });
        fs.writeFileSync(p1, '# One', 'utf8');
        fs.writeFileSync(p2, '# Two', 'utf8');
        fm1.recordFileHistory(p1, 'main');
        fm1.recordFileHistory(p2, 'side');
        fm1.recordFileHistory(p1, 'main'); // p1 が最上位に積まれる（D1: 古い p1 も残る）

        const fm2 = new NotesFileManager(tempDir);
        const hist = fm2.getHistory();
        expect(hist[0].id).toBe(p1);
        expect(hist.map((e) => e.id)).toEqual([p1, p2, p1]);
        expect(hist.map((e) => e.pane), 'pane も永続化される（D2）').toEqual(['main', 'side', 'main']);
    });
});
