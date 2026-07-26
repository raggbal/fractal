/**
 * md export bundle — webview 配線の unit テスト（2 系統）。
 * sprint 20260720-170429-md-export-bundle。
 *
 * H-1/H-2（design-review）: ボタン DOM も bridge も 2 実装ある。
 *   経路A（メイン/standalone md）: generateEditorBodyHtml + factory __createSidePanelBridgeMethods
 *   経路B（sidepanel md）:        generateSidePanelHtml   + SidePanelHostBridge（bespoke クラス）
 * 両系統に配線されたことを検証する（片方だけだと sidepanel でボタンが出ない / undefined）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bodyHtml = require('../../src/shared/editor-body-html.js');

// TC-EX-17（経路A）: メイン/standalone md ツールバーに exportBundle ボタン
test('TC-EX-17 generateEditorBodyHtml に exportBundle ボタン（経路A）', () => {
    const html = bodyHtml.generateEditorBodyHtml({}, 'darwin');
    expect(html).toContain('data-action="exportBundle"');
});

// TC-EX-17b（経路B）: sidepanel md ヘッダーに exportBundle ボタン（H-1 の番人）
test('TC-EX-17b generateSidePanelHtml に exportBundle ボタン（経路B・H-1）', () => {
    const html = bodyHtml.generateSidePanelHtml({});
    expect(html).toContain('data-action="exportBundle"');
    // side-panel-header-actions 内にあること（別領域に紛れていない）
    expect(html).toContain('side-panel-header-actions');
});

// TC-EX-16（経路A）: factory bridge メソッドが postFn を正しい payload で呼ぶ
test('TC-EX-16 factory exportBundle が postFn を呼ぶ（経路A）', () => {
    // sidepanel-bridge-methods.js は window.__createSidePanelBridgeMethods を定義する browser script。
    // node で評価するため window shim を用意して eval する。
    const src = fs.readFileSync(
        path.join(__dirname, '../../src/shared/sidepanel-bridge-methods.js'), 'utf8');
    const win: any = {};
    // eslint-disable-next-line no-new-func
    new Function('window', src)(win);
    const calls: any[] = [];
    const methods = win.__createSidePanelBridgeMethods((msg: any) => calls.push(msg));
    expect(typeof methods.exportBundle).toBe('function');
    const opts = { includeChildren: true, recurseChildren: true, includeLinks: false, recurseLinks: false };
    methods.exportBundle(opts, '/p/x.md');
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ type: 'exportBundle', options: opts, sidePanelFilePath: '/p/x.md' });
});

// TC-EX-16b（経路B）: SidePanelHostBridge が this.filePath を sidePanelFilePath として委譲（H-2 の番人）
// editor.js は巨大な browser script なので、source から SidePanelHostBridge の exportBundle 実装を
// 抽出して評価する（既存 md-paste-asset-copy.spec の DOD-1/10 と同じ source 検証 + 実挙動）。
test('TC-EX-16b SidePanelHostBridge.exportBundle が filePath 付きで委譲（経路B・H-2）', () => {
    const editorJs = fs.readFileSync(path.join(__dirname, '../../src/webview/editor.js'), 'utf8');
    // クラスに exportBundle メソッドがあること（factory を使わない bespoke クラスなので必須）
    const classMatch = editorJs.match(/class SidePanelHostBridge[\s\S]*?(?=\nclass |\nwindow\.SidePanelHostBridge)/);
    expect(classMatch, 'SidePanelHostBridge クラスが見つかる').not.toBeNull();
    expect(classMatch![0]).toContain('exportBundle(options)');

    // 実挙動: exportBundle(options) → mainHost.exportBundle(options, this.filePath)
    // メソッド本体だけを取り出して関数として評価する。
    const methodMatch = editorJs.match(/exportBundle\(options\)\s*\{[\s\S]*?\n {4}\}/);
    expect(methodMatch, 'exportBundle メソッド本体').not.toBeNull();
    const calls: any[] = [];
    const fakeBridge = {
        _mainHost: { exportBundle: (o: any, fp: any) => calls.push({ o, fp }) },
        filePath: '/p/x.md',
    };
    // メソッド本体を Function 化して fakeBridge を this に束縛して実行
    // eslint-disable-next-line no-new-func
    const fn = new Function('return function ' + methodMatch![0] + '')();
    fn.call(fakeBridge, { includeChildren: true, recurseChildren: false, includeLinks: true, recurseLinks: false });
    expect(calls.length).toBe(1);
    expect(calls[0].fp).toBe('/p/x.md');   // this.filePath が sidePanelFilePath として渡る
    expect(calls[0].o.includeLinks).toBe(true);
});
