/**
 * customEditors[] manifest + stub Provider 登録テスト (TASK-A7)
 *
 * design: design/system.md §4.4
 * testcases: TC-101 (manifest 構文), TC-103 (priority: option / default 維持)
 *
 * TC-102 (Provider activation = .vsix ロード後の実 webview) は VSCode 統合テスト相当で、
 * 本 unit-level spec では package.json の登録のみ確認 (`npm run package` での .vsix
 * ビルド成功は手動 reviewer step)。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const PACKAGE_JSON = path.join(__dirname, '..', '..', 'package.json');

interface CustomEditorEntry {
    viewType: string;
    displayName: string;
    selector: { filenamePattern: string }[];
    priority: 'default' | 'option';
}

function loadCustomEditors(): CustomEditorEntry[] {
    const raw = fs.readFileSync(PACKAGE_JSON, 'utf8');
    const pkg = JSON.parse(raw);
    expect(pkg.contributes, 'contributes section').toBeTruthy();
    expect(Array.isArray(pkg.contributes.customEditors)).toBe(true);
    return pkg.contributes.customEditors as CustomEditorEntry[];
}

test.describe('TC-101 — fractal.outlinerTable customEditors manifest', () => {
    test('TC-101 customEditors[] declares fractal.outlinerTable for *.out as priority option', () => {
        const editors = loadCustomEditors();
        const tableEditor = editors.find((e) => e.viewType === 'fractal.outlinerTable');
        expect(tableEditor, 'fractal.outlinerTable entry should exist').toBeDefined();
        expect(tableEditor!.displayName).toBe('Fractal Outliner Table');
        expect(tableEditor!.priority).toBe('option');
        expect(Array.isArray(tableEditor!.selector)).toBe(true);
        expect(tableEditor!.selector.length).toBeGreaterThan(0);
        const patterns = tableEditor!.selector.map((s) => s.filenamePattern);
        expect(patterns).toContain('*.out');
    });
});

test.describe('TC-103 — existing fractal.outliner remains the default editor for *.out', () => {
    test('TC-103 fractal.outliner keeps priority: default', () => {
        const editors = loadCustomEditors();
        const outliner = editors.find((e) => e.viewType === 'fractal.outliner');
        expect(outliner, 'fractal.outliner entry should still exist').toBeDefined();
        expect(outliner!.priority).toBe('default');
        const patterns = outliner!.selector.map((s) => s.filenamePattern);
        expect(patterns).toContain('*.out');
    });

    test('TC-103 only one *.out provider is registered as priority: default', () => {
        const editors = loadCustomEditors();
        const defaults = editors.filter((e) =>
            e.priority === 'default' &&
            e.selector.some((s) => s.filenamePattern === '*.out')
        );
        expect(defaults).toHaveLength(1);
        expect(defaults[0].viewType).toBe('fractal.outliner');
    });

    test('TC-103 fractal.outlinerTable Provider source is wired in extension.ts', () => {
        const extPath = path.join(__dirname, '..', '..', 'src', 'extension.ts');
        const src = fs.readFileSync(extPath, 'utf8');
        expect(src).toContain("from './outlinerTableProvider'");
        expect(src).toContain("'fractal.outlinerTable'");
    });
});
