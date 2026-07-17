/**
 * path-paste-autolink — ファイルパス貼り付けの自動リンク/画像化（FR-PA-01/02/03/04）
 *
 * URL 貼り付けの autolink（既存）と同じ経路で、拡張子付きファイルパスも
 * 画像→![](), 非画像→[]() に変換する。誤検知は拡張子必須・空白なし・単独行で抑制。
 */
import { test, expect, Page } from '@playwright/test';
import { EditorTestHelper } from '../utils/editor-test-helper';

// 実 paste イベントを clipboardData 付きで発火
async function pastePlain(page: Page, text: string) {
    await page.evaluate((t) => {
        const editor = document.getElementById('editor') as HTMLElement;
        editor.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', t);
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        editor.dispatchEvent(ev);
    }, text);
}

test.describe('path paste autolink (FR-PA)', () => {
    let editor: EditorTestHelper;
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        editor = new EditorTestHelper(page);
        await editor.focus();
    });

    test('TC-PA-01: classifyPastedPath 判定表（純粋関数・evaluate）', async ({ page }) => {
        const r = await page.evaluate(() => {
            const f = (window as any).__editorUtils.classifyPastedPath;
            return {
                absMd: f('/Users/x/a.md'),
                homePdf: f('~/notes/b.pdf'),
                relPng: f('./sub/c.png'),
                relJpg: f('../d.jpg'),
                bareRelMd: f('notes/e.md'),
                noExt: f('foo'),
                andOr: f('and/or'),
                win: f('C:\\x\\a.md'),
                backslash: f('a\\b.md'),
                space: f('p q.md'),
                url: f('https://x.com/a.md'),
                relNoExt: f('notes/foo'),
                ab: f('A/B'),
            };
        });
        expect(r.absMd).toMatchObject({ base: 'a.md', isImage: false });
        expect(r.homePdf).toMatchObject({ base: 'b.pdf', isImage: false });
        expect(r.relPng).toMatchObject({ base: 'c.png', isImage: true });
        expect(r.relJpg).toMatchObject({ base: 'd.jpg', isImage: true });
        expect(r.bareRelMd).toMatchObject({ base: 'e.md', isImage: false });
        // null（リンク化しない）
        for (const key of ['noExt', 'andOr', 'win', 'backslash', 'space', 'url', 'relNoExt', 'ab'] as const) {
            expect(r[key], `${key} は null`).toBeNull();
        }
    });

    test('TC-PA-01b: 拡張子必須ガードの load-bearing（notes/foo は null）', async ({ page }) => {
        const r = await page.evaluate(() => {
            const f = (window as any).__editorUtils.classifyPastedPath;
            return { withExt: f('notes/foo.md'), noExt: f('notes/foo') };
        });
        expect(r.withExt, '拡張子ありは非 null').not.toBeNull();
        expect(r.noExt, 'counterfactual: 拡張子なしは null（拡張子ガードが効いている）').toBeNull();
    });

    test('TC-PA-02: 絶対パス md・選択なし → [base](path)', async ({ page }) => {
        await pastePlain(page, '/Users/x/doc.md');
        await page.waitForTimeout(200);
        const a = await page.locator('#editor a').first();
        expect(await a.getAttribute('href')).toBe('/Users/x/doc.md');
        expect(await a.textContent()).toBe('doc.md');
        expect(await editor.getMarkdown()).toContain('[doc.md](/Users/x/doc.md)');
    });

    test('TC-PA-03: 画像パス・選択なし → ![base](path)', async ({ page }) => {
        await pastePlain(page, './img/pic.png');
        await page.waitForTimeout(200);
        const img = page.locator('#editor img');
        expect(await img.count()).toBeGreaterThan(0);
        expect(await img.first().getAttribute('data-markdown-path')).toBe('./img/pic.png');
        expect(await editor.getMarkdown()).toContain('![pic.png](./img/pic.png)');
    });

    test('TC-PA-04: 選択テキストありでパス paste → [選択](path)（画像パスでもリンクラベル優先）', async ({ page }) => {
        // editor に「詳細」を入れて全選択 → パスを paste
        await editor.setMarkdown('詳細');
        await page.waitForTimeout(100);
        await page.evaluate(() => {
            const ed = document.getElementById('editor') as HTMLElement;
            ed.focus();
            const p = ed.querySelector('p') || ed.firstElementChild || ed;
            const r = document.createRange();
            r.selectNodeContents(p);
            const s = window.getSelection()!;
            s.removeAllRanges(); s.addRange(r);
        });
        await pastePlain(page, '/x/a.md');
        await page.waitForTimeout(200);
        const md = await editor.getMarkdown();
        expect(md, '選択語をラベルにリンク化').toContain('[詳細](/x/a.md)');

        // 画像パスでも選択時はリンクラベル優先（![]() でなく []()）
        await editor.setMarkdown('図');
        await page.waitForTimeout(100);
        await page.evaluate(() => {
            const ed = document.getElementById('editor') as HTMLElement;
            ed.focus();
            const p = ed.querySelector('p') || ed.firstElementChild || ed;
            const r = document.createRange();
            r.selectNodeContents(p);
            const s = window.getSelection()!;
            s.removeAllRanges(); s.addRange(r);
        });
        await pastePlain(page, './img/pic.png');
        await page.waitForTimeout(200);
        const md2 = await editor.getMarkdown();
        expect(md2, '画像パスでも選択時はリンク（![]() でない）').toContain('[図](./img/pic.png)');
        expect(md2, '選択時は画像埋め込みにしない').not.toContain('![図]');
    });

    test('TC-PA-05: 非パス plain text は従来どおり（リンク化しない）', async ({ page }) => {
        await pastePlain(page, 'just some text');
        await page.waitForTimeout(200);
        expect(await page.locator('#editor a').count()).toBe(0);
        expect(await editor.getMarkdown()).toContain('just some text');
    });

    test('TC-PA-06: URL 既存挙動の回帰（[url](url)）', async ({ page }) => {
        await pastePlain(page, 'https://www.yahoo.co.jp/');
        await page.waitForTimeout(200);
        const a = page.locator('#editor a').first();
        expect(await a.getAttribute('href')).toBe('https://www.yahoo.co.jp/');
        expect(await editor.getMarkdown()).toContain('[https://www.yahoo.co.jp/](https://www.yahoo.co.jp/)');
    });
});
