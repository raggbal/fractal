const { test, expect } = require('@playwright/test');

test('debug ordered paste', async ({ page }) => {
    await page.goto('/standalone-editor.html');
    await page.waitForSelector('#editor');
    await page.evaluate(() => {
        const editor = document.getElementById('editor');
        editor.innerHTML = '<p><br></p>';
        const p = editor.querySelector('p');
        const range = document.createRange();
        range.selectNodeContents(p); range.collapse(true);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    });
    await page.waitForTimeout(100);

    page.on('console', msg => console.log('[browser]', msg.text()));

    await page.evaluate((text) => {
        const editor = document.getElementById('editor');
        const clipboardData = {
            _data: { 'text/plain': text },
            getData: function (type) { return this._data[type] || ''; },
            setData: function (type, value) { this._data[type] = value; },
            items: []
        };
        const event = new ClipboardEvent('paste', {
            bubbles: true, cancelable: true, clipboardData: new DataTransfer()
        });
        Object.defineProperty(event, 'clipboardData', {
            value: clipboardData, writable: false, configurable: true
        });
        editor.dispatchEvent(event);
    }, '1. one\n2. two\n3. \n');
    await page.waitForTimeout(500);

    const html = await page.evaluate(() => document.getElementById('editor').innerHTML);
    console.log('Editor HTML after paste:', html);
});
