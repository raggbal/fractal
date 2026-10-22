/**
 * md エディタのリンク右クリック: Reveal in Finder（md / subpage / file リンク）と、
 * md / file リンクを含む範囲選択の Export bundle / Export folder（outliner の同名メニューと同じ出力 — host 側は
 * test/unit/md-selection-export.spec.ts）。
 *
 * standalone-editor.html（test-host-bridge = 共有 factory の postFn が __testApi.messages に積む）で、
 * 本番と同じ document の contextmenu → showEditorContextMenu の経路を通す。
 */
import { test, expect, Page } from '@playwright/test';

const MD = [
    '- [[Sub Page]](subpage-a.md)',
    '    - [📎 report.xlsx](files/report.xlsx)',
    '- [normal link](https://example.com/page)',
    '',
    'plain paragraph text',
].join('\n') + '\n';

async function setup(page: Page) {
    await page.goto('/standalone-editor.html');
    await page.waitForSelector('#editor');
    await page.evaluate((md) => { (window as any).__testApi.setMarkdown(md); }, MD);
    await page.waitForTimeout(300);
}

/** selector の要素の中身を選択範囲にする（null なら選択を外す） */
async function selectContents(page: Page, selector: string | null) {
    await page.evaluate((sel) => {
        const s = window.getSelection()!;
        s.removeAllRanges();
        if (!sel) return;
        const r = document.createRange();
        r.selectNodeContents(document.querySelector(sel)!);
        s.addRange(r);
    }, selector);
}

/** 右クリックしてメニューの項目名を返す。labelToClick があれば完全一致の項目を click */
async function openCtx(page: Page, selector: string, labelToClick?: string) {
    return page.evaluate(({ selector, labelToClick }) => {
        const w = window as any;
        w.__testApi.messages.length = 0;
        const el = document.querySelector(selector) as HTMLElement;
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
        const menu = document.querySelector('.editor-context-menu')!;
        const items = Array.from(menu.querySelectorAll('.editor-context-menu-item'));
        const labels = items.map((it) => (it.querySelector('.context-menu-label')!.textContent || '').trim());
        let clicked = false;
        if (labelToClick) {
            const idx = labels.indexOf(labelToClick);
            if (idx >= 0) { (items[idx] as HTMLElement).click(); clicked = true; }
        }
        return { labels, clicked, msgs: JSON.parse(JSON.stringify(w.__testApi.messages)) };
    }, { selector, labelToClick: labelToClick || null });
}

test('subpage リンクの右クリックに Reveal in Finder → revealLinkTarget(kind=md, href) が送出', async ({ page }) => {
    await setup(page);
    await selectContents(page, null);
    const r = await openCtx(page, '#editor a[href$="subpage-a.md"]', 'Reveal in Finder');
    expect(r.clicked).toBe(true);
    const hit = r.msgs.filter((m: any) => m.type === 'revealLinkTarget');
    expect(hit).toEqual([{ type: 'revealLinkTarget', href: 'subpage-a.md', kind: 'md' }]);
});

test('file リンクの右クリックに Reveal in Finder → kind=file', async ({ page }) => {
    await setup(page);
    await selectContents(page, null);
    const r = await openCtx(page, '#editor a[href$="report.xlsx"]', 'Reveal in Finder');
    expect(r.clicked).toBe(true);
    const hit = r.msgs.filter((m: any) => m.type === 'revealLinkTarget');
    expect(hit.length).toBe(1);
    expect(hit[0].kind).toBe('file');
    expect(hit[0].href).toBe('files/report.xlsx');
});

test('https リンク・リンク外には Reveal in Finder を出さない', async ({ page }) => {
    await setup(page);
    await selectContents(page, null);
    expect((await openCtx(page, '#editor a[href^="https://"]')).labels).not.toContain('Reveal in Finder');
    expect((await openCtx(page, '#editor p:last-of-type')).labels).not.toContain('Reveal in Finder');
});

test('md / file リンクを含む範囲選択 → Export folder... で exportMdSelectionFolder(選択 md) が送出', async ({ page }) => {
    await setup(page);
    await selectContents(page, '#editor');
    const r = await openCtx(page, '#editor a[href$="subpage-a.md"]', 'Export folder...');
    expect(r.labels).toContain('Export bundle');
    expect(r.clicked).toBe(true);
    const hit = r.msgs.filter((m: any) => m.type === 'exportMdSelectionFolder');
    expect(hit.length).toBe(1);
    expect(hit[0].markdown).toContain('](subpage-a.md)');
    expect(hit[0].markdown).toContain('](files/report.xlsx)');
});

test('範囲選択 → Export bundle で設定ダイアログ → Export で exportMdSelectionBundle(選択 md, options)', async ({ page }) => {
    await setup(page);
    await selectContents(page, '#editor');
    const r = await openCtx(page, '#editor a[href$="subpage-a.md"]', 'Export bundle');
    expect(r.clicked).toBe(true);
    // ダイアログを閉じるまでは送らない
    expect(r.msgs.filter((m: any) => m.type === 'exportMdSelectionBundle').length).toBe(0);
    await page.locator('.md-export-dialog .md-export-execute').click();
    const msgs = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
    const hit = msgs.filter((m: any) => m.type === 'exportMdSelectionBundle');
    expect(hit.length).toBe(1);
    expect(hit[0].markdown).toContain('](subpage-a.md)');
    expect(hit[0].options).toEqual({ includeChildren: true, recurseChildren: true, includeLinks: false, recurseLinks: false });
});

test('リンクを含まない範囲選択・選択なしには Export bundle / Export folder を出さない', async ({ page }) => {
    await setup(page);
    await selectContents(page, '#editor p:last-of-type');
    const r1 = await openCtx(page, '#editor p:last-of-type');
    expect(r1.labels).not.toContain('Export bundle');
    expect(r1.labels).not.toContain('Export folder...');
    await selectContents(page, null);
    const r2 = await openCtx(page, '#editor a[href$="subpage-a.md"]');
    expect(r2.labels).not.toContain('Export bundle');
});
