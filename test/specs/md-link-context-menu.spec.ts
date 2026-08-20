/**
 * TC-MDM-01/02/03 — md リンク右クリックメニュー（sprint 20260818-183407 FR-MDM-01）
 *
 * メニュー全列挙は requirement FR-MDM-01 の順序が唯一の正:
 *   リンク上 = Rename Link / Cut / Copy / Copy Path / Copy (file link full path) / Duplicate(md・file のみ) / Paste
 *   リンク外 = Cut / Copy / Copy (file link full path)（選択なしはディム）/ Paste
 * https リンクに Duplicate は出ない（requirement の表示裁定）。
 */
import { test, expect, Page } from '@playwright/test';

const MD = [
    '[normal link](https://example.com/page)',
    '',
    '[[Sub Page]](subpage-a.md)',
    '',
    '[📎 report.pdf](files/report.pdf)',
    '',
    'plain paragraph text',
].join('\n') + '\n';

async function setup(page: Page) {
    await page.goto('/standalone-editor.html');
    await page.waitForSelector('#editor');
    await page.evaluate((md) => { (window as any).__testApi.setMarkdown(md); }, MD);
    await page.waitForTimeout(300);
}

/** セレクタで対象要素を右クリックし、メニュー項目 {label, disabled} を取得。labelToClick で click */
async function openCtx(page: Page, selector: string, labelToClick?: string) {
    return page.evaluate(({ selector, labelToClick }) => {
        (window as any).__testApi.messages = (window as any).__testApi.messages || [];
        (window as any).__testApi.messages.length = 0;
        const el = document.querySelector(selector) as HTMLElement;
        if (!el) return { found: false, items: [], clicked: false, msgs: [] };
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
        const menu = document.querySelector('.editor-context-menu');
        const items = menu ? Array.from(menu.querySelectorAll('.editor-context-menu-item, [class*="ctx-item"], div')).filter((d) => (d as HTMLElement).textContent && (d as HTMLElement).childElementCount <= 2).map((it) => ({
            label: ((it as HTMLElement).textContent || '').trim(),
            disabled: (it as HTMLElement).classList.contains('disabled') || (it as HTMLElement).getAttribute('aria-disabled') === 'true',
        })) : [];
        let clicked = false;
        if (labelToClick && menu) {
            const target = Array.from(menu.querySelectorAll('*')).find((it) => ((it as HTMLElement).textContent || '').trim().startsWith(labelToClick)) as HTMLElement;
            if (target) { target.click(); clicked = true; }
        }
        return { found: true, items, clicked, msgs: JSON.parse(JSON.stringify((window as any).__testApi.messages)) };
    }, { selector, labelToClick: labelToClick || null });
}

test('TC-MDM-01a subpage リンク: 全列挙どおり（Copy Path / Copy (file link full path) / Duplicate あり）', async ({ page }) => {
    await setup(page);
    const r = await openCtx(page, '#editor a[href$="subpage-a.md"]');
    const labels = r.items.map((i: any) => i.label).join('|');
    expect(labels).toContain('Rename Link');
    expect(labels).toContain('Copy Path');
    expect(labels).toContain('Copy (file link full path)');
    expect(labels).toContain('Duplicate');
});

test('TC-MDM-01b file リンク: Duplicate あり / https リンク: Duplicate なし', async ({ page }) => {
    await setup(page);
    const rf = await openCtx(page, '#editor a[href$="report.pdf"]');
    expect(rf.items.map((i: any) => i.label).join('|')).toContain('Duplicate');
    const rn = await openCtx(page, '#editor a[href^="https://example.com"]');
    const nl = rn.items.map((i: any) => i.label).join('|');
    expect(nl).toContain('Copy Path');
    expect(nl).not.toContain('Duplicate');
});

test('TC-MDM-01c リンク外: Copy (file link full path) あり・Rename Link/Copy Path なし', async ({ page }) => {
    await setup(page);
    const r = await openCtx(page, '#editor p:last-of-type');
    const labels = r.items.map((i: any) => i.label).join('|');
    expect(labels).toContain('Copy (file link full path)');
    expect(labels).not.toContain('Rename Link');
    // 'Copy Path' 単独項目は無い（'Copy (file link full path)' への部分一致を避け完全一致で確認）
    expect(r.items.some((i: any) => i.label === 'Copy Path')).toBe(false);
});

test('TC-MDM-02 subpage リンク Copy Path click → copyLinkPath(kind=md) が送出される', async ({ page }) => {
    await setup(page);
    const r = await openCtx(page, '#editor a[href$="subpage-a.md"]', 'Copy Path');
    expect(r.clicked).toBe(true);
    const hit = r.msgs.filter((m: any) => m.type === 'copyLinkPath');
    expect(hit.length).toBe(1);
    expect(hit[0].href).toContain('subpage-a.md');
    expect(hit[0].kind).toBe('md');
});

test('TC-MDM-03 https リンク Copy Path click → kind=normal（URL そのままコピー要求）', async ({ page }) => {
    await setup(page);
    const r = await openCtx(page, '#editor a[href^="https://example.com"]', 'Copy Path');
    expect(r.clicked).toBe(true);
    const hit = r.msgs.filter((m: any) => m.type === 'copyLinkPath');
    expect(hit.length).toBe(1);
    expect(hit[0].kind).toBe('normal');
    expect(hit[0].href).toBe('https://example.com/page');
});

test('TC-MDM-02b file リンク Copy Path click → kind=file', async ({ page }) => {
    await setup(page);
    const r = await openCtx(page, '#editor a[href$="report.pdf"]', 'Copy Path');
    expect(r.clicked).toBe(true);
    const hit = r.msgs.filter((m: any) => m.type === 'copyLinkPath');
    expect(hit.length).toBe(1);
    expect(hit[0].kind).toBe('file');
});

// ─── TC-MDM-04/05: Copy (file link full path)（FR-MDM-03・TASK-09） ───

test('TC-MDM-04w 選択範囲で Copy (file link full path) → copyMdWithFullPaths(選択 md) が送出', async ({ page }) => {
    await setup(page);
    // subpage + file + https を含む全選択
    await page.evaluate(() => {
        const editor = document.getElementById('editor')!;
        const r = document.createRange();
        r.selectNodeContents(editor);
        const s = window.getSelection()!;
        s.removeAllRanges();
        s.addRange(r);
    });
    const r = await openCtx(page, '#editor a[href$="subpage-a.md"]', 'Copy (file link full path)');
    expect(r.clicked).toBe(true);
    const hit = r.msgs.filter((m: any) => m.type === 'copyMdWithFullPaths');
    expect(hit.length).toBe(1);
    expect(hit[0].markdown).toContain('subpage-a.md');
    expect(hit[0].markdown).toContain('files/report.pdf');
    expect(hit[0].markdown).toContain('https://example.com/page');
});

test('TC-MDM-05 選択なし・リンク外 → Copy (file link full path) がディム（disabled）', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { window.getSelection()!.removeAllRanges(); });
    const r = await openCtx(page, '#editor p:last-of-type');
    const item = r.items.find((i: any) => i.label.startsWith('Copy (file link full path)'));
    expect(item).toBeTruthy();
    expect(item!.disabled).toBe(true);
});

test('TC-MDM-04l 選択なし・リンク上 → そのリンク 1 個の md が送出される', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { window.getSelection()!.removeAllRanges(); });
    const r = await openCtx(page, '#editor a[href$="report.pdf"]', 'Copy (file link full path)');
    expect(r.clicked).toBe(true);
    const hit = r.msgs.filter((m: any) => m.type === 'copyMdWithFullPaths');
    expect(hit.length).toBe(1);
    expect(hit[0].markdown).toContain('](files/report.pdf)');
});

// ─── TC-MDM-06/07: subpage / file リンクの Duplicate（FR-MDM-02・TASK-10） ───

test('TC-MDM-06w subpage リンク Duplicate → duplicateLinkEntity 送出 + 応答で直下に複製リンク挿入 + undo 1 回', async ({ page }) => {
    await setup(page);
    const r = await openCtx(page, '#editor a[href$="subpage-a.md"]', 'Duplicate');
    expect(r.clicked).toBe(true);
    const hit = r.msgs.filter((m: any) => m.type === 'duplicateLinkEntity');
    expect(hit.length).toBe(1);
    expect(hit[0].href).toContain('subpage-a.md');
    expect(hit[0].kind).toBe('md');
    // host 応答（実体複製済みの新 href）で直下に新行 + 複製リンク
    await page.evaluate(() => {
        (window as any).__hostMessageHandler({
            type: 'duplicateLinkEntityResult', newHref: 'subpage-a-1.md', kind: 'md',
        });
    });
    await page.waitForTimeout(300);
    const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
    expect(md).toContain('subpage-a-1.md');
    // 元リンク直下（file リンク行より前）に挿入
    expect(md.indexOf('subpage-a-1.md')).toBeGreaterThan(md.indexOf('subpage-a.md'));
    expect(md.indexOf('subpage-a-1.md')).toBeLessThan(md.indexOf('files/report.pdf'));
    // subpage 形式（[[label]](href)）で挿入される
    expect(md).toMatch(/\[\[.*\]\]\(subpage-a-1\.md\)/);
    // undo 1 回で挿入行が消える
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.waitForTimeout(300);
    const mdUndo = await page.evaluate(() => (window as any).__testApi.getMarkdown());
    expect(mdUndo).not.toContain('subpage-a-1.md');
});

test('TC-MDM-07w file リンク Duplicate → 応答で 📎 複製リンク挿入', async ({ page }) => {
    await setup(page);
    const r = await openCtx(page, '#editor a[href$="report.pdf"]', 'Duplicate');
    expect(r.clicked).toBe(true);
    const hit = r.msgs.filter((m: any) => m.type === 'duplicateLinkEntity');
    expect(hit.length).toBe(1);
    expect(hit[0].kind).toBe('file');
    await page.evaluate(() => {
        (window as any).__hostMessageHandler({
            type: 'duplicateLinkEntityResult', newHref: 'files/report-1.pdf', newFileName: 'report-1.pdf', kind: 'file',
        });
    });
    await page.waitForTimeout(300);
    const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
    expect(md).toContain('[📎 report-1.pdf](files/report-1.pdf)');
});
