/**
 * () 入り URL/画像パスの E2E テスト
 *
 * - Editor での () 入り画像/リンク描画
 * - Outliner での () 入り URL paste → リンク化 → 描画
 * - Outliner での () 入り Markdown リンク描画
 */

import { test, expect } from '@playwright/test';
import { EditorTestHelper } from '../utils/editor-test-helper';

// --- Editor 描画テスト ---

test.describe('Editor: () 入り画像/リンク描画', () => {
    let editor: EditorTestHelper;

    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        editor = new EditorTestHelper(page);
    });

    test('() 入り画像パスが 1 つの img として描画される', async ({ page }) => {
        await editor.setMarkdown('![photo](images/photo_(v2).png)');
        const imgs = await page.locator('#editor img').all();
        expect(imgs).toHaveLength(1);
        const src = await imgs[0].getAttribute('data-markdown-path');
        expect(src).toBe('images/photo_(v2).png');
    });

    test('ネスト () 画像パスが 1 つの img として描画される', async ({ page }) => {
        await editor.setMarkdown('![data](images/data_((nested)).png)');
        const imgs = await page.locator('#editor img').all();
        expect(imgs).toHaveLength(1);
        const src = await imgs[0].getAttribute('data-markdown-path');
        expect(src).toBe('images/data_((nested)).png');
    });

    test('通常画像パスが退行しない', async ({ page }) => {
        await editor.setMarkdown('![normal](images/normal.png)');
        const imgs = await page.locator('#editor img').all();
        expect(imgs).toHaveLength(1);
        const src = await imgs[0].getAttribute('data-markdown-path');
        expect(src).toBe('images/normal.png');
    });

    test('() 入り Wikipedia リンクが 1 つの a として描画される', async ({ page }) => {
        await editor.setMarkdown('[Foo](https://en.wikipedia.org/wiki/Foo_(bar))');
        const links = await page.locator('#editor a').all();
        expect(links).toHaveLength(1);
        const href = await links[0].getAttribute('href');
        expect(href).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
        const text = await links[0].textContent();
        expect(text).toBe('Foo');
    });

    test('ネスト () リンクが 1 つの a として描画される', async ({ page }) => {
        await editor.setMarkdown('[Complex](https://example.com/path/((a)(b))/end)');
        const links = await page.locator('#editor a').all();
        expect(links).toHaveLength(1);
        const href = await links[0].getAttribute('href');
        expect(href).toBe('https://example.com/path/((a)(b))/end');
    });

    test('通常リンクが退行しない', async ({ page }) => {
        await editor.setMarkdown('[Google](https://www.google.com)');
        const links = await page.locator('#editor a').all();
        expect(links).toHaveLength(1);
        const href = await links[0].getAttribute('href');
        expect(href).toBe('https://www.google.com');
    });

    test('画像 + リンク混在が正しく描画される', async ({ page }) => {
        await editor.setMarkdown('See ![icon](images/photo_(v2).png) and visit [Wiki](https://en.wikipedia.org/wiki/Test_(unit)).');
        const imgs = await page.locator('#editor img').all();
        const links = await page.locator('#editor a').all();
        expect(imgs).toHaveLength(1);
        expect(links).toHaveLength(1);
        expect(await imgs[0].getAttribute('data-markdown-path')).toBe('images/photo_(v2).png');
        expect(await links[0].getAttribute('href')).toBe('https://en.wikipedia.org/wiki/Test_(unit)');
    });

    test('太字/イタリック + () 入りリンクが共存する', async ({ page }) => {
        await editor.setMarkdown('This is **bold** with [a link](https://example.com/foo_(bar)) and *italic* text.');
        const strongs = await page.locator('#editor strong').all();
        const ems = await page.locator('#editor em').all();
        const links = await page.locator('#editor a').all();
        expect(strongs).toHaveLength(1);
        expect(ems).toHaveLength(1);
        expect(links).toHaveLength(1);
        expect(await links[0].getAttribute('href')).toBe('https://example.com/foo_(bar)');
    });
});

// --- Outliner 描画テスト ---

test.describe('Outliner: () 入りリンク描画', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('Markdown リンクに () が含まれても 1 つの a として描画される', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: '[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))', tags: [] }
                }
            });
        });
        await page.waitForTimeout(500);
        // renderInlineText は非フォーカスノードの innerHTML で使われる
        const html = await page.locator('.outliner-node[data-id="n1"] .outliner-text').innerHTML();
        expect(html).toContain('<a ');
        expect(html).toContain('href="https://en.wikipedia.org/wiki/Foo_(bar)"');
        expect(html).toContain('>Wiki</a>');
    });

    test('通常リンクが退行しない', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: '[Google](https://www.google.com)', tags: [] }
                }
            });
        });
        await page.waitForTimeout(500);
        const html = await page.locator('.outliner-node[data-id="n1"] .outliner-text').innerHTML();
        expect(html).toContain('<a ');
        expect(html).toContain('href="https://www.google.com"');
    });
});

// --- Outliner URL 自動リンク化テスト (convertUrlsToMarkdownLinks のロジック検証) ---

test.describe('Outliner: () 入り URL 自動リンク化', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('() 入り URL が balanced paren 対応でリンク化される', async ({ page }) => {
        // Outliner 内部の convertUrlsToMarkdownLinks を直接呼ぶ (Outliner IIFE 内なのでモデル経由)
        // ノードに URL を設定し、モデル経由で確認
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: '', tags: [] }
                }
            });
        });
        await page.waitForTimeout(300);

        // MarkdownLinkParser.extractUrlWithBalancedParens を直接テスト
        const result = await page.evaluate(() => {
            return (window as any).MarkdownLinkParser.extractUrlWithBalancedParens(
                'https://en.wikipedia.org/wiki/Foo_(bar)', 0
            );
        });
        expect(result).not.toBeNull();
        expect(result.url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    });

    test('通常 URL が正しく抽出される', async ({ page }) => {
        const result = await page.evaluate(() => {
            return (window as any).MarkdownLinkParser.extractUrlWithBalancedParens(
                'https://example.com', 0
            );
        });
        expect(result).not.toBeNull();
        expect(result.url).toBe('https://example.com');
    });

    test('renderInlineText で () 入り Markdown link が描画後に a タグになる', async ({ page }) => {
        // text に Markdown link を設定して表示確認
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: '[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))', tags: [] }
                }
            });
        });
        await page.waitForTimeout(500);
        const html = await page.locator('.outliner-node[data-id="n1"] .outliner-text').innerHTML();
        expect(html).toContain('href="https://en.wikipedia.org/wiki/Foo_(bar)"');
        expect(html).toContain('>Wiki</a>');
    });
});
