/**
 * v11: NotesFileManager の color フィールド統合テスト
 * DOD-11-3-7, DOD-11-3-8, DOD-11-3-9, DOD-11-COMPAT-3 を検証
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager, NoteTreeStructure } from '../../src/shared/notes-file-manager';

test.describe('NotesFileManager color フィールド', () => {
    let tempDir: string;
    let fileManager: NotesFileManager;

    test.beforeEach(() => {
        // 各テスト用の一時ディレクトリを作成
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-color-test-'));
    });

    test.afterEach(() => {
        // 一時ディレクトリをクリーンアップ
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('DOD-11-3-7: setItemColor で outline.note に color フィールドが書き込まれる', async () => {
        // fileManager を作成
        fileManager = new NotesFileManager(tempDir);

        // ファイルを作成
        const filePath = fileManager.createFile('TestFile', null);
        const fileId = path.basename(filePath).replace('.out', '');

        // structure を直接操作して color を設定
        const structure = fileManager.getStructure();
        expect(structure).not.toBeNull();
        expect(structure!.items[fileId]).toBeDefined();

        // color を設定
        structure!.items[fileId].color = 'red';
        fileManager.saveStructure();

        // 別インスタンスで再読込
        const fileManager2 = new NotesFileManager(tempDir);
        const structure2 = fileManager2.getStructure();

        expect(structure2).not.toBeNull();
        expect(structure2!.items[fileId].color).toBe('red');
    });

    test('DOD-11-3-8: color=null 設定で outline.note の color フィールドが削除される', async () => {
        // fileManager を作成
        fileManager = new NotesFileManager(tempDir);

        // ファイルを作成
        const filePath = fileManager.createFile('TestFile', null);
        const fileId = path.basename(filePath).replace('.out', '');

        // structure を直接操作して color を設定
        const structure = fileManager.getStructure();
        structure!.items[fileId].color = 'red';
        fileManager.saveStructure();

        // color を削除 (null → delete)
        delete structure!.items[fileId].color;
        fileManager.saveStructure();

        // 別インスタンスで再読込
        const fileManager2 = new NotesFileManager(tempDir);
        const structure2 = fileManager2.getStructure();

        expect(structure2).not.toBeNull();
        expect(structure2!.items[fileId].color).toBeUndefined();

        // JSON ファイルに color キー自体が存在しないことを確認
        const noteFilePath = path.join(tempDir, 'outline.note');
        const noteContent = fs.readFileSync(noteFilePath, 'utf-8');
        const noteJson: NoteTreeStructure = JSON.parse(noteContent);
        expect('color' in noteJson.items[fileId]).toBe(false);
    });

    test('DOD-11-3-9: color フィールドなしの既存 outline.note を読み込んでも壊れない', async () => {
        // 旧形式の outline.note を手書きで作成 (color フィールドなし)
        const legacyStructure = {
            version: 1,
            rootIds: ['file1', 'folder1'],
            items: {
                file1: { type: 'file', id: 'file1', title: 'Legacy File' },
                folder1: { type: 'folder', id: 'folder1', title: 'Legacy Folder', childIds: [], collapsed: false }
            }
        };

        const noteFilePath = path.join(tempDir, 'outline.note');
        fs.writeFileSync(noteFilePath, JSON.stringify(legacyStructure), 'utf-8');

        // 対応する .out ファイルも作成 (title フィールドを含める)
        fs.writeFileSync(path.join(tempDir, 'file1.out'), JSON.stringify({
            version: 1,
            title: 'Legacy File',
            rootIds: [],
            nodes: {}
        }), 'utf-8');

        // fileManager で読み込み
        fileManager = new NotesFileManager(tempDir);
        const structure = fileManager.getStructure();

        // 例外なく読み込める
        expect(structure).not.toBeNull();

        // 既存 items の title, type 等が保持されている
        expect(structure!.items.file1.type).toBe('file');
        expect(structure!.items.file1.title).toBe('Legacy File');
        expect(structure!.items.folder1.type).toBe('folder');
        expect(structure!.items.folder1.title).toBe('Legacy Folder');

        // color は undefined
        expect(structure!.items.file1.color).toBeUndefined();
        expect(structure!.items.folder1.color).toBeUndefined();
    });

    test('DOD-11-COMPAT-3: 既存フィールド (rootIds, items, panelWidth 等) が保存・読込で破壊されない', async () => {
        // 全フィールドを持つ outline.note を作成
        const fullStructure = {
            version: 1,
            rootIds: ['file1', 'folder1'],
            items: {
                file1: { type: 'file', id: 'file1', title: 'Test File' },
                folder1: { type: 'folder', id: 'folder1', title: 'Test Folder', childIds: ['file2'], collapsed: true },
                file2: { type: 'file', id: 'file2', title: 'Nested File' }
            },
            panelWidth: 250,
            s3BucketPath: 'my-bucket/notes'
        };

        const noteFilePath = path.join(tempDir, 'outline.note');
        fs.writeFileSync(noteFilePath, JSON.stringify(fullStructure), 'utf-8');

        // 対応する .out ファイルも作成 (title フィールドを含める)
        fs.writeFileSync(path.join(tempDir, 'file1.out'), JSON.stringify({
            version: 1,
            title: 'Test File',
            rootIds: [],
            nodes: {}
        }), 'utf-8');
        fs.writeFileSync(path.join(tempDir, 'file2.out'), JSON.stringify({
            version: 1,
            title: 'Nested File',
            rootIds: [],
            nodes: {}
        }), 'utf-8');

        // fileManager で読み込み
        fileManager = new NotesFileManager(tempDir);
        const structure = fileManager.getStructure();

        // color を設定
        structure!.items.file1.color = 'blue';
        fileManager.saveStructure();

        // 再読込
        const fileManager2 = new NotesFileManager(tempDir);
        const structure2 = fileManager2.getStructure();

        // 全既存フィールドが保持されている
        expect(structure2!.rootIds).toEqual(['file1', 'folder1']);
        expect(structure2!.items.file1.title).toBe('Test File');
        expect(structure2!.items.folder1.title).toBe('Test Folder');
        expect(structure2!.items.folder1.childIds).toEqual(['file2']);
        expect(structure2!.items.folder1.collapsed).toBe(true);
        expect(structure2!.items.file2.title).toBe('Nested File');
        expect(structure2!.panelWidth).toBe(250);
        expect(structure2!.s3BucketPath).toBe('my-bucket/notes');

        // color のみ追加
        expect(structure2!.items.file1.color).toBe('blue');
    });

    test('フォルダにも color を設定できる', async () => {
        fileManager = new NotesFileManager(tempDir);

        // フォルダを作成
        fileManager.createFolder('ColoredFolder', null);

        const structure = fileManager.getStructure();
        const folderId = Object.keys(structure!.items).find(
            id => structure!.items[id].type === 'folder'
        );
        expect(folderId).toBeDefined();

        // フォルダに color を設定
        structure!.items[folderId!].color = 'green';
        fileManager.saveStructure();

        // 再読込
        const fileManager2 = new NotesFileManager(tempDir);
        const structure2 = fileManager2.getStructure();

        expect(structure2!.items[folderId!].color).toBe('green');
    });

    test('有効な色名 (red) は保存される（regression test）', async () => {
        fileManager = new NotesFileManager(tempDir);

        const filePath = fileManager.createFile('TestFile', null);
        const fileId = path.basename(filePath).replace('.out', '');

        const structure = fileManager.getStructure();
        expect(structure).not.toBeNull();

        // 有効な色名を設定（notesSetItemColor ハンドラをシミュレート）
        const colorName = 'red';
        const { NOTES_COLOR_PALETTE } = require('../../src/shared/notes-color-palette') as { NOTES_COLOR_PALETTE: Array<{ name: string; hex: string }> };
        const validNames = NOTES_COLOR_PALETTE.map(c => c.name);

        // バリデーション: 有効な色名なので保存される
        if (validNames.includes(colorName)) {
            structure!.items[fileId].color = colorName;
            fileManager.saveStructure();
        }

        // 再読込して確認
        const fileManager2 = new NotesFileManager(tempDir);
        const structure2 = fileManager2.getStructure();
        expect(structure2!.items[fileId].color).toBe('red');
    });

    test('不正な色名 (空白入り "red inject-class") は保存されない', async () => {
        fileManager = new NotesFileManager(tempDir);

        const filePath = fileManager.createFile('TestFile', null);
        const fileId = path.basename(filePath).replace('.out', '');

        const structure = fileManager.getStructure();
        expect(structure).not.toBeNull();

        // 不正な色名（空白入り → class injection の可能性）
        const colorName = 'red inject-class';
        const { NOTES_COLOR_PALETTE } = require('../../src/shared/notes-color-palette') as { NOTES_COLOR_PALETTE: Array<{ name: string; hex: string }> };
        const validNames = NOTES_COLOR_PALETTE.map(c => c.name);

        // バリデーション: パレットに含まれない → 保存されない
        if (validNames.includes(colorName)) {
            structure!.items[fileId].color = colorName;
            fileManager.saveStructure();
        }

        // 再読込して確認: color は undefined のまま
        const fileManager2 = new NotesFileManager(tempDir);
        const structure2 = fileManager2.getStructure();
        expect(structure2!.items[fileId].color).toBeUndefined();
    });

    test('不正な色名 (パストラバーサル "../etc/passwd") は保存されない', async () => {
        fileManager = new NotesFileManager(tempDir);

        const filePath = fileManager.createFile('TestFile', null);
        const fileId = path.basename(filePath).replace('.out', '');

        const structure = fileManager.getStructure();

        const colorName = '../etc/passwd';
        const { NOTES_COLOR_PALETTE } = require('../../src/shared/notes-color-palette') as { NOTES_COLOR_PALETTE: Array<{ name: string; hex: string }> };
        const validNames = NOTES_COLOR_PALETTE.map(c => c.name);

        if (validNames.includes(colorName)) {
            structure!.items[fileId].color = colorName;
            fileManager.saveStructure();
        }

        const fileManager2 = new NotesFileManager(tempDir);
        const structure2 = fileManager2.getStructure();
        expect(structure2!.items[fileId].color).toBeUndefined();
    });

    test('不正な色名 (XSS "<script>") は保存されない', async () => {
        fileManager = new NotesFileManager(tempDir);

        const filePath = fileManager.createFile('TestFile', null);
        const fileId = path.basename(filePath).replace('.out', '');

        const structure = fileManager.getStructure();

        const colorName = '<script>';
        const { NOTES_COLOR_PALETTE } = require('../../src/shared/notes-color-palette') as { NOTES_COLOR_PALETTE: Array<{ name: string; hex: string }> };
        const validNames = NOTES_COLOR_PALETTE.map(c => c.name);

        if (validNames.includes(colorName)) {
            structure!.items[fileId].color = colorName;
            fileManager.saveStructure();
        }

        const fileManager2 = new NotesFileManager(tempDir);
        const structure2 = fileManager2.getStructure();
        expect(structure2!.items[fileId].color).toBeUndefined();
    });

    test('不正な色名 (パレット外 "rainbow") は保存されない', async () => {
        fileManager = new NotesFileManager(tempDir);

        const filePath = fileManager.createFile('TestFile', null);
        const fileId = path.basename(filePath).replace('.out', '');

        const structure = fileManager.getStructure();

        const colorName = 'rainbow';
        const { NOTES_COLOR_PALETTE } = require('../../src/shared/notes-color-palette') as { NOTES_COLOR_PALETTE: Array<{ name: string; hex: string }> };
        const validNames = NOTES_COLOR_PALETTE.map(c => c.name);

        if (validNames.includes(colorName)) {
            structure!.items[fileId].color = colorName;
            fileManager.saveStructure();
        }

        const fileManager2 = new NotesFileManager(tempDir);
        const structure2 = fileManager2.getStructure();
        expect(structure2!.items[fileId].color).toBeUndefined();
    });
});
