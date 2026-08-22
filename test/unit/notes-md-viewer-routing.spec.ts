/**
 * TC-VSP-01 — note md の 📎 pdf/html click は sidepanel viewer で開く（sprint 20260822-051129 FR-VSP-01）
 *
 * seam: openNotesMdAttachmentViaSidePanel（依存注入 — behavioral）+ 配線 grep（notesMdOpenLink 分岐が
 * seam/tryOpenViewerPanel を使い tryShowNoteViewer を使わない。他 3 sink は note 面 viewer のまま = 不変 pin）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) delete require.cache[key];
    }
}
function requireWithVscodeStub(modulePath: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache();
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return {
                workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                commands: { executeCommand: () => {} },
                window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: () => {}, registerCustomEditorProvider: () => ({ dispose() {} }) },
                env: { openExternal: () => {} }, ViewColumn: {}, EventEmitter: class { event = () => {}; fire() {} },
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try { return require(modulePath); } finally { Module._load = origLoad; purgeSrcCache(); }
}

test('TC-VSP-01a seam: sidepanel viewer 成功 → openExternal 不発 / false・throw → openExternal 縮退', async () => {
    const nep = requireWithVscodeStub('../../src/notesEditorProvider');
    expect(typeof nep.openNotesMdAttachmentViaSidePanel, 'seam export 不在').toBe('function');
    // 成功
    {
        const calls: string[] = [];
        await nep.openNotesMdAttachmentViaSidePanel({
            tryOpenSidePanelViewer: async (abs: string) => { calls.push('viewer:' + abs); return true; },
            openExternal: (abs: string) => { calls.push('ext:' + abs); },
        }, '/x/doc.pdf');
        expect(calls).toEqual(['viewer:/x/doc.pdf']);
    }
    // viewer 不能（false）→ openExternal
    {
        const calls: string[] = [];
        await nep.openNotesMdAttachmentViaSidePanel({
            tryOpenSidePanelViewer: async () => false,
            openExternal: (abs: string) => { calls.push('ext:' + abs); },
        }, '/x/big.pdf');
        expect(calls).toEqual(['ext:/x/big.pdf']);
    }
    // throw → 縮退で openExternal（落ちない）
    {
        const calls: string[] = [];
        await nep.openNotesMdAttachmentViaSidePanel({
            tryOpenSidePanelViewer: async () => { throw new Error('boom'); },
            openExternal: (abs: string) => { calls.push('ext:' + abs); },
        }, '/x/z.html');
        expect(calls).toEqual(['ext:/x/z.html']);
    }
});

test('TC-VSP-01b 配線: notesMdOpenLink 分岐は sidepanel viewer 経由・他 sink の note 面 viewer は不変', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/notesEditorProvider.ts'), 'utf8');
    // notesMdOpenLink の非 md 分岐を切り出し（notesMdOpenLink 定義から次の platform メソッドまで）
    const start = src.indexOf('notesMdOpenLink: async');
    const end = src.indexOf('notesMdOpenLinkInTab: async');
    expect(start).toBeGreaterThan(0);
    const branch = src.slice(start, end);
    expect(branch.includes('openNotesMdAttachmentViaSidePanel') || branch.includes('tryOpenViewerPanel'),
        'notesMdOpenLink が sidepanel viewer 経由でない').toBe(true);
    expect(branch.includes('tryShowNoteViewer'), 'notesMdOpenLink に note 面 viewer が残存').toBe(false);
    // 他 sink（tree click / in-app link 等）の note 面 viewer は不変（FR-VSP-01 スコープ外 pin）
    const remaining = (src.match(/tryShowNoteViewer\(/g) || []).length;
    // exact pin（QUAL-5 — 許可: test_update）: 定義 1 + sink 4（tree click / in-app ×2 / historyOpenFile）。
    // 増減したら意図的な sink 追加/削除か確認して更新する
    expect(remaining, '他 sink の tryShowNoteViewer 数が想定外').toBe(5);
});
