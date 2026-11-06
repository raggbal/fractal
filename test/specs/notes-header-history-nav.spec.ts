/**
 * Notes の左パネルを閉じたとき、note 面のヘッダーの一番左に ≡（パネル開閉）→ Recent の Back / Forward（< >）を出す（2026-11-05 ユーザー依頼）。
 * - note outliner: 1 行目の左端に ≡ → < > → タイトル（2 行目は集中ボタンから）
 * - note md: ≡ → < > → Outline 開閉 → Undo / Redo（Outline を開いているときは Outline のヘッダで ≡ → < >）
 * - note file viewer: ≡ → < > → ファイルのタイトル
 * - folder view（linkedfd をメインで開いた画面）: ≡ → < >（同じ ≡ の出し分けに合わせる）
 * パネルを開いている間は出さない（パネル最上段の < > がある）。押せるか（端）はパネルの < > と同じで、押すとパネルの < > と同じ動き。
 * TC-HHN-01 outliner / TC-HHN-02 md（Outline 閉・開）/ TC-HHN-03 viewer / TC-HHN-04 folder view / TC-HHN-05 押したときの動きと端
 * TC-HHN-06 4 つの画面（md は Outline の開閉の両方）で、ヘッダーの行は 36px、≡ と < > の位置・大きさ・間隔・上下の位置が同じ（2026-11-06 ユーザー依頼）
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

test('TC-HHN-06 4 つの画面で ヘッダーの行は 36px、≡ と < > の位置・大きさ・間隔・上下の位置が同じ', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 700 });
    await setup(page);
    await page.evaluate(() => {
        // test の harness の outliner の ≡ は中身が空なので、本番（notesWebviewContent.ts）と同じ ☰ を入れる
        const t = document.getElementById('notesPanelToggleBtn')!; if (!t.textContent!.trim()) t.innerHTML = '&#9776;';
    });
    await collapsePanel(page);
    const measure = (scopeSel: string, rowSel: string) => page.evaluate(([s, r]) => {
        const scope = document.querySelector(s)!;
        const vis = (e: Element | null) => { if (!e) return null; const b = (e as HTMLElement).getBoundingClientRect(); return b.width > 0 ? b : null; };
        const first = (sel: string) => Array.from(scope.querySelectorAll(sel)).map(vis).find(Boolean) as DOMRect;
        const row = vis(scope.querySelector(r))!;
        const pane = (document.querySelector('.notes-main-wrapper') as HTMLElement).getBoundingClientRect();
        const f = (b: DOMRect) => ({ x: +(b.left - pane.left).toFixed(1), cy: +(b.top + b.height / 2 - row.top).toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) });
        return {
            rowH: +row.height.toFixed(1),
            toggle: f(first('.notes-panel-toggle-btn')),
            back: f(first('.notes-header-history-btn[data-notes-history-nav="back"]')),
            fwd: f(first('.notes-header-history-btn[data-notes-history-nav="forward"]')),
        };
    }, [scopeSel, rowSel]);
    const all: Record<string, any> = {};
    all.outliner = await measure('.outliner-container', '.outliner-page-title');
    all.outlinerRow2H = await page.evaluate(() => (document.querySelector('.outliner-search-bar') as HTMLElement).getBoundingClientRect().height);
    await page.evaluate(() => { (window as any).__testApi.mdDispatcher.loadMarkdown('# T\n\ntext', '/n/a.md', ''); });
    await page.waitForSelector('.markdown-container .toolbar');
    all.md = await measure('.markdown-container', '.toolbar');
    await page.locator('.markdown-container #openSidebarBtn').click();
    await expect(page.locator('.markdown-container #sidebar')).not.toHaveClass(/hidden/);
    all.mdOutlineOpen = await measure('.markdown-container', '.sidebar-header');
    await page.locator('.markdown-container #closeSidebar').click();
    await page.evaluate(() => { window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: './viewer-fixtures/sample.html', fileName: 'sample.html' }, '*'); });
    await page.waitForSelector('#viewerContainer .viewer-toolbar', { state: 'visible' });
    all.viewer = await measure('#viewerContainer', '.viewer-toolbar');
    await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
    await page.waitForSelector('#folderViewContainer .fv-header', { state: 'visible' });
    all.linkedfd = await measure('#folderViewContainer', '.fv-header');

    expect(all.outlinerRow2H, 'outliner の 2 行目も 36px').toBe(36);
    const ref = all.md;
    expect(ref.rowH).toBe(36);
    for (const k of ['outliner', 'mdOutlineOpen', 'viewer', 'linkedfd']) {
        const v = all[k];
        expect(v.rowH, k + ' の行の高さ').toBe(36);
        for (const b of ['toggle', 'back', 'fwd']) {
            for (const p of ['x', 'cy', 'w', 'h']) {
                expect(Math.abs(v[b][p] - ref[b][p]), `${k} の ${b}.${p}（${v[b][p]} / md ${ref[b][p]}）`).toBeLessThan(0.6);
            }
        }
    }
});
