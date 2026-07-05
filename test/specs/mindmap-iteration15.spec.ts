/**
 * Mindmap iteration 15 — 2 パス高さを「補正後の幅 (realW)」で測る (Wave 20 / FR-021-A6, TASK-47)
 *
 * TC-U4 (★#17 の高さ版): 全角中心・改行なし・280 未満の 1 行ノードの確定高さが 1 行分になる。
 *   iteration 14 (#17) は 2 パス実測の「幅」を char 推定 → 実 DOM 実測に直したが、「高さ」は
 *   pass-1 の狭い幅 (char 推定, 全角過小) で測った getBoundingClientRect().height のまま残した。
 *   全角中心の 1 行ノードは pass-1 で幅が狭すぎて 2 行に折り返し、その 2 行分の高さが frozen される
 *   → 幅は measureRealWidth で正しく広がるのに高さは 2 行分 (2 行目が空白, Image のとおり)。
 *   修正: 2 パスループで realW を先に確定し、foreignObject の width を realW にリフローさせてから
 *   box の実高さを測る (measureBoxHeightAtWidth)。realW 幅では単一行ノードは 1 行に収まる。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() 直呼び禁止。
 *   高さは .mindmap-node[data-node-id] の getBoundingClientRect().height、
 *   折り返し行数は .mindmap-node-text の getClientRects().length。
 *
 * 2 パス発火条件 (needsRealMeasure): いずれかのノードに \n / icon / images / tags があること。
 *   → n1 (全角・改行なし) が 2 パス実測経路を通るよう、兄弟 sib に改行を持たせて 2 パスを強制する。
 *
 * load-bearing (session-log / TC-U4 注記):
 *   standalone のヘッドレスフォントは実機ほど CJK 過小を出さず「pass-1 幅で 2 行折り返す」を
 *   自然再現しにくい。そのため退化検出は「高さ測定に使う幅を狭く (pass-1 相当) するか realW にするかで
 *   単一行ノードの測定高さが変わる」invariant で担保する。実際に render 済みの box に対し
 *   MindmapRender._measureBoxHeightAtWidth を「狭い幅」と「realW 相当の広い幅」で呼び分け、
 *   狭い幅では高さが 2 行分・広い幅では 1 行分になる (= 高さが測定幅に依存する) ことを確認する。
 *   これにより「高さを pass-1 の狭い幅で測る旧方式では単一行ノードの高さが 2 行になる」を font 差に
 *   依存せず実証する。
 */

import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}
function node(id: string, text: string, children: string[] = [], parentId: string | null = null) {
    return { id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] };
}
async function toMindmap(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(200);
}
// foreignObject (.mindmap-node) の getBoundingClientRect().height (画面座標, scale=1)。
function foHeight(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as SVGGraphicsElement | null;
        if (!fo) { return null; }
        return Math.round(fo.getBoundingClientRect().height);
    }, id);
}
function boxHeight(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as HTMLElement | null;
        if (!fo) { return null; }
        const box = fo.querySelector('.mindmap-node-box') as HTMLElement | null;
        if (!box) { return null; }
        return Math.round(box.getBoundingClientRect().height);
    }, id);
}
// .mindmap-node-text の折り返し行数 (getClientRects().length)。1 = 折り返していない。
function textLineCount(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const t = document.querySelector(`.mindmap-node-text[data-node-id="${nid}"]`) as HTMLElement | null;
        if (!t) { return null; }
        return t.getClientRects().length;
    }, id);
}

// 全角中心・改行なし・280 未満に収まる長さのノード (testcases.md TC-U4 の例)。
const N1_TEXT = 'asdあdさだsだsだsだsだ';

test('TC-U4 (★#17高さ版) 改行なし1行ノードは初期描画で折り返さず 1 行高さで確定する', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', title: '', rootIds: ['r'],
        mindmap: { layout: 'right' },
        nodes: {
            r: node('r', 'root', ['n1', 'sib'], null),
            n1: node('n1', N1_TEXT, [], 'r'),
            // sib に改行を持たせて needsRealMeasure=true → n1 が 2 パス実測経路を通る
            // (n1 の確定高さが 2 パスの realW 幅で決まる = TASK-47 の修正経路)。
            sib: node('sib', 'a\nb', [], 'r')
        }
    });
    await page.waitForTimeout(150);

    // 検証1: n1 は改行なしで 1 行に収まる (折り返さない)。
    const lines = await textLineCount(page, 'n1');
    expect(lines).not.toBeNull();
    expect(lines).toBe(1);

    // 検証2: n1 の box 高さが 1 行分 (fontSize*1.4 + padding 相当 ≈ 32〜36px)。
    //   pass-1 の狭い幅で測った 2 行分 (~54px 以上) でないこと。
    const foH = await boxHeight(page, 'n1');
    expect(foH).not.toBeNull();
    expect(foH!).toBeLessThanOrEqual(40);

    // 検証3: 複数行 (sib='a\nb', 2 行) の box 高さより明確に低い (単一行 < 複数行)。
    const sibH = await boxHeight(page, 'sib');
    expect(sibH).not.toBeNull();
    // sib は 2 行なので n1 (1 行) より明確に高い (少なくとも 1 行分の差)。
    expect(foH!).toBeLessThan(sibH!);
});

test('TC-U4 load-bearing: 高さ測定は幅に依存し、狭い幅(pass-1相当)では2行分・realW幅では1行分になる', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', title: '', rootIds: ['r'],
        mindmap: { layout: 'right' },
        nodes: {
            r: node('r', 'root', ['n1', 'sib'], null),
            n1: node('n1', N1_TEXT, [], 'r'),
            sib: node('sib', 'a\nb', [], 'r')
        }
    });
    await page.waitForTimeout(150);

    // render 済みの n1 box に対し、_measureBoxHeightAtWidth を「狭い幅」と「realW 幅」で呼び分けて、
    // 測定高さが「測定に使う幅」に依存することを実証する (font 差に依存しない invariant)。
    //   - 狭い幅 (テキストが折り返す幅): 高さ = 複数行分 → 「高さを狭い幅で測る旧方式」の再現。
    //     ※ 実機の CJK では pass-1 の char 推定幅 (全角過小) がまさにこの「テキストが折り返す狭い幅」に
    //       あたり、単一行ノードの高さが 2 行分 frozen された (#17 の高さ版)。standalone は
    //       headless フォントで est≈realW のため est 幅では折り返さない → 幅依存性そのものを
    //       「明確に狭い幅」で示すことで退化を font 差に依存せず担保する。
    //   - realW 幅 (measureRealWidth の返す 1 行に収まる幅): 高さ = 1 行分 → TASK-47 の修正方式。
    const result = await page.evaluate(() => {
        const MR = (window as any).MindmapRender;
        const fo = document.querySelector('.mindmap-node[data-node-id="n1"]') as SVGGraphicsElement | null;
        if (!fo) { return null; }
        const box = fo.querySelector('.mindmap-node-box') as HTMLElement | null;
        if (!box) { return null; }
        const model = (window as any).Outliner.getModel();
        // realW = 実 DOM の最長行実測 (1 行に収まる幅)。
        const realW: number = MR._measureRealWidth(box, model.nodes['n1'], 14);
        // テキストが確実に折り返す狭い幅 (最長行幅の半分未満)。実機 CJK の pass-1 過小幅に相当。
        const narrowW = Math.max(40, Math.round(realW * 0.4));

        // 狭い幅で測った高さ (= 高さを狭い幅で測る旧方式の再現)。
        const hNarrow: number = MR._measureBoxHeightAtWidth(box, fo, narrowW, -1);
        // realW 幅で測った高さ (= TASK-47 の修正方式)。
        const hReal: number = MR._measureBoxHeightAtWidth(box, fo, realW, -1);
        // 元の realW にセットし直す (後続テストへの副作用回避 — 実際は pass-2 が上書きするが念のため)。
        fo.setAttribute('width', String(realW));

        return { realW, narrowW, hNarrow, hReal };
    });

    expect(result).not.toBeNull();
    const { hNarrow, hReal } = result!;

    // ★load-bearing: 測定高さは「測定に使う幅」に依存する。狭い幅 (旧方式) の測定高さは realW 幅
    //   (修正方式) より明確に高い (折り返しで複数行になる)。→ 高さを realW でなく pass-1 の
    //   (実機 CJK では過小な) 狭い幅で測ると単一行ノードが複数行高さ frozen されることを実証。
    //   修正 (realW 幅で測る) で 1 行高さに収まる。少なくとも 1 行分 (fs*1.4≈20px) 以上の差。
    expect(hNarrow).toBeGreaterThan(hReal + 15);
    // realW 幅の高さは 1 行分 (SVG 内部座標, scale=1 なので画面座標と一致 ≈ 32〜36px)。
    expect(hReal).toBeLessThanOrEqual(40);
});
