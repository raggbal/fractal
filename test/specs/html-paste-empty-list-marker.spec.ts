/**
 * HTML/Markdown ペースト時の空リストマーカー除去テスト
 *
 * (1) 上下が空行 (or BOF/EOF) で「- 」だけの孤立行 → 削除
 * (2) リスト末尾の「- 」(直前が list 行 + 直後が空行 or EOF) → 削除
 * (3) 間に挟まる「- 」(前後が valid list item) は保持
 */

import { test, expect } from '@playwright/test';
import { EditorTestHelper } from '../utils/editor-test-helper';

async function simulateHtmlPaste(page, html: string, plainText?: string) {
    await page.evaluate(({ html, text }) => {
        const editor = document.getElementById('editor');
        const clipboardData = {
            _data: { 'text/plain': text || '', 'text/html': html },
            getData: function (type: string) { return this._data[type] || ''; },
            setData: function (type: string, value: string) { this._data[type] = value; },
            items: []
        };
        const event = new ClipboardEvent('paste', {
            bubbles: true, cancelable: true, clipboardData: new DataTransfer()
        });
        Object.defineProperty(event, 'clipboardData', {
            value: clipboardData, writable: false, configurable: true
        });
        editor.dispatchEvent(event);
    }, { html, text: plainText || '' });
}

async function simulateTextPaste(page, text: string) {
    await page.evaluate((text) => {
        const editor = document.getElementById('editor');
        const clipboardData = {
            _data: { 'text/plain': text },
            getData: function (type: string) { return this._data[type] || ''; },
            setData: function (type: string, value: string) { this._data[type] = value; },
            items: []
        };
        const event = new ClipboardEvent('paste', {
            bubbles: true, cancelable: true, clipboardData: new DataTransfer()
        });
        Object.defineProperty(event, 'clipboardData', {
            value: clipboardData, writable: false, configurable: true
        });
        editor.dispatchEvent(event);
    }, text);
}

async function clearEditor(page) {
    await page.evaluate(() => {
        const editor = document.getElementById('editor');
        editor.innerHTML = '<p><br></p>';
        const p = editor.querySelector('p');
        const range = document.createRange();
        range.selectNodeContents(p);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    });
    await page.waitForTimeout(100);
}

test.describe('HTML ペースト - 空リストマーカー除去', () => {
    let editor: EditorTestHelper;

    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForSelector('#editor');
        editor = new EditorTestHelper(page);
        await editor.focus();
    });

    test('(1) 上下空行に挟まれた孤立「- 」は削除される', async ({ page }) => {
        await clearEditor(page);
        // <p>foo</p><ul><li></li></ul><p>bar</p>
        // → 中央が空 li の HTML
        await simulateHtmlPaste(page,
            '<p>foo</p><ul><li></li></ul><p>bar</p>',
            'foo\n\n\nbar'
        );
        await page.waitForTimeout(300);
        const md = await editor.getMarkdown();
        console.log('(1) standalone empty marker:', JSON.stringify(md));
        expect(md).not.toMatch(/\n\n[-*+] *\n\n/);
        expect(md).not.toMatch(/\n\n[-*+] *$/);
        expect(md).toContain('foo');
        expect(md).toContain('bar');
    });

    test('(2) リスト末尾の「- 」(空) は削除される', async ({ page }) => {
        await clearEditor(page);
        await simulateHtmlPaste(page,
            '<ul><li>item1</li><li>item2</li><li></li></ul>',
            'item1\nitem2\n'
        );
        await page.waitForTimeout(300);
        const md = await editor.getMarkdown();
        console.log('(2) trailing empty:', JSON.stringify(md));
        expect(md).toContain('- item1');
        expect(md).toContain('- item2');
        // 末尾に空マーカーが残ってないこと
        expect(md).not.toMatch(/- item2\n[-*+] *(?:\n|$)/);
    });

    test('(2-multi) 末尾に複数の「- 」が連続しても全部削除', async ({ page }) => {
        await clearEditor(page);
        await simulateTextPaste(page, '- a\n- \n- \n');
        await page.waitForTimeout(300);
        const md = await editor.getMarkdown();
        console.log('(2-multi) multi trailing:', JSON.stringify(md));
        expect(md).toContain('- a');
        // 末尾の 2 つの空マーカーが削除されていること
        const lines = md.split('\n').filter(l => l.trim() !== '');
        const lastListLine = lines.reverse().find(l => /^[ \t]*[-*+]/.test(l));
        expect(lastListLine).toBe('- a');
    });

    test('(3) 間に挟まる「- 」(前後 valid item) は保持される', async ({ page }) => {
        await clearEditor(page);
        await simulateTextPaste(page, '- item1\n- \n- item2\n');
        await page.waitForTimeout(300);
        const md = await editor.getMarkdown();
        console.log('(3) middle empty preserved:', JSON.stringify(md));
        expect(md).toContain('- item1');
        expect(md).toContain('- item2');
        // 中央の空マーカーは残るべき (ユーザー意図的かも)
        expect(md).toMatch(/- item1\n[-*+] *\n- item2/);
    });

    test('(4) リスト全体が valid items のみなら何も削除されない (regression)', async ({ page }) => {
        await clearEditor(page);
        await simulateHtmlPaste(page,
            '<ul><li>a</li><li>b</li><li>c</li></ul>',
            'a\nb\nc'
        );
        await page.waitForTimeout(300);
        const md = await editor.getMarkdown();
        console.log('(4) regression valid list:', JSON.stringify(md));
        expect(md).toContain('- a');
        expect(md).toContain('- b');
        expect(md).toContain('- c');
    });

    test('(5) 数字リスト末尾の空「1. 」も削除', async ({ page }) => {
        await clearEditor(page);
        await simulateTextPaste(page, '1. one\n2. two\n3. \n');
        await page.waitForTimeout(300);
        const md = await editor.getMarkdown();
        console.log('(5) ordered trailing empty:', JSON.stringify(md));
        expect(md).toContain('1. one');
        expect(md).toContain('2. two');
        // 末尾に「3. 」(空) が残ってないこと
        expect(md).not.toMatch(/2\. two\n\d+\. *(?:\n|$)/);
    });
});
