/**
 * MindmapLayout hideNode 述語 unit tests
 * sprint 20260727-024112-mindmap-task-mode / FR-MT-04 / ADRL-0002
 * TC-MTL-01〜09
 *
 * compute(model, settings, measure, titleText, hideNode) — 第 5 位置引数（省略可・後方互換）。
 * hideNode(id)=true のノードは subtree ごと positions に入らない（collapsed と同強度）。
 * 固定 measure を注入して決定論的に検証する。
 */

import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ML = require('../../src/webview/mindmap-layout.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OutlinerModel = require('../../src/webview/outliner-model.js');

const measure = () => ({ width: 100, height: 30 });
const SET = { layout: 'right', siblingSpacing: 16, levelSpacing: 80 };

function tree(nodes: any, rootIds: string[]) {
    return new OutlinerModel({ version: 1, rootIds, nodes });
}

function hideSet(...ids: string[]) {
    const s = new Set(ids);
    return (id: string) => s.has(id);
}

/** r1 -> n2 -> n3 の 1 本鎖 + 独立 root r9 */
function chainModel() {
    return tree({
        r1: { id: 'r1', parentId: null, children: ['n2'], text: 'root1' },
        n2: { id: 'n2', parentId: 'r1', children: ['n3'], text: 'mid' },
        n3: { id: 'n3', parentId: 'n2', children: [], text: 'leaf' },
        r9: { id: 'r9', parentId: null, children: [], text: 'root9' }
    }, ['r1', 'r9']);
}

test.describe('MindmapLayout hideNode (TC-MTL)', () => {

    test('TC-MTL-01 後方互換: 第 5 引数省略で従来と同一 positions', () => {
        const a = ML.compute(chainModel(), { ...SET }, measure);
        const b = ML.compute(chainModel(), { ...SET }, measure, undefined, undefined);
        expect(Object.keys(a.positions).sort()).toEqual(['n2', 'n3', 'r1', 'r9']);
        expect(Object.keys(b.positions).sort()).toEqual(Object.keys(a.positions).sort());
    });

    test('TC-MTL-02 子の除外: hidden ノード+子孫が positions/links から消える (★load-bearing counterfactual)', () => {
        // counterfactual: hideNode 無しなら n2/n3 は positions に入る（同モデル）
        const base = ML.compute(chainModel(), { ...SET }, measure);
        expect(base.positions.n2).toBeTruthy();
        expect(base.positions.n3).toBeTruthy();

        // fix: hideNode(n2) → n2 と子孫 n3 が消え、link も消える
        const r = ML.compute(chainModel(), { ...SET }, measure, undefined, hideSet('n2'));
        expect(r.positions.r1).toBeTruthy();
        expect(r.positions.r9).toBeTruthy();
        expect(r.positions.n2).toBeUndefined();
        expect(r.positions.n3).toBeUndefined();
        const touchesHidden = r.links.filter(
            (l: any) => l.sourceId === 'n2' || l.targetId === 'n2' || l.sourceId === 'n3' || l.targetId === 'n3');
        expect(touchesHidden).toEqual([]);
    });

    test('TC-MTL-03 root の除外 (linear 経路): hidden root の subtree 全体が消え他 root は残る', () => {
        const r = ML.compute(chainModel(), { ...SET }, measure, undefined, hideSet('r1'));
        expect(r.positions.r1).toBeUndefined();
        expect(r.positions.n2).toBeUndefined();
        expect(r.positions.n3).toBeUndefined();
        expect(r.positions.r9).toBeTruthy();
    });

    test('TC-MTL-04 balanced 経路: hidden root は positions に入らず (:236 前弾き)、kids filter も効く', () => {
        const m = tree({
            r1: { id: 'r1', parentId: null, children: ['c1', 'c2'], text: 'root1' },
            c1: { id: 'c1', parentId: 'r1', children: [], text: 'c1' },
            c2: { id: 'c2', parentId: 'r1', children: [], text: 'c2' },
            r2: { id: 'r2', parentId: null, children: [], text: 'root2' }
        }, ['r1', 'r2']);
        const r = ML.compute(m, { layout: 'balanced', siblingSpacing: 16, levelSpacing: 80 },
            measure, undefined, hideSet('c1', 'r2'));
        expect(r.positions.r1).toBeTruthy();
        expect(r.positions.c1).toBeUndefined(); // kids filter
        expect(r.positions.c2).toBeTruthy();
        expect(r.positions.r2).toBeUndefined(); // hidden root が emitBalanced で positions に入らない
    });

    test('TC-MTL-05 title 経路: makeTitleWrapModel 経由でも hidden 子 root が消え __title__ は残る', () => {
        const m = tree({
            r1: { id: 'r1', parentId: null, children: [], text: 'root1' },
            r2: { id: 'r2', parentId: null, children: [], text: 'root2' }
        }, ['r1', 'r2']);
        const r = ML.compute(m, { layout: 'balanced', siblingSpacing: 16, levelSpacing: 80 },
            measure, 'My Title', hideSet('r1'));
        expect(r.positions.__title__).toBeTruthy();
        expect(r.positions.r1).toBeUndefined();
        expect(r.positions.r2).toBeTruthy();
    });

    test('TC-MTL-06 floating topic の除外', () => {
        const m = tree({
            r1: { id: 'r1', parentId: null, children: [], text: 'root1' },
            f1: { id: 'f1', parentId: null, children: [], text: 'float', mindmap: { x: 5, y: 6 } }
        }, ['r1']);
        const base = ML.compute(m, { ...SET }, measure);
        expect(base.positions.f1).toBeTruthy(); // counterfactual: 述語なしなら floating は載る
        const r = ML.compute(m, { ...SET }, measure, undefined, hideSet('f1'));
        expect(r.positions.f1).toBeUndefined();
        expect(r.positions.r1).toBeTruthy();
    });

    test('TC-MTL-07 4 layout 網羅: right/left/balanced/radial で hidden 子が消える', () => {
        for (const layout of ['right', 'left', 'balanced', 'radial']) {
            const r = ML.compute(chainModel(),
                { layout, siblingSpacing: 16, levelSpacing: 80 },
                measure, undefined, hideSet('n2'));
            expect(r.positions.n2, `layout=${layout}: n2 hidden`).toBeUndefined();
            expect(r.positions.n3, `layout=${layout}: n3 (hidden の子孫) hidden`).toBeUndefined();
            expect(r.positions.r1, `layout=${layout}: r1 visible`).toBeTruthy();
            expect(r.positions.r9, `layout=${layout}: r9 visible`).toBeTruthy();
        }
    });

    test('TC-MTL-08 全滅: 全 root hidden → positions 空・links 空・bounds ゼロ', () => {
        const r = ML.compute(chainModel(), { ...SET }, measure, undefined, hideSet('r1', 'r9'));
        expect(Object.keys(r.positions)).toEqual([]);
        expect(r.links).toEqual([]);
        expect(r.bounds).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
    });

    test('TC-MTL-09 collapsed と AND 併存: 両方消え無関係ノードは残る', () => {
        const m = tree({
            r1: { id: 'r1', parentId: null, children: ['c1'], text: 'root1', collapsed: true },
            c1: { id: 'c1', parentId: 'r1', children: [], text: 'c1' },
            r2: { id: 'r2', parentId: null, children: ['c2', 'c3'], text: 'root2' },
            c2: { id: 'c2', parentId: 'r2', children: [], text: 'c2' },
            c3: { id: 'c3', parentId: 'r2', children: [], text: 'c3' }
        }, ['r1', 'r2']);
        const r = ML.compute(m, { ...SET }, measure, undefined, hideSet('c2'));
        expect(r.positions.r1).toBeTruthy();
        expect(r.positions.c1).toBeUndefined(); // collapsed 由来
        expect(r.positions.c2).toBeUndefined(); // hidden 由来
        expect(r.positions.c3).toBeTruthy();    // 無関係は残る
        expect(r.positions.r2).toBeTruthy();
    });
});
