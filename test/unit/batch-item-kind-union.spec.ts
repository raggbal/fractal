/**
 * TASK-04 — host batch 契約の kind 判別可能 union 化
 * sprint 20260910-053026-folder-payload-canon-multifolder-move
 * FR-FDP-03 / ADRL-0125 / INV-2 / NFR-FDP-07
 *
 * TC-KIND-1: 未知 kind を黙って捨てない（検出させる）
 * TC-KIND-2: folder kind が正規化を通る
 * TC-KIND-3: md / file 枝の既存フィールドが全部残る
 * TC-KIND-4: 型 2 系統の併存が解消されている
 *
 * 番人: `normalizeTreeBatchItems` の網羅検査を allowlist の `continue` に戻すと落ちる。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) { delete require.cache[key]; }
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
                window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: () => {} },
                env: {}, ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try { return require(modulePath); } finally { Module._load = origLoad; purgeSrcCache(); }
}
const mod = () => requireWithVscodeStub('../../src/shared/notes-message-handler');

test.describe('TASK-04 batch item の kind union', () => {
    test('TC-KIND-1: 未知 kind を黙って捨てない（処理 + 除外の合計が入力件数と一致）', () => {
        const { normalizeTreeBatchItems } = mod();
        const rejected: Array<{ raw: unknown; reason: string }> = [];
        const raw = [
            { kind: 'md', id: 'm1', filePath: '/n/a.md' },
            { kind: 'unknown', id: 'x1' },
            { kind: 'file', id: 'f1' },
            { kind: 'md' },                 // id 欠落
            { kind: 'folder', id: 'd1' },
        ];
        const items = normalizeTreeBatchItems(raw, (r: unknown, reason: string) => rejected.push({ raw: r, reason }));
        // 3 件処理 + 2 件検出 = 入力 5 件（黙って消えるものが無い = INV-2）
        expect(items).toHaveLength(3);
        expect(rejected).toHaveLength(2);
        expect(items.length + rejected.length).toBe(raw.length);
        expect(rejected.map((r) => r.reason).sort()).toEqual(['missing_id', 'unknown_kind']);
    });

    test('TC-KIND-2: folder kind が正規化を通る', () => {
        const { normalizeTreeBatchItems } = mod();
        const items = normalizeTreeBatchItems([{ kind: 'folder', id: 'd1' }]);
        expect(items).toEqual([{ kind: 'folder', id: 'd1', filePath: null }]);
    });

    test('TC-KIND-3: md / file 枝の既存フィールドが全部残る（契約を縮めない）', () => {
        const { normalizeTreeBatchItems } = mod();
        const items = normalizeTreeBatchItems([
            { kind: 'md', id: 'm1', filePath: '/n/a.md' },
            { kind: 'file', id: 'f1' },
        ]);
        // 旧契約と同一のキー集合・値（filePath は md のみ実値・file は null）
        expect(items[0]).toEqual({ kind: 'md', id: 'm1', filePath: '/n/a.md' });
        expect(items[1]).toEqual({ kind: 'file', id: 'f1', filePath: null });
        expect(Object.keys(items[0]).sort()).toEqual(['filePath', 'id', 'kind']);
    });

    test('TC-KIND-4: 型 2 系統の併存が解消されている（無検証の文字列種別を受け付けない）', () => {
        const src = fs.readFileSync(path.join(SRC_PREFIX, 'shared', 'notes-message-handler.ts'), 'utf8');
        // `srcKind: string` の無検証宣言が残っていない（union の kind に寄せた）
        expect(/srcKind:\s*string/.test(src), '無検証の srcKind: string が残っている（型 2 系統の併存）').toBe(false);
        expect(src.includes('srcKind: TreeBatchKind')).toBe(true);
        // 判別可能 union + 網羅検査が存在する
        expect(src.includes('export type TreeBatchItem =')).toBe(true);
        expect(src.includes('assertNeverKind')).toBe(true);
        // allowlist の silent skip 構造が残っていない
        expect(/x\.kind !== 'md' && x\.kind !== 'file'\) \|\| !x\.id\) \{ continue; \}/.test(src)).toBe(false);
        // provider 側の 4 つの platform batch が網羅 switch になっている
        const prov = fs.readFileSync(path.join(SRC_PREFIX, 'notesEditorProvider.ts'), 'utf8');
        expect((prov.match(/case 'folder': return \{ ok: false, reason: 'kind_unsupported' \}/g) || []).length,
            'folder を理由付き除外にする分岐が 4 つの platform batch に揃っていない').toBe(4);
        expect((prov.match(/default: return assertNeverKind\(it\)/g) || []).length).toBe(4);
    });

    test('TC-KIND-5: runPlatformBatch が理由付き除外を集計に載せる（folder の受け皿）', async () => {
        const { runPlatformBatch } = mod();
        const outcomes: any[] = [];
        const r = await runPlatformBatch(
            [{ kind: 'md', id: 'm1' }, { kind: 'folder', id: 'd1' }, { kind: 'file', id: 'f1' }],
            (it: any) => (it.kind === 'folder' ? { ok: false, reason: 'kind_unsupported' } : true),
            {
                confirmLarge: () => true,
                notifyLimitExceeded: () => { /* noop */ },
                notifyOutcome: (o: any) => outcomes.push(o),
            }
        );
        expect(r.verdict).toBe('ok');
        expect(r.outcome.succeeded).toBe(2);
        // 🔴 「受け手が扱えない種別」は **failed ではなく skipped**（= 除外）として集計される。
        // これが FR-FDP-07 の「除外件数を集計通知に載せる」の受け皿（既存 runBatchTransfer の意味論）。
        expect(r.outcome.skipped).toBe(1);
        expect(r.outcome.failed).toBe(0);
        expect(r.outcome.reasons.kind_unsupported).toBe(1);
        // 除外があるので集計通知が 1 回出る（黙って落とさない = INV-2）
        expect(outcomes).toHaveLength(1);
    });

    test('TC-B5-partial: folderViewMoveInBatch に通知抑止 3 点セットが入っている（B-5 の片方）', () => {
        const src = fs.readFileSync(path.join(SRC_PREFIX, 'shared', 'notes-message-handler.ts'), 'utf8');
        const i = src.indexOf('export async function folderViewMoveInBatch');
        expect(i).toBeGreaterThan(-1);
        const body = src.slice(i, i + 2600);
        expect(body.includes('quietDeps'), 'per-item トーストの抑止が無い').toBe(true);
        expect(body.includes('quietSender'), '一覧再送の抑止が無い').toBe(true);
        expect(body.includes('folderViewListResult'), '一覧再送をループ後 1 回にまとめていない').toBe(true);
    });
});
