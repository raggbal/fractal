/**
 * Sprint: 20260424-135027-debug-banner-outliner-actions
 * 観測機能: blur 時に queuedExternalContent + hasUserEdited が同時にある状態を検知
 *
 * 検証する FR/NFR:
 *   FR-DBG-1: console.warn '[Fractal:blur-with-queue]' が出力される
 *   FR-DBG-2: webview 右上に floating banner (#fractal-debug-banner) 表示
 *   NFR-DBG-1: 通常運用 (queue=null) では一切実行されない (early return)
 *
 * 共通手順 (TC-DBG-1〜6):
 *   1. standalone editor 起動 + setMarkdown で初期化
 *   2. editor.click() で focus → keyboard.type() で typing
 *      (これで hasUserEdited=true, isActivelyEditing=true (1500ms timer 中) になる)
 *   3. window.__hostMessageHandler({type:'update', content:'...'}) で
 *      cross-editor sync を模擬し queuedExternalContent に値を入れる
 *      (isActivelyEditing 中なので queue に保存される、editor.js:13502-13507 参照)
 *   4. blur (or visibilitychange hidden) を発火
 *   5. console.warn / banner DOM を assert
 */

import { test, expect } from '@playwright/test';

test.describe('blur-with-queue observability', () => {
    let consoleWarns: any[] = [];

    test.beforeEach(async ({ page }) => {
        consoleWarns = [];
        page.on('console', msg => {
            if (msg.type() === 'warning' && msg.text().includes('[Fractal:blur-with-queue]')) {
                consoleWarns.push(msg.text());
            }
        });
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    /**
     * TC-DBG-1: editor.blur で console.warn '[Fractal:blur-with-queue]' が出る
     */
    test('TC-DBG-1: editor.blur で console.warn が出る', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('V_BASE');
        });
        await page.waitForTimeout(50);

        const editor = page.locator('#editor');
        await editor.click();
        await page.keyboard.type(' V_USER');
        await page.waitForTimeout(50);

        // cross-editor sync 模擬
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({ type: 'update', content: 'V_QUEUED_EXTERNAL' });
        });
        await page.waitForTimeout(50);

        // blur 発火
        await page.evaluate(() => {
            const el = document.getElementById('editor') as HTMLElement;
            el.blur();
        });
        await page.waitForTimeout(100);

        // console.warn が出たことを確認
        expect(consoleWarns.length).toBeGreaterThan(0);
        const log = consoleWarns[0];
        expect(log).toContain('[Fractal:blur-with-queue]');
        expect(log).toMatch(/instance/);
        expect(log).toMatch(/domLen/);
        expect(log).toMatch(/queueLen/);
        expect(log).toMatch(/delta/);
    });

    /**
     * TC-DBG-2: sourceEditor.blur (source mode) でも console.warn が出る
     *
     * SKIP 理由:
     *   現状の実装では source mode の input handler (`sourceEditor.addEventListener('input', ...)`,
     *   editor.js:11306) は `markAsEdited()` のみ呼び `markActivelyEditing()` を呼ばない。
     *   そのため source mode で typing しても `isActivelyEditing` が true にならず、
     *   'update' message は queue されず即時適用される (editor.js:13502-13507)。
     *   結果として `isSourceMode && hasUserEdited && queuedExternalContent !== null` の
     *   3 条件同時成立は production code では起きない。
     *
     *   sourceEditor.blur 内の検知ブロックは**防御的 coverage** であり、
     *   将来 source mode に編集中ガード機構が追加された時に有効化される。
     *   現時点で自動再現不可のため skip。
     */
    test.skip('TC-DBG-2: sourceEditor.blur でも console.warn が出る (defensive, 現状 source mode は queue しない)', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('V_BASE');
        });
        await page.waitForTimeout(50);

        // source mode に切替 (host message 経由、editor.js:13495 で handle)
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({ type: 'toggleSourceMode' });
        });
        await page.waitForTimeout(150);

        // sourceEditor で typing (display:block を確認してから)
        await page.locator('#sourceEditor').waitFor({ state: 'visible', timeout: 3000 });
        await page.locator('#sourceEditor').click();
        await page.keyboard.type('V_USER_SRC');
        await page.waitForTimeout(50);

        await page.evaluate(() => {
            (window as any).__hostMessageHandler({ type: 'update', content: 'V_QUEUED_EXTERNAL_SRC' });
        });
        await page.waitForTimeout(50);

        await page.evaluate(() => {
            const el = document.getElementById('sourceEditor') as HTMLElement;
            el.blur();
        });
        await page.waitForTimeout(100);

        expect(consoleWarns.length).toBeGreaterThan(0);
        expect(consoleWarns[0]).toContain('[Fractal:blur-with-queue]');
    });

    /**
     * TC-DBG-3: visibilitychange (hidden) でも console.warn が出る
     */
    test('TC-DBG-3: visibilitychange hidden でも console.warn が出る', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('V_BASE');
        });
        await page.waitForTimeout(50);

        const editor = page.locator('#editor');
        await editor.click();
        await page.keyboard.type(' V_USER_VIS');
        await page.waitForTimeout(50);

        await page.evaluate(() => {
            (window as any).__hostMessageHandler({ type: 'update', content: 'V_QUEUED_VIS' });
        });
        await page.waitForTimeout(50);

        // visibilitychange hidden を発火
        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                get: () => 'hidden'
            });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.waitForTimeout(100);

        expect(consoleWarns.length).toBeGreaterThan(0);
        expect(consoleWarns[0]).toContain('[Fractal:blur-with-queue]');
    });

    /**
     * TC-DBG-4: banner DOM 要素 (#fractal-debug-banner) が追加される
     */
    test.skip('TC-DBG-4: banner DOM 要素が追加される (banner removed in v0.195.718, console.warn のみ残置)', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('V_BASE');
        });
        await page.waitForTimeout(50);

        const editor = page.locator('#editor');
        await editor.click();
        await page.keyboard.type(' V_USER');
        await page.waitForTimeout(50);

        await page.evaluate(() => {
            (window as any).__hostMessageHandler({ type: 'update', content: 'V_QUEUED' });
        });
        await page.waitForTimeout(50);

        await page.evaluate(() => {
            const el = document.getElementById('editor') as HTMLElement;
            el.blur();
        });
        await page.waitForTimeout(100);

        const bannerInfo = await page.evaluate(() => {
            const b = document.getElementById('fractal-debug-banner');
            if (!b) return null;
            return {
                exists: true,
                innerHTML: b.innerHTML,
                bgColor: (b as HTMLElement).style.background
            };
        });

        expect(bannerInfo).not.toBeNull();
        expect(bannerInfo!.exists).toBe(true);
        expect(bannerInfo!.innerHTML).toContain('巻き戻り検知');
        expect(bannerInfo!.innerHTML).toContain('domLen=');
        expect(bannerInfo!.innerHTML).toContain('queueLen=');
        expect(bannerInfo!.innerHTML).toContain('delta=');
        // 背景色: #ff9800 (rgba/rgb どちらでも match するよう緩く)
        expect(bannerInfo!.bgColor.toLowerCase()).toMatch(/(ff9800|255.*152|orange)/);
    });

    /**
     * TC-DBG-5: banner クリックで dismiss される
     */
    test.skip('TC-DBG-5: banner クリックで dismiss される (banner removed in v0.195.718)', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('V_BASE');
        });
        await page.waitForTimeout(50);

        const editor = page.locator('#editor');
        await editor.click();
        await page.keyboard.type(' V_USER');
        await page.waitForTimeout(50);

        await page.evaluate(() => {
            (window as any).__hostMessageHandler({ type: 'update', content: 'V_QUEUED' });
        });
        await page.waitForTimeout(50);

        await page.evaluate(() => {
            const el = document.getElementById('editor') as HTMLElement;
            el.blur();
        });
        await page.waitForTimeout(100);

        // banner 存在確認
        let exists = await page.evaluate(() => !!document.getElementById('fractal-debug-banner'));
        expect(exists).toBe(true);

        // クリックで dismiss
        await page.click('#fractal-debug-banner');
        await page.waitForTimeout(50);

        exists = await page.evaluate(() => !!document.getElementById('fractal-debug-banner'));
        expect(exists).toBe(false);
    });

    /**
     * TC-DBG-6: 連続発火で banner が 1 つだけ存在 (上書き)
     */
    test.skip('TC-DBG-6: 連続発火で banner 1 つのみ (banner removed in v0.195.718)', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('V_BASE');
        });
        await page.waitForTimeout(50);

        const editor = page.locator('#editor');
        await editor.click();
        await page.keyboard.type(' V_USER');
        await page.waitForTimeout(50);

        // 1 回目 blur
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({ type: 'update', content: 'V_QUEUED_1' });
        });
        await page.waitForTimeout(50);
        await page.evaluate(() => {
            const el = document.getElementById('editor') as HTMLElement;
            el.blur();
        });
        await page.waitForTimeout(50);

        // 再 focus + 再 typing + 2 回目 blur
        await page.locator('#editor').click();
        await page.keyboard.type(' V_USER2');
        await page.waitForTimeout(50);
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({ type: 'update', content: 'V_QUEUED_2' });
        });
        await page.waitForTimeout(50);
        await page.evaluate(() => {
            const el = document.getElementById('editor') as HTMLElement;
            el.blur();
        });
        await page.waitForTimeout(100);

        const count = await page.evaluate(() =>
            document.querySelectorAll('#fractal-debug-banner').length
        );
        expect(count).toBe(1);
    });

    /**
     * TC-DBG-7: 通常運用 (queue=null) では console.warn / banner 共に呼ばれない
     *           = NFR-DBG-1 (early return パターンの検証)
     */
    test('TC-DBG-7: 通常運用では console.warn / banner 出ない (early return)', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('V_BASE');
        });
        await page.waitForTimeout(50);

        const editor = page.locator('#editor');
        await editor.click();
        await page.keyboard.type(' V_USER');
        await page.waitForTimeout(50);

        // queue は設定しない (queuedExternalContent は null のまま)
        await page.evaluate(() => {
            const el = document.getElementById('editor') as HTMLElement;
            el.blur();
        });
        await page.waitForTimeout(100);

        // console.warn 出ない
        expect(consoleWarns.length).toBe(0);
        // banner removed in v0.195.718, このチェックも削除可だが念のため残置
        const exists = await page.evaluate(() =>
            !!document.getElementById('fractal-debug-banner')
        );
        expect(exists).toBe(false);
    });

    /**
     * TC-DBG-FIX-A: blur 時に hasUserEdited=true なら queue を drop し、view 巻き戻りを防ぐ
     *
     * Fix A (sprint v14 hotfix): editor.blur で flush 後に
     *   queuedExternalContent = null + applyQueuedExternalChange を skip
     * → DOM は user の最新 typing を維持、view 巻き戻り → disk 上書き連鎖を防ぐ。
     */
    test('TC-DBG-FIX-A: blur で hasUserEdited 時、queue を drop して view 巻き戻りなし', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('V_BASE');
        });
        await page.waitForTimeout(50);

        const editor = page.locator('#editor');
        await editor.click();
        await page.keyboard.type(' V_USER_LATEST');
        await page.waitForTimeout(50);

        // cross-edit から古い content が queue に来ている状態
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'update',
                content: 'V_QUEUED_STALE_OLD'  // user の typing より古い content
            });
        });
        await page.waitForTimeout(50);

        // blur 発火
        await page.evaluate(() => {
            const el = document.getElementById('editor') as HTMLElement;
            el.blur();
        });
        await page.waitForTimeout(100);

        // ★ 検証: blur 後の view (markdown) は user の typing を維持し、
        //   queue 内容に巻き戻されていない
        const finalMd = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(finalMd).toContain('V_USER_LATEST');
        expect(finalMd).not.toBe('V_QUEUED_STALE_OLD');
        expect(finalMd).not.toContain('V_QUEUED_STALE_OLD');
    });

    /**
     * TC-DBG-FIX-A2: 真の external change (idle 時 update) は引き続き適用される
     *
     * Fix A は editing editor の blur 時のみ queue drop。
     * idle editor は applyQueuedExternalChange / 即時 apply 経路で正常動作。
     */
    test('TC-DBG-FIX-A2: idle 状態の真 external change は変わらず即時適用される', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('V_BASE');
        });
        await page.waitForTimeout(2000); // idle 確定 (markActivelyEditing の 1500ms 経過)

        // typing なしで update を送る (= 真の external change シナリオ)
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'update',
                content: 'V_TRUE_EXTERNAL_FROM_OTHER_EDITOR'
            });
        });
        await page.waitForTimeout(100);

        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md.trim()).toBe('V_TRUE_EXTERNAL_FROM_OTHER_EDITOR');
    });
});
