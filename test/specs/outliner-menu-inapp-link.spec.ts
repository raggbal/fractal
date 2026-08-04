/**
 * FR-B05 — Note Outliner ヘッダー Menu（⋮ ドロップダウン）に「Copy in-App Link」項目を追加
 *
 * Notes モード（.notes-layout あり）でのみ表示。
 *   folder    = .notes-layout dataset.noteFolderName
 *   outFileId = notesFilePanel.getCurrentOutFileId()
 *   link      = InAppLinkUtils.buildOutLink(folder, outFileId) = fractal://note/{folder}/{outFileId}
 *               （OUT link。nodeId なし・/md/・/page/ セグメントなし）
 *   表示テキスト = 現在の outliner タイトル（model.title）。title の [] は除去。
 *   clipboard = [title](link)
 *
 * リンク文字列は src/shared/inapp-link-utils.js が唯一の生成元。
 * この spec は「Menu 項目が InAppLinkUtils.buildOutLink を正しい引数で呼び clipboard に載せる」
 * ことと「Notes 外（.notes-layout なし）では項目が出ない」ことを検証する。
 */
import { test, expect, Page } from '@playwright/test';

const FOLDER = 'noteA';
const OUT_FILE = '/Users/test/notes/noteA/mydoc.out';
const OUT_ID = 'mydoc';

// copyInAppLink ラベル（全 locale 網羅）
const COPY_INAPP_RE = /Copy in-App Link|Copy In-App Link|アプリ内リンクをコピー|앱 내 링크 복사|复制应用内链接|複製應用內連結|Copier le lien interne|Copiar enlace interno/i;

async function openMenu(page: Page) {
    const menuBtn = page.locator('.outliner-menu-btn');
    await expect(menuBtn).toBeVisible();
    await menuBtn.click();
    await page.waitForTimeout(100);
    await expect(page.locator('.outliner-menu-dropdown')).toBeVisible();
}

test.describe('FR-B05: Note Outliner Menu Copy in-App Link (standalone-notes)', () => {
    test.beforeEach(async ({ context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    });

    test('TC-B05-01: Menu の Copy in-App Link → buildOutLink 形式 [title](link) を clipboard へ（title の [] 除去）', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);

        // outliner タイトルを [] 入りで注入（[] 除去が load-bearing になるようにする）。
        // 注: initOutliner を再度呼ぶと Outliner.init() が再走行し、menuBtn の click listener が
        // addEventListener で二重登録される（1 click で open+close して dropdown が出ない）。
        // 本番 notes と同じ updateData(kind=out) 経路で title を差し込み init 再走行を避ける。
        await page.evaluate(({ outFile }) => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'out', fileChangeId: 1, outFileKey: outFile,
                data: { version: 1, rootIds: [], nodes: {}, title: 'My [Doc]' },
            });
        }, { outFile: OUT_FILE });
        // folder + fileList を注入 → getCurrentOutFileId() が OUT_ID を返す
        await page.evaluate(({ folder, outFile, outId }) => {
            (window as any).__testApi.initNotesPanel(
                [{ filePath: outFile, title: 'My Doc', id: outId }],
                outFile,
                { version: 1, rootIds: [outId], items: { [outId]: { type: 'file', id: outId, title: 'My Doc', ext: 'out' } } },
                null,
                folder
            );
        }, { folder: FOLDER, outFile: OUT_FILE, outId: OUT_ID });
        await page.waitForTimeout(150);

        await openMenu(page);

        const copyItem = page.locator('.outliner-menu-dropdown .menu-item').filter({ hasText: COPY_INAPP_RE });
        await expect(copyItem, 'Notes モードの Menu に Copy in-App Link 項目が存在').toHaveCount(1);
        await copyItem.click();
        await page.waitForTimeout(150);

        // 期待リンクは InAppLinkUtils.buildOutLink を実際に呼んで導出（ハードコードしない）
        const expectedLink = await page.evaluate(({ folder, outId }) =>
            (window as any).InAppLinkUtils.buildOutLink(folder, outId), { folder: FOLDER, outId: OUT_ID });
        expect(expectedLink).toBe('fractal://note/noteA/mydoc');
        // OUT link は nodeId / md / page セグメントを持たない
        expect(expectedLink).not.toContain('/md/');
        expect(expectedLink).not.toContain('/page/');

        const clip = await page.evaluate(() => navigator.clipboard.readText());
        // 表示テキストは model.title 'My [Doc]' の [] を除去した 'My Doc'
        expect(clip).toBe('[My Doc](' + expectedLink + ')');
        expect(clip).not.toMatch(/[\[\]]Doc/); // 角括弧が title 側に残っていない
    });

    test('TC-B05-02: standalone-outliner（.notes-layout なし）の Menu には Copy in-App Link が出ない（counterfactual）', async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);

        // standalone-outliner には .notes-layout が無い（= Notes 外環境）
        const notesLayoutCount = await page.locator('.notes-layout').count();
        expect(notesLayoutCount, 'standalone-outliner に .notes-layout は無い').toBe(0);

        await openMenu(page);

        // Menu には他項目（Import .md files 等）はあるが Copy in-App Link は出ない
        const allItems = await page.locator('.outliner-menu-dropdown .menu-item').allTextContents();
        expect(allItems.length, 'Menu に項目はある').toBeGreaterThan(0);
        const copyItemCount = await page.locator('.outliner-menu-dropdown .menu-item').filter({ hasText: COPY_INAPP_RE }).count();
        expect(copyItemCount, 'Notes 外では Copy in-App Link は出ない').toBe(0);
    });
});
