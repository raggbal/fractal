/**
 * node-move-to-outliner — moveSubtreeToOtherOut 純関数の unit（FR-NM-03/04/05）
 *
 * サブツリー収集・id 再採番・target root 先頭挿入・src 削除・アセット参照引き継ぎ を検証。
 * 副作用（fs）は含まないので純粋にオブジェクト操作でテストできる。
 */
import { test, expect } from '@playwright/test';
import { moveSubtreeToOtherOut, collectSubtreeIds, OutDoc } from '../../src/shared/out-node-move';

function makeDoc(rootIds: string[], nodes: Record<string, any>): OutDoc {
    return { version: 1, rootIds: rootIds.slice(), nodes: JSON.parse(JSON.stringify(nodes)) };
}

test.describe('moveSubtreeToOtherOut (FR-NM-03/04/05)', () => {
    test('TC-NM-01: サブツリー転記（root 先頭・親子保持・src 削除）load-bearing', () => {
        // src: A(子 B, C)
        const src = makeDoc(['A', 'X'], {
            A: { id: 'A', parentId: null, children: ['B', 'C'], text: 'A' },
            B: { id: 'B', parentId: 'A', children: [], text: 'B' },
            C: { id: 'C', parentId: 'A', children: [], text: 'C' },
            X: { id: 'X', parentId: null, children: [], text: 'X' },
        });
        const target = makeDoc(['T1'], {
            T1: { id: 'T1', parentId: null, children: [], text: 'existing' },
        });

        const res = moveSubtreeToOtherOut(src, target, 'A', 'seed');
        expect(res).not.toBeNull();
        const newRoot = res!.newRootId;

        // target: root 先頭に新 A（load-bearing: 先頭であること）
        expect(target.rootIds[0]).toBe(newRoot);
        expect(target.rootIds).toContain('T1');
        // 親子保持: 新 A の children が 2 個、それぞれ text B/C
        const na = target.nodes[newRoot];
        expect(na.children.length).toBe(2);
        expect(na.parentId).toBeNull();
        const childTexts = na.children.map((c: string) => target.nodes[c].text).sort();
        expect(childTexts).toEqual(['B', 'C']);
        // 子の parentId が新 A を指す
        na.children.forEach((c: string) => expect(target.nodes[c].parentId).toBe(newRoot));

        // src: A/B/C が消え、X だけ残る（load-bearing: src 削除）
        expect(src.rootIds).toEqual(['X']);
        expect(src.nodes.A).toBeUndefined();
        expect(src.nodes.B).toBeUndefined();
        expect(src.nodes.C).toBeUndefined();
        expect(src.nodes.X).toBeDefined();
    });

    test('TC-NM-01b: 子ノードの move（親の children から除去 + rootIds 不変）', () => {
        // src: P(子 A(孫 B)) の A を move（A は root でなく P の子）
        const src = makeDoc(['P'], {
            P: { id: 'P', parentId: null, children: ['A'], text: 'P' },
            A: { id: 'A', parentId: 'P', children: ['B'], text: 'A' },
            B: { id: 'B', parentId: 'A', children: [], text: 'B' },
        });
        const target = makeDoc([], {});
        const res = moveSubtreeToOtherOut(src, target, 'A', 'seed');
        expect(res).not.toBeNull();
        // src: P は残り、children から A が除去、A/B は消える
        expect(src.rootIds).toEqual(['P']);
        expect(src.nodes.P.children).toEqual([]);
        expect(src.nodes.A).toBeUndefined();
        expect(src.nodes.B).toBeUndefined();
        // target: 新 A(子 B) が root 先頭
        expect(target.rootIds.length).toBe(1);
        const na = target.nodes[target.rootIds[0]];
        expect(na.text).toBe('A');
        expect(na.children.length).toBe(1);
        expect(target.nodes[na.children[0]].text).toBe('B');
    });

    test('TC-NM-02: id 衝突回避（target に既存 id と衝突しない新 id 採番）', () => {
        // target に seed 由来の id と衝突しそうな id を仕込む
        const src = makeDoc(['A'], { A: { id: 'A', parentId: null, children: [], text: 'A' } });
        const target = makeDoc(['nseed0'], {
            nseed0: { id: 'nseed0', parentId: null, children: [], text: 'collide' },
        });
        const res = moveSubtreeToOtherOut(src, target, 'A', 'seed');
        expect(res).not.toBeNull();
        // 新 id は 'nseed0' と衝突しない
        expect(res!.newRootId).not.toBe('nseed0');
        expect(target.nodes['nseed0'].text).toBe('collide'); // 既存は壊れない
        expect(Object.keys(target.nodes).length).toBe(2);
    });

    test('TC-NM-04: アセット参照引き継ぎ（pageId/images/filePath そのまま・オブジェクトは深いコピー）', () => {
        const src = makeDoc(['A'], {
            A: {
                id: 'A', parentId: null, children: [], text: 'page node',
                isPage: true, pageId: 'p1', images: ['images/x.png'], filePath: 'files/a.zip',
            },
        });
        const target = makeDoc([], {});
        const res = moveSubtreeToOtherOut(src, target, 'A', 'seed');
        const na = target.nodes[res!.newRootId];
        // 参照文字列をそのまま引き継ぐ（同一 note flat 共有 = 物理移動不要）
        expect(na.isPage).toBe(true);
        expect(na.pageId).toBe('p1');
        expect(na.images).toEqual(['images/x.png']);
        expect(na.filePath).toBe('files/a.zip');
        // src からは消えている（純関数はオブジェクト操作のみ = 物理ファイルは触らない → 呼び出し側が「消さない」を担保）
        expect(src.nodes.A).toBeUndefined();
    });

    test('collectSubtreeIds: DFS で自身+子孫を収集', () => {
        const doc = makeDoc(['A'], {
            A: { id: 'A', parentId: null, children: ['B', 'C'], text: 'A' },
            B: { id: 'B', parentId: 'A', children: ['D'], text: 'B' },
            C: { id: 'C', parentId: 'A', children: [], text: 'C' },
            D: { id: 'D', parentId: 'B', children: [], text: 'D' },
        });
        const ids = collectSubtreeIds(doc, 'A').sort();
        expect(ids).toEqual(['A', 'B', 'C', 'D']);
        // 存在しない node → 空
        expect(collectSubtreeIds(doc, 'ZZ')).toEqual([]);
    });
});
