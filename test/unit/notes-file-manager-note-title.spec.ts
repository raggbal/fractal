/**
 * FR-NT-01/02: NotesFileManager の note フォルダタイトル (noteTitle) 永続化
 *
 * outline.note の root フィールド noteTitle に note フォルダ全体のタイトルを保存・取得する。
 * 未設定時は path.basename(mainFolderPath) にフォールバック (後方互換, FR-NT-01)。
 * 空文字で確定するとクリア (= フォルダ名表示に戻る, FR-NT-02)。
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';

test.describe('NotesFileManager — note title', () => {
    let tempDir: string;

    test.beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-title-test-'));
    });
    test.afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    // TC-NT-01: setNoteTitle → getNoteTitle 往復 + 空クリア
    test('TC-NT-01 setNoteTitle→getNoteTitle 往復 + 空でクリアするとフォルダ名に戻る', () => {
        const fm = new NotesFileManager(tempDir);
        fm.createFile('A', null); // outline.note bootstrap

        // 既定はフォルダ名 (basename)
        expect(fm.getNoteTitle()).toBe(path.basename(tempDir));
        expect(fm.getRawNoteTitle()).toBeUndefined();

        fm.setNoteTitle('My Note');
        expect(fm.getNoteTitle()).toBe('My Note');
        expect(fm.getRawNoteTitle()).toBe('My Note');
        // outline.note に永続化
        const parsed = JSON.parse(fs.readFileSync(path.join(tempDir, 'outline.note'), 'utf8'));
        expect(parsed.noteTitle).toBe('My Note');

        // 空でクリア → フォルダ名に戻る
        fm.setNoteTitle('');
        expect(fm.getNoteTitle()).toBe(path.basename(tempDir));
        expect(fm.getRawNoteTitle()).toBeUndefined();
        const parsed2 = JSON.parse(fs.readFileSync(path.join(tempDir, 'outline.note'), 'utf8'));
        expect(parsed2.noteTitle).toBeUndefined();
    });

    // TC-NT-01b: 別インスタンスで再読込しても保持
    test('TC-NT-01b 保存後、別インスタンスで再読込しても noteTitle が保持される', () => {
        const fm1 = new NotesFileManager(tempDir);
        fm1.createFile('A', null);
        fm1.setNoteTitle('Persisted Title');

        const fm2 = new NotesFileManager(tempDir);
        expect(fm2.getNoteTitle()).toBe('Persisted Title');
        expect(fm2.getRawNoteTitle()).toBe('Persisted Title');
    });

    // TC-NT-02: 後方互換 — noteTitle 無しの outline.note で basename
    test('TC-NT-02 後方互換: noteTitle フィールドの無い outline.note では basename を返す', () => {
        // noteTitle を持たない最小 outline.note を直接書く
        const structure = { version: 1, rootIds: [], items: {} };
        fs.writeFileSync(path.join(tempDir, 'outline.note'), JSON.stringify(structure), 'utf8');

        const fm = new NotesFileManager(tempDir);
        expect(fm.getNoteTitle()).toBe(path.basename(tempDir));
        expect(fm.getRawNoteTitle()).toBeUndefined();
    });

    // 空白のみのタイトルはフォールバック扱い
    test('TC-NT-02b 空白のみのタイトルは basename にフォールバックする', () => {
        const fm = new NotesFileManager(tempDir);
        fm.createFile('A', null);
        fm.setNoteTitle('   ');
        expect(fm.getNoteTitle()).toBe(path.basename(tempDir));
        expect(fm.getRawNoteTitle()).toBeUndefined();
    });
});
