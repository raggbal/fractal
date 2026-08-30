/**
 * outliner-export-folder.spec.ts — FR-EXF-01/02（TC-EXF-06 / TC-EXF-08）
 *
 * Sprint 20260827-172802 TASK-12。webview 側の 2 点を実 Chromium（standalone ハーネス）で検証:
 * - DOM-ExportPayload: `buildExportTree(nodeId|null)` が children + images + subtext を載せ、
 *   **collapsed 配下も含む**（実測: buildLlmsTxtTree:7272 が n.children を直接再帰する意味論を踏襲）
 * - ≡ ヘッダーメニュー「Export folder...」の対象解決 = focus 中の node の subtree（focus 無しは outline 全体）
 *
 * bridge 送信は本番と別実装のハーネス recorder（`__testApi.messages`）で観測する。
 */
import { test, expect, Page } from '@playwright/test';

const DATA = {
    version: 1,
    rootIds: ['n1', 'n2'],
    nodes: {
        n1: {
            id: 'n1', parentId: null, children: ['c1'], text: 'Root1', tags: [],
            subtext: 'sub of root1', images: ['images/a.png'],
        },
        c1: {
            id: 'c1', parentId: 'n1', children: ['g1'], text: 'Child1', tags: [],
            collapsed: true, isPage: true, pageId: 'p-1',
        },
        g1: { id: 'g1', parentId: 'c1', children: [], text: 'Grand1', tags: [], filePath: 'files/x.pdf' },
        n2: { id: 'n2', parentId: null, children: [], text: 'Root2', tags: [] },
    },
};

async function initOutliner(page: Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    // updateData 経路（initOutliner 再呼び出しは menuBtn の listener を二重登録するため使わない）
    await page.evaluate((data) => {
        (window as any).__hostMessageHandler({
            type: 'updateData', kind: 'out', fileChangeId: 1, outFileKey: '/tmp/export-spec.out', data,
        });
    }, DATA);
    await page.waitForTimeout(150);
}

const sentTrees = (page: Page) => page.evaluate(() =>
    (window as any).__testApi.messages
        .filter((m: any) => m.type === 'exportOutlinerFolder')
        .map((m: any) => m.tree));

async function openMenu(page: Page) {
    const btn = page.locator('.outliner-menu-btn');
    await expect(btn).toBeVisible();
    await btn.click();
    await page.waitForTimeout(100);
    await expect(page.locator('.outliner-menu-dropdown')).toBeVisible();
}

const EXPORT_LABEL = /Export folder|フォルダを書き出|폴더 내보내|导出文件夹|匯出資料夾|Exporter un dossier|Exportar carpeta/i;

test.describe('FR-EXF-01/02: Export folder の payload と ≡ 対象解決', () => {

    test('TC-EXF-06: buildExportTree が children/images/subtext を載せ collapsed 配下も含む', async ({ page }) => {
        await initOutliner(page);

        const tree = await page.evaluate(() => (window as any).Outliner.buildExportTree('n1'));

        expect(tree.id).toBe('n1');
        expect(tree.text).toBe('Root1');
        expect(tree.subtext, 'subtext が載る').toBe('sub of root1');
        expect(tree.images, '直付き画像が載る').toEqual(['images/a.png']);
        expect(tree.pageId, 'isPage でない node の pageId は null').toBeNull();

        // collapsed=true の子とその孫も含む（表示状態に依存しない）
        expect(tree.children.map((c: any) => c.id)).toEqual(['c1']);
        const c1 = tree.children[0];
        expect(c1.pageId, 'md 添付は pageId が載る').toBe('p-1');
        expect(c1.children.map((c: any) => c.id), 'collapsed 配下の孫も含む').toEqual(['g1']);
        expect(c1.children[0].filePath, 'file 添付は filePath が載る').toBe('files/x.pdf');

        // null → outline 全体（root 群を配列で返す）
        const all = await page.evaluate(() => (window as any).Outliner.buildExportTree(null));
        expect(Array.isArray(all), 'null は配列（root 群）').toBe(true);
        expect(all.map((n: any) => n.id)).toEqual(['n1', 'n2']);
    });

    test('TC-EXF-08: ≡ メニューの Export folder は focus 中 node の subtree を送る', async ({ page }) => {
        await initOutliner(page);

        // n2 を click して focus
        await page.locator('.outliner-node .outliner-text').filter({ hasText: 'Root2' }).first().click();
        await page.waitForTimeout(100);

        await openMenu(page);
        const item = page.locator('.outliner-menu-dropdown .menu-item').filter({ hasText: EXPORT_LABEL });
        await expect(item, '≡ に Export folder 項目がある').toHaveCount(1);
        await item.click();
        await page.waitForTimeout(150);

        const trees = await sentTrees(page);
        expect(trees, 'bridge へ 1 回送信').toHaveLength(1);
        // focus した node の subtree（配列 1 要素 or 単体のどちらでも root は n2 であること）
        const sent = Array.isArray(trees[0]) ? trees[0] : [trees[0]];
        expect(sent.map((n: any) => n.id), 'focus した n2 の subtree').toEqual(['n2']);
        await expect(page.locator('.outliner-menu-dropdown'), 'クリックでメニューが閉じる').toHaveCount(0);
    });

    test('TC-EXF-08: focus が無い/stale のときは outline 全体（root 群）を送る', async ({ page }) => {
        await initOutliner(page);

        // 前提を明示 assert: この状態の focusedNodeId は「無い」か「model に実在しない stale id」
        // （updateData で model が差し替わるため）。どちらでも outline 全体が正しい対象になる。
        const focusState = await page.evaluate(() => {
            const O = (window as any).Outliner;
            const id = O.getFocusedNodeId ? O.getFocusedNodeId() : null;
            return { id, exists: !!(id && O.getModel().getNode(id)) };
        });
        expect(focusState.exists, 'fixture 前提: focus が無い or stale（実在しない）').toBe(false);

        await openMenu(page);
        const item = page.locator('.outliner-menu-dropdown .menu-item').filter({ hasText: EXPORT_LABEL });
        await item.click();
        await page.waitForTimeout(150);

        const trees = await sentTrees(page);
        expect(trees).toHaveLength(1);
        const sent = trees[0];
        expect(Array.isArray(sent), '配列で送る').toBe(true);
        expect(sent.every((n: any) => n && n.id), 'payload に null が混ざらない').toBe(true);
        expect(sent.map((n: any) => n.id), 'outline 全体（root 群）').toEqual(['n1', 'n2']);
    });
});
