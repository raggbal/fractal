/**
 * history-store — pushHistoryEntry 純粋関数の unit（FR-HP-02/03）
 * + spec 20261027-1142-recent-history-nav AC-1（D1: 開いた順に積む・直前と同じだけまとめる・50 件 / D2: pane）
 */
import { test, expect } from '@playwright/test';
import { pushHistoryEntry, HistoryEntry, HISTORY_MAX, historyPaneOf } from '../../src/shared/history-store';

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

    // spec 20261027-1142-recent-history-nav D1 で FR-HP-02 の「重複先頭移動」を supersede。
    // 旧 assert（a→b→a が a>b）は新仕様と矛盾するので、新仕様（a>b>a）の assert に置き換えた（AC-1 も参照）。
    test('TC-HP-02: 重複(kind,id)も積む（開いた順の記録・load-bearing）', () => {
        let l = pushHistoryEntry([], e('note-md', '/a.md', 1));
        l = pushHistoryEntry(l, e('note-md', '/b.md', 2));
        l = pushHistoryEntry(l, e('note-md', '/a.md', 3)); // /a.md 再オープン
        expect(l.map((x) => x.id)).toEqual(['/a.md', '/b.md', '/a.md']);
        expect(l[0].ts, '先頭の ts は最新').toBe(3);
        expect(l[2].ts, '古い a も残る').toBe(1);
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
        // ★reopen 2026-07-23: page-md kind 廃止 → note-md / out の 2 種で dedup キー (kind,id) を検証。
        let l = pushHistoryEntry([], e('note-md', 'X', 1));
        l = pushHistoryEntry(l, e('out', 'X', 2)); // 同 id・別 kind
        expect(l.length).toBe(2);
        expect(l.map((x) => x.kind)).toEqual(['out', 'note-md']);
    });

    test('undefined 入力でも安全', () => {
        const l = pushHistoryEntry(undefined, e('out', '/x.out', 1));
        expect(l.map((x) => x.id)).toEqual(['/x.out']);
    });
});

test.describe('pushHistoryEntry — recent-history-nav (D1 / D2)', () => {
    test('AC-1 a→b→a を開くと a>b>a（同じものも積む）', () => {
        let l = pushHistoryEntry([], e('note-md', '/a.md', 1));
        l = pushHistoryEntry(l, e('note-md', '/b.md', 2));
        expect(l.map((x) => x.id)).toEqual(['/b.md', '/a.md']);
        l = pushHistoryEntry(l, e('note-md', '/a.md', 3));
        expect(l.map((x) => x.id)).toEqual(['/a.md', '/b.md', '/a.md']);
        expect(l.map((x) => x.ts)).toEqual([3, 2, 1]);
    });

    test('AC-1 直前と同じものは 1 件にまとめる（先頭を最新で置き換え）', () => {
        let l = pushHistoryEntry([], e('note-md', '/a.md', 1));
        l = pushHistoryEntry(l, e('note-md', '/b.md', 2));
        l = pushHistoryEntry(l, { ...e('note-md', '/b.md', 3), pane: 'side' });
        expect(l.map((x) => x.id)).toEqual(['/b.md', '/a.md']);
        expect(l[0].ts, '先頭は最新の entry').toBe(3);
        expect(l[0].pane, '先頭は最新の pane').toBe('side');
        // 直前でなければまとめない（kind 違いは別物）
        l = pushHistoryEntry(l, e('out', '/b.md', 4));
        expect(l.length).toBe(3);
    });

    test('AC-1 上限は 50。超えたら最古を落とす', () => {
        expect(HISTORY_MAX).toBe(50);
        let l: HistoryEntry[] = [];
        // 2 件を交互に開く（重複が積まれる）
        for (let i = 1; i <= 60; i++) l = pushHistoryEntry(l, e('note-md', i % 2 ? '/a.md' : '/b.md', i));
        expect(l.length).toBe(50);
        expect(l[0].ts, '最新が先頭').toBe(60);
        expect(l[49].ts, '最古 10 件（ts 1..10）が落ちる').toBe(11);
    });

    test('AC-1 pane の無い旧 entry は main として読める', () => {
        const legacy: HistoryEntry[] = [{ kind: 'note-md', id: '/old.md', title: 'old', ts: 1 }];
        expect(historyPaneOf(legacy[0])).toBe('main');
        expect(historyPaneOf({ pane: 'side' })).toBe('side');
        expect(historyPaneOf({ pane: 'bogus' })).toBe('main');
        const l = pushHistoryEntry(legacy, { ...e('note-md', '/new.md', 2), pane: 'side' });
        expect(l.map((x) => historyPaneOf(x))).toEqual(['side', 'main']);
    });
});
