/**
 * TASK-30 — batch payload 正規化の共有ヘルパ（`src/shared/batch-payload.js`）
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-MSEL-02/04 / §4-1）
 *
 * 出典: reviewer iteration 1 **QUAL-3** — `treeBatchIds`（outliner.js）と `batchIdsOf`
 * （notes-folder-view.js）が **関数名以外 byte 一致**の 8 行を別名で複製していた。
 * 本 sprint 自身が `menu-placement.js` の冒頭で「同型の字面コピーで両方とも負値ガードを
 * 欠いていた実績がある」と名指し警告している失敗クラスの再現だったため、
 * 同 sprint で確立した**共有ヘルパ + 6 点登録**のパターンへ寄せる。
 *
 * 🔴 counterfactual: 6 点登録のいずれか 1 点を外すと「登録の番人」が RED になる
 * （1 点漏れると面単位で silent no-op = generator_failures 2026-08-17）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const MODULE_PATH = path.join(ROOT, 'src', 'shared', 'batch-payload.js');

/** モジュールを素の Node コンテキストで評価して window に載る関数を取り出す。 */
function loadModule(): any {
    const src = fs.readFileSync(MODULE_PATH, 'utf8');
    const win: any = {};
    // eslint-disable-next-line no-new-func
    new Function('window', src)(win);
    return win.__batchPayload;
}

test.describe('batch-payload — extractBatchIds() の挙動（§4-1 後方互換）', () => {
    test('新形式 { v:1, items:[…] } から id 配列を取り出す', () => {
        const bp = loadModule();
        expect(bp, 'window.__batchPayload が公開されていない').toBeTruthy();
        expect(bp.extractBatchIds({ v: 1, items: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b']);
    });

    test('旧形式（単一オブジェクト）は 1 件として読む（既存の単一 drop TC を壊さない）', () => {
        const bp = loadModule();
        expect(bp.extractBatchIds({ id: 'solo' })).toEqual(['solo']);
    });

    test('null / undefined / 空配列 / id 無しは落とす', () => {
        const bp = loadModule();
        expect(bp.extractBatchIds(null)).toEqual([]);
        expect(bp.extractBatchIds(undefined)).toEqual([]);
        expect(bp.extractBatchIds({ v: 1, items: [] })).toEqual([]);
        expect(bp.extractBatchIds({ v: 1, items: [{ id: 'a' }, null, { }, { id: 'b' }] })).toEqual(['a', 'b']);
    });

    test('items が配列でない値は旧形式として 1 件に落ちる（壊れた payload で無反応にしない）', () => {
        const bp = loadModule();
        // `items` が配列でなければ payload 自身を 1 件として扱う（0 件にすると drop が無反応になる）。
        // ⚠️ `extractBatchIds` は「id を持つ item の id」しか返さないので、payload 自身に id が無い
        // このケースでは 0 件になるのが正しい。件数の番人は `extractBatchItems` で見る。
        expect(bp.extractBatchItems({ v: 1, items: { id: 'x' } }).length, '壊れた payload で 0 件になった').toBe(1);
        expect(bp.extractBatchIds({ v: 1, items: { id: 'x' } }), 'payload 自身に id は無い').toEqual([]);
        // 旧形式（payload 自身が id を持つ）は 1 件として id が取れる
        expect(bp.extractBatchIds({ id: 'legacy' })).toEqual(['legacy']);
    });

    test('extractBatchItems() は id を持たない要素も含めて返す（fv の relPath 系が使う）', () => {
        const bp = loadModule();
        expect(bp.extractBatchItems({ v: 1, items: [{ relPath: 'a.txt' }, { relPath: 'b.txt' }] }))
            .toEqual([{ relPath: 'a.txt' }, { relPath: 'b.txt' }]);
        expect(bp.extractBatchItems({ relPath: 'solo.txt' })).toEqual([{ relPath: 'solo.txt' }]);
    });
});

test.describe('batch-payload — 重複の解消（QUAL-3 の番人）', () => {
    test('🔴 正規化イディオムがソース全体で共有ヘルパ 1 箇所だけになっている', () => {
        // `Array.isArray(payload.items) ? payload.items : [payload]` の字面が
        // 共有ヘルパ以外に残っていたら、また別々に drift する
        const idiom = 'Array.isArray(payload.items) ? payload.items : [payload]';
        const hits: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) { walk(p); continue; }
                if (!/\.(js|ts)$/.test(e.name)) { continue; }
                if (fs.readFileSync(p, 'utf8').includes(idiom)) { hits.push(path.relative(ROOT, p)); }
            }
        };
        walk(path.join(ROOT, 'src'));
        expect(hits, `正規化イディオムが複数箇所に残っている: ${hits.join(', ')}`)
            .toEqual(['src/shared/batch-payload.js']);
    });

    test('🔴 treeBatchIds / batchIdsOf の重複定義が消えている', () => {
        const outliner = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'outliner.js'), 'utf8');
        const fv = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'notes-folder-view.js'), 'utf8');
        expect(outliner.includes('function treeBatchIds('),
            'outliner.js に重複関数 treeBatchIds が残っている').toBe(false);
        expect(fv.includes('function batchIdsOf('),
            'notes-folder-view.js に重複関数 batchIdsOf が残っている').toBe(false);
        // 代わりに共有ヘルパを参照している
        expect(outliner.includes('__batchPayload'), 'outliner.js が共有ヘルパを使っていない').toBe(true);
        expect(fv.includes('__batchPayload'), 'notes-folder-view.js が共有ヘルパを使っていない').toBe(true);
    });
});

test.describe('batch-payload — 6 点登録（menu-placement と同じパターン）', () => {
    test('ハーネス build 生成器 3 本が batch-payload を読み込んでいる', () => {
        for (const gen of ['build-standalone-notes.js', 'build-standalone-outliner.js', 'build-standalone.js']) {
            const src = fs.readFileSync(path.join(ROOT, 'test', gen), 'utf8');
            expect(src.includes('batch-payload'),
                `${gen} が batch-payload を読み込んでいない（面単位で silent no-op になる）`).toBe(true);
        }
    });

    test('生成済みハーネス HTML 3 本に定義マーカーが含まれる', () => {
        for (const html of ['standalone-notes.html', 'standalone-outliner.html', 'standalone-editor.html']) {
            const p = path.join(ROOT, 'test', 'html', html);
            if (!fs.existsSync(p)) { continue; }   // 未ビルドの面はスキップ（gate 側でビルドされる）
            expect(fs.readFileSync(p, 'utf8').includes('window.__batchPayload'),
                `${html} に batch-payload が埋め込まれていない`).toBe(true);
        }
    });

    test('本番 webview 3 面の生成 HTML に定義マーカーが含まれる', () => {
        // Module._load stub + require の spec は「require 前 purge」と「finally purge」を対で書く
        // （generator_failures 2026-08-17）
        const Module = require('module');
        const SRC_PREFIX = path.join(ROOT, 'src') + path.sep;
        const origLoad = (Module as any)._load;
        const purge = () => {
            for (const k of Object.keys(require.cache)) {
                if (k.startsWith(SRC_PREFIX)) { delete require.cache[k]; }
            }
        };
        const vscodeStub: any = {
            Uri: {
                file: (p: string) => ({ fsPath: p, scheme: 'file', path: p, toString: () => 'file://' + p }),
                joinPath: (base: any, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }),
            },
            env: { openExternal: () => Promise.resolve(true), language: 'en' },
            workspace: { getConfiguration: () => ({ get: () => undefined }) },
            window: {},
            ExtensionMode: { Production: 1, Development: 2, Test: 3 },
        };

        purge();
        (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
            if (request === 'vscode') { return vscodeStub; }
            return origLoad.apply(this, [request, parent, isMain]);
        };
        try {
            const notes = require(path.join(ROOT, 'src', 'notesWebviewContent'));
            const outliner = require(path.join(ROOT, 'src', 'outlinerWebviewContent'));
            const editor = require(path.join(ROOT, 'src', 'webviewContent'));
            const webviewStub = {
                cspSource: 'vscode-webview://test',
                asWebviewUri: (u: any) => ({ toString: () => 'vscode-webview://res' + (u?.fsPath || '') }),
            } as any;
            const extUri = { fsPath: ROOT, scheme: 'file', path: ROOT, toString: () => 'file://' + ROOT } as any;
            const config = { theme: 'light', fontSize: 14, webviewMessages: {} };

            const notesHtml: string = notes.getNotesWebviewContent(webviewStub, extUri, config, {
                jsonContent: '{"rootIds":[],"nodes":{}}', fileList: [], currentFilePath: null, panelCollapsed: false,
            });
            const outlinerHtml: string = outliner.getOutlinerWebviewContent(
                webviewStub, extUri, '{"rootIds":[],"nodes":{}}', config);
            const editorHtml: string = editor.getWebviewContent(webviewStub, extUri, '# md\n', config);

            expect(notesHtml, 'notesWebviewContent に batch-payload が inline されていない')
                .toContain('window.__batchPayload');
            expect(outlinerHtml, 'outlinerWebviewContent に batch-payload が inline されていない')
                .toContain('window.__batchPayload');
            expect(editorHtml, 'webviewContent（standalone md editor）に batch-payload が inline されていない')
                .toContain('window.__batchPayload');
        } finally {
            (Module as any)._load = origLoad;
            purge();
        }
    });
});
