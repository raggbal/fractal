/**
 * MindmapLayout group 余白 unit — sprint 20260727-084500-mindmap-group-overlap
 * TC-GO-01〜05
 *
 * バグ: layout が group（render が bbox+pad14+label帯 で後描き）を知らず、
 * 隣接 group 同士 / group と非メンバー node が重なる。
 * 修正: compute の第 6 引数（省略可）で groups を受け、spacing/スタッキングに余白を足す。
 *
 * 固定 measure で決定論検証。矩形交差は「render と同じ式」（group: メンバー bbox + pad、
 * node: measure 由来の外接）で判定する。
 */

import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ML = require('../../src/webview/mindmap-layout.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OutlinerModel = require('../../src/webview/outliner-model.js');

const measure = () => ({ width: 100, height: 30 });
const SET = { layout: 'right', siblingSpacing: 16, levelSpacing: 80 };
const PAD = 14;      // render の group pad（mindmap-render.js buildGroupEls と同値）
const LABEL_H = 18;  // label 帯の概算高（枠上端の外側に出る）

function tree(nodes: any, rootIds: string[]) {
    return new OutlinerModel({ version: 1, rootIds, nodes });
}

/** render の buildNodeEl と同じ外接（right 側: [x, x+w] / 縦: y±h/2） */
function nodeRect(positions: any, id: string) {
    const p = positions[id];
    const m = measure();
    const loX = p.x < 0 ? p.x - m.width : p.x;
    const hiX = p.x < 0 ? p.x : p.x + m.width;
    return { x1: loX, y1: p.y - m.height / 2, x2: hiX, y2: p.y + m.height / 2 };
}

/** render の buildGroupEls と同じ group 枠（メンバー bbox + pad。label 帯は上に LABEL_H） */
function groupRect(positions: any, memberIds: string[], withLabel = false) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const id of memberIds) {
        const r = nodeRect(positions, id);
        x1 = Math.min(x1, r.x1); y1 = Math.min(y1, r.y1);
        x2 = Math.max(x2, r.x2); y2 = Math.max(y2, r.y2);
    }
    return { x1: x1 - PAD, y1: y1 - PAD - (withLabel ? LABEL_H : 0), x2: x2 + PAD, y2: y2 + PAD };
}

function intersects(a: any, b: any) {
    return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

/** 兄弟 3 subtree: r1(g1: r1+c1), r2(非メンバー), r3(g2: r3+c3) — スクリーンショットの再現形 */
function twoGroupModel() {
    return tree({
        r1: { id: 'r1', parentId: null, children: ['c1a', 'c1b'], text: 'Q1' },
        c1a: { id: 'c1a', parentId: 'r1', children: [], text: 'kickoff' },
        c1b: { id: 'c1b', parentId: 'r1', children: [], text: 'research' },
        r2: { id: 'r2', parentId: null, children: ['c2a', 'c2b'], text: 'Q2' },
        c2a: { id: 'c2a', parentId: 'r2', children: [], text: 'core api' },
        c2b: { id: 'c2b', parentId: 'r2', children: [], text: 'onboarding' },
        r3: { id: 'r3', parentId: null, children: [], text: 'beta' },
    }, ['r1', 'r2', 'r3']);
}

const G1 = { id: 'g1', nodeIds: ['r1', 'c1a', 'c1b'], label: 'aaa', color: null };
const G2 = { id: 'g2', nodeIds: ['r2', 'c2a', 'c2b'], label: 'bbb', color: null };

/**
 * 同一 root 配下の**隣接兄弟 subtree** を group にした形（2026-09-05 / 裁定 R33 で追加）。
 * root 間の縦積みが実 measure 高さ基準になった（TASK-81 / FR-MMS-01）ため、root どうしの間隔は
 * 常に 60px 空く → group 枠が要求する余白（下辺 PAD 14 + 上辺 PAD+LABEL 32 = 46）を上回り、
 * **root レベルでは groups を渡さなくても枠が交差しなくなった**（旧 counterfactual が成立しない）。
 * group 余白が今も load-bearing なのは「同じ root の中で兄弟 subtree が siblingSpacing(16) で
 * 詰まる」経路（flextree の ft.spacing に GROUP_EXTRA を足す）なので、退化検出はそこで行う。
 */
function siblingGroupModel() {
    return tree({
        root: { id: 'root', parentId: null, children: ['s1', 's2'], text: 'root' },
        s1: { id: 's1', parentId: 'root', children: ['s1a'], text: 'Q1' },
        s1a: { id: 's1a', parentId: 's1', children: [], text: 'kickoff' },
        s2: { id: 's2', parentId: 'root', children: ['s2a'], text: 'Q2' },
        s2a: { id: 's2a', parentId: 's2', children: [], text: 'core api' },
    }, ['root']);
}
const SG1 = { id: 'g1', nodeIds: ['s1', 's1a'], label: 'aaa', color: null };
const SG2 = { id: 'g2', nodeIds: ['s2', 's2a'], label: 'bbb', color: null };

test.describe('MindmapLayout group spacing (TC-GO)', () => {

    test('TC-GO-01 ★load-bearing: 隣接 group 同士が重ならない（counterfactual: 兄弟 subtree で groups 未指定なら交差）', () => {
        // counterfactual は「同じ root 配下の兄弟 subtree」で取る（siblingGroupModel の注記参照。
        // root レベルは裁定 R33 で 60px 空くようになり、groups 無しでも交差しなくなった）。
        const sm = siblingGroupModel();
        const sbase = ML.compute(sm, { ...SET }, measure);
        expect(intersects(groupRect(sbase.positions, SG1.nodeIds, true), groupRect(sbase.positions, SG2.nodeIds, true)),
            'pre-fix: 兄弟 subtree の枠が交差しているはず').toBe(true);
        const sr = ML.compute(sm, { ...SET }, measure, undefined, undefined, [SG1, SG2]);
        expect(intersects(groupRect(sr.positions, SG1.nodeIds, true), groupRect(sr.positions, SG2.nodeIds, true)),
            'post-fix: 兄弟 subtree の枠が離れる').toBe(false);

        // root レベル（別 root の group 同士）も交差しない。groups 有無いずれでも成立する
        // （R33 以降は root 間 60px が group 枠の要求余白 46px を上回るため）。
        const m = twoGroupModel();
        const r = ML.compute(m, { ...SET }, measure, undefined, undefined, [G1, G2]);
        expect(intersects(groupRect(r.positions, G1.nodeIds, true), groupRect(r.positions, G2.nodeIds, true)),
            'post-fix: root レベルの枠が離れる').toBe(false);
    });

    test('TC-GO-02 group と非メンバー node が重ならない', () => {
        const m = twoGroupModel();
        const r = ML.compute(m, { ...SET }, measure, undefined, undefined, [G1, G2]);
        // g2 の枠 vs 非メンバー r3/c1a…（全非メンバー node と交差なし）
        const g1 = groupRect(r.positions, G1.nodeIds, true);
        const g2 = groupRect(r.positions, G2.nodeIds, true);
        const members = new Set([...G1.nodeIds, ...G2.nodeIds]);
        for (const id of Object.keys(r.positions)) {
            if (members.has(id)) continue;
            expect(intersects(g1, nodeRect(r.positions, id)), `g1 vs ${id}`).toBe(false);
            expect(intersects(g2, nodeRect(r.positions, id)), `g2 vs ${id}`).toBe(false);
        }
    });

    test('TC-GO-03 後方互換: groups 無し/空配列は従来と同一 positions', () => {
        const m = twoGroupModel();
        const a = ML.compute(m, { ...SET }, measure);
        const b = ML.compute(m, { ...SET }, measure, undefined, undefined, []);
        const c = ML.compute(m, { ...SET }, measure, undefined, undefined, undefined);
        for (const id of Object.keys(a.positions)) {
            expect(b.positions[id], `[] ${id}`).toEqual(a.positions[id]);
            expect(c.positions[id], `undefined ${id}`).toEqual(a.positions[id]);
        }
    });

    test('TC-GO-04 balanced 経路（title 中心）でも group 余白が効く', () => {
        const m = twoGroupModel();
        const r = ML.compute(m, { layout: 'balanced', siblingSpacing: 16, levelSpacing: 80 },
            measure, 'Center', undefined, [G1, G2]);
        const g1 = groupRect(r.positions, G1.nodeIds, true);
        const g2 = groupRect(r.positions, G2.nodeIds, true);
        expect(intersects(g1, g2)).toBe(false);
    });

    test('TC-GO-05 hideNode と併用: filter で消えたメンバーは無視され例外なし', () => {
        const m = twoGroupModel();
        const hidden = (id: string) => id === 'r1'; // g1 の root ごと非表示
        const r = ML.compute(m, { ...SET }, measure, undefined, hidden, [G1, G2]);
        expect(r.positions.r1).toBeUndefined();
        // 生き残りの g2 と非メンバーは交差なし・例外なし
        const g2 = groupRect(r.positions, G2.nodeIds, true);
        expect(intersects(g2, nodeRect(r.positions, 'r3'))).toBe(false);
    });
});
