/**
 * history-store — pushHistoryEntry 純粋関数の unit（FR-HP-02/03）
 */
import { test, expect } from '@playwright/test';
import { pushHistoryEntry, HistoryEntry, HISTORY_MAX } from '../../src/shared/history-store';

function e(kind: HistoryEntry['kind'], id: string, ts: number): HistoryEntry {
    return { kind, id, title: id, ts };
}

test.describe('pushHistoryEntry (FR-HP-02/03)', () => {
    test('TC-HP-01: 追加は先頭（最新順）・入力を破壊しない', () => {
        const l0: HistoryEntry[] = [];
        const l1 = pushHistoryEntry(l0, e('note-md', '/a.md', 1));
        const l2 = pushHistoryEntry(l1, e('note-md', '/b.md', 2));
        const l3 = pushHistoryEntry(l2, e('out', '/c.out', 3));
        expect(l3.map((x) => x.id)).toEqual(['/c.out', '/b.md', '/a.md']); // 最後に push が先頭
        expect(l0).toEqual([]); // 入力破壊なし
        expect(l1.length).toBe(1);
    });

    test('TC-HP-02: 重複(kind,id)は先頭移動・重複追加しない（load-bearing）', () => {
        let l = pushHistoryEntry([], e('note-md', '/a.md', 1));
        l = pushHistoryEntry(l, e('note-md', '/b.md', 2));
        l = pushHistoryEntry(l, e('note-md', '/a.md', 3)); // /a.md 再オープン
        expect(l.map((x) => x.id)).toEqual(['/a.md', '/b.md']); // a が先頭に移動・重複なし
        expect(l.length).toBe(2);
        expect(l[0].ts, '先頭の ts は最新').toBe(3);
        // counterfactual: 重複除去が無いと ['/a.md'(3),'/b.md','/a.md'(1)] = length 3 になる → この assert が守る
    });

    test('TC-HP-03: max 件でトリム（最古が落ちる）', () => {
        let l: HistoryEntry[] = [];
        for (let i = 1; i <= HISTORY_MAX + 5; i++) l = pushHistoryEntry(l, e('note-md', '/f' + i + '.md', i));
        expect(l.length).toBe(HISTORY_MAX);
        expect(l[0].id, '最新が先頭').toBe('/f' + (HISTORY_MAX + 5) + '.md');
        expect(l[l.length - 1].id, '最古(残存分の末尾)は f6').toBe('/f6.md'); // f1..f5 が落ちる
        expect(l.some((x) => x.id === '/f1.md')).toBe(false);
    });

    test('TC-HP-03b: max=3 の明示トリム', () => {
        let l: HistoryEntry[] = [];
        for (let i = 1; i <= 5; i++) l = pushHistoryEntry(l, e('note-md', '/f' + i + '.md', i), 3);
        expect(l.map((x) => x.id)).toEqual(['/f5.md', '/f4.md', '/f3.md']);
    });

    test('TC-HP-04: 同一 id でも kind 違いは別 entry', () => {
        let l = pushHistoryEntry([], e('note-md', 'X', 1));
        l = pushHistoryEntry(l, e('page-md', 'X', 2)); // 同 id・別 kind
        expect(l.length).toBe(2);
        expect(l.map((x) => x.kind)).toEqual(['page-md', 'note-md']);
    });

    test('undefined 入力でも安全', () => {
        const l = pushHistoryEntry(undefined, e('out', '/x.out', 1));
        expect(l.map((x) => x.id)).toEqual(['/x.out']);
    });
});
