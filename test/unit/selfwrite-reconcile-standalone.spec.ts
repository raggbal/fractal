/**
 * selfwrite-reconcile-standalone — 自己保存の残響イベントで巻き戻さない（FR-LV-06 site 3）
 * sprint 20260825-055613-livereload-selfsave-revert TASK-04
 *
 * TC-SWR-03: editorProvider の照合 seam `reconcileStandaloneMd`（external-md-watcher.ts）が
 *   台帳内容（scheduleEdit で記録済み = 自己保存の残響）を読んだとき no-op で return する
 *   （postUpdate 0 件・doc 不変・save されない）。台帳に無い内容は従来どおり適用（外部編集）。
 *   併せて配線 pin: editorProvider.ts が seam 関数を import して onFsEvent から呼ぶこと
 *   （grep 番人 — seam 抽出が本番未配線にならない）。
 *   counterfactual: isRecentSelfWrite 照合を外すと RED（旧 inline 実装相当 = 巻き戻り）。
 */
import { test, expect } from '@playwright/test';
import * as fsReal from 'fs';
import * as pathReal from 'path';

function loadWatcherWithStub(vscodeNs: any): any {
    const Module = require('module');
    const origLoad = Module._load;
    Module._load = function (request: string, ...rest: any[]) {
        if (request === 'vscode') { return vscodeNs; }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        Object.keys(require.cache).filter((k) => k.includes('/src/shared/')).forEach((k) => { delete require.cache[k]; });
        const resolved = require.resolve('../../src/shared/external-md-watcher');
        delete require.cache[resolved];
        const watcher = require('../../src/shared/external-md-watcher');
        // registry は watcher と同一ロード世代のインスタンスを掴む（finally の purge 後に別 require すると
        // 別 Map を持つ新インスタンスになり、record が watcher 側の照合に効かない）
        const registry = require('../../src/shared/self-write-registry');
        return { watcher, registry };
    } finally {
        Module._load = origLoad;
        Object.keys(require.cache).filter((k) => k.includes('/src/shared/')).forEach((k) => { delete require.cache[k]; });
    }
}

function makeEnv(initialDoc: string, disk: string) {
    const state = {
        diskContent: disk,
        docContent: initialDoc,
        saveCount: 0,
        applied: [] as string[],
    };
    const doc = {
        uri: { fsPath: '/fake/standalone/a.md', toString: () => 'file:///fake/standalone/a.md' },
        getText: () => state.docContent,
        positionAt: (_n: number) => ({ line: 0, character: 0 }),
        save: async () => { state.saveCount++; state.diskContent = state.docContent; return true; },
    };
    const vscodeNs: any = {
        Range: class { constructor(..._a: any[]) {} },
        WorkspaceEdit: class {
            _content: string | null = null;
            replace(_uri: any, _range: any, content: string) { this._content = content; }
        },
        workspace: {
            fs: { readFile: async (_uri: any) => new TextEncoder().encode(state.diskContent) },
            applyEdit: async (edit: any) => {
                if (edit._content !== null) { state.docContent = edit._content; state.applied.push(edit._content); }
                return true;
            },
        },
    };
    return { state, doc, vscodeNs };
}

test.describe('FR-LV-06 site 3: reconcileStandaloneMd（editorProvider 照合 seam）', () => {

    test('TC-SWR-03: 台帳内容（自己保存の残響）は no-op — postUpdate なし・doc 不変・save なし', async () => {
        const env = makeEnv('- item', '- itemX'); // doc は新しい編集、disk は 1 世代前の自己保存
        const { watcher, registry } = loadWatcherWithStub(env.vscodeNs);

        registry.clearSelfWrites('/fake/standalone/a.md');
        // scheduleEdit 相当: 過去に自分が書いた 2 世代を記録（'- itemX' → '- item'）
        registry.recordSelfWrite('/fake/standalone/a.md', '- itemX');
        registry.recordSelfWrite('/fake/standalone/a.md', '- item');

        const updates: string[] = [];
        let applying = false;
        await watcher.reconcileStandaloneMd({
            filePath: '/fake/standalone/a.md',
            vscodeNs: env.vscodeNs,
            document: env.doc,
            setIsApplying: (b: boolean) => { applying = b; },
            convertContent: (raw: string) => `CONVERTED:${raw}`,
            postUpdate: (c: string) => { updates.push(c); },
        });

        expect(updates.length, '自己保存の残響で postUpdate しない').toBe(0);
        expect(env.state.docContent, 'doc を巻き戻さない').toBe('- item');
        expect(env.state.saveCount, 'save しない').toBe(0);
        registry.clearSelfWrites('/fake/standalone/a.md');
    });

    test('TC-SWR-03b: 台帳に無い内容（真の外部編集）は従来どおり適用（apply + save + postUpdate、convertContent 経由）', async () => {
        const env = makeEnv('MINE', 'AI_EXTERNAL');
        const { watcher, registry } = loadWatcherWithStub(env.vscodeNs);
        registry.clearSelfWrites('/fake/standalone/a.md');
        registry.recordSelfWrite('/fake/standalone/a.md', 'MINE');

        const updates: string[] = [];
        let applying = false;
        await watcher.reconcileStandaloneMd({
            filePath: '/fake/standalone/a.md',
            vscodeNs: env.vscodeNs,
            document: env.doc,
            setIsApplying: (b: boolean) => { applying = b; },
            convertContent: (raw: string) => `CONVERTED:${raw}`,
            postUpdate: (c: string) => { updates.push(c); },
        });

        expect(env.state.docContent).toBe('AI_EXTERNAL');
        expect(env.state.saveCount).toBe(1);
        expect(updates).toEqual(['CONVERTED:AI_EXTERNAL']);
        expect(applying, 'setIsApplying が false に戻る').toBe(false);
        // 適用内容は台帳に記録される（残響イベントの再照合が no-op になる）
        expect(registry.isRecentSelfWrite('/fake/standalone/a.md', 'AI_EXTERNAL')).toBe(true);
        registry.clearSelfWrites('/fake/standalone/a.md');
    });

    test('TC-SWR-03 配線 pin: editorProvider.ts が reconcileStandaloneMd を呼ぶ（grep 番人）', () => {
        const src = fsReal.readFileSync(pathReal.resolve(__dirname, '../../src/editorProvider.ts'), 'utf8');
        const hits = (src.match(/reconcileStandaloneMd/g) || []).length;
        expect(hits, 'seam 抽出が本番未配線にならない').toBeGreaterThanOrEqual(1);
        // scheduleEdit の記録配線も対で pin（自己保存の記録が無いと照合が成立しない）
        expect(src).toContain('recordSelfWrite');
    });
});
