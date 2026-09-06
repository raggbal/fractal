/**
 * TASK-05 の完了条件 smoke — 小 viewport ハーネスが 7 サイトで機能することを確認する。
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-MFIT-01 の検証前提）
 *
 * ここで検証するのは**ハーネス自身**（面が開けるか / 測定できるか /
 * assertWithinViewport に検出力があるか）。
 * 各サイトの配置そのものは TC-MFIT-01..14（TASK-06..09）が踏む。
 */
import { test, expect } from '@playwright/test';
import {
    MENU_SITES, MENU_SELECTOR, MENU_HARNESS, SMALL_VIEWPORT, BOTTOM_RIGHT,
    gotoSmall, measureMenu, assertWithinViewport, type MenuRect,
} from '../utils/small-viewport';

test('TASK-05 smoke: 7 サイトの定義が揃っている（selector / harness の対応表）', () => {
    expect(MENU_SITES.length, '対象は 7 サイト全部（依頼文「右クリックメニュー全般」）').toBe(7);
    for (const site of MENU_SITES) {
        expect(MENU_SELECTOR[site], `${site} の selector 未定義`).toBeTruthy();
        expect(MENU_HARNESS[site], `${site} の harness 未定義`).toBeTruthy();
    }
    // linkedfd を落とすと TASK-26 の「Outliner に送る」が clamp の無い面に残る（自己矛盾）
    expect(MENU_SITES).toContain('linkedfd-row');
    // 列ヘッダ / mindmap も対象（clamp が元から無い面）
    expect(MENU_SITES).toContain('outliner-column');
    expect(MENU_SITES).toContain('mindmap');
});

test('TASK-05 smoke: 小 viewport でハーネスが開く（3 面すべて）', async ({ page }) => {
    const harnesses = [...new Set(MENU_SITES.map((s) => MENU_HARNESS[s]))];
    expect(harnesses.length, 'ハーネスは outliner / editor / notes の 3 面').toBe(3);

    for (const site of ['outliner-node', 'md-editor', 'tree-file'] as const) {
        await gotoSmall(page, site);
        const vp = page.viewportSize();
        expect(vp).toEqual(SMALL_VIEWPORT);
        // ページが実際に読み込まれている（404 の白ページを掴んでいない）
        const hasBody = await page.evaluate(() => document.body.children.length > 0);
        expect(hasBody, `${MENU_HARNESS[site]} が空 — ハーネスのビルド漏れ`).toBe(true);
    }
});

test('TASK-05 smoke: BOTTOM_RIGHT が viewport の端 5px 内側（flip を確実に発火させる座標）', () => {
    expect(BOTTOM_RIGHT.x).toBe(SMALL_VIEWPORT.width - 5);
    expect(BOTTOM_RIGHT.y).toBe(SMALL_VIEWPORT.height - 5);
});

test('TASK-05 smoke: assertWithinViewport に検出力がある（4 辺それぞれで throw する）', () => {
    const ok: MenuRect = {
        left: 8, top: 8, right: 200, bottom: 200, width: 192, height: 192,
        vw: 400, vh: 300, maxHeight: '', overflowY: '', scrollable: false,
    };
    // 正常系は throw しない
    expect(() => assertWithinViewport(ok, 'ok')).not.toThrow();

    // 4 辺それぞれの違反を確実に検出する（1 辺でも見逃すと番人が穴を持つ）
    expect(() => assertWithinViewport({ ...ok, left: -1 }, 'x')).toThrow(/left=-1/);
    expect(() => assertWithinViewport({ ...ok, top: -1 }, 'x')).toThrow(/top=-1/);
    expect(() => assertWithinViewport({ ...ok, right: 401 }, 'x')).toThrow(/right=401/);
    expect(() => assertWithinViewport({ ...ok, bottom: 301 }, 'x')).toThrow(/bottom=301/);
});

test('TASK-05 smoke: measureMenu が開いていないメニューで待機タイムアウトする（vacuous pass の防止）', async ({ page }) => {
    await gotoSmall(page, 'outliner-node');
    // メニューを開かずに測定すると失敗する = 「開いていないのに green」を構造的に防げている
    let threw = false;
    try {
        await measureMenu(page, 'outliner-node');
    } catch {
        threw = true;
    }
    expect(threw, 'メニュー未オープンでも measureMenu が成功した — 番人が空回りする').toBe(true);
});
