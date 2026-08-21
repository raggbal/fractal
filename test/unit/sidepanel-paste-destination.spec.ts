/**
 * TC-PDB-04/05 — sidepanel paste 二重貼付の destination 札配線（sprint 20260818-183407 FR-PDB-01/02）
 *
 * 機序: pasteOutlinerNodesWithAssets / extractDataUrlsInPastedMd の結果 message
 * (pasteWithAssetCopyResult / extractDataUrlsInPastedMdResult) が destination 無しで
 * broadcast され、md ペイン（無条件処理）と sidepanel（outliner.js 転送）の両方が挿入する。
 * 修正 = FR-XP-01 / ADRL-0046 と同型の destination 札を発行元が積み host が echo back する。
 *
 * counterfactual: 発行元の destination 付与を外すと TC-PDB-04a/04b が RED
 * （= 札が防御の実体。受信側の routing は TC-PDB-01/02 = specs 側で検証）。
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';

// generator_failures 2026-08-17: Module._load stub + require は「require 直前の
// 対象 prefix purge」と「finally での同 purge」を必ず対で書く（先行 spec の別 stub 下
// cache を掴まない / 自分の stub 済み cache を残さない）。
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
                workspace: { getConfiguration: () => ({ get: () => undefined }) },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                commands: { executeCommand: () => {} },
                window: {}, env: {}, ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(modulePath);
    } finally {
        Module._load = origLoad;
        purgeSrcCache();
    }
}

// ─── TC-PDB-04a: 共有 factory（sidepanel-bridge-methods.js）の発行元 ───────────

function createFactoryBridge(): { bridge: any; sent: any[] } {
    const sent: any[] = [];
    // webview スクリプト（window グローバル代入）を node で実行する
    (global as any).window = (global as any).window || {};
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    delete require.cache[require.resolve('../../src/shared/sidepanel-bridge-methods.js')];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../../src/shared/sidepanel-bridge-methods.js');
    const bridge = (global as any).window.__createSidePanelBridgeMethods((msg: any) => sent.push(msg));
    return { bridge, sent };
}

test('TC-PDB-04a factory 発行元: pasteOutlinerNodesWithAssets が destination を積む', () => {
    const { bridge, sent } = createFactoryBridge();
    bridge.pasteOutlinerNodesWithAssets('- a\n', [{ text: 'a', level: 0 }], '/notes/A/page.md');
    expect(sent.length).toBe(1);
    expect(sent[0].type).toBe('pasteOutlinerNodesWithAssets');
    // counterfactual: destination 付与を外すとここが undefined = RED
    expect(sent[0].destination).toBe('sidepanel');

    // sidePanelFilePath 無し（standalone main md 経由）は main-md
    bridge.pasteOutlinerNodesWithAssets('- a\n', [], undefined);
    expect(sent[1].destination).toBe('main-md');
});

test('TC-PDB-04a2 factory 発行元: extractDataUrlsInPastedMd が destination を積む', () => {
    const { bridge, sent } = createFactoryBridge();
    bridge.extractDataUrlsInPastedMd('![x](data:image/png;base64,AAA)', '/notes/A/page.md');
    expect(sent.length).toBe(1);
    expect(sent[0].type).toBe('extractDataUrlsInPastedMd');
    expect(sent[0].destination).toBe('sidepanel');

    bridge.extractDataUrlsInPastedMd('![x](data:image/png;base64,AAA)', undefined);
    expect(sent[1].destination).toBe('main-md');
});

// ─── TC-PDB-05: notes-message-handler の dispatch / fallback echo ──────────────

const noopPlatform = {
    showInformationMessage: () => {},
    showErrorMessage: () => {},
} as any;

test('TC-PDB-05a handler dispatch: pasteOutlinerNodesWithAssets が destination を platform へ渡す', async () => {
    const handleNotesMessage = requireWithVscodeStub('../../src/shared/notes-message-handler').handleNotesMessage;
    const calls: any[] = [];
    const platform = {
        ...noopPlatform,
        pasteOutlinerNodesWithAssets: (plainText: string, nodes: unknown[], spfp: string, destination?: string) => {
            calls.push({ plainText, nodes, spfp, destination });
        },
    };
    await handleNotesMessage(
        { type: 'pasteOutlinerNodesWithAssets', plainText: '- a\n', nodes: [], sidePanelFilePath: '/n/p.md', destination: 'sidepanel' },
        {} as any, { postMessage: () => {} } as any, platform
    );
    expect(calls.length).toBe(1);
    // counterfactual: dispatch が destination を落とすと undefined = RED
    expect(calls[0].destination).toBe('sidepanel');
});

test('TC-PDB-05b handler fallback echo: 宛先不明 fallback が destination を echo back する', async () => {
    const handleNotesMessage = requireWithVscodeStub('../../src/shared/notes-message-handler').handleNotesMessage;
    const posted: any[] = [];
    // sidePanelFilePath 無し → TASK-B5 防御 fallback（リストのみ md を返す）に落ちる経路
    await handleNotesMessage(
        { type: 'pasteOutlinerNodesWithAssets', plainText: '- a\n', nodes: [{ text: 'a', level: 0 }], destination: 'main-md' },
        {} as any, { postMessage: (m: any) => posted.push(m) } as any, noopPlatform
    );
    const results = posted.filter((m) => m.type === 'pasteWithAssetCopyResult');
    expect(results.length).toBe(1);
    expect(results[0].destination).toBe('main-md');
});

test('TC-PDB-05c handler dispatch: extractDataUrlsInPastedMd が destination を platform へ渡す', async () => {
    const handleNotesMessage = requireWithVscodeStub('../../src/shared/notes-message-handler').handleNotesMessage;
    const calls: any[] = [];
    const platform = {
        ...noopPlatform,
        extractDataUrlsInPastedMd: (markdown: string, spfp: string, destination?: string) => {
            calls.push({ markdown, spfp, destination });
        },
    };
    await handleNotesMessage(
        { type: 'extractDataUrlsInPastedMd', markdown: 'x', sidePanelFilePath: '/n/p.md', destination: 'sidepanel' },
        {} as any, { postMessage: () => {} } as any, platform
    );
    expect(calls.length).toBe(1);
    expect(calls[0].destination).toBe('sidepanel');
});

test('TC-PDB-05d 後方互換: destination 無し message は undefined のまま platform へ（旧形式非破壊）', async () => {
    const handleNotesMessage = requireWithVscodeStub('../../src/shared/notes-message-handler').handleNotesMessage;
    const calls: any[] = [];
    const platform = {
        ...noopPlatform,
        pasteOutlinerNodesWithAssets: (_pt: string, _n: unknown[], _sp: string, destination?: string) => {
            calls.push({ destination });
        },
    };
    await handleNotesMessage(
        { type: 'pasteOutlinerNodesWithAssets', plainText: '- a\n', nodes: [], sidePanelFilePath: '/n/p.md' },
        {} as any, { postMessage: () => {} } as any, platform
    );
    expect(calls.length).toBe(1);
    expect(calls[0].destination).toBeUndefined();
});

// ─── TC-SRC-05: outlinerProvider の pasteWithAssetCopyResult destination echo（sprint 20260819-210558 TASK-02） ───
// outlinerProvider の paste handler は resolveCustomTextEditor closure 内のため dispatch 手法
// （TC-PDB-05 系）が届かない — 配線 grep 番人で pin する（TC-MDM-09p と同クラス。
// echo パターンの behavioral 正しさは editorProvider/notesEditorProvider 側 TC が担保済み）。
test('TC-SRC-05 outlinerProvider: pasteWithAssetCopy case の result postMessage に destination echo が実在', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs2 = require('fs');
    const src: string = fs2.readFileSync(path.join(__dirname, '../../src/outlinerProvider.ts'), 'utf8');
    const caseStart = src.indexOf("case 'pasteWithAssetCopy':");
    expect(caseStart, "case 'pasteWithAssetCopy' 不在").toBeGreaterThan(-1);
    const caseEnd = src.indexOf('case ', caseStart + 10);
    const block = src.slice(caseStart, caseEnd);
    // result postMessage が存在し、その中に destination echo がある
    expect(block).toContain("type: 'pasteWithAssetCopyResult'");
    // counterfactual: 現行実装は destination フィールド不在（editorProvider:1476 / notesEditorProvider:2038 は echo 済み）
    expect(block.includes('destination: message.destination'),
        'pasteWithAssetCopyResult に destination echo が無い（v1.3.2 FR-PDB クラスの取りこぼし）').toBe(true);
});
