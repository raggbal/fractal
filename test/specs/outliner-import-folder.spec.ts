/**
 * outliner-import-folder.spec.ts — FR-OIF-01/02・NFR-OIF-01（TC-OIF-04）
 *
 * Sprint 20260827-172802 TASK-04。host の importFolderResult（階層 entries）を webview が
 * 階層 node として再現する面と、≡ メニュー「Import folder...」→ bridge 送信（2 端配線の送信側）を
 * standalone-outliner ハーネス（実 Chromium）で検証する。
 *
 * - dir → 通常 node（text=フォルダ名）/ md → md 添付 node（isPage+pageId・text=拡張子なし）/
 *   file → ファイル添付 node（filePath・text=ファイル名）
 * - 挿入位置 = 対象 node の子末尾（targetNodeId=null は root 末尾）
 * - saveSnapshot は 1 取り込み 1 回 → **undo 1 回で全 node が消える**（DOD-12-11 と同じ検証形）
 */
import { test, expect, Page } from '@playwright/test';

const ENTRIES = [
    {
        kind: 'dir', name: 'docs', children: [
            { kind: 'md', name: 'guide.md', pageId: 'p-guide' },
            {
                kind: 'dir', name: 'img', children: [
                    { kind: 'file', name: 'logo.png', filePath: 'files/logo.png' },
                ],
            },
        ],
    },
    { kind: 'md', name: 'readme.md', pageId: 'p-readme' },
    { kind: 'file', name: 'report.pdf', filePath: 'files/report.pdf' },
];

/** 木を {text, kind 情報, children} に畳んで比較しやすくする */
async function snapshotTree(page: Page) {
    return page.evaluate(() => {
        const model = (window as any).__testApi.getModel();
        const walk = (ids: string[]): any[] => ids.map((id: string) => {
            const n = model.nodes[id];
            return {
                text: n.text,
                isPage: !!n.isPage,
                pageId: n.pageId || null,
                filePath: n.filePath || null,
                children: walk(n.children || []),
            };
        });
        return { rootIds: model.rootIds.slice(), tree: walk(model.rootIds) };
    });
}

async function initTwoNodes(page: Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    // 注: initOutliner の再呼び出しは Outliner.init() を再走行させ menuBtn の listener を
    // 二重登録する（outliner-menu-inapp-link.spec.ts :43 の実録）。本番と同じ updateData 経路で注入する。
    await page.evaluate(() => {
        (window as any).__hostMessageHandler({
            type: 'updateData', kind: 'out', fileChangeId: 1, outFileKey: '/tmp/spec.out',
            data: {
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'Node2', tags: [] },
                },
            },
        });
    });
    await page.waitForTimeout(150);
}

test.describe('FR-OIF-02: importFolderResult の階層 node 再現（TC-OIF-04）', () => {

    test('TC-OIF-04: 対象 node の子末尾に階層再現 + kind 別 node 種別 + undo 1 回で全消滅', async ({ page }) => {
        await initTwoNodes(page);

        await page.evaluate((entries) => {
            (window as any).__hostMessageHandler({
                type: 'importFolderResult', targetNodeId: 'n1', entries, skipped: 0,
            });
        }, ENTRIES);
        await page.waitForTimeout(200);

        const after = await snapshotTree(page);
        expect(after.rootIds, 'root は増えない（active node の下に入る）').toEqual(['n1', 'n2']);

        const n1 = after.tree[0];
        expect(n1.text).toBe('Node1');
        expect(n1.children.map((c: any) => c.text), '子末尾に walk 順で 3 エントリ')
            .toEqual(['docs', 'readme', 'report.pdf']);

        // dir = 通常 node（添付ではない）
        const docs = n1.children[0];
        expect(docs.isPage, 'dir は md 添付ではない').toBe(false);
        expect(docs.filePath, 'dir はファイル添付ではない').toBeNull();
        expect(docs.children.map((c: any) => c.text), '2 階層目も再現').toEqual(['guide', 'img']);

        // md = md 添付 node（text は拡張子なし）
        const guide = docs.children[0];
        expect(guide.isPage).toBe(true);
        expect(guide.pageId).toBe('p-guide');
        expect(guide.filePath, 'md 添付は filePath を持たない（相互排他）').toBeNull();

        // 3 階層目の file 添付
        const logo = docs.children[1].children[0];
        expect(logo.text, 'ファイル名は拡張子込み').toBe('logo.png');
        expect(logo.filePath).toBe('files/logo.png');
        expect(logo.isPage).toBe(false);

        const readme = n1.children[1];
        expect(readme.isPage).toBe(true);
        expect(readme.pageId).toBe('p-readme');
        const report = n1.children[2];
        expect(report.filePath).toBe('files/report.pdf');
        expect(report.isPage).toBe(false);

        // NFR-OIF-01: saveSnapshot 1 回 → undo 1 回で 6 node すべてが戻る
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(200);
        const undone = await snapshotTree(page);
        expect(undone.rootIds).toEqual(['n1', 'n2']);
        expect(undone.tree[0].children, 'undo 1 回で取り込み分が全消滅').toEqual([]);
    });

    test('TC-OIF-04: targetNodeId=null は root 末尾へ（既存 root の後ろ）', async ({ page }) => {
        await initTwoNodes(page);

        await page.evaluate((entries) => {
            (window as any).__hostMessageHandler({
                type: 'importFolderResult', targetNodeId: null, entries, skipped: 0,
            });
        }, ENTRIES);
        await page.waitForTimeout(200);

        const after = await snapshotTree(page);
        expect(after.tree.map((n: any) => n.text), 'root 末尾に追加（既存 2 node は不動）')
            .toEqual(['Node1', 'Node2', 'docs', 'readme', 'report.pdf']);
        expect(after.tree[0].children, '既存 node の子は増えない').toEqual([]);
        expect(after.tree[2].children.map((c: any) => c.text)).toEqual(['guide', 'img']);
    });

    test('TC-OIF-04: ≡ メニュー「Import folder...」→ bridge へ focusedNodeId 付きで送信（送信側）', async ({ page }) => {
        await initTwoNodes(page);

        // 2 番目の node（n2）をクリックして focus（focusedNodeId が同乗することを検証可能にする）
        await page.locator('.outliner-node .outliner-text').nth(1).click();
        await page.waitForTimeout(100);

        const menuBtn = page.locator('.outliner-menu-btn');
        await expect(menuBtn).toBeVisible();
        await menuBtn.click();
        await page.waitForTimeout(100);

        const item = page.locator('.outliner-menu-dropdown .menu-item')
            .filter({ hasText: /Import folder|フォルダを取り込|폴더 가져오|导入文件夹|匯入資料夾|Importer un dossier|Importar carpeta/i });
        await expect(item, 'メニューに Import folder 項目がある').toHaveCount(1);
        await item.click();
        await page.waitForTimeout(100);

        const sent = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'importFolderDialog'));
        expect(sent, 'importFolderDialog が 1 回・focus 中の node id 付きで送られる')
            .toEqual([{ type: 'importFolderDialog', targetNodeId: 'n2' }]);
        await expect(page.locator('.outliner-menu-dropdown'), 'クリックでメニューは閉じる').toHaveCount(0);
    });

    test('TC-OIF-04: entries 空（全件 skip）なら node を 1 つも作らない', async ({ page }) => {
        await initTwoNodes(page);

        // host は「全コピー失敗」でも status='imported' + entries=[] + skipped=N を送りうる
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'importFolderResult', targetNodeId: 'n1', entries: [], skipped: 3,
            });
        });
        await page.waitForTimeout(200);

        const after = await snapshotTree(page);
        expect(after.rootIds, 'root 不変').toEqual(['n1', 'n2']);
        expect(after.tree[0].children, '空 entries で子 node を作らない').toEqual([]);
        expect(after.tree[1].children).toEqual([]);
    });
});
