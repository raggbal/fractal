/**
 * mindmap で sidepanel を esc/✗ で閉じたら元 node をアクティブに（機能①）。
 * sprint 20260721-145658。closeSidePanelImmediate が mindmap mode で origin node の text 要素へ
 * real DOM focus を当て、閉じた直後にキー操作（↑↓/Enter/Alt+Arrow）が効くようにする。
 *
 * ★load-bearing: is-focused クラスだけでなく「閉じた後に実際にキー操作が効くか」を検証する。
 * （renderTree で class を付けるだけでは real DOM focus が無く keydown が treeEl に届かない = 実機バグ）
 */
import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}
function n(id: string, text: string, extra: any = {}) {
    return Object.assign({ id, parentId: null, children: [], text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] }, extra);
}
async function toMindmap(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(150);
}
async function orderFromSync(page: import('@playwright/test').Page, parentId: string) {
    return page.evaluate((pid) => {
        const msgs = ((window as any).__testApi.messages || []) as any[];
        let last: any = null;
        for (const m of msgs) { if (m.type === 'syncData' && m.content) last = m; }
        if (!last) return null;
        try { const d = JSON.parse(last.content); return d.nodes[pid] ? d.nodes[pid].children.slice() : d.rootIds.slice(); }
        catch { return null; }
    }, parentId);
}

// TC-RF-01: mindmap で sidepanel を開いて閉じると元 node がアクティブ + キー操作が効く（load-bearing）
test('TC-RF-01 mindmap で sidepanel close → 元 node がアクティブでキー操作可能', async ({ page }) => {
    await setup(page);
    // p は兄弟 [p, q] の先頭。close 後に p を選択状態で Alt+↓ すると [q, p] になる（キー操作が効く証明）。
    await toMindmap(page, { version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: { r: n('r', 'Root', { children: ['p', 'q'] }),
            p: n('p', 'PageNode', { parentId: 'r', isPage: true, pageId: 'uuid-p' }),
            q: n('q', 'Q', { parentId: 'r' }) } });

    // p を選択して cmd+enter → openPageInSidePanel（sidePanelOriginNodeId = p）
    await page.locator('.mindmap-node[data-node-id="p"]').click();
    await page.waitForTimeout(50);
    await page.keyboard.press('Meta+Enter');
    await page.waitForTimeout(100);
    // sidepanel を開いた状態を作る（standalone は openSidePanel host message で。既存 nav-flow パターン）
    await page.evaluate(() => {
        (window as any).__hostMessageHandler && (window as any).__hostMessageHandler({
            type: 'openSidePanel', markdown: '# P', filePath: '/x/uuid-p.md', fileName: 'uuid-p.md', toc: [],
        });
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });

    // esc で閉じる → closeSidePanelImmediate（mindmap 分岐で p へ real focus）
    await page.keyboard.press('Escape');
    await page.waitForTimeout(450); // closeSidePanel の setTimeout(200) + rerender + focus

    // (a) 元 node p が is-focused
    await expect(page.locator('.mindmap-node[data-node-id="p"] .mindmap-node-box')).toHaveClass(/is-focused/);
    // (b) ★load-bearing: 閉じた直後にキー操作が効く（Alt+↓ で p が q と入れ替わる）
    await page.keyboard.press('Alt+ArrowDown');
    await page.waitForTimeout(1200);
    expect(await orderFromSync(page, 'r')).toEqual(['q', 'p']);
});
