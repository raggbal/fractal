/**
 * MindmapLayout: root subtree の縦積みを「実 measure 高さ」で行う (裁定 R33 / FR-MMS-01)
 *
 * ★この unit test の存在理由 (2026-09-05 / 裁定 R34 / FR-MMT-01):
 *   R34 で「title が空でも中心ノードを出す」ようになったため、製品の render 経路 (mindmap-render.js は
 *   常に `model.title || ''` を渡す) では root 間縦積みを**通らない** (root はすべて中心ノードの子)。
 *   縦積み経路は「titleText を渡さない compute」= 非 notes / unit 呼び出しだけが通る。
 *   R33 の退化 (概算高さで次の root を 60px 後ろに置き、背の高い box が上の root に食い込む) を
 *   守る番人が browser spec 側から消えるので、算法そのものをここで直接叩く。
 *   実 DOM measure の代わりに固定 measure (long 系だけ背が高い) を注入して決定論的に検証する。
 */

import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ML = require('../../src/webview/mindmap-layout.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OutlinerModel = require('../../src/webview/outliner-model.js');

const ROOT_GAP = 60;
// 実機データ (doc/ggg/mt0wj1x7eaua.out) の形: 空 root と背の高い長文 root が交互に並び、
// さらに「自分は 1 行だが背の高い子を 2 つ持つ root」が続く。
const HEIGHT: Record<string, number> = { e1: 32, long: 180, e2: 32, P: 32, c1: 180, c2: 180, e3: 32 };
const measure = (id: string) => ({ width: 280, height: HEIGHT[id] || 32 });

function fixture() {
    return new OutlinerModel({
        version: 1,
        rootIds: ['e1', 'long', 'e2', 'P', 'e3'],
        nodes: {
            e1: { id: 'e1', parentId: null, children: [], text: '' },
            long: { id: 'long', parentId: null, children: [], text: 'long' },
            e2: { id: 'e2', parentId: null, children: [], text: '' },
            P: { id: 'P', parentId: null, children: ['c1', 'c2'], text: 'parent' },
            c1: { id: 'c1', parentId: 'P', children: [], text: 'long' },
            c2: { id: 'c2', parentId: 'P', children: [], text: 'long' },
            e3: { id: 'e3', parentId: null, children: [], text: '' },
        },
    });
}

// positions は box **中心**の座標。上端/下端は measure 高さの半分で求める。
function topOf(pos: any, ids: string[]) {
    return Math.min(...ids.map((i) => pos[i].y - measure(i).height / 2));
}
function bottomOf(pos: any, ids: string[]) {
    return Math.max(...ids.map((i) => pos[i].y + measure(i).height / 2));
}

const STACK = [['e1'], ['long'], ['e2'], ['P', 'c1', 'c2'], ['e3']];

for (const layout of ['right', 'left']) {
    test(`TC-MMS-01u ${layout}: 隣接 root subtree の間隔が実高さ基準で ROOT_GAP=60 一定`, () => {
        const r = ML.compute(fixture(), { layout }, measure); // titleText を渡さない = 縦積み経路
        expect(r.positions['__title__']).toBeFalsy();         // 中心ノードは出ない (R34: titleText == null)
        for (let i = 1; i < STACK.length; i++) {
            const gap = topOf(r.positions, STACK[i]) - bottomOf(r.positions, STACK[i - 1]);
            expect(Math.abs(gap - ROOT_GAP), `gap before ${STACK[i][0]} = ${gap}`).toBeLessThanOrEqual(1);
        }
    });
}

test('TC-MMS-02u balanced: 同じ列の box が縦に 1 組も重ならない', () => {
    const r = ML.compute(fixture(), { layout: 'balanced' }, measure);
    const ids = Object.keys(r.positions);
    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            const a = ids[i], b = ids[j];
            // 同じ列 (X が一致) の box 同士だけを比較する。列が違えば横にずれているので
            // Y が重なっても box は重ならない (幅は node ごとに違い、ここでは判定材料にしない)。
            if (Math.abs(r.positions[a].x - r.positions[b].x) > 1) { continue; }
            const ah = measure(a).height / 2, bh = measure(b).height / 2;
            const ay = r.positions[a].y, by = r.positions[b].y;
            const oy = Math.min(ay + ah, by + bh) - Math.max(ay - ah, by - bh);
            expect(oy, `${a} X ${b} が縦に重なっている`).toBeLessThanOrEqual(1);
        }
    }
});

// ★load-bearing: 背の高い root を「1 行扱い」で概算すると必ず gap が縮む (旧実装の退化形)。
//   旧コードは復元できないので、概算 (高さ 32 固定) を自分で計算して「60 に届かない」ことを示す。
test('TC-MMS-03u load-bearing: 高さを概算すると背の高い root の直後で間隔が破綻する', () => {
    const r = ML.compute(fixture(), { layout: 'right' }, measure);
    const realGap = topOf(r.positions, ['e2']) - bottomOf(r.positions, ['long']);
    // 概算 (すべて 1 行 = 32px と仮定) で同じ配置を評価すると、long の実高さ 180 が無視され
    // 74px ぶん食い込む (= 実機の「上の root の裏に隠れる」)。
    const approxGap = (r.positions.e2.y - 32 / 2) - (r.positions.long.y + 32 / 2);
    expect(Math.abs(realGap - ROOT_GAP)).toBeLessThanOrEqual(1);
    expect(approxGap).toBeGreaterThan(realGap); // 概算では「空いている」と誤認する
    // 誤差は long の「1 行を超える下半分」= (180 - 32) / 2 = 74px。旧実装はこの 74px を無視して
    // 次の root を置いていたので、実機では上の root の box に 74px 食い込んで裏に隠れた。
    expect(approxGap - realGap).toBeCloseTo((HEIGHT.long - 32) / 2, 0);
});
