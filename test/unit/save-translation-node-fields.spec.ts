/**
 * Translation save: OutlinerModel field 整合性 unit tests (sprint 20260510-140531)
 *
 * TC-NEW-03: 翻訳保存の新 node が OutlinerModel 必須 field を全持つ
 *
 * 実装は notesEditorProvider.ts / outlinerProvider.ts の saveTranslationToOutlinerNode。
 * 関数自体は fileManager / vscode API に強く依存して unit test 困難なので、
 * **source-grep で必須 field 群が含まれていることを invariant として保護**する。
 *
 * これは v0.207.24 の bug (`childIds` という存在しない field を使い node が孤児化) が
 * 再発しないようにするための regression guard。
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../..');

const REQUIRED_FIELDS = [
    'parentId:',  // ← 親 ID
    'children:',  // ← OutlinerModel が読む field 名 (childIds ではない、絶対)
    'tags:',
    'isPage:',
    'pageId:',
    'collapsed:',
    'checked:',
    'subtext:',
    'images:',
    'filePath:',
];

function readSaveBlock(filePath: string): string {
    // saveTranslationToOutlinerNode の出現位置から、その後 200 行を抽出 (関数本体 + 周辺)
    const cmd = `grep -n 'saveTranslationToOutlinerNode' "${filePath}" | head -1 | cut -d: -f1`;
    const lineStr = execSync(cmd, { encoding: 'utf-8' }).trim();
    const startLine = parseInt(lineStr || '1', 10);
    const sedCmd = `sed -n '${startLine},${startLine + 200}p' "${filePath}"`;
    return execSync(sedCmd, { encoding: 'utf-8' });
}

test.describe('Translation save / OutlinerModel field invariants (FR-TR-02)', () => {
    test('TC-NEW-03a: notesEditorProvider.ts の saveTranslationToOutlinerNode が全必須 field を持つ', () => {
        const block = readSaveBlock(path.join(projectRoot, 'src/notesEditorProvider.ts'));
        for (const field of REQUIRED_FIELDS) {
            expect(block).toContain(field);
        }
    });

    test('TC-NEW-03b: outlinerProvider.ts の saveTranslationToOutlinerNode が全必須 field を持つ', () => {
        const block = readSaveBlock(path.join(projectRoot, 'src/outlinerProvider.ts'));
        for (const field of REQUIRED_FIELDS) {
            expect(block).toContain(field);
        }
    });

    test('TC-NEW-03c: notesEditorProvider が childIds を field として使っていない (regression guard)', () => {
        const block = readSaveBlock(path.join(projectRoot, 'src/notesEditorProvider.ts'));
        // 「childIds」は OutlinerModel に存在しない field、絶対に使ってはならない
        // ただし comment 内の言及 (regression note) は許容
        const stripped = block.replace(/\/\/[^\n]*/g, '');
        expect(stripped).not.toContain('childIds');
    });

    test('TC-NEW-03d: outlinerProvider が childIds を field として使っていない (regression guard)', () => {
        const block = readSaveBlock(path.join(projectRoot, 'src/outlinerProvider.ts'));
        const stripped = block.replace(/\/\/[^\n]*/g, '');
        expect(stripped).not.toContain('childIds');
    });

    test('TC-NEW-03e: notesEditorProvider が parentNode.children に push する', () => {
        const block = readSaveBlock(path.join(projectRoot, 'src/notesEditorProvider.ts'));
        expect(block).toMatch(/parentNode\.children\.push/);
    });

    test('TC-NEW-03f: outlinerProvider が parentNode.children に push する', () => {
        const block = readSaveBlock(path.join(projectRoot, 'src/outlinerProvider.ts'));
        expect(block).toMatch(/parentNode\.children\.push/);
    });

    test('TC-NEW-03g: 新 pageId が "p" prefix で生成されている', () => {
        const block = readSaveBlock(path.join(projectRoot, 'src/notesEditorProvider.ts'));
        expect(block).toContain("'p' + Date.now()");
    });

    test('TC-NEW-03h: 新 nodeId が "n" prefix で生成されている', () => {
        const block = readSaveBlock(path.join(projectRoot, 'src/notesEditorProvider.ts'));
        expect(block).toContain("'n' + Date.now()");
    });

    test('TC-NEW-03i: OutlinerModel は children を読む (childIds ではない invariant)', () => {
        const modelPath = path.join(projectRoot, 'src/webview/outliner-model.js');
        const cmd = `grep -n 'childIds\\|node\\.children' "${modelPath}" || true`;
        const out = execSync(cmd, { encoding: 'utf-8' });
        // OutlinerModel は children を使う、childIds は登場しない
        expect(out).toContain('children');
        expect(out).not.toContain('childIds');
    });
});
