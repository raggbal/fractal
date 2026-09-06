/**
 * 2026-09-04 ユーザー実機（rc.3）— リスト行の先頭がアイコン付きリンク（📎 file / subpage / md）のとき、
 * 行頭（= アンカー内 offset 0。アイコンは CSS ::before なのでその左に caret 位置は無い）で Enter すると
 * リンクが元行に残り後続テキストだけ次行へ落ちていた（TASK-03 の「分割点をアンカーの後ろへ繰り上げる」が
 * 行頭でも効いていた）。期待: 元行は空行、リンクごと次行へ（通常の行頭 Enter と同じ）。
 *
 * TC-LX-12（📎 file リンク）/ TC-LX-13（subpage リンク）/ TC-LX-14（途中・末尾は従来どおり = TC-LX-07/08 の契約不変）
 * 🔴 counterfactual: 実装前は TC-LX-12/13 で liTexts が ['doc.pdf', 'x d s d', …] になり RED。
 */
import { test, expect, Page } from '@playwright/test';

async function setupMd(page: Page, md: string): Promise<void> {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.setMarkdown);
    await page.evaluate((m) => { (window as any).__testApi.setMarkdown(m); }, md);
    await page.waitForTimeout(400);
}

/** 先頭 li の最初のアンカー内 offset 0 に caret（← / Home で着地する実位置）。 */
async function caretAtFirstAnchorStart(page: Page): Promise<void> {
    await page.evaluate(() => {
        const editor = document.getElementById('editor') as HTMLElement;
        const a = editor.querySelector('li a') as HTMLAnchorElement;
        const sel = window.getSelection() as Selection;
        const r = document.createRange();
        r.setStart(a.firstChild as Node, 0);
        r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        editor.focus();
    });
}

async function state(page: Page) {
    return page.evaluate(() => {
        const editor = document.getElementById('editor') as HTMLElement;
        const lis = Array.from(editor.querySelectorAll('li'));
        return {
            liTexts: lis.map((l) => (l.textContent || '').trim()),
            liHasAnchor: lis.map((l) => !!l.querySelector('a')),
            firstLiHasBr: !!lis[0]?.querySelector('br'),
            anchorCount: editor.querySelectorAll('li a').length,
            emptyAnchors: Array.from(editor.querySelectorAll('li a')).filter((a) => !(a.textContent || '').trim()).length,
            md: (window as any).__testApi.getMarkdown ? (window as any).__testApi.getMarkdown() : null,
        };
    });
}

test('TC-LX-12 📎 file リンク行の行頭で Enter → 元行は空、リンクごと次行へ（テキストだけ落ちない）', async ({ page }) => {
    await setupMd(page, '- [📎 doc.pdf](files/doc.pdf) x d s d\n- next\n');
    await caretAtFirstAnchorStart(page);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const s = await state(page);
    expect(s.liTexts, `li=${JSON.stringify(s.liTexts)}`).toEqual(['', 'doc.pdf x d s d', 'next']);
    expect(s.liHasAnchor).toEqual([false, true, false]);
    expect(s.firstLiHasBr, '空になった元行に <br> が無い（描画・caret 着地不可）').toBe(true);
    expect(s.anchorCount).toBe(1);
    expect(s.emptyAnchors).toBe(0);
    expect(s.md).toContain('[📎 doc.pdf](files/doc.pdf) x d s d');
    expect((s.md.match(/doc\.pdf/g) || []).length, 'リンクが複製された').toBe(2); // alt + url の 2 回
});

test('TC-LX-13 subpage リンク行の行頭で Enter も同じ', async ({ page }) => {
    await setupMd(page, '- [[sss]](sub.md)xx\n- next\n');
    await caretAtFirstAnchorStart(page);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const s = await state(page);
    expect(s.liTexts).toEqual(['', 'sssxx', 'next']);
    expect(s.liHasAnchor).toEqual([false, true, false]);
    expect(s.anchorCount).toBe(1);
    expect(s.emptyAnchors).toBe(0);
    expect((s.md.match(/sub\.md/g) || []).length).toBe(1);
});

test('TC-LX-14 regression: アンカー内テキストの途中 / 末尾で Enter はリンクを元行に残す（TC-LX-07/08 契約）', async ({ page }) => {
    await setupMd(page, '- [📎 doc.pdf](files/doc.pdf) x d s d\n- next\n');
    await page.evaluate(() => {
        const editor = document.getElementById('editor') as HTMLElement;
        const a = editor.querySelector('li a') as HTMLAnchorElement;
        const sel = window.getSelection() as Selection;
        const r = document.createRange();
        r.setStart(a.firstChild as Node, 3);   // "doc|.pdf"
        r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        editor.focus();
    });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const s = await state(page);
    expect(s.liTexts).toEqual(['doc.pdf', 'x d s d', 'next']);
    expect(s.liHasAnchor).toEqual([true, false, false]);
    expect(s.anchorCount).toBe(1);
});
