/**
 * Mindmap iteration 13 — ノード幅を「最長行フィット・上限 280」に是正 (Wave 17 / FR-021-A6,A7, TASK-43)
 *
 * TC-U2 (★是正の核心): 各行が短い複数行ノードは最長行フィット (280 未満)、長い行を含むノードは 280。
 *   iteration 12 (TASK-41) の過剰修正で「改行/折り返しがあれば一律 280」になっていた (Image #16)。
 *   正しい仕様: 最長行の自然幅にフィット、その自然幅が 280 を超えるときだけ 280 上限。
 *   (decision-a6-fit-longest-line-cap-280)
 *
 * 根本原因 (session-log iteration 13):
 *   - estimateMeasure: `if (naturalW > maxW || explicitLines.length > 1 || lines > 1) { w = maxW; }` により
 *     改行がある / 折り返すだけで 280 固定 → naturalW < 280 でも 280 になっていた。是正で撤去。
 *   - 2 パス実測 (isMultiLineBox): node.text に \n or getClientRects().length > 1 で realW=280 → 同じ誤り。
 *     是正で「幅は estimateMeasure の最長行フィット値 (min(280, naturalW)) を採用、高さのみ実測補正」に。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() は使わない。初期描画後の実 DOM 幅を測る。
 * 幅は .mindmap-node[data-node-id] の getBoundingClientRect().width (viewport scale=1)。
 * helper は mindmap-iteration11.spec.ts / iteration12-width.spec.ts と同方式。
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
function foWidth(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as SVGGraphicsElement | null;
        if (!fo) { return null; }
        const r = fo.getBoundingClientRect();
        return Math.round(r.width);
    }, id);
}

// testcases.md TC-U2 の texts をそのまま使用。
// shortMulti: 各行が短い複数行 (最長行 ~14 文字 → naturalW ~142 < 280)。← iteration12 バグでは 280。
const SHORT_MULTI = 'asfasdfasdfafa\ndfasdfadfa';
// longMulti: 長い行を含む複数行 (最長行 ~39 文字 → naturalW ~352 > 280 → 280 クランプ)。
const LONG_MULTI = 'あsだsだsだsだdさだあsだsdっdsds\nsdsdsd\nsdsdssssssssssssssssssssssssssssssssdsd';
// oneShort: 単一行短い (naturalW ~49 → min 80)。
const ONE_SHORT = 'sds';

test('TC-U2 (★是正の核心) 各行短い複数行ノードは最長行フィット(280未満)・長行含むノードは280・両者別幅', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', title: '', rootIds: ['r'],
        mindmap: { layout: 'right' },
        nodes: {
            r: node('r', 'root', ['shortMulti', 'longMulti', 'oneShort'], null),
            shortMulti: node('shortMulti', SHORT_MULTI, [], 'r'),
            longMulti: node('longMulti', LONG_MULTI, [], 'r'),
            oneShort: node('oneShort', ONE_SHORT, [], 'r')
        }
    });
    await page.waitForTimeout(150);

    const wShortMulti = await foWidth(page, 'shortMulti');
    const wLongMulti = await foWidth(page, 'longMulti');
    const wOneShort = await foWidth(page, 'oneShort');

    expect(wShortMulti).not.toBeNull();
    expect(wLongMulti).not.toBeNull();
    expect(wOneShort).not.toBeNull();

    // ★是正の核心: 各行が短い複数行ノードは 280 未満 (最長行フィット)。
    // iteration 12 バグでは 280 だった。最長行 ~14 文字ぶんの幅 (100〜220) にフィット。
    expect(wShortMulti).toBeLessThan(260);
    expect(wShortMulti).toBeGreaterThanOrEqual(100);
    expect(wShortMulti).toBeLessThanOrEqual(220);

    // 長い行を含むノードは 280 (±3) — 最長行が長いので上限クランプ
    expect(wLongMulti).toBeGreaterThanOrEqual(277);
    expect(wLongMulti).toBeLessThanOrEqual(283);

    // 単一行短いノードは小さい
    expect(wOneShort).toBeLessThan(120);

    // shortMulti < longMulti — 両者が別幅 (一律 280 ではない = 是正されている)
    expect(wShortMulti!).toBeLessThan(wLongMulti!);
});
