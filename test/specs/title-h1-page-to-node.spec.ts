/**
 * FR-TH-05/06: outliner node 由来で開いた sidepanel md の先頭 H1 編集 → 呼び出し元 node の text 反映。
 * origin=構造逆引き（ADRL-0001）: 今開いている md の basename=pageId が現 .out の node に一致する時だけ。
 *
 * 編集は本番 syncContent 経路（__testApi.editSidePanelMarkdown = SidePanelHostBridge.syncContent）で駆動。
 * これは editor が編集ごとに呼ぶ実関数で、updateSidePanelTocFromMarkdown（本番反映コード）を通す。
 */
import { test, expect, Page } from '@playwright/test';

const DOC = 'http://localhost:3000/note1/';

async function initTwoPageNodes(page: Page) {
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({
            version: 1,
            rootIds: ['nA', 'nB'],
            nodes: {
                nA: { id: 'nA', parentId: null, children: [], text: 'A original', tags: [], isPage: true, pageId: 'pA' },
                nB: { id: 'nB', parentId: null, children: [], text: 'B original', tags: [], isPage: true, pageId: 'pB' }
            }
        });
    });
}

async function openSidePanel(page: Page, md: string, pageId: string) {
    await page.evaluate(({ md, fp, doc }) => {
        (window as any).__hostMessageHandler({
            type: 'openSidePanel', markdown: md, filePath: fp, fileName: fp.split('/').pop(), toc: [], documentBaseUri: doc
        });
    }, { md, fp: `${DOC}${pageId}.md`, doc: DOC });
    await page.waitForTimeout(200);
}

async function editSidePanel(page: Page, md: string) {
    await page.evaluate((m) => (window as any).__testApi.editSidePanelMarkdown(m), md);
    await page.waitForTimeout(150);
}

async function nodeText(page: Page, id: string): Promise<string> {
    return page.evaluate((nid) => {
        const n = (window as any).__testApi.getModel().getNode(nid);
        return n ? n.text : '__no_node__';
    }, id);
}

test.describe('FR-TH-05/06 sidepanel md H1 → node text (standalone-outliner)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    // TC-TH-10: node A の page md を開き H1 編集 → node A の text が追従（load-bearing）
    test('TC-TH-10 sidepanel(pA) の H1 編集で node A の text が変わる', async ({ page }) => {
        await initTwoPageNodes(page);
        await openSidePanel(page, '# A original\n\nbody', 'pA');
        expect(await nodeText(page, 'nA')).toBe('A original');

        await editSidePanel(page, '# A renamed\n\nbody');
        expect(await nodeText(page, 'nA'), 'H1 編集で node A が追従').toBe('A renamed');
    });

    // TC-TH-11: クロス状態（★failure DB 2026-07-14）— A から開いた後 B へ navigate、B 編集で B のみ更新・A 不変
    test('TC-TH-11 node A→リンクで pB へ navigate→pB 編集で node B のみ更新・A 不変', async ({ page }) => {
        await initTwoPageNodes(page);
        await openSidePanel(page, '# A original\n', 'pA');
        // 別 md（pB）へ切替（リンク/nav 相当。openSidePanel が isSwitch=true で再入）
        await openSidePanel(page, '# B original\n', 'pB');

        await editSidePanel(page, '# B renamed\n');
        expect(await nodeText(page, 'nB'), 'B が更新される').toBe('B renamed');
        expect(await nodeText(page, 'nA'), 'A は不変（origin=構造逆引きの load-bearing）').toBe('A original');
    });

    // TC-TH-12: 現 .out に該当 node が無い md（履歴/外部由来相当）の H1 編集 → どの node も変わらない
    test('TC-TH-12 現 model に無い pageId の md 編集はどの node も更新しない', async ({ page }) => {
        await initTwoPageNodes(page);
        await openSidePanel(page, '# ghost\n', 'pGHOST'); // pGHOST は model に無い
        await editSidePanel(page, '# ghost renamed\n');
        expect(await nodeText(page, 'nA')).toBe('A original');
        expect(await nodeText(page, 'nB')).toBe('B original');
    });
});
