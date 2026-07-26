/**
 * MindmapLayout unit tests (sprint 20260701-122355-outliner-mindmap-mode)
 * TC-140〜149, TC-148b (radial no-overlap)
 * 固定 measure を注入して決定論的に検証する。
 */

import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ML = require('../../src/webview/mindmap-layout.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OutlinerModel = require('../../src/webview/outliner-model.js');

const measure = () => ({ width: 100, height: 30 });

function tree(nodes: any, rootIds: string[]) {
    return new OutlinerModel({ version: 1, rootIds, nodes });
}

test.describe('MindmapLayout.compute', () => {
    test('TC-140 right: child is right of parent', () => {
        const m = tree({
            n1: { id: 'n1', parentId: null, children: ['n2'], text: 'a' },
            n2: { id: 'n2', parentId: 'n1', children: [], text: 'b' }
        }, ['n1']);
        const r = ML.compute(m, { layout: 'right', siblingSpacing: 16, levelSpacing: 80 }, measure);
        expect(r.positions.n2.x).toBeGreaterThan(r.positions.n1.x);
    });

    test('TC-141 left: child is left of parent', () => {
        const m = tree({
            n1: { id: 'n1', parentId: null, children: ['n2'], text: 'a' },
            n2: { id: 'n2', parentId: 'n1', children: [], text: 'b' }
        }, ['n1']);
        const r = ML.compute(m, { layout: 'left', siblingSpacing: 16, levelSpacing: 80 }, measure);
        expect(r.positions.n2.x).toBeLessThan(r.positions.n1.x);
    });

    test('TC-142 balanced: some children right, some left', () => {
        const m = tree({
            n1: { id: 'n1', parentId: null, children: ['a', 'b', 'c', 'd'], text: 'r' },
            a: { id: 'a', parentId: 'n1', children: [], text: 'a' },
            b: { id: 'b', parentId: 'n1', children: [], text: 'b' },
            c: { id: 'c', parentId: 'n1', children: [], text: 'c' },
            d: { id: 'd', parentId: 'n1', children: [], text: 'd' }
        }, ['n1']);
        const r = ML.compute(m, { layout: 'balanced', siblingSpacing: 16, levelSpacing: 80 }, measure);
        const anyRight = ['a', 'b', 'c', 'd'].some(k => r.positions[k].x > r.positions.n1.x);
        const anyLeft = ['a', 'b', 'c', 'd'].some(k => r.positions[k].x < r.positions.n1.x);
        expect(anyRight && anyLeft).toBe(true);
    });

    test('TC-143 radial (=left/right both-sides): children split L/R, no angle field', () => {
        // sync 2026-07-01: radial は左右両側に再定義。angle 廃止・balanced と同一。
        const m = tree({
            n1: { id: 'n1', parentId: null, children: ['a', 'b', 'c', 'd'], text: 'r' },
            a: { id: 'a', parentId: 'n1', children: [], text: 'a' },
            b: { id: 'b', parentId: 'n1', children: [], text: 'b' },
            c: { id: 'c', parentId: 'n1', children: [], text: 'c' },
            d: { id: 'd', parentId: 'n1', children: [], text: 'd' }
        }, ['n1']);
        const r = ML.compute(m, { layout: 'radial', siblingSpacing: 16, levelSpacing: 80 }, measure);
        // 極座標廃止: angle フィールドは無い
        expect(r.positions.a.angle).toBeUndefined();
        // 子が中心の左右に分かれる (balanced と同じ)
        const anyRight = ['a', 'b', 'c', 'd'].some(k => r.positions[k].x > r.positions.n1.x);
        const anyLeft = ['a', 'b', 'c', 'd'].some(k => r.positions[k].x < r.positions.n1.x);
        expect(anyRight && anyLeft).toBe(true);
    });

    test('TC-133b title center node: __title__ at center, roots are its L/R children', () => {
        const m = tree({
            n1: { id: 'n1', parentId: null, children: [], text: 'R1' },
            n2: { id: 'n2', parentId: null, children: [], text: 'R2' }
        }, ['n1', 'n2']);
        const r = ML.compute(m, { layout: 'radial', siblingSpacing: 16, levelSpacing: 80 }, measure, 'My Map');
        expect(r.positions['__title__']).toBeTruthy();
        // title→n1, title→n2 links
        const titleLinks = r.links.filter((l: any) => l.sourceId === '__title__');
        expect(titleLinks.map((l: any) => l.targetId).sort()).toEqual(['n1', 'n2']);
        // roots split L/R of title
        const tx = r.positions['__title__'].x;
        const oneRight = r.positions.n1.x > tx || r.positions.n2.x > tx;
        const oneLeft = r.positions.n1.x < tx || r.positions.n2.x < tx;
        expect(oneRight && oneLeft).toBe(true);
    });

    test('TC-133b-empty: empty title → no center node', () => {
        const m = tree({ n1: { id: 'n1', parentId: null, children: [], text: 'R1' } }, ['n1']);
        const r = ML.compute(m, { layout: 'radial' }, measure, '');
        expect(r.positions['__title__']).toBeUndefined();
        expect(r.positions.n1).toBeTruthy();
    });

    test('TC-144 empty tree', () => {
        const r = ML.compute(tree({}, []), { layout: 'right' }, measure);
        expect(Object.keys(r.positions)).toHaveLength(0);
        expect(r.links).toHaveLength(0);
        expect(Number.isFinite(r.bounds.minX)).toBe(true);
    });

    test('TC-145 single node', () => {
        const m = tree({ n1: { id: 'n1', parentId: null, children: [], text: 'a' } }, ['n1']);
        const r = ML.compute(m, { layout: 'right' }, measure);
        expect(Object.keys(r.positions)).toHaveLength(1);
        expect(r.links).toHaveLength(0);
    });

    test('TC-146 collapsed: children not placed', () => {
        const m = tree({
            n1: { id: 'n1', parentId: null, children: ['n2'], text: 'a', collapsed: true },
            n2: { id: 'n2', parentId: 'n1', children: [], text: 'b' }
        }, ['n1']);
        const r = ML.compute(m, { layout: 'right' }, measure);
        expect(r.positions.n2).toBeUndefined();
        expect(r.links.some((l: any) => l.targetId === 'n2')).toBe(false);
    });

    test('TC-147 variable size: siblings do not overlap', () => {
        const m = tree({
            n1: { id: 'n1', parentId: null, children: ['a', 'b', 'c'], text: 'r' },
            a: { id: 'a', parentId: 'n1', children: [], text: 'a' },
            b: { id: 'b', parentId: 'n1', children: [], text: 'b' },
            c: { id: 'c', parentId: 'n1', children: [], text: 'c' }
        }, ['n1']);
        const r = ML.compute(m, { layout: 'right', siblingSpacing: 16, levelSpacing: 80 }, measure);
        const ys = ['a', 'b', 'c'].map(k => r.positions[k].y).sort((x, y) => x - y);
        const minGap = Math.min(ys[1] - ys[0], ys[2] - ys[1]);
        expect(minGap).toBeGreaterThanOrEqual(30 + 16 - 1);
    });

    test('TC-148 floating topic uses its own coords', () => {
        const m = tree({ nF: { id: 'nF', parentId: null, children: [], text: 'f', mindmap: { x: 200, y: 120 } } }, []);
        const r = ML.compute(m, { layout: 'right' }, measure);
        expect(r.positions.nF).toBeTruthy();
        expect(r.positions.nF.x).toBe(200);
        expect(r.positions.nF.y).toBe(120);
    });

    test('TC-148b radial: no two nodes overlap', () => {
        const nodes: any = { R: { id: 'R', parentId: null, children: ['s1', 's2', 's3', 's4', 's5'], text: 'R' } };
        ['s1', 's2', 's3', 's4', 's5'].forEach(s => {
            nodes[s] = { id: s, parentId: 'R', children: [s + 'a', s + 'b'], text: s };
            nodes[s + 'a'] = { id: s + 'a', parentId: s, children: [], text: s + 'a' };
            nodes[s + 'b'] = { id: s + 'b', parentId: s, children: [], text: s + 'b' };
        });
        const r = ML.compute(tree(nodes, ['R']), { layout: 'radial', siblingSpacing: 16, levelSpacing: 80 }, measure);
        const ids = Object.keys(r.positions);
        let minDist = Infinity;
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const a = r.positions[ids[i]], b = r.positions[ids[j]];
                minDist = Math.min(minDist, Math.hypot(a.x - b.x, a.y - b.y));
            }
        }
        expect(minDist).toBeGreaterThanOrEqual(8);
    });

    test('TC-149 findAdjacent', () => {
        const m = tree({
            n1: { id: 'n1', parentId: null, children: ['n2'], text: 'a' },
            n2: { id: 'n2', parentId: 'n1', children: [], text: 'b' }
        }, ['n1']);
        const r = ML.compute(m, { layout: 'right', siblingSpacing: 16, levelSpacing: 80 }, measure);
        expect(ML.findAdjacent(r.positions, 'n1', 'right', 'right')).toBe('n2');
        expect(ML.findAdjacent(r.positions, 'n2', 'left', 'right')).toBe('n1');
    });
});
