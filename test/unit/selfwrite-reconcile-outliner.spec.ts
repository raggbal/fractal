/**
 * selfwrite-reconcile-outliner — 自己保存の残響イベントで巻き戻さない（FR-LV-06 site 4）
 * sprint 20260825-055613-livereload-selfsave-revert TASK-05
 *
 * TC-SWR-04: outlinerProvider の照合メソッド `reconcileOutExternal` が台帳内容（applyEdit で
 *   記録済み = 自己保存の残響）を読んだとき no-op（updateData postMessage 0 件・doc 不変・save なし）。
 *   台帳に無い内容（真の外部編集）は従来どおり適用 + 記録。
 *   counterfactual: isRecentSelfWrite 照合を外すと RED（旧 inline 実装相当 = 巻き戻り）。
 *
 * 配線 pin（design-review TDD-1）: FSW onDidChange ハンドラが reconcileOutExternal を呼ぶこと。
 *   resolveCustomTextEditor のフル起動は fileManager/webview HTML 依存で unit 不能
 *   （先例: translate-routing.spec.ts 冒頭コメント）のため、onDidChange ブロックを source から
 *   切り出して照合メソッド呼び出しを assert する「ブロック限定 pin」+ grep 番人で代替する
 *   （メソッド単体の behavioral 検証と合わせて、seam 未配線（旧 inline 残存）を検出できる）。
 */
import { test, expect } from '@playwright/test';
import * as fsReal from 'fs';
import * as pathReal from 'path';

function loadProviderWithStub(vscodeNs: any): any {
    const Module = require('module');
    const origLoad = Module._load;
    Module._load = function (request: string, ...rest: any[]) {
        if (request === 'vscode') { return vscodeNs; }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        Object.keys(require.cache).filter((k) => k.includes('/src/')).forEach((k) => { delete require.cache[k]; });
        const provider = require('../../src/outlinerProvider');
        const registry = require('../../src/shared/self-write-registry'); // provider と同一ロード世代
        return { provider, registry };
    } finally {
        Module._load = origLoad;
        Object.keys(require.cache).filter((k) => k.includes('/src/')).forEach((k) => { delete require.cache[k]; });
    }
}

function makeVscodeStub(state: { diskContent: string; docContent: string; saveCount: number }) {
    return {
        workspace: {
            getConfiguration: () => ({ get: (_k: string, d: any) => d }),
            fs: { readFile: async (_uri: any) => new TextEncoder().encode(state.diskContent) },
            applyEdit: async (edit: any) => {
                if (edit._content !== null) { state.docContent = edit._content; }
                return true;
            },
            onDidChangeTextDocument: (_h: any) => ({ dispose: () => {} }),
            createFileSystemWatcher: () => ({ onDidChange: () => ({ dispose: () => {} }), dispose: () => {} }),
        },
        Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
        Range: class { constructor(..._a: any[]) {} },
        WorkspaceEdit: class {
            _content: string | null = null;
            replace(_uri: any, _range: any, content: string) { this._content = content; }
        },
        RelativePattern: class { constructor(_b: any, _p: string) {} },
        commands: { executeCommand: () => {} },
        window: { showErrorMessage: () => {}, showInformationMessage: () => {} },
        env: {}, ViewColumn: {}, EventEmitter: class {},
    } as any;
}

function makeDoc(state: { docContent: string; saveCount: number; diskContent: string }) {
    return {
        uri: { fsPath: '/fake/out/a.out', toString: () => 'file:///fake/out/a.out' },
        getText: () => state.docContent,
        positionAt: (_n: number) => ({ line: 0, character: 0 }),
        lineCount: 1,
        save: async () => { state.saveCount++; state.diskContent = state.docContent; return true; },
    };
}

const OLD_JSON = JSON.stringify({ title: 'T', nodes: { root: { text: 'itemX' } } });
const NEW_JSON = JSON.stringify({ title: 'T', nodes: { root: { text: 'item' } } });
const EXT_JSON = JSON.stringify({ title: 'EXT', nodes: { root: { text: 'external' } } });

test.describe('FR-LV-06 site 4: outlinerProvider reconcileOutExternal', () => {

    test('TC-SWR-04: 台帳内容（自己保存の残響）は no-op — updateData なし・doc 不変・save なし', async () => {
        const state = { diskContent: OLD_JSON, docContent: NEW_JSON, saveCount: 0 };
        const vscodeNs = makeVscodeStub(state);
        const { provider, registry } = loadProviderWithStub(vscodeNs);
        const inst = new provider.OutlinerProvider({} as any);

        registry.clearSelfWrites('/fake/out/a.out');
        // applyEdit 相当: 過去に自分が書いた 2 世代（OLD → NEW）を記録
        registry.recordSelfWrite('/fake/out/a.out', OLD_JSON);
        registry.recordSelfWrite('/fake/out/a.out', NEW_JSON);

        const messages: any[] = [];
        const panel = { webview: { postMessage: (m: any) => { messages.push(m); return Promise.resolve(true); } } };
        let applying = false;
        await (inst as any).reconcileOutExternal(makeDoc(state), panel, (b: boolean) => { applying = b; });

        expect(messages.filter((m) => m.type === 'updateData').length, '残響で updateData を push しない').toBe(0);
        expect(state.docContent, 'doc を巻き戻さない').toBe(NEW_JSON);
        expect(state.saveCount, 'save しない').toBe(0);
        registry.clearSelfWrites('/fake/out/a.out');
    });

    test('TC-SWR-04b: 台帳に無い内容（真の外部編集）は従来どおり適用 + 記録', async () => {
        const state = { diskContent: EXT_JSON, docContent: NEW_JSON, saveCount: 0 };
        const vscodeNs = makeVscodeStub(state);
        const { provider, registry } = loadProviderWithStub(vscodeNs);
        const inst = new provider.OutlinerProvider({} as any);
        registry.clearSelfWrites('/fake/out/a.out');
        registry.recordSelfWrite('/fake/out/a.out', NEW_JSON);

        const messages: any[] = [];
        const panel = { webview: { postMessage: (m: any) => { messages.push(m); return Promise.resolve(true); } } };
        let applying = false;
        await (inst as any).reconcileOutExternal(makeDoc(state), panel, (b: boolean) => { applying = b; });

        const ups = messages.filter((m) => m.type === 'updateData');
        expect(ups.length, '外部編集は updateData で反映される').toBe(1);
        expect(ups[0].data.title).toBe('EXT');
        expect(ups[0].outFileKey).toBe('/fake/out/a.out');
        expect(state.docContent).toBe(EXT_JSON);
        expect(state.saveCount).toBe(1);
        expect(applying, 'setApplying が false に戻る').toBe(false);
        expect(registry.isRecentSelfWrite('/fake/out/a.out', EXT_JSON), '適用内容が台帳に記録される').toBe(true);
        registry.clearSelfWrites('/fake/out/a.out');
    });

    test('TC-SWR-04 配線 pin: FSW onDidChange ブロックが reconcileOutExternal を呼ぶ（ブロック限定 pin + grep 番人）', () => {
        const src = fsReal.readFileSync(pathReal.resolve(__dirname, '../../src/outlinerProvider.ts'), 'utf8');
        // grep 番人: 定義 + 呼び出しで ≥2
        const hits = (src.match(/reconcileOutExternal/g) || []).length;
        expect(hits, 'seam 抽出が本番未配線にならない（定義+呼び出し）').toBeGreaterThanOrEqual(2);
        // ブロック限定 pin: fileWatcher.onDidChange ハンドラのブロック内に照合メソッド呼び出しがある
        const idx = src.indexOf('fileWatcher.onDidChange');
        expect(idx, 'FSW onDidChange 購読が実在').toBeGreaterThanOrEqual(0);
        const block = src.slice(idx, idx + 1200);
        expect(block, 'onDidChange ハンドラが照合メソッドを呼ぶ').toContain('reconcileOutExternal');
        // 旧 inline 実装の残存検出: onDidChange ブロック内に直接 applyEdit/readFile が残っていない
        expect(block).not.toContain('vscode.workspace.fs.readFile');
        // 記録配線の対 pin: applyEdit choke point / translate 直接サイトに recordSelfWrite がある
        const applyEditIdx = src.indexOf('private async applyEdit(');
        expect(applyEditIdx).toBeGreaterThanOrEqual(0);
        expect(src.slice(applyEditIdx, applyEditIdx + 800)).toContain('recordSelfWrite');
    });
});
