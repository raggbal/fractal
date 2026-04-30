/**
 * F2: NotesFileManager の note-level sidepanel width / outline width 永続化
 *
 * Note 共通 (.out 横断) の sidepanel md 幅 / TOC 幅を outline.note の root
 * フィールド sidePanelWidth / sidePanelOutlineWidth に保存・取得する。
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';

test.describe('NotesFileManager — note-level sidepanel widths', () => {
    let tempDir: string;

    test.beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-spwidth-test-'));
    });

    test.afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('saveSidePanelWidth → getSidePanelWidth で同じ値が返る', () => {
        const fm = new NotesFileManager(tempDir);
        // 初期 outline.note を生成 (createFile でブートストラップ)
        fm.createFile('A', null);

        expect(fm.getSidePanelWidth()).toBeUndefined();

        fm.saveSidePanelWidth(720);
        expect(fm.getSidePanelWidth()).toBe(720);
    });

    test('saveSidePanelOutlineWidth → getSidePanelOutlineWidth で同じ値が返る', () => {
        const fm = new NotesFileManager(tempDir);
        fm.createFile('A', null);

        expect(fm.getSidePanelOutlineWidth()).toBeUndefined();

        fm.saveSidePanelOutlineWidth(220);
        expect(fm.getSidePanelOutlineWidth()).toBe(220);
    });

    test('保存後、別インスタンスで再読込しても値が保持される (outline.note 永続化)', () => {
        const fm1 = new NotesFileManager(tempDir);
        fm1.createFile('A', null);
        fm1.saveSidePanelWidth(800);
        fm1.saveSidePanelOutlineWidth(260);

        const fm2 = new NotesFileManager(tempDir);
        expect(fm2.getSidePanelWidth()).toBe(800);
        expect(fm2.getSidePanelOutlineWidth()).toBe(260);
    });

    test('outline.note に sidePanelWidth / sidePanelOutlineWidth が直接書き込まれる', () => {
        const fm = new NotesFileManager(tempDir);
        fm.createFile('A', null);
        fm.saveSidePanelWidth(640);
        fm.saveSidePanelOutlineWidth(180);

        const noteFilePath = path.join(tempDir, 'outline.note');
        const raw = fs.readFileSync(noteFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        expect(parsed.sidePanelWidth).toBe(640);
        expect(parsed.sidePanelOutlineWidth).toBe(180);
    });

    test('panelWidth / sidePanelWidth / sidePanelOutlineWidth は独立して保存される', () => {
        const fm = new NotesFileManager(tempDir);
        fm.createFile('A', null);

        fm.savePanelWidth(280);            // 既存: 左パネル幅
        fm.saveSidePanelWidth(720);        // 新規: sidepanel md 幅
        fm.saveSidePanelOutlineWidth(220); // 新規: TOC 幅

        expect(fm.getPanelWidth()).toBe(280);
        expect(fm.getSidePanelWidth()).toBe(720);
        expect(fm.getSidePanelOutlineWidth()).toBe(220);
    });
});
