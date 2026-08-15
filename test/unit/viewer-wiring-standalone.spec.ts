/**
 * viewer-wiring-standalone.spec.ts — standalone 面の契約 TC（TC-FV-30）
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-03。
 * provider 層は vscode 依存で behavioral unit 不可 → package.json の customEditors を
 * JSON パースで契約検証（source-contract 文字列 grep は使わない — design/tdd.md）。
 * 実 VS Code での動作は test-usecase §2 に明示割当。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));

test.describe('standalone 面の契約（FR-FV-02 / TASK-03）', () => {

    test('TC-FV-30: customEditors に fileViewer — *.pdf=default / *.html,*.htm=option', () => {
        const editors = pkg.contributes.customEditors as Array<{
            viewType: string; selector: Array<{ filenamePattern: string }>; priority: string;
        }>;

        const pdfViewer = editors.find((e) => e.viewType === 'fractal.fileViewer');
        expect(pdfViewer, 'fractal.fileViewer が宣言されている').toBeTruthy();
        expect(pdfViewer!.selector.map((s) => s.filenamePattern)).toEqual(['*.pdf']);
        expect(pdfViewer!.priority, '.pdf は default（VS Code 標準で開けない形式）').toBe('default');

        const htmlViewer = editors.find((e) => e.viewType === 'fractal.fileViewerHtml');
        expect(htmlViewer, 'fractal.fileViewerHtml が宣言されている').toBeTruthy();
        expect(htmlViewer!.selector.map((s) => s.filenamePattern).sort()).toEqual(['*.htm', '*.html']);
        expect(htmlViewer!.priority, '.html は option（標準テキスト編集を奪わない）').toBe('option');

        // 既存 2 provider の宣言は不変（regression）
        expect(editors.find((e) => e.viewType === 'fractal.editor')?.priority).toBe('option');
        expect(editors.find((e) => e.viewType === 'fractal.outliner')?.priority).toBe('default');
    });

    test('TC-FV-37: 生成 HTML の CSP nonce 契約（SEC-1 番人 — nonce 無しの inline script は本番でブロックされる）', () => {
        // fileViewerContent は vscode import を持つため Module._load モックで読み込む
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Module = require('module');
        const vscodeMock = {
            Uri: {
                file: (p: string) => ({ fsPath: p, path: p }),
                joinPath: (base: any, ...parts: string[]) => ({ fsPath: path.join(base.fsPath || '', ...parts) }),
            },
        };
        const origLoad = Module._load;
        Module._load = function (request: string, ...rest: unknown[]) {
            if (request === 'vscode') { return vscodeMock; }
            return origLoad.call(this, request, ...rest);
        };
        let html: string;
        try {
            const modPath = require.resolve('../../src/fileViewerContent');
            delete require.cache[modPath];
            delete require.cache[require.resolve('../../src/webviewContent')];
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { getFileViewerHtml } = require('../../src/fileViewerContent');
            const webview = {
                cspSource: 'https://csp.example',
                asWebviewUri: (u: any) => ({ toString: () => `vscode-resource://${u.fsPath}` }),
            };
            html = getFileViewerHtml(webview, { fsPath: '/ext' }, { fsPath: '/note/files/doc.pdf' }, 'pdf');
        } finally {
            Module._load = origLoad;
        }
        // ① CSP に nonce がある
        const cspMatch = html.match(/script-src 'nonce-([^']+)'/);
        expect(cspMatch, "CSP script-src に 'nonce-…' がある").toBeTruthy();
        const nonce = cspMatch![1];
        // ② 全 script タグに同一 nonce（counterfactual: nonce を外すと本番 CSP で inline がブロック = RED）
        const scriptTags = html.match(/<script[^>]*>/g) || [];
        expect(scriptTags.length).toBeGreaterThanOrEqual(2);   // inline config + module src
        for (const tag of scriptTags) {
            expect(tag, `script タグに nonce: ${tag}`).toContain(`nonce="${nonce}"`);
        }
        // ③ __viewerConfig の inline 注入が存在（kind/fileUri が config に乗る）
        expect(html).toContain('window.__viewerConfig');
        expect(html).toContain('"kind":"pdf"');
    });
});
