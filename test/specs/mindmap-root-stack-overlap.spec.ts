/**
 * Mindmap: root subtree の縦積みが「実 measure 高さ」で行われる (裁定 R33 / FR-MMS-01)
 *
 * 実機報告 (2026-09-05, doc/ggg/mt0wj1x7eaua.out): mindmap で box が重なり、
 * 間の root が長文 box の裏に隠れて「訳が分からない」表示になる。
 * 原因は MindmapLayout.compute の **root 間縦積み**が subtree 高さを概算していたこと:
 *   - right/left      : subtreeSpan()   = node 中心座標の範囲のみ (= ノード高さ 0 扱い)。
 *                       単一ノード root は常に 0 → 次の root を 60px 後ろに置いていた。
 *   - balanced/radial : subtreeHeight() = leaf 数 × root 自身の高さ (子の実高さを見ない)。
 * さらに配置基準が「最上ノードの中心を stackY に合わせる」だったため、背の高いノードは
 * 自分の高さの半分ぶん**上の root 側へ**はみ出していた。
 * 修正: 一旦テンポラリへ emit して実 Y 範囲 (中心 ± measure 高さ/2) を測り、その **上端**を
 * stackY に合わせて平行移動 → stackY を実高さ + ROOT_GAP(60) だけ進める。
 *
 * TC-MMS-01 (right): box が 1 組も重ならない。
 * TC-MMS-02 (balanced): 左右両側展開でも box が 1 組も重ならない。
 * TC-MMS-03: fixture の妥当性 (長文 root が実際に背の高い box になっている) を明示。
 *   これが崩れると TC-MMS-01/02 が「重なる要素が無いから通る」空テストになるため必須。
 *
 * ★2026-09-05 / 裁定 R34 (FR-MMT-01) による再設定 (test_update):
 *   title が空でも中心ノード (__title__) が出るようになったため、**製品の render 経路では
 *   root 間縦積み (ROOT_GAP=60) を通らない**（root はすべて中心ノードの子として放射配置される）。
 *   よってこの spec の役割は「実機報告そのもの = box が重ならない」に一本化し、
 *   ROOT_GAP=60 の間隔検証は縦積み経路をそのまま叩ける unit test
 *   (test/unit/mindmap-root-stack.spec.ts / TC-MMS-01u) へ移した。
 *   box 数は中心ノードを含めて 8 (7 node + __title__)。
 */

import { test, expect } from '@playwright/test';

function node(id: string, text: string, children: string[] = [], parentId: string | null = null) {
    return { id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] };
}

// 実機データの再現: 空 root と「280px で折り返す長文 root」が交互に並び、
// さらに背の高い子を持つ root が続く。title は付けない (= multi-root 縦積み経路を通す)。
const LONG = 'note 横断検索で pdf の検索結果をClickすると、viewer が開き、検索バーが表示されて検索語が入った状態で該当ページへ自動ジャンプ + ハイライトまでしてほしい。長文なので 280px 幅で折り返して背が高くなる。';
function fixture(layout: string) {
    return {
        version: 1, viewMode: 'mindmap', rootIds: ['e1', 'long', 'e2', 'P', 'e3'],
        mindmap: { layout: layout },
        nodes: {
            e1: node('e1', ''),
            long: node('long', LONG),
            e2: node('e2', ''),
            P: node('P', 'parent', ['c1', 'c2'], null),
            c1: node('c1', LONG, [], 'P'),
            c2: node('c2', LONG, [], 'P'),
            e3: node('e3', ''),
        },
    };
}

type Box = { id: string; x: number; y: number; w: number; h: number };

async function boxes(page: import('@playwright/test').Page): Promise<Box[]> {
    return page.evaluate(() => {
        const out: any[] = [];
        document.querySelectorAll('.mindmap-node[data-node-id]').forEach((fo) => {
            const box = (fo as HTMLElement).querySelector('.mindmap-node-box') as HTMLElement | null;
            if (!box) { return; }
            const r = box.getBoundingClientRect();
            out.push({
                id: (fo as HTMLElement).getAttribute('data-node-id'),
                x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
            });
        });
        return out;
    });
}

function overlaps(bs: Box[]): string[] {
    const bad: string[] = [];
    for (let i = 0; i < bs.length; i++) {
        for (let j = i + 1; j < bs.length; j++) {
            const a = bs[i], b = bs[j];
            const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            // 1px は border/丸め由来の接触を許容 (重なりは 2px 以上を検出)
            if (ox > 1 && oy > 1) { bad.push(`${a.id} X ${b.id} (${ox}x${oy})`); }
        }
    }
    return bad;
}

async function setup(page: import('@playwright/test').Page, layout: string) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d, '/n/mm.out'); }, fixture(layout));
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(400);
}

test('TC-MMS-01: right layout — box が 1 組も重ならない (中心ノード込み)', async ({ page }) => {
    await setup(page, 'right');
    const bs = await boxes(page);
    expect(bs.length).toBe(8);              // 7 node + __title__ (R34: title 空でも中心ノードが出る)
    expect(bs.some((b) => b.id === '__title__')).toBe(true);
    expect(overlaps(bs)).toEqual([]);

    // root 列 (rootIds 順) の subtree が縦方向に食い合わない = 実機報告「間の root が裏に隠れる」の直接検証。
    const byId: Record<string, Box> = {};
    bs.forEach((b) => { byId[b.id] = b; });
    const bottomOf = (ids: string[]) => Math.max(...ids.map((i) => byId[i].y + byId[i].h));
    const topOf = (ids: string[]) => Math.min(...ids.map((i) => byId[i].y));
    const stack: string[][] = [['e1'], ['long'], ['e2'], ['P', 'c1', 'c2'], ['e3']];
    for (let i = 1; i < stack.length; i++) {
        const gap = topOf(stack[i]) - bottomOf(stack[i - 1]);
        expect(gap, `gap before ${stack[i][0]}`).toBeGreaterThan(0);
    }
});

test('TC-MMS-02: balanced layout — 左右両側展開でも root box が重ならない', async ({ page }) => {
    await setup(page, 'balanced');
    const bs = await boxes(page);
    expect(bs.length).toBe(8);              // 7 node + __title__ (R34)
    expect(overlaps(bs)).toEqual([]);
});

test('TC-MMS-03: fixture 妥当性 — 長文 root は折り返して背の高い box になる', async ({ page }) => {
    await setup(page, 'right');
    const bs = await boxes(page);
    const long = bs.find((b) => b.id === 'long')!;
    const empty = bs.find((b) => b.id === 'e1')!;
    expect(long.h).toBeGreaterThan(100);       // 複数行に折り返した高さ
    expect(empty.h).toBeLessThan(50);          // 空 node は 1 行高さ
    expect(long.h).toBeGreaterThan(empty.h * 2); // 旧概算 (60px 進み) では必ず重なる高さ差
});
