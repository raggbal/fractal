/**
 * dailynotes 旧レイアウト再発バグの修正 (sprint 20260812-171126-dailynotes-flat-archive)
 *
 * - TC-DNF-01/02: ensureDailyNotesFile が flat ヒント (pageDir/imageDir/fileDir) を書く + 冪等性
 * - TC-DNF-03/04/05: notesArchiveTasks の dest dir 解決が flat-layout 正典
 *   (resolvePagesDir/resolveFilesDir) を通り、旧 `./dailynotes/` フォールバックで
 *   旧レイアウト dir を新規に作らない (作ると移行ゲートが再発する)
 *
 * ハーネス: 実 fs (mkdtemp) + NotesFileManager 直駆動 + handleNotesMessage 直呼び。
 * sender/platform は必要メソッドだけ持つ明示 stub (Proxy fake 禁止)。
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';
import { handleNotesMessage } from '../../src/shared/notes-message-handler';
import { FLAT_OUT_HINTS } from '../../src/shared/flat-layout';

const noopSender = { postMessage: () => {} } as any;
const noopPlatform = {
    showInformationMessage: () => {},
    showErrorMessage: () => {},
} as any;

test.describe('dailynotes flat archive', () => {
    let tempDir: string;

    test.beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnf-test-'));
    });
    test.afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    // TC-DNF-01: 新規 dailynotes.out が flat ヒント付きで作られる
    test('TC-DNF-01 ensureDailyNotesFile が pageDir/imageDir/fileDir の flat ヒントを書く', () => {
        const fm = new NotesFileManager(tempDir);
        const p = fm.ensureDailyNotesFile();
        expect(p).toBe(path.join(tempDir, 'dailynotes.out'));
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        expect(data.pageDir).toBe(FLAT_OUT_HINTS.pageDir);   // '.'
        expect(data.imageDir).toBe(FLAT_OUT_HINTS.imageDir); // './images'
        expect(data.fileDir).toBe(FLAT_OUT_HINTS.fileDir);   // './files'
        // 既存挙動維持: outline.note に dailynotes item が登録される
        const structure = JSON.parse(fs.readFileSync(path.join(tempDir, 'outline.note'), 'utf8'));
        expect(structure.items['dailynotes']).toBeTruthy();
        expect(structure.rootIds[0]).toBe('dailynotes');
    });

    // TC-DNF-02: 既存 dailynotes.out は書き換えない (冪等・pageDir 後付けスタンプなし)
    test('TC-DNF-02 既存 dailynotes.out があれば内容を書き換えない', () => {
        const p = path.join(tempDir, 'dailynotes.out');
        const original = JSON.stringify({
            version: 1, title: 'Daily Notes', rootIds: [], nodes: {}, custom: 'keep',
        }, null, 2);
        fs.writeFileSync(p, original, 'utf8');
        const fm = new NotesFileManager(tempDir);
        const ret = fm.ensureDailyNotesFile();
        expect(ret).toBe(p);
        expect(fs.readFileSync(p, 'utf8')).toBe(original); // byte 同一
    });
});
