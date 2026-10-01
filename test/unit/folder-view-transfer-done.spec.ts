/**
 * linkedfd の転送完了通知（folderViewTransferDone）— provider 側
 * sprint 20260930-192647-linkedfd-conflict-rename-and-paste-sibling
 * FR-FVT-01 / INV-11 改訂 / DOM-TransferDoneSignal
 *
 * provider の platform 実装は resolveCustomEditor のクロージャ内で組まれ seam が無いため、
 * 完了通知の送出を export 関数 `runFolderViewTransfer` に切り出してそれを直接踏む
 * （designer_failures 2026-08-07: behavioral TC には seam を切る）。
 * 加えて platform の folderViewMove / folderViewMoveBatch がこの関数を通ることをソースで固定する。
 *
 * TC-FVT-01: 結末（成功 / false / throw）によらず完了通知を 1 回送る
 * TC-FVT-02: batch の verdict 非 ok（件数ゲート拒否）でも 1 回送る
 * TC-FVT-05: dispose 後で postMessage が throw しても reject しない
 * 番人: finally を外して成功時だけ送ると TC-FVT-01(b)(c)(d) / TC-FVT-02 が落ちる
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
                commands: { executeCommand: () => {}, registerCommand: () => ({ dispose: () => {} }) },
                window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: () => {} },
                env: {}, ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try { return require(modulePath); } finally { Module._load = origLoad; purgeSrcCache(); }
}

function recorder() {
    const msgs: any[] = [];
    return { msgs, sender: { postMessage: (m: any) => { msgs.push(m); } } };
}
const doneCount = (msgs: any[], id: string) =>
    msgs.filter((m) => m && m.type === 'folderViewTransferDone' && m.folderLinkId === id).length;

test.describe('転送完了通知（provider / FR-FVT-01）', () => {
    test('TC-FVT-01: 結末によらず folderViewTransferDone を 1 回送る', async () => {
        const { runFolderViewTransfer } = requireWithVscodeStub('../../src/notesEditorProvider');
        expect(typeof runFolderViewTransfer, 'runFolderViewTransfer が export されていない').toBe('function');
        // (a) 成功
        let r = recorder();
        await runFolderViewTransfer(r.sender, 'fl1', async () => true);
        expect(doneCount(r.msgs, 'fl1'), '(a) 成功').toBe(1);
        // (b) 同一位置 move = false（一覧再送なし）
        r = recorder();
        await runFolderViewTransfer(r.sender, 'fl1', async () => false);
        expect(doneCount(r.msgs, 'fl1'), '(b) no-op').toBe(1);
        // (c) IntoSelf 拒否 = false（エラー通知のみ）
        r = recorder();
        await runFolderViewTransfer(r.sender, 'fl1', async () => { r.msgs.push({ type: 'err' }); return false; });
        expect(doneCount(r.msgs, 'fl1'), '(c) IntoSelf').toBe(1);
        // (d) throw
        r = recorder();
        await expect(runFolderViewTransfer(r.sender, 'fl1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(doneCount(r.msgs, 'fl1'), '(d) throw でも送る').toBe(1);
    });

    test('TC-FVT-02: batch の verdict 非 ok（件数ゲート拒否）でも 1 回送る', async () => {
        const { runFolderViewTransfer } = requireWithVscodeStub('../../src/notesEditorProvider');
        const r = recorder();
        await runFolderViewTransfer(r.sender, 'fl2', async () => ({ verdict: 'cancel', outcome: { succeeded: 0 } }));
        expect(doneCount(r.msgs, 'fl2')).toBe(1);
        expect(r.msgs.filter((m) => m.type === 'folderViewListResult')).toEqual([]);
    });

    test('TC-FVT-05: dispose 後で postMessage が throw しても reject しない', async () => {
        const { runFolderViewTransfer } = requireWithVscodeStub('../../src/notesEditorProvider');
        const sender = { postMessage: () => { throw new Error('Webview is disposed'); } };
        await expect(runFolderViewTransfer(sender, 'fl1', async () => true)).resolves.not.toThrow();
    });

    test('TC-FVT-01b: platform の folderViewMove / folderViewMoveBatch が runFolderViewTransfer を通る', () => {
        const code = fs.readFileSync(path.join(SRC_PREFIX, 'notesEditorProvider.ts'), 'utf8');
        for (const name of ['folderViewMove', 'folderViewMoveBatch']) {
            const re = new RegExp(`\\n\\s*${name}: async \\([^)]*\\) => \\{\\s*\\n\\s*await runFolderViewTransfer\\(senderRef, id,`);
            expect(re.test(code), `platform.${name} が完了通知の seam を通っていない`).toBe(true);
        }
    });
});
