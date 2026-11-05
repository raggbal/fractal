/**
 * Notes の左パネルを閉じたとき、note 面のヘッダーの一番左に ≡（パネル開閉）→ Recent の Back / Forward（< >）を出す（2026-11-05 ユーザー依頼）。
 * - note outliner: 1 行目の左端に ≡ → < > → タイトル（2 行目は集中ボタンから）
 * - note md: ≡ → < > → Outline 開閉 → Undo / Redo（Outline を開いているときは Outline のヘッダで ≡ → < >）
 * - note file viewer: ≡ → < > → ファイルのタイトル
 * - folder view（linkedfd をメインで開いた画面）: ≡ → < >（同じ ≡ の出し分けに合わせる）
 * パネルを開いている間は出さない（パネル最上段の < > がある）。押せるか（端）はパネルの < > と同じで、押すとパネルの < > と同じ動き。
 * TC-HHN-01 outliner / TC-HHN-02 md（Outline 閉・開）/ TC-HHN-03 viewer / TC-HHN-04 folder view / TC-HHN-05 押したときの動きと端
 */
import { test, expect, Page } from '@playwright/test';

const H = [
    { kind: 'note-md', id: '/n/a.md', title: 'a', ts: 3, pane: 'main' },
    { kind: 'out', id: '/n/b.out', title: 'b', ts: 2, pane: 'main' },
    { kind: 'note-md', id: '/n/c.md', title: 'c', ts: 1, pane: 'main' },
];

async function setup(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready && (window as any).__viewerDispatcher && (window as any).__folderViewDispatcher);
    await page.evaluate((h) => { (window as any).__testApi.initHistoryPanel(h, null, false); }, H);
}
async function collapsePanel(page: Page) {
    await page.locator('#filePanelCollapse').click();
    await expect(page.locator('.notes-file-panel')).toHaveClass(/collapsed/);
}
/** 表示中の子要素を左から順に（class の先頭 + data-notes-history-nav）。x で並べる */
async function visibleOrder(page: Page, containerSel: string) {
    return page.evaluate((sel) => {
        const c = document.querySelector(sel)!;
        return Array.from(c.children)
            .filter((e) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; })
            .sort((a, b) => (a as HTMLElement).getBoundingClientRect().left - (b as HTMLElement).getBoundingClientRect().left)
            .map((e) => (e.getAttribute('data-notes-history-nav') ? 'hist-' + e.getAttribute('data-notes-history-nav') : (e.id ? '#' + e.id : (e.getAttribute('data-action') ? '[' + e.getAttribute('data-action') + ']' : e.className.split(' ')[0]))));
    }, containerSel);
}

test('TC-HHN-01 outliner: パネルを閉じると 1 行目の左端に ≡ → < > → タイトル（開いている間は出さない）', async ({ page }) => {
    await setup(page);
    const hist = page.locator('.outliner-page-title .notes-header-history-btn');
    await expect(hist).toHaveCount(2);
    await expect(hist.first()).toBeHidden();
    await collapsePanel(page);
    await expect(hist.first()).toBeVisible();
    const order = await visibleOrder(page, '.outliner-page-title');
    expect(order.slice(0, 4)).toEqual(['#notesPanelToggleBtn', 'hist-back', 'hist-forward', 'outliner-page-title-input']);
    // 2 行目は集中ボタンから（≡ と < > は 2 行目に無い）
    await expect(page.locator('.outliner-search-bar .notes-header-history-btn, .outliner-search-bar #notesPanelToggleBtn')).toHaveCount(0);
});

test('TC-HHN-02 md: Outline 閉は toolbar で ≡ → < > → Outline 開閉 → Undo / Redo、Outline 開は Outline のヘッダで ≡ → < >', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { (window as any).__testApi.mdDispatcher.loadMarkdown('# T\n\ntext', '/n/a.md', ''); });
    await page.waitForSelector('.markdown-container .toolbar');
    await collapsePanel(page);
    // Outline 閉（既定）
    const tb = '.markdown-container .toolbar-fixed--left';
    const order = await visibleOrder(page, tb);
    const flat = order.filter((x) => x !== 'toolbar-group');
    expect(flat.slice(0, 4)).toEqual(['notes-panel-toggle-btn', 'hist-back', 'hist-forward', '#openSidebarBtn']);
    const undoAfter = await page.evaluate((sel) => {
        const fwd = document.querySelector(sel + ' .notes-header-history-btn[data-notes-history-nav="forward"]')!.getBoundingClientRect();
        const outline = document.querySelector('.markdown-container #openSidebarBtn')!.getBoundingClientRect();
        const undo = document.querySelector(sel + ' [data-action="undo"]')!.getBoundingClientRect();
        return fwd.right <= outline.left + 1 && outline.right <= undo.left + 1;
    }, tb);
    expect(undoAfter, '< > → Outline 開閉 → Undo').toBe(true);
    await expect(page.locator('.markdown-container .sidebar-header .notes-header-history-btn').first()).toBeHidden();

    // Outline 開: toolbar 側は消え、Outline のヘッダの ≡ の右に出る
    await page.locator('.markdown-container #openSidebarBtn').click();
    await expect(page.locator('.markdown-container #sidebar')).not.toHaveClass(/hidden/);
    await expect(page.locator(tb + ' .notes-header-history-btn').first()).toBeHidden();
    const head = await visibleOrder(page, '.markdown-container .sidebar-header');
    expect(head.slice(0, 3)).toEqual(['notes-panel-toggle-btn', 'hist-back', 'hist-forward']);
});

test('TC-HHN-03 viewer: ≡ → < > → ファイルのタイトル', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: './viewer-fixtures/sample.html', fileName: 'sample.html' }, '*'); });
    await page.waitForSelector('#viewerContainer .viewer-toolbar', { state: 'visible' });
    const hist = page.locator('#viewerContainer .viewer-toolbar .notes-header-history-btn');
    await expect(hist).toHaveCount(2);
    await expect(hist.first()).toBeHidden();
    await collapsePanel(page);
    await expect(hist.first()).toBeVisible();
    const order = await visibleOrder(page, '#viewerContainer .viewer-toolbar');
    expect(order.slice(0, 3)).toEqual(['notes-panel-toggle-btn', 'hist-back', 'hist-forward']);
    expect(order[3], 'その次はファイルのタイトル').toMatch(/title|name/);
});

test('TC-HHN-04 folder view: ≡ → < >（開き直しても 1 組だけ）', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
    await page.waitForSelector('#folderViewContainer .fv-header', { state: 'visible' });
    await collapsePanel(page);
    const order = await visibleOrder(page, '#folderViewContainer .fv-header');
    expect(order.slice(0, 3)).toEqual(['notes-panel-toggle-btn', 'hist-back', 'hist-forward']);
    await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
    await expect(page.locator('#folderViewContainer .notes-header-history-btn')).toHaveCount(2);
});

test('TC-HHN-05 ヘッダーの < > はパネルの < > と同じ動き。端では押せない', async ({ page }) => {
    await setup(page);
    await collapsePanel(page);
    const back = page.locator('.outliner-page-title .notes-header-history-btn[data-notes-history-nav="back"]');
    const fwd = page.locator('.outliner-page-title .notes-header-history-btn[data-notes-history-nav="forward"]');
    const pe = (l: any) => l.evaluate((e: HTMLElement) => getComputedStyle(e).pointerEvents);
    // 先頭: Back だけ押せる
    expect(await pe(back)).not.toBe('none');
    expect(await pe(fwd)).toBe('none');
    await page.evaluate(() => { (window as any).__testApi.messages = []; });
    await back.click();
    const msgs = await page.evaluate(() => (window as any).__testApi.messages.filter((m: any) => !/^notesSaveHistoryPanel/.test(m.type)));
    expect(msgs).toEqual([{ type: 'notesOpenFile', filePath: '/n/b.out', noHistory: true }]);
    expect(await page.evaluate(() => (window as any).__notesHistoryPanel.getCursor())).toBe(1);
    // 真ん中: 両方押せる（パネルの < > と同じ）
    expect(await pe(fwd)).not.toBe('none');
    expect(await page.evaluate(() => (document.getElementById('notesHistoryForward') as HTMLButtonElement).disabled)).toBe(false);
    await fwd.click();
    expect(await page.evaluate(() => (window as any).__notesHistoryPanel.getCursor())).toBe(0);
    expect(await pe(fwd)).toBe('none');
});
