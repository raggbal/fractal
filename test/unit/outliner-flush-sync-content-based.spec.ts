/**
 * v0.207.40: outliner.js の flushSync が content-based に skip するかの unit test
 *
 * 修正内容:
 *   - flushSync は serializeForSave() == lastSentJson の時 skip (= 編集なしなら何もしない)
 *   - syncToHostImmediate 末尾で lastSentJson 更新
 *   - init / applyExternalUpdate / applySyncedData / fileChangeId 付き updateData で baseline 更新
 *
 * 検証方針:
 *   - source-grep ベース (関数本体が webview / VSCode API に強く依存して direct unit test 困難)
 *   - 重要 invariant が source に残ってるか確認
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const projectRoot = path.resolve(__dirname, '../..');
const outlinerJsPath = path.join(projectRoot, 'src/webview/outliner.js');

let outlinerSrc: string;

test.beforeAll(() => {
    outlinerSrc = fs.readFileSync(outlinerJsPath, 'utf8');
});

test.describe('outliner.js flushSync content-based skip (v0.207.40)', () => {
    test('lastSentJson 変数が宣言されている', () => {
        expect(outlinerSrc).toMatch(/var\s+lastSentJson\s*=\s*null;/);
    });

    test('serializeForSave() ヘルパー関数が定義されている', () => {
        expect(outlinerSrc).toMatch(/function\s+serializeForSave\s*\(\s*\)\s*\{/);
    });

    test('serializeForSave() が JSON.stringify(data, null, 2) を返す', () => {
        // serializeForSave 関数本体の最後で stringify を return
        const m = outlinerSrc.match(/function\s+serializeForSave\s*\(\s*\)\s*\{([\s\S]*?)\n\s{4}\}/);
        expect(m, 'serializeForSave 関数本体が見つからない').toBeTruthy();
        if (m) {
            expect(m[1]).toContain('return JSON.stringify(data, null, 2)');
        }
    });

    test('syncToHostImmediate が lastSentJson を更新する', () => {
        // syncToHostImmediate 関数本体に lastSentJson = jsonString が含まれる
        const m = outlinerSrc.match(/function\s+syncToHostImmediate\s*\(\s*\)\s*\{([\s\S]*?)\n\s{4}\}/);
        expect(m, 'syncToHostImmediate 関数本体が見つからない').toBeTruthy();
        if (m) {
            expect(m[1]).toContain('lastSentJson = jsonString');
            // host.syncData の引数も jsonString 経由 (= serializeForSave の結果)
            expect(m[1]).toMatch(/host\.syncData\(jsonString\)/);
        }
    });

    test('flushSync が content-based に skip 判定する', () => {
        // window.Outliner.flushSync の関数本体
        const m = outlinerSrc.match(/flushSync:\s*function\s*\(\s*\)\s*\{([\s\S]*?)\n\s{8}\}/);
        expect(m, 'flushSync 関数本体が見つからない').toBeTruthy();
        if (m) {
            const body = m[1];
            // current = serializeForSave() を計算
            expect(body).toMatch(/var\s+current\s*=\s*serializeForSave\(\)/);
            // current !== lastSentJson の判定
            expect(body).toMatch(/current\s*!==\s*lastSentJson/);
            // 違う時だけ syncToHostImmediate を呼ぶ
            expect(body).toContain('syncToHostImmediate()');
            // model 不在 guard
            expect(body).toMatch(/if\s*\(!model\)\s*return/);
        }
    });

    test('init() 末尾で lastSentJson を初期化する (file load 直後 = disk と一致)', () => {
        // init 関数本体の終わり (= focusFirstVisibleNode 周辺) に lastSentJson 代入があるか
        const m = outlinerSrc.match(/function\s+init\s*\(\s*data,\s*outFileKey\s*\)\s*\{([\s\S]*?)\n\s{4}\}\n/);
        expect(m, 'init 関数本体が見つからない').toBeTruthy();
        if (m) {
            expect(m[1]).toMatch(/lastSentJson\s*=\s*serializeForSave\(\)/);
        }
    });

    test('applyExternalUpdate 末尾で lastSentJson を更新する', () => {
        const m = outlinerSrc.match(/function\s+applyExternalUpdate\s*\(\s*data\s*\)\s*\{([\s\S]*?)\n\s{4}\}\n/);
        expect(m, 'applyExternalUpdate 関数本体が見つからない').toBeTruthy();
        if (m) {
            expect(m[1]).toMatch(/lastSentJson\s*=\s*serializeForSave\(\)/);
        }
    });

    // ('applySyncedData の data 適用後 lastSentJson を更新する' の TC は、
    //  applySyncedData が outliner ヘッダー S3 sync 専用関数として削除されたため除去
    //  sprint 20260721-112357-remove-outliner-header-s3sync)

    test('updateData (fileChangeId 付き) 経路で lastSentJson 更新する', () => {
        // case 'updateData' の fileChangeId 分岐内に lastSentJson 代入
        const m = outlinerSrc.match(/case\s+'updateData':[\s\S]*?if\s*\(msg\.fileChangeId[\s\S]*?break;/);
        expect(m, 'updateData fileChangeId 分岐が見つからない').toBeTruthy();
        if (m) {
            expect(m[0]).toMatch(/lastSentJson\s*=\s*serializeForSave\(\)/);
        }
    });

    test('regression guard: flushSync 旧実装 (無条件 syncToHostImmediate) が残ってない', () => {
        // 旧: flushSync: function() { if (model) syncToHostImmediate(); }
        // 新: 上記の content-based 実装
        // 旧版が混入していないことを保証
        const oldImpl = /flushSync:\s*function\s*\(\s*\)\s*\{\s*if\s*\(model\)\s*syncToHostImmediate\(\);?\s*\}/;
        expect(outlinerSrc).not.toMatch(oldImpl);
    });
});
