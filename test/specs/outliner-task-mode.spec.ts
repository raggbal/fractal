/**
 * Outliner タスクモード動作テスト
 * - taskMode toggle ON で root node に checkbox 自動付与
 * - taskFilter='active' で checked=true 行が非表示
 * - timestamps 自動列も連動
 */

import { test, expect } from '@playwright/test';

const HTML = '/standalone-outliner.html';

async function getCheckedAttrs(page) {
    return await page.evaluate(() => {
        var els = document.querySelectorAll('.outliner-node');
        var out = [];
        for (var i = 0; i < els.length; i++) {
            out.push(els[i].dataset.checked);
        }
        return out;
    });
}

async function clickToggleBtn(page, selector) {
    await page.evaluate((sel) => {
        var b = document.querySelector(sel);
        if (b) b.click();
    }, selector);
    await page.waitForTimeout(150);
}

/**
 * FR-TS-01: task mode ON はポップアップで scope を選ばせる仕様に変更された。
 * 既存テストは「ON で root backfill・filter active」を検証するので、
 * 従来の「トップレベルのみ」= root backfill 相当を選んで確定する（意味論不変）。
 * ポップアップが出なければ（= OFF への toggle 等）何もしない。
 */
async function enableTaskMode(page, scope = 'top') {
    await page.evaluate(() => {
        const b = document.querySelector('.outliner-task-mode-toggle-btn') as HTMLElement | null;
        if (b) b.click();
    });
    await page.waitForTimeout(80);
    const opened = await page.evaluate((sc) => {
        const dlg = document.querySelector('.outliner-task-scope-dialog');
        if (!dlg) return false;
        const btn = dlg.querySelector('.outliner-task-scope-' + sc) as HTMLElement | null;
        if (btn) btn.click();
        return true;
    }, scope);
    await page.waitForTimeout(150);
    return opened;
}

test.describe('Outliner タスクモード', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(HTML);
        await page.waitForSelector('.outliner-tree');
    });

    test('タスクモード ON で既存ルート node に checkbox backfill', async ({ page }) => {
        // 初期: checkbox なし (data: { id, text } のみ)
        const beforeChecked = await getCheckedAttrs(page);
        // checkbox なしの状態は data-checked = undefined
        // (タスクモード OFF で初期化されているはず)

        // FR-TS-01: ON はポップアップ経由。「トップレベルのみ」= 従来の root backfill 相当。
        await enableTaskMode(page, 'top');

        const afterChecked = await getCheckedAttrs(page);
        // root node に checkbox 付与されるので "false" になる
        expect(afterChecked.length).toBeGreaterThan(0);
        expect(afterChecked[0]).toBe('false');
    });

    test('filter / archive ボタンは常時表示 (taskMode 状態に依らず)', async ({ page }) => {
        const visibleInitial = await page.evaluate(() => {
            var f = document.querySelector('.outliner-task-filter-toggle-btn') as HTMLElement;
            var a = document.querySelector('.outliner-archive-btn') as HTMLElement;
            return { filter: !!f && f.offsetParent !== null, archive: !!a && a.offsetParent !== null };
        });
        expect(visibleInitial.filter).toBe(true);
        expect(visibleInitial.archive).toBe(true);
    });

    test('タスクモード ON + checked=true → filter active で非表示', async ({ page }) => {
        // FR-TS-01: ON はポップアップ経由（「トップレベルのみ」で確定 = 従来の root backfill）。
        await enableTaskMode(page, 'top');
        // 全 root に checked=false 付与される
        await page.waitForTimeout(100);

        const beforeCount = await page.evaluate(() => document.querySelectorAll('.outliner-node').length);
        expect(beforeCount).toBeGreaterThan(0);

        // 1 つ目を checked=true にする
        await page.evaluate(() => {
            var cb = document.querySelector('.outliner-node .outliner-checkbox input[type="checkbox"]') as HTMLInputElement;
            if (cb) {
                cb.checked = true;
                cb.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        await page.waitForTimeout(200);

        // active filter のため画面から消えるはず (枝ごと非表示)
        const afterCount = await page.evaluate(() => document.querySelectorAll('.outliner-node').length);
        expect(afterCount).toBeLessThan(beforeCount);
    });
});
