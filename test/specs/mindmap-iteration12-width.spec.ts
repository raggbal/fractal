/**
 * Mindmap iteration 12 → iteration 13 是正 — ノード幅は「最長行フィット・上限 280」(Wave 17 / FR-021-A6,A7, TASK-43)
 *
 * ⚠️ iteration 13 (TASK-43, 許可: test_update) で TC-U1 を更新。
 *    旧版は「複数行=一律 280」の誤期待を encode していた (iteration 12 TASK-41 の過剰修正)。
 *    正しい仕様 (FR-021-A6 実寸フィット + A7 上限 280) は「最長行の自然幅にフィット、その自然幅が
 *    280 を超える (= 折り返しが必要な) ときだけ 280 上限」。改行があるだけでは 280 にしない。
 *    (decision-a6-fit-longest-line-cap-280)
 *
 * TC-U1: 最長行が 280 幅を超える単一行の長文ノードは 280 に統一。短い単一行は内容フィット (280 未満)。
 *        各行が短い複数行ノードは 280 未満 (最長行フィット) — 改行だけでは 280 にしない。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() は使わない。初期描画後の実 DOM 幅を測る。
 * 幅は .mindmap-node[data-node-id] の getBoundingClientRect().width (viewport scale=1)。
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

// 最長行が 280 幅を超える単一行の長文 (naturalW = 40*8.4+24 = 360 / 60*8.4+24 = 528 → どちらも 280 クランプ)
const WIDE_A = 'あ'.repeat(40); // 単一行 40 文字 (naturalW 360 > 280)
const WIDE_B = 'い'.repeat(60); // 単一行 60 文字 (naturalW 528 > 280)
// 各行が短い明示改行の複数行 (最長行 20 文字 → naturalW 192 < 280。改行があっても 280 にしないことの確認)
const SHORT_MULTI = 'aaaaaaaaaaaaaaaaaaaa\nbbbbbbbbbbbbbbbbbbbb\ncccccccccccccccccccc';

test('TC-U1 (是正/load-bearing) 最長行フィット・上限280: 長行は280統一・短い単一行はフィット・短い複数行は280未満', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', title: '', rootIds: ['r'],
        mindmap: { layout: 'right' },
        nodes: {
            r: node('r', 'root', ['wideA', 'wideB', 'shortMulti', 'short'], null),
            wideA: node('wideA', WIDE_A, [], 'r'),
            wideB: node('wideB', WIDE_B, [], 'r'),
            shortMulti: node('shortMulti', SHORT_MULTI, [], 'r'),
            short: node('short', 'abc', [], 'r')
        }
    });
    await page.waitForTimeout(150);

    const wA = await foWidth(page, 'wideA');
    const wB = await foWidth(page, 'wideB');
    const wSM = await foWidth(page, 'shortMulti');
    const wShort = await foWidth(page, 'short');

    expect(wA).not.toBeNull();
    expect(wB).not.toBeNull();
    expect(wSM).not.toBeNull();
    expect(wShort).not.toBeNull();

    // 最長行が 280 幅を超える単一行長文ノードは 280 (±3) に統一
    expect(wA).toBeGreaterThanOrEqual(277);
    expect(wA).toBeLessThanOrEqual(283);
    expect(wB).toBeGreaterThanOrEqual(277);
    expect(wB).toBeLessThanOrEqual(283);
    // 両者の幅がほぼ一致 (共に上限クランプ)
    expect(Math.abs(wA! - wB!)).toBeLessThanOrEqual(3);

    // ★是正の核心: 各行が短い複数行ノードは 280 未満 (最長行フィット)。改行があるだけでは 280 にしない。
    expect(wSM).toBeLessThan(260);
    // 最長行 ~20 文字ぶんの自然幅 (192 前後) にフィット
    expect(wSM).toBeGreaterThan(120);

    // 短い単一行ノードは 280 未満 (内容フィット)
    expect(wShort).toBeLessThan(150);
});
