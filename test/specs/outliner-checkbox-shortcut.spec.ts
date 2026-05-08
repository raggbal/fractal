/**
 * Outliner checkbox shortcut tests
 * - `[ ]` + space → checkbox 変換 (MD task list と同じ挙動)
 * - `[x]` + space → checked checkbox 変換
 * - Cmd+Shift+X → checkbox toggle
 */

import { test, expect } from '@playwright/test';

const HTML = '/standalone-outliner.html';

async function getFirstNode(page) {
    return await page.evaluate(() => {
        var el = document.querySelector('.outliner-node');
        return el ? el.dataset.id : null;
    });
}

async function getNodeChecked(page, nodeId) {
    return await page.evaluate((id) => {
        var el = document.querySelector('.outliner-node[data-id="' + id + '"]');
        return el ? el.dataset.checked : undefined;
    }, nodeId);
}

async function getNodeText(page, nodeId) {
    return await page.evaluate((id) => {
        var el = document.querySelector('.outliner-node[data-id="' + id + '"] .outliner-text');
        return el ? (el.textContent || '') : '';
    }, nodeId);
}

async function focusFirstNode(page) {
    await page.evaluate(() => {
        var el = document.querySelector('.outliner-node .outliner-text');
        if (el) el.focus();
    });
}

test.describe('Outliner checkbox shortcuts', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(HTML);
        await page.waitForSelector('.outliner-tree');
    });

    test('[ ] + space → unchecked checkbox 追加', async ({ page }) => {
        const id = await getFirstNode(page);
        expect(id).toBeTruthy();
        await focusFirstNode(page);

        // text に `[ ]` を入力
        await page.keyboard.press('[');
        await page.keyboard.press('Space');
        await page.keyboard.press(']');
        await page.waitForTimeout(80);
        // space で変換トリガー
        await page.keyboard.press('Space');
        await page.waitForTimeout(150);

        const checked = await getNodeChecked(page, id);
        const text = await getNodeText(page, id);
        expect(checked).toBe('false');
        expect(text).toBe('');
    });

    test('[x] + space → checked checkbox 追加', async ({ page }) => {
        const id = await getFirstNode(page);
        await focusFirstNode(page);
        await page.keyboard.press('[');
        await page.keyboard.press('x');
        await page.keyboard.press(']');
        await page.waitForTimeout(80);
        await page.keyboard.press('Space');
        await page.waitForTimeout(150);

        const checked = await getNodeChecked(page, id);
        expect(checked).toBe('true');
    });

    test('Cmd+Shift+X (cmd) → checkbox 追加 → toggle', async ({ page }) => {
        const id = await getFirstNode(page);
        await focusFirstNode(page);

        const isMac = process.platform === 'darwin';
        const mod = isMac ? 'Meta' : 'Control';

        // 1 回目: 追加 (false)
        await page.keyboard.down(mod);
        await page.keyboard.down('Shift');
        await page.keyboard.press('KeyX');
        await page.keyboard.up('Shift');
        await page.keyboard.up(mod);
        await page.waitForTimeout(150);
        expect(await getNodeChecked(page, id)).toBe('false');

        // 2 回目: トグル (true)
        await page.keyboard.down(mod);
        await page.keyboard.down('Shift');
        await page.keyboard.press('KeyX');
        await page.keyboard.up('Shift');
        await page.keyboard.up(mod);
        await page.waitForTimeout(150);
        expect(await getNodeChecked(page, id)).toBe('true');

        // 3 回目: トグル (false)
        await page.keyboard.down(mod);
        await page.keyboard.down('Shift');
        await page.keyboard.press('KeyX');
        await page.keyboard.up('Shift');
        await page.keyboard.up(mod);
        await page.waitForTimeout(150);
        expect(await getNodeChecked(page, id)).toBe('false');
    });
});
