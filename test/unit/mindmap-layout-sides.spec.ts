/**
 * Mindmap layout — iteration 5: title 中心での right/left 尊重 + 左右安定化 (Wave 9)
 * TC-140b, 141b, 143b (#3 layout 尊重), TC-142b (#2 安定化)
 */

import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ML = require('../../src/webview/mindmap-layout.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OutlinerModel = require('../../src/webview/outliner-model.js');

const measure = () => ({ width: 100, height: 30 });
function roots(ids: string[]) {
    const nodes: any = {};
    ids.forEach((id) => { nodes[id] = { id, parentId: null, children: [], text: id }; });
    return new OutlinerModel({ version: 1, rootIds: ids, nodes });
}

test.describe('#3 title 中心で settings.layout を尊重', () => {
    test('TC-140b right → 全子が中心より右', () => {
        const r = ML.compute(roots(['a', 'b', 'c']), { layout: 'right' }, measure, 'T');
        const tx = r.positions['__title__'].x;
        expect(['a', 'b', 'c'].every((k) => r.positions[k].x > tx)).toBe(true);
    });
    test('TC-141b left → 全子が中心より左', () => {
        const r = ML.compute(roots(['a', 'b', 'c']), { layout: 'left' }, measure, 'T');
        const tx = r.positions['__title__'].x;
        expect(['a', 'b', 'c'].every((k) => r.positions[k].x < tx)).toBe(true);
    });
    test('TC-143b balanced/radial → 両側', () => {
        for (const layout of ['balanced', 'radial']) {
            const r = ML.compute(roots(['a', 'b', 'c']), { layout }, measure, 'T');
            const tx = r.positions['__title__'].x;
            const anyR = ['a', 'b', 'c'].some((k) => r.positions[k].x > tx);
            const anyL = ['a', 'b', 'c'].some((k) => r.positions[k].x < tx);
            expect(anyR && anyL).toBe(true);
        }
    });
    test('right と left で見た目が変わる (#3 の核心)', () => {
        const rr = ML.compute(roots(['a', 'b', 'c']), { layout: 'right' }, measure, 'T');
        const rl = ML.compute(roots(['a', 'b', 'c']), { layout: 'left' }, measure, 'T');
        // a の x 符号が right と left で反転する
        const tr = rr.positions['__title__'].x, tl = rl.positions['__title__'].x;
        expect((rr.positions.a.x > tr)).not.toBe((rl.positions.a.x > tl));
    });
});

test.describe('#2 左右振り分けの安定化 (ブロック分割)', () => {
    function mkN(n: number) {
        const ids: string[] = [], nodes: any = {};
        for (let i = 0; i < n; i++) { const id = 'n' + i; ids.push(id); nodes[id] = { id, parentId: null, children: [], text: id }; }
        return new OutlinerModel({ version: 1, rootIds: ids, nodes });
    }
    function side(res: any, tx: number, id: string) { return res.positions[id].x > tx ? 'R' : 'L'; }

    test('TC-142b 末尾に1子追加しても既存子の side が保たれる', () => {
        const r4 = ML.compute(mkN(4), { layout: 'balanced' }, measure, 'T');
        const r5 = ML.compute(mkN(5), { layout: 'balanced' }, measure, 'T');
        const t4 = r4.positions['__title__'].x, t5 = r5.positions['__title__'].x;
        // block split: 4→RRLL, 5→RRRLL。先頭 n0,n1 は不変
        expect(side(r4, t4, 'n0')).toBe(side(r5, t5, 'n0'));
        expect(side(r4, t4, 'n1')).toBe(side(r5, t5, 'n1'));
        // 過半数保持
        const preserved = ['n0', 'n1', 'n2', 'n3'].filter((id) => side(r4, t4, id) === side(r5, t5, id)).length;
        expect(preserved).toBeGreaterThanOrEqual(3);
    });
});
