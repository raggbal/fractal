/**
 * 選択色トークンの構造的検査（FR-OSC-01 rev2 / NFR-OSM-04 / NFR-MSEL-04 rev3 / ADRL-0115）
 * sprint 20260906-095357-outliner-selmode-cmda-linkedfd-multimove
 *
 * 計算後の色は e2e（outliner-select-mode.spec.ts TC-OSM-30..32/36/37）が見る。
 * ここは「**定義が 3 ブロックすべてに入っているか**」「**禁止トークンを黄色にしていないか**」という
 * 計算後の色では検出できない構造を見る（1 ブロックだけ直すと theme 切替で旧色が残る = 前 sprint TASK-84 の構造弱点）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function rgb(s: string) {
    const m = s.match(/rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)(?:[,\s/]+([0-9.]+))?/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
}

test('TC-OSM-33 --outliner-selection-bg の 3 定義すべてが amber で、間接参照が残っていない', () => {
    const css = read('src/webview/outliner.css');
    const defs = css.split('\n').filter((l) => /--outliner-selection-bg\s*:/.test(l));
    expect(defs.length, `--outliner-selection-bg の定義数が 3 でない（1 箇所だけ直すと theme 切替で旧色が残る）: ${defs.length}`).toBe(3);
    for (const d of defs) {
        const c = rgb(d);
        expect(c, `値が rgba() で読めない: ${d.trim()}`).not.toBeNull();
        expect(c!.r, `amber でない定義がある（R>B が成り立たない）: ${d.trim()}`).toBeGreaterThan(c!.b);
        expect(c!.g, `amber でない定義がある（G>B が成り立たない）: ${d.trim()}`).toBeGreaterThan(c!.b);
        // 🔴 --fr-bg-selection は未定義 fallback で mindmap.css と共用。間接参照を残すと
        //    将来 --fr-bg-selection が定義された瞬間に outliner が mindmap と一緒に色を変える（D1 違反）
        expect(d, `var(--fr-bg-selection …) の間接参照が残っている（mindmap と連動してしまう）: ${d.trim()}`)
            .not.toContain('--fr-bg-selection');
    }
    // light（@layer fr-legacy :root）と dark（[data-fr-theme] / prefers-color-scheme）で別値
    const alphas = defs.map((d) => rgb(d)!.a);
    expect(new Set(alphas).size, `light / dark で同一 alpha（白地でほぼ不可視になる旧構造のまま）: ${alphas.join(',')}`).toBeGreaterThan(1);
});

test('TC-OSM-34 禁止トークンが黄色になっていない（他 3 面へ波及させない）', () => {
    // --fr-color-selection-bg: note tree / linkedfd の複数選択・linkedfd の drop-into・outliner の focus 行・hover と共用
    const tokens = read('src/webview/tokens.css');
    const frSel = tokens.split('\n').filter((l) => /--fr-color-selection-bg\s*:/.test(l));
    expect(frSel.length, '--fr-color-selection-bg の定義が見つからない').toBeGreaterThan(0);
    for (const l of frSel) {
        expect(l, `--fr-color-selection-bg を黄色（amber リテラル）にしている: ${l.trim()}`).not.toMatch(/rgba?\(\s*25[0-9]\s*,\s*(1[0-9]{2}|20[0-9])\s*,/);
    }
    // --fr-bg-selection は **未定義のまま**であること（定義すると mindmap.css の 4 箇所が追随する）
    for (const f of ['src/webview/tokens.css', 'src/webview/outliner.css', 'src/webview/fr-components.css', 'src/webview/styles.css']) {
        const body = read(f);
        const defined = body.split('\n').filter((l) => /^\s*--fr-bg-selection\s*:/.test(l));
        expect(defined.length, `${f} で --fr-bg-selection を定義している（mindmap.css:116/229/370/402 が追随して mindmap も色が変わる）`).toBe(0);
    }
});

test('TC-OSM-35 選択黄は検索ハイライトより薄い（重なっても検索が勝つ）', () => {
    const css = read('src/webview/outliner.css');
    const selAlphas = css.split('\n').filter((l) => /--outliner-selection-bg\s*:/.test(l)).map((l) => rgb(l)!.a);
    // 検索ヒット rgba(255,255,0,0.4) / 現在ヒット rgba(255,165,0,0.6)
    for (const a of selAlphas) {
        expect(a, `選択黄の alpha が検索ヒット(0.4)以上（重なると選択が検索を隠す）: ${a}`).toBeLessThan(0.4);
    }
});

test('TC-OSM-36b caret 非表示ルールがコンテナ class 方式で 1 本だけ定義されている', () => {
    const css = read('src/webview/outliner.css');
    const rules = css.split('\n').filter((l) => /is-select-mode/.test(l));
    expect(rules.length, `.is-select-mode のセレクタが 1 本でない（再描画に強いコンテナ 1 クラス方式を崩している）: ${rules.length}`).toBe(1);
    expect(rules[0], 'コンテナ（.outliner-tree）側に付ける方式になっていない').toContain('.outliner-tree.is-select-mode');
    const idx = css.indexOf(rules[0]);
    const block = css.slice(idx, idx + 240);
    expect(block, 'caret-color: transparent 以外の手段（blur / contenteditable / user-select）を使っている').toContain('caret-color: transparent');
});
