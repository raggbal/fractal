/**
 * resource-roots-settings TASK-08 — アクセス権フッター帯（standalone E2E・3 build）
 *
 * host が resourceAccessStatus を webview に送ると、範囲外画像ありならフッター帯が表示、
 * なしなら非表示。settings ボタン click で host.openResourceRootsSettings() が発火し
 * __testApi.messages に {type:'openResourceRootsSettings'} が積まれる。
 *
 * 本番忠実（実 localResourceRoots ブロック）は standalone では近似不能 → 手動 US-01/02 で検収。
 * ここは「通知 → フッター表示/クリア」の UI 配線 + settings ボタン経路の regression ガード。
 *
 * TC-RR-40 standalone editor: outOfRange → フッター表示
 * TC-RR-41 (load-bearing) outOfRange:false → フッター非表示（常時表示でないこと）
 * TC-RR-42 settings ボタン click → openResourceRootsSettings 発火
 * TC-RR-43 standalone outliner でも表示/クリアが効く
 * TC-RR-44 standalone notes でも表示/クリアが効く
 */
import { test, expect } from '@playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function pushStatus(page: any, outOfRange: boolean, count: number, samplePath?: string) {
    await page.evaluate(
        ({ o, c, s }: { o: boolean; c: number; s?: string }) => {
            (window as any).__hostMessageHandler({
                type: 'resourceAccessStatus',
                outOfRange: o,
                count: c,
                samplePath: s,
            });
        },
        { o: outOfRange, c: count, s: samplePath }
    );
}

test.describe('resource access footer — standalone editor', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('TC-RR-40: outOfRange → フッター帯が表示される', async ({ page }) => {
        await pushStatus(page, true, 2, '/ext/x.png');
        const footer = page.locator('.fractal-resource-footer').first();
        await expect(footer).toBeVisible();
        await expect(footer.locator('.rrf-open-settings')).toBeVisible();
    });

    test('TC-RR-41: outOfRange:false → フッター帯は非表示（load-bearing）', async ({ page }) => {
        // まず表示させてから false でクリアされることを確認（常時表示だと fail）
        await pushStatus(page, true, 1, '/ext/x.png');
        await expect(page.locator('.fractal-resource-footer').first()).toBeVisible();
        await pushStatus(page, false, 0);
        await expect(page.locator('.fractal-resource-footer').first()).toBeHidden();
    });

    test('TC-RR-42: settings ボタン click → openResourceRootsSettings 発火', async ({ page }) => {
        await pushStatus(page, true, 1, '/ext/x.png');
        await page.locator('.fractal-resource-footer .rrf-open-settings').first().click();
        const fired = await page.evaluate(() =>
            (window as any).__testApi.messages.some(
                (m: any) => m.type === 'openResourceRootsSettings'
            )
        );
        expect(fired).toBe(true);
    });

    test('TC-RR-45: フッター文言に count と samplePath が動的反映される（dead payload 解消）', async ({ page }) => {
        await pushStatus(page, true, 3, '/ext/out.png');
        const msg = page.locator('.fractal-resource-footer .rrf-msg').first();
        await expect(msg).toContainText('3');           // count が入る
        await expect(msg).toContainText('/ext/out.png'); // samplePath が入る
    });
});

test.describe('resource access footer — standalone outliner', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('TC-RR-43: outliner でフッター表示 → クリア', async ({ page }) => {
        await pushStatus(page, true, 3, '/ext/y.png');
        await expect(page.locator('.fractal-resource-footer').first()).toBeVisible();
        await pushStatus(page, false, 0);
        await expect(page.locator('.fractal-resource-footer').first()).toBeHidden();
    });
});

test.describe('resource access footer — standalone notes', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('TC-RR-44: notes でフッター表示 → クリア', async ({ page }) => {
        await pushStatus(page, true, 1, '/ext/z.png');
        await expect(page.locator('.fractal-resource-footer').first()).toBeVisible();
        await pushStatus(page, false, 0);
        await expect(page.locator('.fractal-resource-footer').first()).toBeHidden();
    });

    test('TC-RR-46: cross-script 二重発火の解消（load-bearing）', async ({ page }) => {
        // outliner.js の click listener は init 済み。ここで md ペインの EditorInstance を構築して
        // editor.js の click listener も同一 document に登録させ、cross-script 二重登録条件を成立させる。
        await page.evaluate(() => {
            (window as any).__testApi.loadMarkdownPane('# hello');
        });
        // 二重登録条件が実際に成立しているか（editor.js の listener が本当に付こうとしたか）を検証。
        // 先勝ちガード window.__rrfClickWired が true になっていること = 両 script が同じフラグを見ている。
        const wired = await page.evaluate(() => (window as any).__rrfClickWired === true);
        expect(wired).toBe(true);

        // settings ボタンで 1 回 bubbling click を起こす。二重発火の検証が目的なので、
        // マウス到達性（他要素に覆われる等）ではなく document click listener の登録数が焦点。
        // dispatchEvent(bubbles) で document まで伝播させ、登録済み listener 数だけ発火する。
        const count = await page.evaluate(() => {
            (window as any).__testApi.messages.length = 0;
            const btn = document.querySelector('.rrf-open-settings') as HTMLElement;
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return (window as any).__testApi.messages.filter(
                (m: any) => m.type === 'openResourceRootsSettings'
            ).length;
        });
        // 先勝ち 1 回登録なので openResourceRootsSettings は ちょうど 1 件（二重発火なら 2 件）
        expect(count).toBe(1);
    });
});
