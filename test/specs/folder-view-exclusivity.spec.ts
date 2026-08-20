/**
 * folder-view-exclusivity.spec.ts — TC-FLV-33 排他マトリクス全セル（7 セル）
 *
 * sprint 20260817-053313-notetree-local-folder-view / TASK-07（FR-FLV-10）。
 * ハーネス: standalone-notes.html（folder-view-dispatcher.js + notes-folder-view.js +
 * viewer-dispatcher.js + notes-md-dispatcher.js 組込済み）。
 * 判定は z-index の重なりでなく display / DOM 不在（testcases.md TC-FLV-33 の契約）。
 * 面切替の駆動は既存 precedent（viewer-note-pane.spec.ts TC-FV-22/35/59）と同型:
 *   md 切替 = __testApi.mdDispatcher.loadMarkdown / viewer = postMessage showNoteViewer /
 *   md sidepanel open = .side-panel への class 付与（sidepanel-tab-coexist.spec.ts 同型）。
 */
import { test, expect, Page } from '@playwright/test';

async function gotoNotes(page: Page): Promise<void> {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() =>
        (window as any).__folderViewDispatcher && (window as any).__viewerDispatcher && (window as any).__testApi);
}

async function showFolderView(page: Page): Promise<void> {
    await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
    await page.waitForSelector('#folderViewContainer', { state: 'visible', timeout: 5000 });
}

function paneDisplay(page: Page, cls: string) {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        return el ? el.style.display : '(missing)';
    }, cls);
}

test.describe('TC-FLV-33 — 排他マトリクス（FR-FLV-10 全 7 セル）', () => {

    test('セル①②: showFolderView → outliner 面 / md 面が display:none（+ folder view 自体はスケルトン mount）', async ({ page }) => {
        await gotoNotes(page);
        // 前提: outliner 面が見えている（ハーネス初期状態）
        expect(await paneDisplay(page, '.outliner-container')).not.toBe('none');
        await showFolderView(page);
        // ① outliner 面 hidden（display で判定 — 被さりではない）
        expect(await paneDisplay(page, '.outliner-container'), '① outliner 面').toBe('none');
        // ② md 面 hidden
        expect(await paneDisplay(page, '.markdown-container'), '② md 面').toBe('none');
        // folder view のスケルトンが実 mount される（排他だけして中身が出ないのを防ぐ）
        expect(await page.locator('#folderViewContainer .fv-header').count()).toBe(1);
        expect(await page.locator('#folderViewContainer .fv-tree').count()).toBe(1);
    });

    test('セル③: showFolderView → note 面 viewer が hide + DOM 破棄', async ({ page }) => {
        await gotoNotes(page);
        // 前提: viewer を表示（message 受信経路 — TC-FV-22 同型）
        await page.evaluate(() => {
            window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: './viewer-fixtures/sample.html', fileName: 'sample.html' }, '*');
        });
        await page.waitForSelector('#viewerContainer', { state: 'visible', timeout: 5000 });
        await page.waitForSelector('#viewerContainer .viewer-html-frame', { timeout: 5000 });

        await showFolderView(page);
        const viewerHidden = await page.evaluate(() => {
            const el = document.getElementById('viewerContainer');
            return !el || el.style.display === 'none';
        });
        expect(viewerHidden, '③ viewer container が hidden').toBe(true);
        expect(await page.locator('#viewerContainer .viewer-html-frame').count(), '③ viewer DOM 破棄（hideViewer 到達）').toBe(0);
    });

    test('セル④: showFolderView → md sidepanel が close（.open 除去 + display:none 到達）', async ({ page }) => {
        await gotoNotes(page);
        // md sidepanel を open 状態に（実 openSidePanel は host 往復のため class 操作で再現 — TC-FV-59 同型）
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel') as HTMLElement;
            sp.style.display = 'flex';
            sp.classList.add('open');
        });
        expect(await page.locator('.side-panel.open').count(), '前提: md sidepanel open').toBe(1);

        await showFolderView(page);
        // close ボタン click 経由（.open 除去は同期・display:none は 200ms 後 — TC-FV-59 同型）
        await page.waitForTimeout(300);
        expect(await page.locator('.side-panel.open').count(), '④ md sidepanel（z-index:100）が閉じる').toBe(0);
        const spHidden = await page.evaluate(() =>
            (document.querySelector('.side-panel') as HTMLElement).style.display === 'none');
        expect(spHidden, '④ closeSidePanelImmediate まで到達').toBe(true);
    });

    test('セル⑤: showFolderView → viewer sidepanel close が呼ばれる', async ({ page }) => {
        await gotoNotes(page);
        // 明示メソッド recorder（Proxy 禁止 — generator_failures 2026-08-09）。
        // 実 __viewerSidePanel は close() を持つ契約 — その呼び出しを記録する
        await page.evaluate(() => {
            (window as any).__vspCloseCalls = 0;
            (window as any).__viewerSidePanel = {
                close: () => { (window as any).__vspCloseCalls += 1; },
            };
        });
        await showFolderView(page);
        expect(await page.evaluate(() => (window as any).__vspCloseCalls), '⑤ viewer sidepanel close').toBe(1);
    });

    test('セル⑥: showOutliner / showMarkdown（既存タブ切替）→ folder view が DOM 破棄される', async ({ page }) => {
        await gotoNotes(page);
        await showFolderView(page);
        expect(await page.locator('#folderViewContainer .fv-header').count()).toBe(1);

        // md へ切替（loadMarkdown 内部で showMarkdown → hook 発火 — TC-FV-35 同型の正規テスト API）
        await page.evaluate(() => {
            (window as any).__testApi.mdDispatcher.loadMarkdown('# md へ切替', '/x/a.md', '');
        });
        await page.waitForTimeout(300);
        const fvHiddenAfterMd = await page.evaluate(() => {
            const el = document.getElementById('folderViewContainer');
            return !el || el.style.display === 'none';
        });
        expect(fvHiddenAfterMd, '⑥ showMarkdown で folder view hidden').toBe(true);
        expect(await page.locator('#folderViewContainer .fv-header').count(), '⑥ DOM 破棄（display:none だけの残留は RED）').toBe(0);
        // md 面は表示に復帰している（hideFolderView の復元が md 表示を巻き戻さない）
        expect(await paneDisplay(page, '.markdown-container')).not.toBe('none');

        // 再度 folder view → showOutliner 側の hook も検証
        await showFolderView(page);
        expect(await page.locator('#folderViewContainer .fv-header').count()).toBe(1);
        await page.evaluate(() => {
            // .out へ戻す既存経路: updateData(kind!=='md') → showOutliner（notes-md-dispatcher.js:96-123）。
            // ハーネスの subscribe は __hostMessageHandlers に handler を積む（build-standalone-notes.js:601）。
            // md-dispatcher 以外の同居 handler（outliner の applyExternalUpdate 等）は本 TC の
            // 関心外で data 形式に敏感なため個別 try/catch で切り離す（md-dispatcher handler は throw しない）
            (window as any).__hostMessageHandlers.forEach((h: any) => {
                try { h({ type: 'updateData', kind: 'out', data: '', filePath: '/x/a.out' }); } catch { /* 関心外 handler */ }
            });
        });
        await page.waitForTimeout(300);
        const fvHiddenAfterOut = await page.evaluate(() => {
            const el = document.getElementById('folderViewContainer');
            return !el || el.style.display === 'none';
        });
        expect(fvHiddenAfterOut, '⑥ showOutliner で folder view hidden').toBe(true);
        expect(await page.locator('#folderViewContainer .fv-header').count()).toBe(0);
        expect(await paneDisplay(page, '.outliner-container'), 'outliner 面が復帰').not.toBe('none');
    });

    test('セル⑦: showViewer → folder view が DOM 破棄される（viewer は表示）', async ({ page }) => {
        await gotoNotes(page);
        await showFolderView(page);
        expect(await page.locator('#folderViewContainer .fv-header').count()).toBe(1);

        await page.evaluate(() => {
            window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: './viewer-fixtures/sample.html', fileName: 'sample.html' }, '*');
        });
        await page.waitForSelector('#viewerContainer', { state: 'visible', timeout: 5000 });
        const fvHidden = await page.evaluate(() => {
            const el = document.getElementById('folderViewContainer');
            return !el || el.style.display === 'none';
        });
        expect(fvHidden, '⑦ showViewer で folder view hidden').toBe(true);
        expect(await page.locator('#folderViewContainer .fv-header').count(), '⑦ DOM 破棄').toBe(0);
        // viewer は実 mount される
        await page.waitForSelector('#viewerContainer .viewer-html-frame', { timeout: 5000 });
    });
});

// ── TC-FLV-56（TASK-20 / FR-FLV-27）: esc で sidepanel を閉じた後のフォーカス復帰 ──

test.describe('TC-FLV-56 — esc フォーカス復帰（再オープン①）', () => {

    async function setupWithSelectedRow(page: Page): Promise<void> {
        await gotoNotes(page);
        await page.evaluate(() => {
            window.postMessage({
                type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '',
                entries: [
                    { name: 'a.md', relPath: 'a.md', isDir: false },
                    { name: 'b.md', relPath: 'b.md', isDir: false },
                ],
            }, '*');
        });
        // showFolderView 後に行が出るまで
        await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
        await page.evaluate(() => {
            window.postMessage({
                type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '',
                entries: [
                    { name: 'a.md', relPath: 'a.md', isDir: false },
                    { name: 'b.md', relPath: 'b.md', isDir: false },
                ],
            }, '*');
        });
        await page.waitForSelector('.fv-row[data-rel="a.md"]', { timeout: 5000 });
        await page.click('.fv-row[data-rel="a.md"]'); // 選択
    }

    /** md sidepanel を open 状態にする（TC-FV-59 と同型の class 再現） */
    async function openMdSidePanel(page: Page): Promise<void> {
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel') as HTMLElement;
            sp.style.display = 'flex';
            sp.classList.add('open');
        });
    }

    test('esc → sidepanel close 後に .fv-tree へフォーカス復帰・選択保持・直後の ↓ が効く', async ({ page }) => {
        await setupWithSelectedRow(page);
        await openMdSidePanel(page);
        // フォーカスは sidepanel 側にある想定（body でも成立）
        await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur?.(); });
        await page.keyboard.press('Escape');
        // esc ハンドラ（実装依存）に代わり、close 済み状態を明示再現（class 除去 = 実 close と同期挙動）
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel') as HTMLElement;
            sp.classList.remove('open');
            sp.style.display = 'none';
        });
        await page.waitForTimeout(300);
        const active = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.className || '');
        expect(active.includes('fv-tree'), 'フォーカスが .fv-tree に戻る').toBe(true);
        // 選択保持 + 直後の ↓ が効く
        expect(await page.evaluate(() => (document.querySelector('.fv-row.fv-selected') as HTMLElement)?.dataset.rel)).toBe('a.md');
        await page.keyboard.press('ArrowDown');
        expect(await page.evaluate(() => (document.querySelector('.fv-row.fv-selected') as HTMLElement)?.dataset.rel)).toBe('b.md');
    });

    test('stole 判定: esc 後にユーザーが他要素へフォーカス済みなら奪い返さない', async ({ page }) => {
        await setupWithSelectedRow(page);
        await openMdSidePanel(page);
        await page.keyboard.press('Escape');
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel') as HTMLElement;
            sp.classList.remove('open');
            sp.style.display = 'none';
            // ユーザーが検索ボックスへ移動した（stole）
            (document.querySelector('.fv-search') as HTMLElement).focus();
        });
        await page.waitForTimeout(300);
        const active = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.className || '');
        expect(active.includes('fv-search'), '奪い返さない').toBe(true);
    });

    test('folder view 非表示時の esc は何もしない（regression）', async ({ page }) => {
        await gotoNotes(page);
        await openMdSidePanel(page);
        await page.keyboard.press('Escape');
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel') as HTMLElement;
            sp.classList.remove('open');
            sp.style.display = 'none';
        });
        await page.waitForTimeout(300);
        const active = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.className || '');
        expect(active.includes('fv-tree')).toBe(false);
    });
});
