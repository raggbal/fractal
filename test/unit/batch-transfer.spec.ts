/**
 * TASK-22 — 複数選択 D&D の batch 基盤（payload / 件数上限 / 集計通知）
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit /
 *  FR-MSEL-02/04 / NFR-MSEL-02/03 / NFR-NDA-03 / §4-1 §4-3b §4-4）
 *
 * TC-MSEL-19（同期読み取り）/ TC-MSEL-20（後方互換）/ TC-MSEL-24（2001 件で 0 件処理）/
 * TC-MSEL-25（201 件超の modal キャンセルで no-op）。
 *
 * 🔴 番人の主眼は **「0 件処理」が本当に 0 件であること**（部分実行の検出）と
 * **「1 件の失敗が別の item の source を消さない」**こと（generator_failures 2026-08-22 の禁止パターン）。
 */
import { test, expect } from '@playwright/test';
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

function mh(): any { return requireWithVscodeStub('../../src/shared/notes-message-handler'); }
function fi(): any { return requireWithVscodeStub('../../src/shared/folder-import'); }

/** 呼び出しを記録する deps。confirmLarge の返値を差し替えられる。 */
function makeDeps(opts?: { confirm?: boolean }) {
    const calls = { confirmLarge: [] as number[], limitExceeded: [] as string[], outcomes: [] as any[] };
    return {
        calls,
        deps: {
            confirmLarge: (n: number) => { calls.confirmLarge.push(n); return opts?.confirm !== false; },
            notifyLimitExceeded: (e: string) => { calls.limitExceeded.push(e); },
            notifyOutcome: (o: any) => { calls.outcomes.push(o); },
        },
    };
}

test.describe('TC-MSEL-20 batch payload の後方互換（§4-1）', () => {
    test('新形式 { v:1, items:[…] } と旧形式（単一オブジェクト）の両方を読む', () => {
        const { readBatchItems } = mh();
        expect(readBatchItems({ v: 1, items: [{ id: 'a' }, { id: 'b' }] }), '新形式が読めない')
            .toEqual([{ id: 'a' }, { id: 'b' }]);
        // 旧形式 = 1 件（既存の単一 drop TC が無変更で green になる根拠）
        expect(readBatchItems({ id: 'abc' }), '旧形式が 1 件として読めない').toEqual([{ id: 'abc' }]);
        // null / undefined / items:[] は 0 件
        expect(readBatchItems(null)).toEqual([]);
        expect(readBatchItems(undefined)).toEqual([]);
        expect(readBatchItems({ v: 1, items: [] })).toEqual([]);
        // items 内の null は落とす（後段で undefined 参照させない）
        expect(readBatchItems({ v: 1, items: [{ id: 'a' }, null, { id: 'b' }] as any }))
            .toEqual([{ id: 'a' }, { id: 'b' }]);
    });

    test('items が配列でない値（オブジェクト / 文字列）は旧形式として 1 件に落ちる', () => {
        const { readBatchItems } = mh();
        // 壊れた payload を 0 件にしてしまうと「drop が無反応」になるので 1 件に落とす
        expect(readBatchItems({ v: 1, items: { id: 'x' } } as any).length).toBe(1);
    });
});

test.describe('TC-MSEL-19 batch の全件処理（NFR-NDA-03）', () => {
    test('5 件すべてが処理される（1 件も落ちない）', async () => {
        const { runBatchTransfer } = mh();
        const { deps, calls } = makeDeps();
        const seen: string[] = [];
        const items = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
        const r = await runBatchTransfer(items, async (it: any) => { seen.push(it.id); return { ok: true }; }, deps);
        expect(seen, `処理順と件数: ${seen.join(',')}`).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(r.outcome.succeeded).toBe(5);
        expect(r.outcome.failed + r.outcome.skipped).toBe(0);
        // 全成功なら通知を出さない（成功時のノイズ通知を作らない）
        expect(calls.outcomes.length, '全成功で通知が出た').toBe(0);
    });

    test('1 件の失敗が他の件に波及しない（rollback なし・禁止パターンの検出器）', async () => {
        const { runBatchTransfer } = mh();
        const { deps, calls } = makeDeps();
        // 「source を消した item」を記録して、失敗した item 以外が消えていることを確認する。
        // 禁止パターン（allOk フラグ + 2 周目で削除）だと **1 件も消えない** か
        // **失敗した item まで消える**ので、この 2 点で弁別できる。
        const deleted: string[] = [];
        const items = [{ id: 'ok1' }, { id: 'bad' }, { id: 'ok2' }];
        const r = await runBatchTransfer(items, async (it: any) => {
            if (it.id === 'bad') { throw new Error('copy failed'); }
            deleted.push(it.id);     // 複製成功 → その item の source を消す（同一イテレーション内）
            return { ok: true };
        }, deps);

        expect(deleted, '成功した item の source だけが消えていない').toEqual(['ok1', 'ok2']);
        expect(deleted, '失敗した item の source が消えた（データロス）').not.toContain('bad');
        expect(r.outcome.succeeded).toBe(2);
        expect(r.outcome.failed).toBe(1);
        // NFR-MSEL-03: 通知は 1 回だけ（アイテム毎ではない）
        expect(calls.outcomes.length, '通知が 1 回でない').toBe(1);
        expect(calls.outcomes[0].failed).toBe(1);
        expect(calls.outcomes[0].reasons['copy failed']).toBe(1);
    });

    test('skip 理由が集計される（アイテム毎通知にしない）', async () => {
        const { runBatchTransfer } = mh();
        const { deps, calls } = makeDeps();
        const items = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }];
        await runBatchTransfer(items, async (it: any) =>
            (it.id === '1' ? { ok: true } : { ok: false, reason: 'unsupported' }), deps);
        expect(calls.outcomes.length, '通知が 1 回でない').toBe(1);
        expect(calls.outcomes[0].skipped).toBe(3);
        expect(calls.outcomes[0].reasons.unsupported).toBe(3);
    });
});

test.describe('TC-MSEL-24 / 25 件数上限ゲート（NFR-MSEL-02 / §4-3b）', () => {
    test('TC-MSEL-24 2001 件は 1 件も処理されない + 上限通知 1 回', async () => {
        const { runBatchTransfer } = mh();
        const { deps, calls } = makeDeps();
        const items = Array.from({ length: 2001 }, (_, i) => ({ id: String(i) }));
        let processed = 0;
        const r = await runBatchTransfer(items, async () => { processed += 1; return { ok: true }; }, deps);

        expect(r.verdict).toBe('abort');
        expect(processed, `2001 件で ${processed} 件処理された（部分実行）`).toBe(0);
        expect(calls.limitExceeded, '上限通知が 1 回でない').toEqual(['too_many']);
        // modal は出さない（上限超過は問答無用で中断）
        expect(calls.confirmLarge.length, '上限超過で confirm modal が出た').toBe(0);
    });

    test('TC-MSEL-25 201 件の modal でキャンセル → 1 件も処理されない', async () => {
        const { runBatchTransfer } = mh();
        const { deps, calls } = makeDeps({ confirm: false });
        const items = Array.from({ length: 201 }, (_, i) => ({ id: String(i) }));
        let processed = 0;
        const r = await runBatchTransfer(items, async () => { processed += 1; return { ok: true }; }, deps);

        expect(r.verdict).toBe('cancel');
        expect(processed, `キャンセルなのに ${processed} 件処理された（部分実行）`).toBe(0);
        expect(calls.confirmLarge, 'confirm modal が 1 回でない / 件数が違う').toEqual([201]);
    });

    test('TC-MSEL-25b 201 件の modal で続行 → 201 件すべて処理される', async () => {
        const { runBatchTransfer } = mh();
        const { deps, calls } = makeDeps({ confirm: true });
        const items = Array.from({ length: 201 }, (_, i) => ({ id: String(i) }));
        let processed = 0;
        const r = await runBatchTransfer(items, async () => { processed += 1; return { ok: true }; }, deps);
        expect(r.verdict).toBe('ok');
        expect(processed, '続行を選んだのに全件処理されない').toBe(201);
        expect(calls.confirmLarge).toEqual([201]);
    });

    test('200 件以下は modal を出さずそのまま実行', async () => {
        const { runBatchTransfer } = mh();
        const { deps, calls } = makeDeps();
        const items = Array.from({ length: 200 }, (_, i) => ({ id: String(i) }));
        let processed = 0;
        await runBatchTransfer(items, async () => { processed += 1; return { ok: true }; }, deps);
        expect(processed).toBe(200);
        expect(calls.confirmLarge.length, '200 件で modal が出た（閾値は 200 超）').toBe(0);
    });

    test('🔴 第 3 の上限実装を書いていない: 閾値は FR-OIF-03 の定数を共有している', async () => {
        const { checkBatchLimit, FOLDER_IMPORT_MAX_FILES, FOLDER_IMPORT_CONFIRM_THRESHOLD } = fi();
        expect(FOLDER_IMPORT_MAX_FILES, 'FR-OIF-03 の上限が変わった').toBe(2000);
        expect(FOLDER_IMPORT_CONFIRM_THRESHOLD, 'FR-OIF-03 の modal 閾値が変わった').toBe(200);

        // 境界を定数から導出して確認（数値のハードコードで二重管理しない）
        const { deps } = makeDeps();
        expect(await checkBatchLimit(FOLDER_IMPORT_MAX_FILES, deps)).toBe('ok');
        expect(await checkBatchLimit(FOLDER_IMPORT_MAX_FILES + 1, deps)).toBe('abort');
        expect(await checkBatchLimit(FOLDER_IMPORT_CONFIRM_THRESHOLD, deps)).toBe('ok');

        const cancel = makeDeps({ confirm: false });
        expect(await checkBatchLimit(FOLDER_IMPORT_CONFIRM_THRESHOLD + 1, cancel.deps)).toBe('cancel');
    });

    test('深さ判定は適用しない（フラットな行集合に階層の概念が無い）', async () => {
        const { checkBatchLimit } = fi();
        const { deps, calls } = makeDeps();
        await checkBatchLimit(5, deps);
        expect(calls.limitExceeded, "'too_deep' が発火した（深さ判定を持ち込んでいる）").toEqual([]);
    });
});
