/**
 * mindmap: .out タイトルが**空でも** title 中心ノードから放射する (裁定 R34 / FR-MMT-01)
 *
 * 実機報告 (2026-09-05, rc.17): 「なんで root に所属していない node が沢山あるの？通常 .out の
 *   タイトルを root として全て放射状に展開するのでは？… いま title を入れたら放射になりました。
 *   untitled、つまり .out タイトルが空だから放射にならなかったのか。title が空でもちゃんと
 *   放射にしてほしい」。
 * 原因: MindmapLayout.compute の中心ノード生成条件が `titleText && titleText.trim() !== ''`。
 *   空タイトルでは中心ノードが出ず root が縦積み (FR-MMS-01 経路) になり、「root に所属しない
 *   node の羅列」に見えた。
 * 修正: 中心ノードの有無は `titleText != null` で決める (空文字 = タイトル未設定の実ファイルなので
 *   中心ノードを出す / null = title の概念を持たない呼び出しは従来どおり縦積み)。
 *   中心ノードには薄いイタリックの Untitled プレースホルダを出し、**編集開始で必ず捨てる**
 *   (捨てないと commitEdit が 'Untitled' を実タイトルとして保存してしまう)。
 */
import { test, expect } from '@playwright/test';

function node(id: string, text: string, children: string[] = [], parentId: string | null = null) {
    return { id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] };
}

// title を持たない (= 空タイトル) 複数 root の .out。実機報告と同じ形。
function noTitleTree() {
    return {
        version: 1, viewMode: 'mindmap', rootIds: ['r1', 'r2', 'r3'],
        nodes: {
            r1: node('r1', 'one', ['a']), a: node('a', 'one-child', [], 'r1'),
            r2: node('r2', 'two'),
            r3: node('r3', 'three'),
        },
    };
}

async function toMindmap(page: import('@playwright/test').Page, data: any) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(300);
}

test('TC-MMT-01 空タイトルでも中心ノードが出て全 root が放射する', async ({ page }) => {
    await toMindmap(page, noTitleTree());

    // 中心ノードが存在する (修正前は存在しなかった = root 縦積み)
    await expect(page.locator('.mindmap-node[data-node-id="__title__"]')).toHaveCount(1);

    // すべての root が中心ノードから 1 本の link で吊られている = 放射
    const roots = ['r1', 'r2', 'r3'];
    for (const r of roots) {
        await expect(
            page.locator(`.mindmap-layer-links path.mindmap-link[data-source-id="__title__"][data-target-id="${r}"]`),
            `__title__ → ${r} の link`
        ).toHaveCount(1);
    }
    // 孤立 root (どこからも link が来ていない node) が無い
    const orphans = await page.evaluate(() => {
        const ids: string[] = [];
        document.querySelectorAll('.mindmap-node[data-node-id]').forEach((fo) => {
            const id = fo.getAttribute('data-node-id')!;
            if (id === '__title__') { return; }
            if (!document.querySelector(`path.mindmap-link[data-target-id="${id}"]`)) { ids.push(id); }
        });
        return ids;
    });
    expect(orphans).toEqual([]);
});

test('TC-MMT-02 空タイトルの中心ノードは薄いイタリックの Untitled プレースホルダ', async ({ page }) => {
    await toMindmap(page, noTitleTree());
    const ph = page.locator('.mindmap-title-box .mindmap-node-text.is-placeholder');
    await expect(ph).toHaveCount(1);
    expect((await ph.textContent())!.trim().length).toBeGreaterThan(0);   // 空 box ではない
    const style = await ph.evaluate((el) => {
        const s = getComputedStyle(el as HTMLElement);
        return { opacity: parseFloat(s.opacity), fontStyle: s.fontStyle };
    });
    expect(style.opacity).toBeLessThan(1);        // 薄い = 実タイトルと見分けが付く
    expect(style.fontStyle).toBe('italic');

    // タイトルがあるときは placeholder を付けない (counterfactual)
    await toMindmap(page, Object.assign(noTitleTree(), { title: 'Real Title' }));
    await expect(page.locator('.mindmap-title-box .mindmap-node-text.is-placeholder')).toHaveCount(0);
    expect((await page.locator('.mindmap-title-box .mindmap-node-text').textContent())!.trim()).toBe('Real Title');
});

test('TC-MMT-03 プレースホルダは編集開始で捨てられ、model.title に保存されない', async ({ page }) => {
    await toMindmap(page, noTitleTree());
    const titleText = page.locator('.mindmap-node[data-node-id="__title__"] .mindmap-node-text');
    await titleText.dblclick();
    await page.waitForTimeout(120);

    // 編集開始の時点で placeholder 文字が消えている (残ると 'Untitled' が実タイトルになる)
    expect(await titleText.evaluate((el) => (el as HTMLElement).textContent)).toBe('');
    expect(await titleText.evaluate((el) => (el as HTMLElement).classList.contains('is-placeholder'))).toBe(false);

    await page.keyboard.type('My Map');
    // 別ノードを click して確定 (commitEdit)
    await page.locator('.mindmap-node[data-node-id="r2"] .mindmap-node-box').click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as any).__testApi.getModel().title)).toBe('My Map');
});

test('TC-MMT-03b 何も打たずに編集を抜けてもタイトルは空のまま (Untitled が保存されない)', async ({ page }) => {
    await toMindmap(page, noTitleTree());
    await page.locator('.mindmap-node[data-node-id="__title__"] .mindmap-node-text').dblclick();
    await page.waitForTimeout(120);
    await page.locator('.mindmap-node[data-node-id="r2"] .mindmap-node-box').click();
    await page.waitForTimeout(200);
    const title = await page.evaluate(() => (window as any).__testApi.getModel().title);
    expect(title == null || title === '').toBe(true);
    // placeholder は再描画で戻る
    await expect(page.locator('.mindmap-title-box .mindmap-node-text.is-placeholder')).toHaveCount(1);
});
