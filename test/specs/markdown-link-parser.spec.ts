/**
 * markdown-link-parser unit tests
 * balanced paren 対応の parseMarkdownLinks / extractImagePaths / extractUrlWithBalancedParens を検証
 *
 * Playwright の page.evaluate 経由で standalone-outliner.html 内にロードされた
 * window.MarkdownLinkParser を呼び出す。
 */

import { test, expect } from '@playwright/test';

test.describe('markdown-link-parser', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    // --- parseMarkdownLinks ---

    test('単純な image を parse できる', async ({ page }) => {
        const result = await page.evaluate(() =>
            (window as any).MarkdownLinkParser.parseMarkdownLinks('![alt](foo.png)')
        );
        expect(result).toEqual([{ kind: 'image', alt: 'alt', url: 'foo.png', start: 0, end: 15 }]);
    });

    test('単純な link を parse できる', async ({ page }) => {
        const result = await page.evaluate(() =>
            (window as any).MarkdownLinkParser.parseMarkdownLinks('[text](https://example.com)')
        );
        expect(result).toHaveLength(1);
        expect(result[0].kind).toBe('link');
        expect(result[0].alt).toBe('text');
        expect(result[0].url).toBe('https://example.com');
    });

    test('画像パスに () を含んでも正しく parse できる', async ({ page }) => {
        const result = await page.evaluate(() =>
            (window as any).MarkdownLinkParser.parseMarkdownLinks('![a](path_(v2).png)')
        );
        expect(result).toHaveLength(1);
        expect(result[0].url).toBe('path_(v2).png');
    });

    test('Wikipedia 風 URL の link を parse できる', async ({ page }) => {
        const result = await page.evaluate(() =>
            (window as any).MarkdownLinkParser.parseMarkdownLinks('[Foo](https://en.wikipedia.org/wiki/Foo_(bar))')
        );
        expect(result).toHaveLength(1);
        expect(result[0].url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    });

    test('ネストした () を含む URL を parse できる', async ({ page }) => {
        const result = await page.evaluate(() =>
            (window as any).MarkdownLinkParser.parseMarkdownLinks('[x](a_((b)(c))_d)')
        );
        expect(result).toHaveLength(1);
        expect(result[0].url).toBe('a_((b)(c))_d');
    });

    test('全角括弧はそのまま URL の一部として扱う', async ({ page }) => {
        const result = await page.evaluate(() =>
            (window as any).MarkdownLinkParser.parseMarkdownLinks('![a](東京（tokyo）.png)')
        );
        expect(result).toHaveLength(1);
        expect(result[0].url).toBe('東京（tokyo）.png');
    });

    test('複数の image/link を parse できる', async ({ page }) => {
        const result = await page.evaluate(() =>
            (window as any).MarkdownLinkParser.parseMarkdownLinks('![a](x.png)![b](y_(1).png)[t](z.com)')
        );
        expect(result).toHaveLength(3);
        expect(result[0].kind).toBe('image');
        expect(result[0].url).toBe('x.png');
        expect(result[1].kind).toBe('image');
        expect(result[1].url).toBe('y_(1).png');
        expect(result[2].kind).toBe('link');
        expect(result[2].url).toBe('z.com');
    });

    test('空 alt の image も parse できる', async ({ page }) => {
        const result = await page.evaluate(() =>
            (window as any).MarkdownLinkParser.parseMarkdownLinks('![](foo.png)')
        );
        expect(result).toHaveLength(1);
        expect(result[0].alt).toBe('');
        expect(result[0].url).toBe('foo.png');
    });

    test('閉じカッコが欠けている壊れた入力はマッチしない', async ({ page }) => {
        const result = await page.evaluate(() =>
            (window as any).MarkdownLinkParser.parseMarkdownLinks('![alt](unclosed')
        );
        expect(result).toEqual([]);
    });

    test('link text が空の [](x) は無視 (現状の editor 挙動踏襲)', async ({ page }) => {
        const result = await page.evaluate(() =>
            (window as any).MarkdownLinkParser.parseMarkdownLinks('[](foo)')
        );
        // parser 自体は kind='link', alt='' で返す。editor 側のフィルタで落とす
        expect(result).toHaveLength(1);
        expect(result[0].alt).toBe('');
    });

    // --- extractImagePaths ---

    test('extractImagePaths は http/https URL を除外する', async ({ page }) => {
        const result = await page.evaluate(() =>
            (window as any).MarkdownLinkParser.extractImagePaths(
                '![a](https://example.com/x.png) ![b](local_(v2).png)'
            )
        );
        expect(result).toEqual(['local_(v2).png']);
    });

    test('extractImagePaths は data:/file: と絶対パスを除外する', async ({ page }) => {
        const result = await page.evaluate(() =>
            (window as any).MarkdownLinkParser.extractImagePaths(
                '![a](data:image/png;base64,xxx) ![b](/abs/path.png) ![c](rel.png)'
            )
        );
        expect(result).toEqual(['rel.png']);
    });

    test('extractImagePaths はクエリ/フラグメントを除去する', async ({ page }) => {
        const result = await page.evaluate(() =>
            (window as any).MarkdownLinkParser.extractImagePaths('![a](foo.png?v=1#top)')
        );
        expect(result).toEqual(['foo.png']);
    });

    test('extractImagePaths は HTML img タグも抽出する', async ({ page }) => {
        const result = await page.evaluate(() =>
            (window as any).MarkdownLinkParser.extractImagePaths('<img src="bar.png" alt="b">')
        );
        expect(result).toEqual(['bar.png']);
    });

    // --- extractUrlWithBalancedParens ---

    test('extractUrlWithBalancedParens は通常 URL を取得', async ({ page }) => {
        const result = await page.evaluate(() => {
            const text = 'see https://example.com here';
            return (window as any).MarkdownLinkParser.extractUrlWithBalancedParens(text, 4);
        });
        expect(result).toEqual({ url: 'https://example.com', endIndex: 23 });
    });

    test('extractUrlWithBalancedParens は URL 内の () を含める', async ({ page }) => {
        const result = await page.evaluate(() => {
            const text = 'see https://en.wikipedia.org/wiki/Foo_(bar) end';
            return (window as any).MarkdownLinkParser.extractUrlWithBalancedParens(text, 4);
        });
        expect(result?.url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    });

    test('extractUrlWithBalancedParens は末尾 . を URL に含めない', async ({ page }) => {
        const result = await page.evaluate(() => {
            const text = 'visit https://example.com.';
            return (window as any).MarkdownLinkParser.extractUrlWithBalancedParens(text, 6);
        });
        expect(result?.url).toBe('https://example.com');
    });

    test('extractUrlWithBalancedParens は末尾句読点を段階的に外す', async ({ page }) => {
        const result = await page.evaluate(() => {
            const text = 'url: https://example.com/!?';
            return (window as any).MarkdownLinkParser.extractUrlWithBalancedParens(text, 5);
        });
        expect(result?.url).toBe('https://example.com/');
    });

    test('extractUrlWithBalancedParens は http:// でも動作', async ({ page }) => {
        const result = await page.evaluate(() => {
            const text = 'http://a.b/c';
            return (window as any).MarkdownLinkParser.extractUrlWithBalancedParens(text, 0);
        });
        expect(result?.url).toBe('http://a.b/c');
    });

    test('extractUrlWithBalancedParens は プロトコルなしなら null', async ({ page }) => {
        const result = await page.evaluate(() => {
            return (window as any).MarkdownLinkParser.extractUrlWithBalancedParens('plain text', 0);
        });
        expect(result).toBeNull();
    });
});
