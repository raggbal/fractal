/**
 * fix-notes-roundtrip-paste-stale-clip TASK-01 — selectClipSource 純関数
 *
 * 根本原因: webview の paste が貼り付け先自身の internalClipboard を plainText 一致だけで
 * 最優先採用し、copy では internalClipboard を消さないため、round-trip 2 回目に古い
 * internalClipboard（stale pageId）が新しい OS crossMeta（正しい pageId）をシャドウする。
 *
 * 修正: copy 時に一意 copyId(nonce) を internalClipboard と OS crossMeta の両方へ刻み、
 * paste 時は「copyId 一致（= 同一コピー操作）」の時だけ internalClipboard を採用する。
 * 不一致 or crossMeta が新しいなら crossMeta を優先。
 *
 * TC-CS-01（round-trip stale シャドウ解消）と TC-CS-06（後方互換 copyId 無し）が
 * LOAD-BEARING。counterfactual コメントを付す。
 */
import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { selectClipSource } = require('../../src/webview/outliner-clip-select.js');

test.describe('selectClipSource', () => {
    // TC-CS-01（load-bearing: round-trip の stale シャドウを解消）
    // a の古い internalClip（copyId='c1', pageId='p1'）が、b→a paste で
    // 新しい OS crossMeta（copyId='c2', pageId='pB'）と同一 plainText で衝突するケース。
    test('TC-CS-01 round-trip: nonce 不一致なら crossMeta を採用（stale internal をシャドウしない）', () => {
        const internalClip = {
            plainText: 'node A',
            isCut: false,
            nodes: [{ pageId: 'p1' }],
            sourceOutFileKey: 'A',
            copyId: 'c1',
        };
        const crossMeta = {
            nodes: [{ pageId: 'pB' }],
            isCut: false,
            sourceOutFileKey: 'B',
            copyId: 'c2',
        };
        const result = selectClipSource(internalClip, crossMeta, 'node A');
        expect(result).not.toBeNull();
        expect(result.source).toBe('cross');
        expect(result.nodes[0].pageId).toBe('pB');
        // counterfactual: 旧ロジック（plainText 一致で internal 優先）だと pageId='p1'（stale）を返す。
        // すなわち result.nodes[0].pageId === 'p1' なら退行（バグ再発）。
        expect(result.nodes[0].pageId).not.toBe('p1');
    });

    // TC-CS-02（同一コピー操作: nonce 一致で internal 採用＝高速路維持）
    test('TC-CS-02 nonce 一致なら internal を採用（webview ローカル情報の高速路）', () => {
        const internalClip = {
            plainText: 'node A',
            isCut: false,
            nodes: [{ pageId: 'p1', columnValues: { x: 1 } }],
            sourceOutFileKey: 'A',
            copyId: 'c1',
        };
        const crossMeta = {
            nodes: [{ pageId: 'p1' }],
            isCut: false,
            sourceOutFileKey: 'A',
            copyId: 'c1',
        };
        const result = selectClipSource(internalClip, crossMeta, 'node A');
        expect(result).not.toBeNull();
        expect(result.source).toBe('internal');
        expect(result.nodes[0].pageId).toBe('p1');
    });

    // TC-CS-03（crossMeta のみ = 別 webview からの通常 cross paste）
    test('TC-CS-03 internal 無し・crossMeta あり → cross を採用', () => {
        const crossMeta = {
            nodes: [{ pageId: 'pX' }],
            isCut: false,
            sourceOutFileKey: 'X',
            copyId: 'c9',
        };
        const result = selectClipSource(null, crossMeta, 'anything');
        expect(result).not.toBeNull();
        expect(result.source).toBe('cross');
        expect(result.nodes[0].pageId).toBe('pX');
        expect(result.sourceOutFileKey).toBe('X');
    });

    // TC-CS-04（internal のみ = OS クリップボード API 失敗時 fallback）
    test('TC-CS-04 crossMeta 無し・internal テキスト一致 → internal を採用（fallback）', () => {
        const internalClip = {
            plainText: 'x',
            isCut: false,
            nodes: [{ pageId: 'p1' }],
            sourceOutFileKey: 'A',
            copyId: 'c1',
        };
        const result = selectClipSource(internalClip, null, 'x');
        expect(result).not.toBeNull();
        expect(result.source).toBe('internal');
        expect(result.nodes[0].pageId).toBe('p1');
    });

    // TC-CS-05（plainText 不一致の internal は無視）
    test('TC-CS-05 internal の plainText 不一致・crossMeta 無し → null', () => {
        const internalClip = {
            plainText: 'old',
            isCut: false,
            nodes: [{ pageId: 'p1' }],
            sourceOutFileKey: 'A',
            copyId: 'c1',
        };
        const result = selectClipSource(internalClip, null, 'new');
        expect(result).toBeNull();
    });

    // TC-CS-06（load-bearing: 後方互換 copyId 無し旧 internal + crossMeta あり → crossMeta 優先）
    // 前バージョンで積まれた copyId 無しの internalClip は nonce 照合できないので、
    // OS クリップボードを真実として stale シャドウを防ぐ。
    test('TC-CS-06 backward-compat: copyId 無し internal + crossMeta → cross を採用', () => {
        const internalClip = {
            plainText: 'node A',
            isCut: false,
            nodes: [{ pageId: 'p1' }],
            sourceOutFileKey: 'A',
            // copyId 無し（旧データ）
        };
        const crossMeta = {
            nodes: [{ pageId: 'pB' }],
            isCut: false,
            sourceOutFileKey: 'B',
            // copyId 無し（旧データ）
        };
        const result = selectClipSource(internalClip, crossMeta, 'node A');
        expect(result).not.toBeNull();
        expect(result.source).toBe('cross');
        expect(result.nodes[0].pageId).toBe('pB');
        // counterfactual: copyId 無し同士を「undefined===undefined で一致」と誤判定すると
        // internal（stale pageId='p1'）が勝ってしまう → 退行。
        expect(result.nodes[0].pageId).not.toBe('p1');
    });

    // TC-CS-07（cut フラグの伝播）
    test('TC-CS-07 cut フラグが cross / internal どちらの採用でも伝播する', () => {
        // cross 採用（nonce 不一致）で isCut=true
        const internalClipA = {
            plainText: 'n',
            isCut: false,
            nodes: [{ pageId: 'p1' }],
            sourceOutFileKey: 'A',
            copyId: 'c1',
        };
        const crossMetaCut = {
            nodes: [{ pageId: 'pB' }],
            isCut: true,
            sourceOutFileKey: 'B',
            copyId: 'c2',
        };
        const r1 = selectClipSource(internalClipA, crossMetaCut, 'n');
        expect(r1.source).toBe('cross');
        expect(r1.isCut).toBe(true);

        // internal 採用（nonce 一致）で isCut=true
        const internalClipCut = {
            plainText: 'n',
            isCut: true,
            nodes: [{ pageId: 'p1' }],
            sourceOutFileKey: 'A',
            copyId: 'c1',
        };
        const crossMetaSame = {
            nodes: [{ pageId: 'p1' }],
            isCut: true,
            sourceOutFileKey: 'A',
            copyId: 'c1',
        };
        const r2 = selectClipSource(internalClipCut, crossMetaSame, 'n');
        expect(r2.source).toBe('internal');
        expect(r2.isCut).toBe(true);
    });
});
