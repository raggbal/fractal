/**
 * subpage-marker TASK-04/05 — 層2+3 レンダラ+シリアライザ（standalone E2E）
 *
 * `[[sub]](x.md)` を parse → render(DOM) → serialize しても構文が保たれる（ラウンドトリップ・INV-1）。
 * 参照リンク `[ref](y.md)` は `[]` のまま。テーブルセル内 subpage も保持。
 *
 * TC-SP-10 (load-bearing) ラウンドトリップ保持（counterfactual: __setSubpageSerialize(false) で [] 劣化）
 * TC-SP-11 参照リンクは [] のまま
 * TC-SP-12 subpage レンダリングの区別 class
 * TC-SP-13 テーブルセル内 subpage もラウンドトリップ保持
 */
import { test, expect } from '@playwright/test';

test.describe('subpage marker roundtrip', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as { __testApi?: { ready?: boolean } }).__testApi?.ready);
    });

    test('TC-SP-10: ラウンドトリップ保持（load-bearing）', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('[[sub]](x.md)');
        });
        // DOM に <a data-subpage="true" ...>sub</a> が描画される
        const a = page.locator('a.link-subpage');
        await expect(a).toHaveText('sub');
        await expect(a).toHaveAttribute('data-subpage', 'true');
        // serialize（無編集）→ [[sub]](x.md) 保持
        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md).toContain('[[sub]](x.md)');
        expect(md).not.toContain('[sub](x.md)'); // 劣化していない

        // ★counterfactual（機械実証）: subpage serialize 分岐を切ると [[sub]] → [sub] に劣化
        const mdPreFix = await page.evaluate(() => {
            (window as any).__testApi.__setSubpageSerialize(false);
            const out = (window as any).__testApi.getMarkdown();
            (window as any).__testApi.__setSubpageSerialize(true); // 復元
            return out;
        });
        expect(mdPreFix).toContain('[sub](x.md)');       // 劣化する
        expect(mdPreFix).not.toContain('[[sub]](x.md)'); // [[]] が失われる = fix が load-bearing
    });

    test('TC-SP-11: 参照リンクは [] のまま', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('[ref](y.md)');
        });
        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md).toContain('[ref](y.md)');
        expect(md).not.toContain('[[ref]](y.md)'); // 参照リンクは [[]] 化しない
    });

    test('TC-SP-12: subpage レンダリングの区別 class', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('[[sub]](x.md) と [ref](y.md)');
        });
        const sub = page.locator('a[data-subpage="true"]');
        await expect(sub).toHaveClass(/link-subpage/);
        await expect(sub).toHaveClass(/link-internal-md/);
        // 参照リンクは link-subpage を持たない
        const ref = page.locator('a:not([data-subpage])');
        await expect(ref).toHaveText('ref');
    });

    test('TC-SP-13: テーブルセル内 subpage もラウンドトリップ保持', async ({ page }) => {
        const tableMd = '| col |\n| --- |\n| [[sub]](x.md) |';
        await page.evaluate((md) => {
            (window as any).__testApi.setMarkdown(md);
        }, tableMd);
        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md).toContain('[[sub]](x.md)'); // テーブル内でも [[]] 保持
    });

    // TC-SP-14: cmd+/ Add SubPage（simple flow）→ handlePageCreatedAtPath が
    //   <a data-subpage> を生成し、serialize で [[]] になる（ADRL-0003）。
    test('TC-SP-14: Add SubPage (simple flow) が <a data-subpage> を生成し serialize で [[]]', async ({ page }) => {
        await page.evaluate(() => { (window as any).__testApi.setMarkdown('# Hello\n\nbody\n\n'); });
        await page.waitForTimeout(150);
        // カーソルを editor 内最終 p に
        await page.evaluate(() => {
            const editor: any = document.querySelector('.editor[contenteditable]');
            editor.focus();
            const lastP = editor.querySelector('p:last-of-type') || editor.lastElementChild;
            const r = document.createRange();
            r.setStart(lastP, lastP.childNodes.length);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        // cmd+/ → Enter → modal OK（linkName）→ host が pageCreatedAtPath 返信
        await page.evaluate(() => {
            const inst = (window as any).EditorInstance?.getActiveInstance?.();
            inst._handleGlobalShortcut(new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true }));
        });
        await page.waitForTimeout(120);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(150);
        await page.evaluate(() => {
            const overlay: any = document.querySelector('.rename-link-modal-overlay');
            const input: any = overlay.querySelector('input[type="text"]');
            input.value = 'child';
            (Array.from(overlay.querySelectorAll('button')).reverse()[0] as HTMLButtonElement).click();
        });
        await page.waitForTimeout(120);
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({ type: 'pageCreatedAtPath', relativePath: 'child-1.md' });
        });
        await page.waitForTimeout(150);
        // 生成された <a> が data-subpage を持つ
        const hasSubpageAnchor = await page.evaluate(() => {
            const editor: any = document.querySelector('.editor[contenteditable]');
            return Array.from(editor.querySelectorAll('a[href="child-1.md"]')).some((a: any) => a.dataset.subpage === 'true');
        });
        expect(hasSubpageAnchor).toBe(true);
        // serialize すると [[child]](child-1.md)
        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md).toContain('[[child]](child-1.md)');
    });

    // TC-SP-15: action panel 経路（finalizeAddPage）— 新規=subpage / 既存=参照（HIGH-1）
    test('TC-SP-15: finalizeAddPage は新規パスで subpage / 既存ファイルで参照リンク', async ({ page }) => {
        // (a) 新規パス作成（isExistingFile=false）→ data-subpage + serialize で [[]]
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('# doc\n\ntext\n\n');
        });
        await page.waitForTimeout(120);
        await page.evaluate(() => {
            const editor: any = document.querySelector('.editor[contenteditable]');
            editor.focus();
            const lastP = editor.querySelector('p:last-of-type') || editor.lastElementChild;
            const r = document.createRange();
            r.setStart(lastP, lastP.childNodes.length);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
            (window as any).__testApi.__finalizeAddPage('new-page.md', 'newpage', false);
        });
        await page.waitForTimeout(80);
        const newIsSubpage = await page.evaluate(() => {
            const editor: any = document.querySelector('.editor[contenteditable]');
            const a: any = editor.querySelector('a[href="new-page.md"]');
            return a ? a.dataset.subpage : null;
        });
        expect(newIsSubpage).toBe('true');
        const mdNew = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(mdNew).toContain('[[newpage]](new-page.md)');

        // (b) 既存ファイル参照（isExistingFile=true）→ data-subpage なし + serialize で [] (参照リンク)
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('# doc2\n\ntext\n\n');
        });
        await page.waitForTimeout(120);
        await page.evaluate(() => {
            const editor: any = document.querySelector('.editor[contenteditable]');
            editor.focus();
            const lastP = editor.querySelector('p:last-of-type') || editor.lastElementChild;
            const r = document.createRange();
            r.setStart(lastP, lastP.childNodes.length);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
            (window as any).__testApi.__finalizeAddPage('existing.md', 'existing', true);
        });
        await page.waitForTimeout(80);
        const existIsSubpage = await page.evaluate(() => {
            const editor: any = document.querySelector('.editor[contenteditable]');
            const a: any = editor.querySelector('a[href="existing.md"]');
            return a ? (a.dataset.subpage || 'undefined') : null;
        });
        expect(existIsSubpage).toBe('undefined'); // 既存参照は subpage フラグを付けない
        const mdExist = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(mdExist).toContain('[existing](existing.md)');
        expect(mdExist).not.toContain('[[existing]](existing.md)'); // 参照リンクは [[]] 化しない
    });
});
