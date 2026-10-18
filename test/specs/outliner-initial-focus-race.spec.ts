/**
 * init 直後の遅延初期フォーカス（setTimeout 100ms → 先頭 node）が、その間にユーザーが focus した node を奪わない。
 * lesson L-20260829-g20（recurrence 2 で番人化）: 待たずに click → shift+↓ すると範囲が先頭 node から始まり、
 * export-selection-roots.spec.ts が HEAD でも落ちていた。
 */
import { test, expect } from '@playwright/test';

function n(id: string, text: string) {
    return { id, parentId: null, children: [], text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] };
}

test('init 直後に click した node の focus は遅延初期フォーカスに奪われない（先頭 node へ飛ばない）', async ({ page }) => {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({ version: 1, rootIds: ['a', 'b', 'c'],
            nodes: { a: { id: 'a', parentId: null, children: [], text: 'alpha', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
                b: { id: 'b', parentId: null, children: [], text: 'bravo', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
                c: { id: 'c', parentId: null, children: [], text: 'charlie', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] } } });
        // init と同じタスク内で b に focus（= 遅延タイマーより必ず前）
        ((document.querySelector('.outliner-node[data-id="b"] .outliner-text') as HTMLElement)).focus();
    });
    const activeId = () => page.evaluate(() => (document.activeElement as any)?.closest?.('.outliner-node')?.dataset.id || null);
    expect(await activeId()).toBe('b');
    await page.waitForTimeout(300);   // 遅延初期フォーカス（100ms）が確実に発火した後
    expect(await activeId(), '遅延初期フォーカスが b の focus を奪って先頭 node へ移した').toBe('b');
});

test('何も focus していなければ従来どおり先頭 node に focus する', async ({ page }) => {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((nodes) => { (window as any).__testApi.initOutliner({ version: 1, rootIds: ['a', 'b'], nodes }); },
        { a: n('a', 'alpha'), b: n('b', 'bravo') });
    await expect.poll(() => page.evaluate(() => (document.activeElement as any)?.closest?.('.outliner-node')?.dataset.id || null)).toBe('a');
});
