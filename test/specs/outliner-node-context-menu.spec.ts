/**
 * outliner-node-context-menu.spec.ts — FR-NCM-01/02（TC-NCM-01 / TC-NCM-02）
 *
 * Sprint 20260827-172802 TASK-13。node 右クリックメニューへ Import/Export 系 4 項目を追加し、
 * 対象を「右クリックしたその node」にする（focus / 選択集合は参照しない）。
 * design/system/outliner-node-context-menu.md が仕様。
 */
import { test, expect, Page } from '@playwright/test';

const DATA = {
    version: 1,
    rootIds: ['n1', 'n2', 'n3'],
    nodes: {
        n1: { id: 'n1', parentId: null, children: [], text: 'Alpha', tags: [] },
        n2: { id: 'n2', parentId: null, children: [], text: 'Bravo', tags: [] },
        n3: { id: 'n3', parentId: null, children: [], text: 'Charlie', tags: [] },
    },
};

const ITEM_RE = {
    importMd: /Import \.md files|\.md ファイルを取り込|md 파일 가져오|导入 \.md|匯入 \.md|Importer des fichiers \.md|Importar archivos \.md/i,
    importFiles: /Import any files|ファイルを取り込|파일 가져오|导入文件|匯入檔案|Importer des fichiers|Importar archivos/i,
    importFolder: /Import folder|フォルダを取り込|폴더 가져오|导入文件夹|匯入資料夾|Importer un dossier|Importar carpeta/i,
    exportFolder: /Export folder|フォルダを書き出|폴더 내보내|导出文件夹|匯出資料夾|Exporter un dossier|Exportar carpeta/i,
};

async function initOutliner(page: Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((data) => {
        (window as any).__hostMessageHandler({
            type: 'updateData', kind: 'out', fileChangeId: 1, outFileKey: '/tmp/ncm-spec.out', data,
        });
    }, DATA);
    await page.waitForTimeout(150);
}

/** 指定テキストの node を右クリックしてメニューを開く */
async function rightClickNode(page: Page, text: string) {
    const el = page.locator('.outliner-node .outliner-text').filter({ hasText: text }).first();
    await expect(el).toBeVisible();
    await el.click({ button: 'right' });
    await page.waitForTimeout(120);
    await expect(page.locator('.outliner-context-menu')).toBeVisible();
}

const menuTexts = (page: Page) => page.locator('.outliner-context-menu .outliner-context-menu-item').allTextContents();
const messages = (page: Page, type: string) => page.evaluate((t) =>
    (window as any).__testApi.messages.filter((m: any) => m.type === t), type);

test.describe('FR-NCM-01/02: node 右クリックメニューの Import/Export 系', () => {

    test('TC-NCM-01: 4 項目が既存項目の後に separator 付きでこの順で並ぶ', async ({ page }) => {
        await initOutliner(page);
        await rightClickNode(page, 'Alpha');

        const texts = await menuTexts(page);
        const idx = {
            importMd: texts.findIndex((t) => ITEM_RE.importMd.test(t)),
            importFiles: texts.findIndex((t) => ITEM_RE.importFiles.test(t) && !ITEM_RE.importMd.test(t)),
            importFolder: texts.findIndex((t) => ITEM_RE.importFolder.test(t)),
            exportFolder: texts.findIndex((t) => ITEM_RE.exportFolder.test(t)),
        };
        expect(idx.importMd, 'Import .md files が存在').toBeGreaterThanOrEqual(0);
        expect(idx.importFiles, 'Import any files が存在').toBeGreaterThanOrEqual(0);
        expect(idx.importFolder, 'Import folder が存在').toBeGreaterThanOrEqual(0);
        expect(idx.exportFolder, 'Export folder が存在').toBeGreaterThanOrEqual(0);

        // 全順序（隣接ペア）を pin — 部分順序では逆順実装を素通しする
        expect(idx.importMd, 'md → any files').toBeLessThan(idx.importFiles);
        expect(idx.importFiles, 'any files → folder').toBeLessThan(idx.importFolder);
        expect(idx.importFolder, 'folder → export').toBeLessThan(idx.exportFolder);

        // 4 項目は末尾に固まっている（既存項目の後）
        expect(idx.exportFolder, '最後の項目が Export folder').toBe(texts.length - 1);
        expect(idx.importMd, '4 項目が連続している').toBe(texts.length - 4);

        // 既存項目の回帰（削除・並び替えしていない）
        const existing = texts.slice(0, texts.length - 4).join('|');
        for (const re of [/Add Child Node|子ノード/i, /Move Up|上へ/i, /Delete Node|ノードを削除/i]) {
            expect(existing, `既存項目が残る: ${re}`).toMatch(re);
        }
    });

    // 実測（TASK-13 実装時・probe spec）: **右クリックは focus をその node へ移す**（n1 focus → n2 右クリック
    // → focusedNodeId が n2 になる）。したがって「右クリック node」と「focusedNodeId」はクリック時点で
    // 一致し、この 2 本目の test は FR-NCM-02 の要求（対象 = 右クリックした node）を pin するが、
    // focus 参照実装との差は検出できない。**判別力を持つのは 3 本目（選択集合を無視）**で、
    // そちらは counterfactual（選択集合優先に変える）で RED を実測済み。
    test('TC-NCM-02: 対象は右クリックした node（focus は右クリックで追従するため一致）', async ({ page }) => {
        await initOutliner(page);
        // Alpha を click して focus を置く
        await page.locator('.outliner-node .outliner-text').filter({ hasText: 'Alpha' }).first().click();
        await page.waitForTimeout(100);
        const focused = await page.evaluate(() => (window as any).Outliner.getFocusedNodeId());
        expect(focused, 'focus は n1（Alpha）').toBe('n1');

        // 別 node（Bravo = n2）を右クリック → Import folder
        await rightClickNode(page, 'Bravo');
        await page.locator('.outliner-context-menu .outliner-context-menu-item')
            .filter({ hasText: ITEM_RE.importFolder }).first().click();
        await page.waitForTimeout(120);

        const sent = await messages(page, 'importFolderDialog');
        expect(sent, 'importFolderDialog が 1 回').toHaveLength(1);
        expect(sent[0].targetNodeId, '右クリックした n2 が対象（focus の n1 ではない）').toBe('n2');
    });

    test('TC-NCM-02: 複数選択中でも Export folder の対象は右クリックした node（選択集合を無視）', async ({ page }) => {
        await initOutliner(page);
        // n1 と n2 を複数選択（shift+click）
        await page.locator('.outliner-node .outliner-text').filter({ hasText: 'Alpha' }).first().click();
        await page.waitForTimeout(80);
        await page.locator('.outliner-node .outliner-text').filter({ hasText: 'Bravo' }).first().click({ modifiers: ['Shift'] });
        await page.waitForTimeout(80);

        // 選択に含まれない n3（Charlie）を右クリック → Export folder
        await rightClickNode(page, 'Charlie');
        await page.locator('.outliner-context-menu .outliner-context-menu-item')
            .filter({ hasText: ITEM_RE.exportFolder }).first().click();
        await page.waitForTimeout(150);

        const sent = await messages(page, 'exportOutlinerFolder');
        expect(sent, 'exportOutlinerFolder が 1 回').toHaveLength(1);
        const tree = sent[0].tree;
        expect(Array.isArray(tree)).toBe(true);
        expect(tree.map((n: any) => n.id), '右クリックした n3 の subtree のみ（選択集合は無視）').toEqual(['n3']);
    });
});
