/**
 * notes-md-cmdf-search — Notes md メインペインの Cmd+F/Cmd+H md 内検索（sprint 20260806-115421）
 *
 * バグ: Notes webview では outliner.js のグローバル Cmd+F/Cmd+H フォールバック
 * （document keydown・stopImmediatePropagation）が md メインペインフォーカス時も先取りし、
 * editor.js の検索委譲（getActiveInstance → _handleSearchShortcut → openSearchBox）へ届かない。
 * 除外ガードが inBox / inSidePanel のみで .markdown-container を見ていなかった。
 *
 * 修正: outliner.js のフォールバック除外に inMdPane（ae.closest('.markdown-container')）を追加。
 *
 * TC-MF-01 (load-bearing): md ペインフォーカス + Cmd+F → md の search-replace-box が開く。
 *   counterfactual: inMdPane 除外を外すと md box は display:none のまま（修正前の実測挙動）= RED。
 * TC-MF-02: Cmd+H → md 検索ボックス + replace-row が開く。
 * TC-MF-03 (回帰 pin): outliner 表示中の Cmd+F → outliner テキスト検索が従来どおり開く。
 * TC-MF-04: md 内検索が実際にヒットする（機能疎通・highlight 2 件）。
 */
import { test, expect, Page } from '@playwright/test';

const MD_FILE = '/Users/test/notes/noteA/page-main.md';
const MD_BODY = '# Hello\n\nkeyword line one\n\nkeyword line two\n';

async function openMdPane(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ fp, md }) => {
        (window as any).__hostMessageHandler({
            type: 'updateData', kind: 'md', markdown: md, filePath: fp, documentBaseUri: '',
        });
    }, { fp: MD_FILE, md: MD_BODY });
    await page.waitForTimeout(300);
    await page.click('.markdown-container .editor');
    await page.waitForTimeout(100);
}

function mdSearchState(page: Page) {
    return page.evaluate(() => {
        const mdBox = document.querySelector('.markdown-container .search-replace-box') as HTMLElement;
        const mdReplaceRow = document.querySelector('.markdown-container .replace-row') as HTMLElement;
        const outlinerBox = document.querySelector('.outliner-search-replace-box') as HTMLElement;
        const ae = document.activeElement as HTMLElement;
        return {
            mdBoxDisplay: mdBox ? mdBox.style.display : 'MISSING',
            mdReplaceRowDisplay: mdReplaceRow ? mdReplaceRow.style.display : 'MISSING',
            outlinerBoxDisplay: outlinerBox ? outlinerBox.style.display : 'ABSENT',
            focusInMdSearch: !!(ae && ae.classList && ae.classList.contains('search-input')
                && !!ae.closest('.markdown-container')),
        };
    });
}

test.describe('Notes md メインペインの Cmd+F/Cmd+H（TC-MF）', () => {

    test('TC-MF-01: md ペインフォーカスで Cmd+F → md 検索ボックスが開く（outliner 検索は開かない）', async ({ page }) => {
        await openMdPane(page);
        await page.keyboard.press('Meta+f');
        await page.waitForTimeout(200);

        const s = await mdSearchState(page);
        expect(s.mdBoxDisplay).toBe('block');
        expect(s.focusInMdSearch).toBe(true);
        // outliner 側フォールバックが先取りしていない（不在 or 閉じたまま）
        expect(s.outlinerBoxDisplay === 'ABSENT' || s.outlinerBoxDisplay === 'none').toBe(true);
    });

    test('TC-MF-02: md ペインフォーカスで Cmd+H → md 検索ボックス + replace row が開く', async ({ page }) => {
        await openMdPane(page);
        await page.keyboard.press('Meta+h');
        await page.waitForTimeout(200);

        const s = await mdSearchState(page);
        expect(s.mdBoxDisplay).toBe('block');
        expect(s.mdReplaceRowDisplay).toBe('flex');
        expect(s.outlinerBoxDisplay === 'ABSENT' || s.outlinerBoxDisplay === 'none').toBe(true);
    });

    test('TC-MF-03 (回帰 pin): outliner 表示中の Cmd+F → outliner テキスト検索が従来どおり開く', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        // 初期状態 = outliner 表示（md instance なし）。body フォーカスのまま Cmd+F
        await page.keyboard.press('Meta+f');
        await page.waitForTimeout(200);

        const outlinerBoxDisplay = await page.evaluate(() => {
            const box = document.querySelector('.outliner-search-replace-box') as HTMLElement;
            return box ? box.style.display : 'ABSENT';
        });
        expect(outlinerBoxDisplay).toBe('block');
    });

    test('TC-MF-04: md 内検索が実際にヒットする（highlight 2 件）', async ({ page }) => {
        await openMdPane(page);
        await page.keyboard.press('Meta+f');
        await page.waitForTimeout(200);
        await page.evaluate(() => {
            const input = document.querySelector('.markdown-container .search-input') as HTMLInputElement;
            input.value = 'keyword';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForTimeout(300);

        const hits = await page.evaluate(() =>
            document.querySelectorAll('.markdown-container .editor .search-highlight, .markdown-container .editor .search-highlight-current').length
        );
        expect(hits).toBe(2);
    });
});
