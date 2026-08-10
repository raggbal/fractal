/**
 * notetree-file-s3-regression — sprint 20260809-031217-notetree-file-dnd / TASK-06
 *
 * TC-S3-01 (FR-TF-09): S3 転送層は無変更（design §9）。tree file の実体保存先 `files/<name>`
 *   と note の `outline.note` が walkLocalDir の列挙に含まれることを behavioral に固定する。
 *   walkLocalDir はサブディレクトリを再帰 walk するため、新設の files/ 配下も既存のまま転送対象
 *   になる（= S3 側にコード変更が不要）。counterfactual: walkLocalDir が files/ サブディレクトリや
 *   outline.note を除外するようになると、tree file が sync から漏れて RED。
 *
 * TC-RG-01 (NFR-TF-03) wiring 部: 全新設 bridge メソッド（design/system.md §8 の正典 16 個）が
 *   4 層（webview 呼び出し元 → bridge → handler case → provider 実装）すべてに配線されていることを
 *   grep で数え漏れゼロ確認する permanent guard。designer_failures 2026-08-09（attachTreeFileToMd が
 *   散文宣言のみで bridge 一覧・TASK・TC から漏れた「配線台帳の突き合わせ漏れ」）の再発防止。
 *   どれか 1 層でもメソッドが欠けると、欠落 (method, layer) の一覧付きで RED。
 *
 * TC-RG-01 の「既存全 spec 無変更 green」本体は run-parallel-tests.sh + known-red gate
 *   （scripts/check-known-red.sh — collection 成功判定込み）で担保する（この spec 内では固定しない）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { walkLocalDir } from '../../src/s3-per-file-sync';

// ─────────────────────────────────────────────────────────────
// TC-S3-01: walkLocalDir が files/<name> と outline.note を列挙に含む（S3 転送層 無変更の固定）
// ─────────────────────────────────────────────────────────────
test('TC-S3-01 walkLocalDir は files/<name> と outline.note を列挙に含む（S3 転送層 無変更）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notetree-s3-'));
    try {
        // note ルート直下: outline.note（.out 台帳） + md
        fs.writeFileSync(path.join(tmp, 'outline.note'), '{"nodes":[]}');
        fs.writeFileSync(path.join(tmp, 'a.md'), '# A');
        // tree file 実体の保存先 = files/ サブディレクトリ（本 sprint の新設ロケーション）
        fs.mkdirSync(path.join(tmp, 'files'));
        fs.writeFileSync(path.join(tmp, 'files', 'doc.pdf'), 'PDF');
        fs.writeFileSync(path.join(tmp, 'files', 'Report (1).pdf'), 'PDF2'); // 空白・括弧入り実名
        // 既存の images/ サブディレクトリ（回帰対象外だが混在で walk されることも確認）
        fs.mkdirSync(path.join(tmp, 'images'));
        fs.writeFileSync(path.join(tmp, 'images', 'x.png'), 'PNG');

        const keys = new Set(walkLocalDir(tmp).keys());

        // 新設 files/ 実体 + outline.note が転送列挙に含まれる（S3 側の変更不要の根拠）
        expect(keys.has('outline.note')).toBe(true);
        expect(keys.has('files/doc.pdf')).toBe(true);
        expect(keys.has('files/Report (1).pdf')).toBe(true);
        // 既存も引き続き列挙される（additive・回帰なし）
        expect(keys.has('a.md')).toBe(true);
        expect(keys.has('images/x.png')).toBe(true);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ─────────────────────────────────────────────────────────────
// TC-RG-01 (wiring): 新設 bridge メソッド 16 個の 4 層配線 数え漏れゼロ
// ─────────────────────────────────────────────────────────────
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../', rel), 'utf8');

// design/system.md §8 の正典一覧（順不同・attachTreeFileToMd 含む。
// 再オープン③ 2026-08-10: notesRegisterExternalUris（FR-TF-17）を追加 = 12 個。
// design-review SYS-NEW-1: 完了済み TASK-06 の guard は 11 個時点の検証のため、
// 12 個目はこの一覧への追加で regression 網に恒久編入する）
const BRIDGE_METHODS = [
    'openTreeFileExternal',
    'notesImportFileIntoOut',
    'notesAttachFileIntoMd',
    'attachTreeFileToMd',
    'notesImportTreeFileAtPosition',
    'notesRegisterFileFromOutNode',
    'notesRegisterFileFromMdLink',
    'revealTreeFileInOS',
    'copyTreeFilePath',
    'deleteTreeFile',
    'notifyError',
    'notesRegisterExternalUris',
    'attachOutNodeFileToMd',
    'importOutPageNodeToMd',
    'attachMdFileLinkToMd',
    'linkMdSubpageToMd',
];

test('TC-RG-01 wiring: 正典一覧が 16 個ちょうど（§8 と一致・重複なし）', () => {
    expect(BRIDGE_METHODS.length).toBe(16);
    expect(new Set(BRIDGE_METHODS).size).toBe(16);
});

test('TC-RG-01 wiring: 全 16 bridge メソッドが webview→bridge→handler→provider の 4 層に配線済み（数え漏れゼロ）', () => {
    const bridge = read('src/shared/notes-host-bridge.js');
    const handler = read('src/shared/notes-message-handler.ts');
    const provider = read('src/notesEditorProvider.ts');
    // webview 呼び出し元は 3 面のいずれか（panel / outliner / editor）に ≥1 現れれば OK
    const webviewSrc =
        read('src/shared/notes-file-panel.js') +
        '\n' + read('src/webview/outliner.js') +
        '\n' + read('src/webview/editor.js');

    const gaps: string[] = [];
    for (const m of BRIDGE_METHODS) {
        // bridge: メソッド定義 + postMessage の type contract（handler の case と対）
        if (!bridge.includes(`${m}: function`)) gaps.push(`bridge(method-def): ${m}`);
        if (!bridge.includes(`type: '${m}'`)) gaps.push(`bridge(postMessage-type): ${m}`);
        // handler: message type を捌く case（bridge の postMessage と 1:1）
        if (!handler.includes(`case '${m}'`)) gaps.push(`handler(case): ${m}`);
        // provider: platform 実装（handler が platform.<m>(...) で呼ぶ実体）
        if (!provider.includes(`${m}:`)) gaps.push(`provider(impl): ${m}`);
        // webview 呼び出し元（bridge メソッドを呼ぶ起点）が 3 面のどこかに存在
        if (!webviewSrc.includes(m)) gaps.push(`webview(call-site): ${m}`);
    }

    // 欠落があれば (method, layer) を全件出して RED（数え漏れの位置を特定できる）
    expect(gaps, `配線漏れ:\n${gaps.join('\n')}`).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// TC-RG-02 (FR-TF-19 §4m): wiring guard ブロック単位化 — 追報①（attachTreeFileToMd が
// notesMarkdownHostBridge ブロックのみで outlinerHostBridge ブロックに欠落 = Notes sidepanel で
// silent no-op）の恒久封じ。TC-RG-01 のファイル単位 grep はブロック内欠落を検出できない。
// ─────────────────────────────────────────────────────────────

// md editor が SidePanelHostBridge 経由（_mainHost）で呼びうるメソッド集合。
// Notes の _mainHost は面によって別物（main md = notesMarkdownHostBridge / outliner ページ上の
// sidepanel = outlinerHostBridge）のため、両ブロックに揃って定義されていなければならない。
const SIDEPANEL_DELEGATED_METHODS = [
    'linkMdAsSubpageForSidePanel',
    'attachTreeFileToMd',
    'attachOutNodeFileToMd',
    'importOutPageNodeToMd',
    'attachMdFileLinkToMd',
    'linkMdSubpageToMd',
];

// FR-TF-20 (§4n): outliner → host の direct-dispatch メソッド（handler 内 seam を直接呼ぶため
// provider 層を持たない = 3 層検査）。TC-RG-01 の 4 層リストと別建て。
const DIRECT_DISPATCH_METHODS = ['importMdFileLinkIntoOut', 'importMdSubpageIntoOut'];

test('TC-RG-01b wiring: direct-dispatch 2 メソッドが webview→bridge→handler の 3 層に配線済み', () => {
    const bridge = read('src/shared/notes-host-bridge.js');
    const handler = read('src/shared/notes-message-handler.ts');
    const webviewSrc = read('src/webview/outliner.js');
    const gaps: string[] = [];
    for (const m of DIRECT_DISPATCH_METHODS) {
        if (!bridge.includes(`${m}: function`)) gaps.push(`bridge(method-def): ${m}`);
        if (!bridge.includes(`type: '${m}'`)) gaps.push(`bridge(postMessage-type): ${m}`);
        if (!handler.includes(`case '${m}'`)) gaps.push(`handler(case): ${m}`);
        if (!handler.includes(`export function ${m}`)) gaps.push(`handler(seam): ${m}`);
        if (!webviewSrc.includes(m)) gaps.push(`webview(call-site): ${m}`);
    }
    expect(gaps, `配線漏れ:\n${gaps.join('\n')}`).toEqual([]);
});

test('TC-RG-02 wiring(block): sidepanel 委譲メソッドが outlinerHostBridge / notesMarkdownHostBridge の両ブロックに定義済み', () => {
    const bridge = read('src/shared/notes-host-bridge.js');
    // ブロック分割: outlinerHostBridge ブロック = 26 行付近の Object.assign から
    // notesMarkdownHostBridge の Object.assign まで / md ブロック = そこから notesHostBridge まで
    const outStart = bridge.indexOf('window.outlinerHostBridge = Object.assign');
    const mdStart = bridge.indexOf('window.notesMarkdownHostBridge = Object.assign');
    const notesStart = bridge.indexOf('window.notesHostBridge =');
    expect(outStart).toBeGreaterThan(-1);
    expect(mdStart).toBeGreaterThan(outStart);
    expect(notesStart).toBeGreaterThan(mdStart);
    const outBlock = bridge.slice(outStart, mdStart);
    const mdBlock = bridge.slice(mdStart, notesStart);

    const gaps: string[] = [];
    for (const m of SIDEPANEL_DELEGATED_METHODS) {
        if (!outBlock.includes(`${m}: function`)) gaps.push(`outlinerHostBridge block: ${m}`);
        if (!mdBlock.includes(`${m}: function`)) gaps.push(`notesMarkdownHostBridge block: ${m}`);
    }
    // counterfactual: 追報①時点の code base では outlinerHostBridge block: attachTreeFileToMd が gap = RED
    expect(gaps, `ブロック単位の配線漏れ（追報①クラス）:\n${gaps.join('\n')}`).toEqual([]);
});
