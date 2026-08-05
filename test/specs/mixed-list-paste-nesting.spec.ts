/**
 * sprint 20260805-124854 TASK-09 — 混在リスト（bullet + 数字）貼付のネスト解釈の全面見直し
 *
 * 旧実装は listStack.length（深さ）と indentLevel を混同し、インデントが 1 段で
 * 2 レベル以上跳ぶ入力の後の同インデント別種リストを誤って入れ子化していた。
 * 新実装はスタックに保存した indent 値で比較する（CommonMark 的な階層解釈）。
 *
 * TC-ML-01  ユーザー再現: - ada / 4sp- asda / 4sp1. asda → ul と ol が同階層の兄弟
 *           （counterfactual: 旧実装だと ol が ul の子 = RED）
 * TC-ML-02  逆パターン（ol 親・ol/ul 子）も同階層
 * TC-ML-03  深いインデント跳び（8sp）でも同インデント同士は同階層
 * TC-ML-04  インデント復帰（ネスト → top）+ top の型切替が正しく閉じる
 * TC-ML-05  round-trip 安定（再 serialize → 再 parse で構造不変）
 */
import { test, expect } from '@playwright/test';

async function loadMd(page: import('@playwright/test').Page, md: string) {
    await page.evaluate((m) => { (window as any).__testApi.setMarkdown(m); }, md);
    await page.waitForTimeout(150);
    return page.evaluate(() => ({
        html: document.getElementById('editor')!.innerHTML,
        back: (window as any).__testApi.getMarkdown(),
    }));
}

test.describe('混在リスト貼付のネスト解釈 (TASK-09)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('TC-ML-01 ユーザー再現: 4sp インデントの - と 1. が同階層の兄弟', async ({ page }) => {
        const r = await loadMd(page, '- ada\n    - asda\n    1. asda');
        expect(r.html).toBe('<ul><li>ada<ul><li>asda</li></ul><ol><li>asda</li></ol></li></ul>');
    });

    test('TC-ML-02 ol 親でも子の 1. と - が同階層', async ({ page }) => {
        const r = await loadMd(page, '1. a\n    1. b\n    - c');
        expect(r.html).toBe('<ol><li>a<ol><li>b</li></ol><ul><li>c</li></ul></li></ol>');
    });

    test('TC-ML-03 深いインデント跳び（8sp）でも同インデント同士は同階層', async ({ page }) => {
        const r = await loadMd(page, '- a\n        - deep\n        1. num');
        expect(r.html).toBe('<ul><li>a<ul><li>deep</li></ul><ol><li>num</li></ol></li></ul>');
    });

    test('TC-ML-04 インデント復帰 + top の型切替が正しく閉じる', async ({ page }) => {
        const r = await loadMd(page, '- a\n    - b\n- c\n1. d');
        expect(r.html).toBe('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul><ol><li>d</li></ol>');
    });

    test('TC-ML-05 round-trip 安定（serialize → 再 parse で構造不変）', async ({ page }) => {
        const first = await loadMd(page, '- ada\n    - asda\n    1. asda');
        const second = await loadMd(page, first.back);
        // 末尾 \n 由来の空段落 <p><br></p> はリスト構造と無関係なので除いて比較
        const strip = (h: string) => h.replace(/<p><br><\/p>$/, '');
        expect(strip(second.html)).toBe(strip(first.html));
        expect(second.back).toBe(first.back);
    });
});
