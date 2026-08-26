/**
 * pinch-coefficient-consistency.spec.ts — ピンチ係数の複製リテラル一致番人（TC-VZP-16）
 *
 * sprint 20260825-224210-viewer-zoom-pan TASK-12（reviewer iter1 QUAL-2）。
 * ピンチ係数 exp(-deltaY*K) の K は設計裁定（TASK-01 (b)）により 3+1 箇所へ直書き複製されている:
 *   1. src/webview/viewer-common/pinch-zoom.mjs（kind モジュール共通ゲート）
 *   2. src/webview/file-viewer.js — pdf 直接ハンドラ（非 ESM のため import 不可）
 *   3. src/webview/file-viewer.js — injectZoomHelper の注入 <script> 文字列（html iframe 内）
 *   4. src/webview/mindmap-interactions.js — 元祖（Kiro 実機チューニング済みの K=0.003）
 * 食い違っても構文/実行時エラーにならず kind 間の体感速度だけが silent に分岐するため、
 * fs 読みでリテラルを抽出し全一致を assert する。これは挙動 pin ではなく
 * 「複製リテラルの一致」というテキスト不変条件そのものの番人（source-pin 禁止
 * = generator_failures 2026-08-25 は挙動検証の代用への禁止であり非該当 — reviewer iter1 裁定）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('TC-VZP-16: ピンチ係数リテラルが 3+1 箇所で一致する', () => {
    // 1) pinch-zoom.mjs: Math.exp(-e.deltaY * K)
    const pz = read('src/webview/viewer-common/pinch-zoom.mjs');
    const mPz = pz.match(/Math\.exp\(-e\.deltaY \* ([0-9.]+)\)/);
    expect(mPz, 'pinch-zoom.mjs に係数式がある').toBeTruthy();

    // 2)(3) file-viewer.js: pdf ハンドラ + injectZoomHelper 注入文字列（スペース有無の両形）
    const fv = read('src/webview/file-viewer.js');
    const mFv = Array.from(fv.matchAll(/Math\.exp\(-e\.deltaY\s*\*\s*([0-9.]+)\)/g)).map((m) => m[1]);
    expect(mFv.length, 'file-viewer.js に係数式が 2 箇所（pdf ハンドラ + 注入文字列）').toBe(2);

    // 4) mindmap-interactions.js: var K = 0.003（exp(-dy*K) 形の元祖）
    const mm = read('src/webview/mindmap-interactions.js');
    const mMm = mm.match(/var K = ([0-9.]+);/);
    expect(mMm, 'mindmap-interactions.js に K 定義がある').toBeTruthy();

    const all = [mPz![1], ...mFv, mMm![1]];
    for (const v of all) {
        expect(v, `全箇所の係数が一致（実測: ${JSON.stringify(all)}）`).toBe(all[0]);
    }
});
