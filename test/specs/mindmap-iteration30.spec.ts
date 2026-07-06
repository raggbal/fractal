/**
 * Mindmap iteration 30 — 短い単一行テキストが確定ノードで折り返すバグの是正 (Wave 35 / TASK-81)
 *   TC-M27: 改行なし・280 未満の単一行ノードは、確定表示で折り返さない (border 3px 不足の是正)。
 *
 * 根本原因 (session-log「iteration 30」): .mindmap-node-box は box-sizing:border-box +
 *   padding 20px + border 3px。幅算出 (measureRealWidth/estimateMeasure/adjustEditWidth) は
 *   PAD_H(20) しか勘定せず border 3px を無視 → content 領域が 3px 狭く、自然幅が折り返し境界に
 *   近い短文が折れた (Image #3/#4)。→ BORDER_W(=4: border 3 + 丸め安全 1) を needInner/naturalW に加算。
 *
 * テスト方針 (generator_failures 2026-07-02): 実 DOM の box 幅・テキスト高さを実測。standalone の
 *   ヘッドレスフォント字幅は実機と異なるが、「短い単一行が 1 行高さで収まる (折り返さない)」+
 *   「box 幅が 280 未満」の invariant は字幅絶対値に依存せず検証できる。
 */

import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1200, height: 800 } });

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

function node(id: string, text: string, children: string[] = [], parentId: string | null = null) {
    return { id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] };
}

async function toMindmap(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(JSON.parse(JSON.stringify(d))); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(400);
}

function metrics(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const fo = document.querySelector('.mindmap-node[data-node-id="' + nid + '"]');
        if (!fo) { return null; }
        const box = fo.querySelector('.mindmap-node-box') as HTMLElement;
        const txt = fo.querySelector('.mindmap-node-text') as HTMLElement;
        return { boxW: box.getBoundingClientRect().width, txtH: txt.getBoundingClientRect().height };
    }, id);
}

// ユーザー報告 (Image #3/#4) の実文言を含む短い単一行ノード群
function model() {
    return {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: {
            r: node('r', 'root', ['a', 'b', 'c', 'd']),
            a: node('a', '問題の改善を求む', [], 'r'),
            b: node('b', '現状の問題点ってなんでしたっけ', [], 'r'),
            c: node('c', '現状は問題ありません', [], 'r'),
            d: node('d', 'Hello World Foo Bar', [], 'r'),
        },
    };
}

test('TC-M27 改行なしの短い単一行ノードは折り返さない (280 未満・1 行高さ)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, model());

    // 1 行高さの上限目安: fontSize 13 * lineHeight 1.4 ≒ 18.2px + padding 上下 12px。
    // 折り返すと text 自体が 2 行 (~36px) になる。text の height で判定 (padding 込みの box でなく text)。
    const ONE_LINE_MAX = 28; // 1 行 (~18) は下回る / 2 行 (~36) は超える
    for (const id of ['a', 'b', 'c', 'd']) {
        const m = await metrics(page, id);
        expect(m).not.toBeNull();
        // 折り返していない = テキスト高さが 1 行分
        expect(m!.txtH).toBeLessThanOrEqual(ONE_LINE_MAX);
        // 最大幅 280 は超えない
        expect(m!.boxW).toBeLessThanOrEqual(280);
    }
});

test('TC-M27 長文 (280 超) は従来どおり折り返す (上限クランプは維持)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: {
            r: node('r', 'root', ['long']),
            long: node('long', 'ああああああああああああああああああああああああああああああああああ', [], 'r'),
        },
    });
    const m = await metrics(page, 'long');
    expect(m).not.toBeNull();
    // 280 でクランプ (それ以上広がらない) → 折り返して複数行高さ
    expect(m!.boxW).toBeLessThanOrEqual(281);
    expect(m!.txtH).toBeGreaterThan(28); // 折り返して 2 行以上
});
