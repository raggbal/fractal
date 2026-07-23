/**
 * sidepanel-recent-history — 最近開いたファイル履歴パネル（FR-HP-01/04/05/06/07）E2E
 *
 * standalone-notes build で history パネルの DOM・描画・開閉・クリック振り分け・縦 resize を検証。
 * 永続化と実 open フックは host+fs 依存で E2E 不能 → 手動 US。ここは webview 側ロジックを検証。
 */
import { test, expect, Page } from '@playwright/test';

// ★reopen 2026-07-23: page-md kind 廃止。page md も note-md（絶対パス）で記録・クリックは全 openFile（メインペイン）。
const HISTORY = [
    { kind: 'out', id: '/note/diagram.out', title: 'diagram', ts: 3 },
    { kind: 'note-md', id: '/note/memo.md', title: 'memo', ts: 2 },
    { kind: 'note-md', id: '/note/pages/p1.md', title: 'ページ1', ts: 1 }, // 旧 page md 相当（絶対パス note-md）
];

async function setup(page: Page, history = HISTORY, height: number | null = null, collapsed = false) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    // FR-HP-08: history パネルは .notes-main-wrapper 下部で「常時表示」。
    // sidepanel を open しない（open しなくても見えることが本要件）。
    await page.evaluate(({ h, hg, c }) => {
        (window as any).__testApi.initHistoryPanel(h, hg, c);
    }, { h: history, hg: height, c: collapsed });
    await page.waitForTimeout(150);
}

test.describe('sidepanel recent history (FR-HP)', () => {
    test('TC-HP-10: history パネルが左ファイルツリーパネル(.notes-file-panel)下部に常時表示', async ({ page }) => {
        await setup(page);
        const info = await page.evaluate(() => {
            const hp = document.getElementById('sidePanelHistory');
            const filePanel = document.querySelector('.notes-file-panel');
            const sidePanel = document.querySelector('.side-panel');
            const mainWrapper = document.querySelector('.notes-main-wrapper');
            // 左パネル内の最後の file-panel-content（history はその後＝最下部にあるべき）
            const contents = filePanel ? Array.from(filePanel.querySelectorAll(':scope > .file-panel-content')) : [];
            const lastContent = contents[contents.length - 1] || null;
            const rect = hp ? hp.getBoundingClientRect() : null;
            return {
                exists: !!hp,
                inFilePanel: !!(hp && filePanel && filePanel.contains(hp)),
                notInMainWrapper: !!(hp && mainWrapper && !mainWrapper.contains(hp)),
                notInSidePanel: !!(hp && sidePanel && !sidePanel.contains(hp)),
                // sidepanel を open していないのに実サイズを持つ = 常時表示
                sidePanelOpen: !!(sidePanel && sidePanel.classList.contains('open')),
                visibleHeight: rect ? rect.height : 0,
                // history は file-panel-content 群より後（下部）
                afterContents: !!(hp && lastContent && (lastContent.compareDocumentPosition(hp) & Node.DOCUMENT_POSITION_FOLLOWING)),
            };
        });
        expect(info.exists).toBe(true);
        expect(info.inFilePanel, '左ファイルツリーパネル .notes-file-panel 内（常時表示）').toBe(true);
        expect(info.notInMainWrapper, 'メイン領域 .notes-main-wrapper 内ではない').toBe(true);
        expect(info.notInSidePanel, '右 .side-panel オーバーレイ内ではない').toBe(true);
        expect(info.sidePanelOpen, 'sidepanel は開いていない').toBe(false);
        expect(info.visibleHeight, 'sidepanel を開かなくても実高さを持つ（常時表示）').toBeGreaterThan(20);
        expect(info.afterContents, 'file-panel-content 群より後（下部）').toBe(true);
    });

    test('TC-HP-11: history が最新順で描画・kind 別', async ({ page }) => {
        await setup(page);
        const items = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('#sidePanelHistoryList .side-panel-history-item')).map((el: any) => ({
                kind: el.dataset.kind, id: el.dataset.id, title: el.querySelector('.side-panel-history-item-title')?.textContent,
            }));
        });
        expect(items.length).toBe(3);
        expect(items.map((x) => x.id)).toEqual(['/note/diagram.out', '/note/memo.md', '/note/pages/p1.md']); // 配列先頭=最新
        expect(items[0].kind).toBe('out');
        expect(items[2].title).toBe('ページ1');
    });

    test('TC-HP-12: 開閉トグルで collapsed + host に保存', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        await page.locator('#sidePanelHistoryToggle').click();
        const r = await page.evaluate(() => {
            const hp = document.getElementById('sidePanelHistory')!;
            const msgs = ((window as any).__testApi.messages || []).filter((m: any) => m.type === 'notesSaveHistoryPanelCollapsed');
            return { collapsed: hp.classList.contains('collapsed'), saved: msgs.length, savedVal: msgs[0]?.collapsed };
        });
        expect(r.collapsed, 'collapsed クラス付与').toBe(true);
        expect(r.saved, 'host に保存').toBe(1);
        expect(r.savedVal).toBe(true);
        // list が非表示
        expect(await page.locator('#sidePanelHistoryList').isVisible()).toBe(false);
    });

    // ★reopen 2026-07-23: 全 kind が openFile（メインペイン）に流れる。openPageFromHistory は廃止（送信ゼロ）。
    test('TC-HP-13: クリックは全て openFile（メインペイン統一・load-bearing）', async ({ page }) => {
        await setup(page);
        // note-md クリック → notesOpenFile
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        await page.locator('#sidePanelHistoryList .side-panel-history-item[data-kind="note-md"]').first().click();
        let msgs = await page.evaluate(() => (window as any).__testApi.messages);
        expect(msgs.filter((m: any) => m.type === 'notesOpenFile' && m.filePath === '/note/memo.md').length, 'note-md → openFile').toBe(1);

        // 旧 page md 相当（note-md・絶対パス）クリック → openFile（メインペイン。openPageFromHistory には流れない）
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        await page.locator('#sidePanelHistoryList .side-panel-history-item[data-id="/note/pages/p1.md"]').click();
        msgs = await page.evaluate(() => (window as any).__testApi.messages);
        expect(msgs.filter((m: any) => m.type === 'notesOpenFile' && m.filePath === '/note/pages/p1.md').length, '旧 page md も openFile（メインペイン）').toBe(1);
        // ★ counterfactual: 統一で openPageFromHistory は一切送られない（sidepanel 専用経路の廃止を担保）
        expect(msgs.filter((m: any) => m.type === 'openPageFromHistory').length, 'openPageFromHistory は廃止').toBe(0);

        // out クリック → notesOpenFile（メイン）
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        await page.locator('#sidePanelHistoryList .side-panel-history-item[data-kind="out"]').click();
        msgs = await page.evaluate(() => (window as any).__testApi.messages);
        expect(msgs.filter((m: any) => m.type === 'notesOpenFile' && m.filePath === '/note/diagram.out').length, 'out → openFile').toBe(1);
    });

    test('TC-HP-14: 縦 resize で高さ変更 + host に保存', async ({ page }) => {
        await setup(page, HISTORY, 150, false);
        const before = await page.evaluate(() => document.getElementById('sidePanelHistory')!.offsetHeight);
        // resize handle を上へドラッグ（高さ増）
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        const changed = await page.evaluate(() => {
            const handle = document.getElementById('sidePanelHistoryResizeHandle')!;
            const startY = 500;
            handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: startY }));
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: startY - 100 })); // 上へ 100px
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientY: startY - 100 }));
            const hp = document.getElementById('sidePanelHistory')!;
            const msgs = ((window as any).__testApi.messages || []).filter((m: any) => m.type === 'notesSaveHistoryPanelHeight');
            return { height: hp.offsetHeight, saved: msgs.length };
        });
        expect(changed.height, `高さが増えた（${before} → ${changed.height}）`).toBeGreaterThan(before);
        expect(changed.saved, 'host に高さ保存').toBe(1);
    });
});
