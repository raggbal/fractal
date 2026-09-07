/**
 * Export 側の件数上限 parity（FR-CBD-06 / DOM-ExportLimitParity）
 * sprint 20260906-095357-outliner-selmode-cmda-linkedfd-multimove / TASK-03
 *
 * 既存の非対称: import 側は `FOLDER_IMPORT_MAX_FILES = 2000` + `checkBatchLimit` で
 * 「>2000 は列挙段階で中断（コピー 0）」を持つが、**export 側は
 * `FOLDER_EXPORT_CONFIRM_THRESHOLD = 200` しか無く上限中断が存在しなかった**（実測）。
 *
 * 本 sprint の ADRL-0116（Cmd+A の 2 段階 escalation）で「全 node 選択」の到達性が上がるため、
 * 「Cmd+A → cmd+c → linkedfd で cmd+v」で 2000 件超が**無警告で流れる**経路が現実化する。
 * → export 側にも上限中断を入れて import 側と揃える（第 3 のゲートは書かない）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runFolderExport, ExportNode, FOLDER_EXPORT_MAX_FILES, FOLDER_EXPORT_CONFIRM_THRESHOLD } from '../../src/shared/folder-export';

const mk = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const ROOT_DIR = path.resolve(__dirname, '..', '..');

function makeNote() {
    const noteDir = mk('fexlim-note-');
    for (const sub of ['pages', 'files', 'images']) { fs.mkdirSync(path.join(noteDir, sub), { recursive: true }); }
    return noteDir;
}

/** plain node を n 件（資産なし = 出力は空フォルダ / ファイルなし） */
function flatTree(n: number): ExportNode[] {
    const out: ExportNode[] = [];
    for (let i = 0; i < n; i++) { out.push({ text: `n${i}`, children: [] } as any); }
    return out;
}

function makeDeps(noteDir: string, dest: string) {
    const calls = { confirmLarge: 0, notifyDone: 0, notifyLimitExceeded: [] as string[] };
    return {
        calls,
        deps: {
            pickDestination: () => dest,
            confirmLarge: () => { calls.confirmLarge++; return true; },
            notifyDone: () => { calls.notifyDone++; },
            notifyLimitExceeded: (e: string) => { calls.notifyLimitExceeded.push(e); },
            srcOutDir: noteDir,
            srcPagesDir: path.join(noteDir, 'pages'),
            srcFileDir: path.join(noteDir, 'files'),
            srcImageDir: path.join(noteDir, 'images'),
        } as any,
    };
}

test('TC-CBD-51 >2000 件の export は 0 件処理で中断し理由を通知する', async () => {
    const noteDir = makeNote();
    const dest = mk('fexlim-dest-');
    const { deps, calls } = makeDeps(noteDir, dest);

    const r = await runFolderExport(flatTree(FOLDER_EXPORT_MAX_FILES + 1), deps);

    expect(r.status, `>${FOLDER_EXPORT_MAX_FILES} でも中断していない（無警告で 2001 件が流れる）`).toBe('aborted');
    expect((r as any).error, '中断理由が too_many になっていない').toBe('too_many');
    expect(r.folders, '中断なのにフォルダが出力された（部分適用）').toBe(0);
    expect(r.files, '中断なのにファイルが出力された（部分適用）').toBe(0);
    expect(fs.readdirSync(dest).length, '出力先に何か書かれている（0 件処理でない）').toBe(0);
    expect(calls.notifyLimitExceeded, '理由の通知が 1 回でない').toEqual(['too_many']);
    expect(calls.confirmLarge, '上限超過なのに確認 modal を出している（先に中断すべき）').toBe(0);
    expect(calls.notifyDone, '中断なのに完了通知を出している').toBe(0);
});

test('TC-CBD-51b 上限以下は従来どおり（201〜2000 は確認 modal / ≤200 は即実行）', async () => {
    // 201〜2000 帯: 確認 modal が出る（既存 FOLDER_EXPORT_CONFIRM_THRESHOLD の挙動は不変）
    {
        const noteDir = makeNote(); const dest = mk('fexlim-dest-');
        const { deps, calls } = makeDeps(noteDir, dest);
        const r = await runFolderExport(flatTree(FOLDER_EXPORT_CONFIRM_THRESHOLD + 1), deps);
        expect(r.status, '201 件で中断してしまっている（上限は 2000）').toBe('exported');
        expect(calls.confirmLarge, '201 件で確認 modal が出ていない').toBe(1);
        expect(calls.notifyLimitExceeded, '201 件で上限超過を通知している').toEqual([]);
    }
    // ≤200: 確認なしで即実行
    {
        const noteDir = makeNote(); const dest = mk('fexlim-dest-');
        const { deps, calls } = makeDeps(noteDir, dest);
        const r = await runFolderExport(flatTree(10), deps);
        expect(r.status).toBe('exported');
        expect(calls.confirmLarge, '10 件で確認 modal が出ている').toBe(0);
    }
});

test('TC-CBD-51c 上限は import 側と同じ 2000（第 3 の閾値を発明していない）', () => {
    expect(FOLDER_EXPORT_MAX_FILES, 'export 側の上限が import 側（FOLDER_IMPORT_MAX_FILES=2000）と揃っていない').toBe(2000);
    expect(FOLDER_EXPORT_CONFIRM_THRESHOLD, '確認閾値が変わっている（既存挙動を壊している）').toBe(200);
});

test('TC-CBD-52 件数上限の実装が既存 3 点に閉じている（第 3 のゲートを増やしていない）', () => {
    const files = [
        'src/shared/folder-import.ts', 'src/shared/folder-export.ts',
        'src/shared/notes-message-handler.ts', 'src/shared/notes-folder-view.js',
        'src/webview/outliner.js', 'src/shared/notes-file-panel.js', 'src/shared/notes-host-bridge.js',
    ];
    const found: string[] = [];
    for (const f of files) {
        const body = fs.readFileSync(path.join(ROOT_DIR, f), 'utf8');
        // 件数上限の定数定義（MAX_FILES / CONFIRM_THRESHOLD 系）を探す
        for (const line of body.split('\n')) {
            if (/^\s*export const \w*(MAX_FILES|MAX_DEPTH|CONFIRM_THRESHOLD)\w*\s*=/.test(line)) {
                found.push(`${f}: ${line.trim()}`);
            }
        }
    }
    // 期待: import 側 3 定数 + export 側 2 定数 の 5 件だけ（webview 側に閾値を持たない）
    const importDefs = found.filter((x) => x.startsWith('src/shared/folder-import.ts'));
    const exportDefs = found.filter((x) => x.startsWith('src/shared/folder-export.ts'));
    const others = found.filter((x) => !x.startsWith('src/shared/folder-import.ts') && !x.startsWith('src/shared/folder-export.ts'));
    expect(importDefs.length, `import 側の閾値定数が 3 でない: ${importDefs.join(' | ')}`).toBe(3);
    expect(exportDefs.length, `export 側の閾値定数が 2 でない（MAX_FILES + CONFIRM_THRESHOLD）: ${exportDefs.join(' | ')}`).toBe(2);
    expect(others, `件数上限の定数が import / export 以外に増えている（第 3 のゲート）: ${others.join(' | ')}`).toEqual([]);

    // checkBatchLimit の呼び出しも既存 2 箇所に閉じている
    const gateCalls: string[] = [];
    for (const f of ['src/shared/folder-import.ts', 'src/shared/notes-message-handler.ts', 'src/shared/folder-export.ts']) {
        const body = fs.readFileSync(path.join(ROOT_DIR, f), 'utf8');
        body.split('\n').forEach((line, i) => {
            if (/[^\w]checkBatchLimit\s*\(/.test(line) && !/export async function checkBatchLimit/.test(line)) {
                gateCalls.push(`${f}:${i + 1}`);
            }
        });
    }
    expect(gateCalls.length, `checkBatchLimit の呼び出しが 2 箇所でない（ゲートの配線点が増減した）: ${gateCalls.join(' | ')}`).toBe(2);
});
