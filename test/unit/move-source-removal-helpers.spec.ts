/**
 * TC-SRC-06/07/08 — 移動系「source 除去」共通ヘルパ（sprint 20260819-210558 TASK-03/04）
 *
 * - removeMdAnchorAndEcho: removeMdAnchorFromFile（fs 正典）+ webview エコーの 2 段を 1 関数に
 *   集約（旧: 裸ペアが notes-message-handler 6 サイト + notesEditorProvider 1 サイトに分散 —
 *   配線漏れ再発クラス = generator_failures 2026-08-14 の根治）
 * - detachOutNodeFileOwnership: .out node の file 所有解除（子なし = node 削除 / 子あり = filePath null）
 *   の字面重複 2 サイトを集約
 *
 * ヘルパは vscode 非依存（fs + sender 注入）— 直接 require で unit 検証。
 * grep 番人は「裸の直呼びが残存しない」ことを実ソースで数える（ヘルパ迂回の再発防止）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'src-helper-'));
}

test('TC-SRC-06 removeMdAnchorAndEcho: fs アンカー除去 + kind 別エコー（payload byte 互換）', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { removeMdAnchorAndEcho } = require('../../src/shared/md-anchor-remove');
    expect(typeof removeMdAnchorAndEcho, 'removeMdAnchorAndEcho 不在').toBe('function');
    const dir = mkTmp();

    // kind='subpage' → removeSubpageLink
    const md1 = path.join(dir, 'a.md');
    fs.writeFileSync(md1, 'x\n[[Sub]](sub.md)\ny\n', 'utf8');
    const msgs1: any[] = [];
    removeMdAnchorAndEcho(md1, 'sub.md', { postMessage: (m: any) => msgs1.push(m) }, 'subpage');
    expect(fs.readFileSync(md1, 'utf8')).not.toContain('(sub.md)');
    expect(msgs1).toEqual([{ type: 'removeSubpageLink', href: 'sub.md', sourceMdPath: md1 }]);

    // kind='file' → removeFileLink
    const md2 = path.join(dir, 'b.md');
    fs.writeFileSync(md2, '[📎 doc.pdf](files/doc.pdf)\n', 'utf8');
    const msgs2: any[] = [];
    removeMdAnchorAndEcho(md2, 'files/doc.pdf', { postMessage: (m: any) => msgs2.push(m) }, 'file');
    expect(fs.readFileSync(md2, 'utf8')).not.toContain('(files/doc.pdf)');
    expect(msgs2).toEqual([{ type: 'removeFileLink', href: 'files/doc.pdf', sourceMdPath: md2 }]);
});

test('TC-SRC-07 grep 番人: removeMdAnchorFromFile の裸直呼びが呼び出し側 2 ファイルに残存しない', () => {
    // 全呼び出し側がヘルパ removeMdAnchorAndEcho を経由する（fs 除去とエコーの片割れ漏れを構造的に防ぐ）。
    // removeMdAnchorFromFile の直呼びは定義元 md-anchor-remove.ts（ヘルパ内部）にのみ許される。
    const nmh = fs.readFileSync(path.join(ROOT, 'src/shared/notes-message-handler.ts'), 'utf8');
    const nep = fs.readFileSync(path.join(ROOT, 'src/notesEditorProvider.ts'), 'utf8');
    const bare = (src: string) => (src.match(/removeMdAnchorFromFile\(/g) || []).length;
    expect(bare(nmh), 'notes-message-handler に裸直呼びが残存').toBe(0);
    expect(bare(nep), 'notesEditorProvider に裸直呼びが残存').toBe(0);
    // ヘルパ経由の呼び出しが実在する（消し忘れでなく置換であることの対の番人）
    const viaHelper = (src: string) => (src.match(/removeMdAnchorAndEcho\(/g) || []).length;
    // 2026-09-05 test_update（sprint 20260901-075849 TASK-69 / TASK-74）: 6 → 8。md リンク → tree md 行の
    // リンク移動（linkMdLinkIntoMdItem）と linkedfd への md リンク移動（folderViewMoveFromMd）がヘルパ経由で加わった
    expect(viaHelper(nmh)).toBe(8);
    expect(viaHelper(nep)).toBe(1);
});

test('TC-SRC-08 detachOutNodeFileOwnership: 子なし=node 削除 / 子あり=filePath null の両分岐 + 重複ブロック残存ゼロ', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    const SRC_PREFIX = path.join(ROOT, 'src') + path.sep;
    const purge = () => { for (const k of Object.keys(require.cache)) { if (k.startsWith(SRC_PREFIX)) delete require.cache[k]; } };
    purge();
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return {
                workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } },
                Uri: { file: (p: string) => ({ fsPath: p }) },
                commands: { executeCommand: () => {} },
                window: { showErrorMessage: () => {}, showInformationMessage: () => {} },
                env: {}, ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    let mh: any;
    try {
        mh = require('../../src/shared/notes-message-handler');
    } finally {
        Module._load = origLoad;
        purge();
    }
    expect(typeof mh.detachOutNodeFileOwnership, 'detachOutNodeFileOwnership 不在').toBe('function');

    // 子なし: node 削除 + rootIds / 親 children から除去
    const data1: any = {
        rootIds: ['p', 'f'],
        nodes: {
            p: { id: 'p', parentId: null, children: ['fc'], text: 'parent' },
            f: { id: 'f', parentId: null, children: [], text: 'root file', filePath: 'files/a.bin' },
            fc: { id: 'fc', parentId: 'p', children: [], text: 'child file', filePath: 'files/b.bin' },
        },
    };
    mh.detachOutNodeFileOwnership(data1, 'f');
    expect(data1.nodes.f).toBeUndefined();
    expect(data1.rootIds).toEqual(['p']);
    mh.detachOutNodeFileOwnership(data1, 'fc');
    expect(data1.nodes.fc).toBeUndefined();
    expect(data1.nodes.p.children).toEqual([]);

    // 子あり: filePath null のみ（node は温存）
    const data2: any = {
        rootIds: ['f'],
        nodes: {
            f: { id: 'f', parentId: null, children: ['c'], text: 'file with child', filePath: 'files/a.bin' },
            c: { id: 'c', parentId: 'f', children: [], text: 'child' },
        },
    };
    mh.detachOutNodeFileOwnership(data2, 'f');
    expect(data2.nodes.f).toBeTruthy();
    expect(data2.nodes.f.filePath).toBeNull();
    expect(data2.rootIds).toEqual(['f']);

    // grep 番人: 同型ブロックの字面重複が消えている（ヘルパ 1 箇所のみ）
    const nmhSrc = fs.readFileSync(path.join(ROOT, 'src/shared/notes-message-handler.ts'), 'utf8');
    const dupBlock = (nmhSrc.match(/delete outData\.nodes\[payload\.nodeId\]/g) || []).length;
    expect(dupBlock, '子なし削除ブロックの字面重複が残存（ヘルパ未集約）').toBe(0);
});
