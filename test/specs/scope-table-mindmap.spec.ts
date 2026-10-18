/**
 * spec 20261018-1512-scope-table-mindmap — Scope を table / mindmap でも outliner と同じに
 *
 * D1: table の scope は scope ノード自身を先頭行（.outliner-scope-header）に出し、子を depth 0 から並べる
 * D2: mindmap の scope は scope ノードを唯一の root（中心）にしてその subtree だけを描く
 * D3/D4: mindmap の右クリック Scope / Clear Scope と Cmd+] / Cmd+Shift+]
 * D5: mindmap の scope ノードは Enter / Shift+Enter / Delete / Backspace の対象外（Tab は可）
 * D6: scope を変えたら新しい中心を画面中央へ
 *
 * 実キー・実クリック・実右クリックで駆動する（standalone-outliner.html）。
 */

import { test, expect, Page } from '@playwright/test';

test.use({ viewport: { width: 1000, height: 720 } });

function node(id: string, text: string, children: string[] = [], parentId: string | null = null, extra: any = {}) {
    return Object.assign({ id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] }, extra);
}

/**
 * 複数 root（A / B）+ scope 外の兄弟（A2）+ Floating Topic（F）を持つ文書。scope 対象は A1（子 A1a / A1b）。
 *   A ─ A1 ─ A1a
 *     │    └ A1b
 *     └ A2
 *   B ─ B1
 *   F（parentId=null・rootIds 外・mindmap.x/y あり = Floating Topic）
 */
function doc(viewMode: string, opts: { layout?: string; a1?: any; taskFilter?: string } = {}) {
    return {
        version: 1, viewMode, title: 'Doc Title', rootIds: ['A', 'B'],
        taskFilter: opts.taskFilter,
        mindmap: { layout: opts.layout || 'right' },
        nodes: {
            A: node('A', 'alpha', ['A1', 'A2']),
            A1: node('A1', 'alpha one', ['A1a', 'A1b'], 'A', opts.a1 || {}),
            A1a: node('A1a', 'alpha one a', [], 'A1'),
            A1b: node('A1b', 'alpha one b', [], 'A1'),
            A2: node('A2', 'alpha two', [], 'A'),
            B: node('B', 'beta', ['B1']),
            B1: node('B1', 'beta one', [], 'B'),
            F: node('F', 'floating', [], null, { mindmap: { x: 600, y: -200 } }),
        },
    };
}

async function boot(page: Page, data: any) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((d) => {
        (window as any).__testApi.initOutliner(JSON.parse(JSON.stringify(d)));
        (window as any).Outliner.setViewMode(d.viewMode);
    }, data);
    await page.waitForTimeout(250);
}

async function setMode(page: Page, mode: string) {
    await page.evaluate((m) => (window as any).Outliner.setViewMode(m), mode);
    await page.waitForTimeout(250);
}

/** outliner / table: ノードのテキストにカーソルを入れて Cmd+] */
async function scopeViaOutlinerNode(page: Page, id: string) {
    await page.locator(`.outliner-node[data-id="${id}"] .outliner-text`).first().click();
    await page.keyboard.press('ControlOrMeta+]');
    await page.waitForTimeout(150);
}

/** table: 描画順の outliner 列セル（data-id と scope ヘッダーか） */
function tableRows(page: Page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('.outliner-tree .outliner-node.outliner-cell-outliner'))
        .map((el) => ({ id: (el as HTMLElement).dataset.id, header: el.classList.contains('outliner-scope-header'),
            depth: Number((el as HTMLElement).dataset.depth || (el as HTMLElement).getAttribute('data-depth') || 'NaN') })));
}

/** mindmap: 描かれているノード id（描画順） */
function mmIds(page: Page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('.mindmap-node[data-node-id]'))
        .map((el) => el.getAttribute('data-node-id')).sort());
}

async function mmSelect(page: Page, id: string) {
    await page.locator(`.mindmap-node[data-node-id="${id}"] .mindmap-node-box`).click();
    await page.waitForTimeout(100);
}

async function mmRightClick(page: Page, id: string | null) {
    if (id) {
        await page.locator(`.mindmap-node[data-node-id="${id}"] .mindmap-node-box`).click({ button: 'right' });
    } else {
        const t = (await page.locator('.outliner-tree').boundingBox())!;
        await page.mouse.click(t.x + 20, t.y + t.height - 20, { button: 'right' });
    }
    await page.waitForTimeout(120);
}

function menuLabels(page: Page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('.mindmap-context-menu .mindmap-ctx-item')).map((e) => (e.textContent || '').trim()));
}

async function clickMenu(page: Page, re: RegExp) {
    const items = page.locator('.mindmap-context-menu .mindmap-ctx-item');
    const n = await items.count();
    for (let i = 0; i < n; i++) {
        const t = ((await items.nth(i).textContent()) || '').trim();
        if (re.test(t)) { await items.nth(i).click(); await page.waitForTimeout(250); return; }
    }
    throw new Error('menu item not found: ' + re + ' in ' + JSON.stringify(await menuLabels(page)));
}

const SCOPE_RE = /^(Scope|スコープ)$/;
const CLEAR_RE = /^(Clear Scope|スコープ解除)$/;
const ALL_MM = ['A', 'A1', 'A1a', 'A1b', 'A2', 'B', 'B1', 'F', '__title__'].sort();

function mmCenter(page: Page, id: string) {
    return page.evaluate((nid) => {
        const t = (document.querySelector('.outliner-tree') as HTMLElement).getBoundingClientRect();
        const vl = Math.max(t.left, 0), vr = Math.min(t.right, window.innerWidth);
        const vt = Math.max(t.top, 0), vb = Math.min(t.bottom, window.innerHeight);
        const el = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as Element | null;
        if (!el) { return null; }
        const r = el.getBoundingClientRect();
        return { dx: Math.abs((r.left + r.right) / 2 - (vl + vr) / 2), dy: Math.abs((r.top + r.bottom) / 2 - (vt + vb) / 2), w: vr - vl, h: vb - vt };
    }, id);
}

test.describe('Scope — table / mindmap を outliner と同じに', () => {

    test('AC-1 table: scope node is the first row (scope header, no bullet) and its children follow at depth 0; nothing outside the scope', async ({ page }) => {
        await boot(page, doc('table'));
        await scopeViaOutlinerNode(page, 'A1');
        const rows = await tableRows(page);
        expect(rows.map((r) => r.id)).toEqual(['A1', 'A1a', 'A1b']);
        expect(rows[0].header, '先頭行が scope ヘッダーになっていない').toBe(true);
        expect(rows.slice(1).every((r) => !r.header)).toBe(true);
        // バレットなし（outliner mode の scope ヘッダーと同じ CSS）。要素の存在を固定してから非表示を見る
        const bullet = page.locator('.outliner-node.outliner-scope-header[data-id="A1"] > .outliner-bullet');
        await expect(bullet).toHaveCount(1);
        await expect(bullet).toBeHidden();
        await expect(page.locator('.outliner-node.outliner-cell-outliner[data-id="A1a"] > .outliner-bullet')).toBeVisible();
        // scope ノードも子も depth 0（createNodeElement の data-depth）
        expect(rows.map((r) => r.depth)).toEqual([0, 0, 0]);
    });

    test('AC-2 table: a leaf scope shows only the scope row; Clear Scope returns to the whole document', async ({ page }) => {
        await boot(page, doc('table'));
        await scopeViaOutlinerNode(page, 'A2');
        expect((await tableRows(page)).map((r) => r.id)).toEqual(['A2']);
        await page.keyboard.press('ControlOrMeta+Shift+]');
        await page.waitForTimeout(150);
        expect((await tableRows(page)).map((r) => r.id)).toEqual(['A', 'A1', 'A1a', 'A1b', 'A2', 'B', 'B1']);
    });

    for (const layout of ['right', 'radial']) {
        test(`AC-3 mindmap (${layout}): scoping draws only the scope node and its descendants; Clear Scope restores title, other roots and the floating topic`, async ({ page }) => {
            await boot(page, doc('mindmap', { layout }));
            expect(await mmIds(page), '前提: 全体表示に title / Floating Topic がある').toEqual(ALL_MM);
            await mmRightClick(page, 'A1');
            await clickMenu(page, SCOPE_RE);
            expect(await mmIds(page)).toEqual(['A1', 'A1a', 'A1b']);
            await mmRightClick(page, 'A1');
            await clickMenu(page, CLEAR_RE);
            expect(await mmIds(page)).toEqual(ALL_MM);
        });
    }

    test('AC-4 mindmap context menu: Scope on a node, Clear Scope on node and blank while scoped, no Scope on the title', async ({ page }) => {
        await boot(page, doc('mindmap'));
        await mmRightClick(page, 'A');
        let labels = await menuLabels(page);
        expect(labels.some((l) => SCOPE_RE.test(l))).toBe(true);
        expect(labels.some((l) => CLEAR_RE.test(l)), 'scope していないのに Clear Scope が出た').toBe(false);
        await page.keyboard.press('Escape');
        await page.mouse.click(5, 5);
        await mmRightClick(page, '__title__');
        labels = await menuLabels(page);
        expect(labels.some((l) => SCOPE_RE.test(l)), 'title に Scope が出た').toBe(false);
        await page.mouse.click(5, 5);

        await mmRightClick(page, 'A');
        await clickMenu(page, SCOPE_RE);
        expect(await mmIds(page)).toEqual(['A', 'A1', 'A1a', 'A1b', 'A2']);
        await mmRightClick(page, 'A1a');
        labels = await menuLabels(page);
        expect(labels.some((l) => CLEAR_RE.test(l))).toBe(true);
        await page.mouse.click(5, 5);
        await mmRightClick(page, null);
        await clickMenu(page, CLEAR_RE);
        expect(await mmIds(page)).toEqual(ALL_MM);
    });

    test('AC-5 mindmap: Cmd+] scopes to the selected node, Cmd+Shift+] clears', async ({ page }) => {
        await boot(page, doc('mindmap'));
        await mmSelect(page, 'B');
        await page.keyboard.press('ControlOrMeta+]');
        await page.waitForTimeout(250);
        expect(await mmIds(page)).toEqual(['B', 'B1']);
        await mmSelect(page, 'B1');
        await page.keyboard.press('ControlOrMeta+Shift+]');
        await page.waitForTimeout(250);
        expect(await mmIds(page)).toEqual(ALL_MM);
    });

    test('AC-6 mindmap: on the scope node Enter / Shift+Enter / Delete / Backspace change nothing; Tab adds a child drawn inside the scope', async ({ page }) => {
        await boot(page, doc('mindmap'));
        await mmSelect(page, 'A1');
        await page.keyboard.press('ControlOrMeta+]');
        await page.waitForTimeout(250);
        const count = () => page.evaluate(() => Object.keys((window as any).Outliner.getModel().nodes).length);
        const before = await count();
        for (const key of ['Enter', 'Shift+Enter', 'Delete', 'Backspace', 'ControlOrMeta+x']) {
            await mmSelect(page, 'A1');
            await page.keyboard.press(key);
            await page.waitForTimeout(150);
            expect(await count(), `${key} でノード数が変わった`).toBe(before);
            expect(await mmIds(page)).toEqual(['A1', 'A1a', 'A1b']);
        }
        await mmSelect(page, 'A1');
        await page.keyboard.press('Tab');
        await page.waitForTimeout(250);
        expect(await count()).toBe(before + 1);
        const kids = await page.evaluate(() => (window as any).Outliner.getModel().getNode('A1').children.slice());
        expect(kids.length).toBe(3);
        const ids = await mmIds(page);
        for (const k of kids) { expect(ids).toContain(k); }
        expect(ids.length).toBe(4);
    });

    test('AC-7 scope set in outliner mode survives switching to table and mindmap, each showing the scope node on top', async ({ page }) => {
        await boot(page, doc('outliner'));
        await scopeViaOutlinerNode(page, 'A1');
        await setMode(page, 'table');
        const rows = await tableRows(page);
        expect(rows.map((r) => r.id)).toEqual(['A1', 'A1a', 'A1b']);
        expect(rows[0].header).toBe(true);
        await setMode(page, 'mindmap');
        expect(await mmIds(page)).toEqual(['A1', 'A1a', 'A1b']);
    });

    test('AC-8 mindmap: after Scope the scope node sits near the view center (within 10%); after Clear Scope the title does', async ({ page }) => {
        // right layout: 中心化しないと scope ノード（唯一の root）は既定フレームの左端に来る
        await boot(page, doc('mindmap', { layout: 'right' }));
        // 前提: B1 を中央から大きく外した位置へパンしておく（フレーム安定化で「元の位置に残る」だけでは通らないように）
        await page.evaluate(() => {
            const R = (window as any).MindmapRender;
            const vp = R.getViewport();
            R.updateViewport({ translateX: vp.translateX - 280, translateY: vp.translateY - 180, scale: vp.scale });
        });
        await page.waitForTimeout(100);
        const pre = (await mmCenter(page, 'B1'))!;
        expect(pre.dx > pre.w * 0.1 || pre.dy > pre.h * 0.1, '前提: B1 が最初から中央にある').toBe(true);
        await mmRightClick(page, 'B1');
        await clickMenu(page, SCOPE_RE);
        await page.waitForTimeout(150);
        const c = (await mmCenter(page, 'B1'))!;
        expect(c, 'scope ノードが描かれていない').not.toBeNull();
        expect(c.dx, 'scope ノードが横方向に中央から外れている').toBeLessThanOrEqual(c.w * 0.1);
        expect(c.dy, 'scope ノードが縦方向に中央から外れている').toBeLessThanOrEqual(c.h * 0.1);
        await mmRightClick(page, null);
        await clickMenu(page, CLEAR_RE);
        await page.waitForTimeout(150);
        const t = (await mmCenter(page, '__title__'))!;
        expect(t.dx).toBeLessThanOrEqual(t.w * 0.1);
        expect(t.dy).toBeLessThanOrEqual(t.h * 0.1);
    });

    test('AC-10 mindmap: breadcrumb TOP clears the scope; deleting the scope node in outliner mode falls back to the whole document', async ({ page }) => {
        await boot(page, doc('mindmap'));
        await mmSelect(page, 'A1');
        await page.keyboard.press('ControlOrMeta+]');
        await page.waitForTimeout(250);
        expect(await mmIds(page)).toEqual(['A1', 'A1a', 'A1b']);
        await page.locator('.outliner-breadcrumb-top').click();
        await page.waitForTimeout(250);
        expect(await mmIds(page)).toEqual(ALL_MM);

        // scope → outliner mode で scope ノードを消す（model 経由の削除）→ mindmap に戻ると全体表示
        await mmSelect(page, 'B');
        await page.keyboard.press('ControlOrMeta+]');
        await page.waitForTimeout(250);
        await setMode(page, 'outliner');
        await page.evaluate(() => { (window as any).Outliner.getModel().removeNode('B'); });
        await setMode(page, 'mindmap');
        expect(await mmIds(page)).toEqual(['A', 'A1', 'A1a', 'A1b', 'A2', 'F', '__title__'].sort());
        await expect(page.locator('.outliner-breadcrumb')).not.toHaveClass(/is-visible/);
    });

    test('AC-11 a collapsed or task-filter-hidden scope node is still drawn with its children (mindmap) and as the first row (table)', async ({ page }) => {
        // collapsed
        await boot(page, doc('mindmap', { a1: { collapsed: true } }));
        await mmRightClick(page, 'A');
        await clickMenu(page, SCOPE_RE);
        await mmRightClick(page, 'A1');
        await clickMenu(page, SCOPE_RE);
        expect(await mmIds(page)).toEqual(['A1', 'A1a', 'A1b']);
        // task filter で隠れる scope ノード（checked + taskFilter active）
        await boot(page, doc('mindmap', { a1: { checked: true }, taskFilter: 'active' }));
        expect(await mmIds(page), '前提: task filter で A1 の枝が隠れている').not.toContain('A1');
        await page.evaluate(() => { (window as any).Outliner.setViewMode('outliner'); });
        await page.waitForTimeout(200);
        await page.evaluate(() => { (window as any).Outliner.setViewMode('mindmap'); });
        await page.waitForTimeout(200);
        await mmRightClick(page, 'A');
        await clickMenu(page, SCOPE_RE);
        // A の scope では A1 は task filter で隠れたまま（子孫には効く）
        expect(await mmIds(page)).toEqual(['A', 'A2']);
        // A1 自身に scope（outliner mode から）→ mindmap でも table でも A1 が頂点に出る
        await page.evaluate(() => { (window as any).Outliner.getModel().taskFilter = null; });
        await setMode(page, 'outliner');
        await scopeViaOutlinerNode(page, 'A1');
        await page.evaluate(() => { (window as any).Outliner.getModel().taskFilter = 'active'; });
        await setMode(page, 'mindmap');
        expect(await mmIds(page)).toEqual(['A1', 'A1a', 'A1b']);
        await setMode(page, 'table');
        expect((await tableRows(page)).map((r) => r.id)).toEqual(['A1', 'A1a', 'A1b']);

        // table: collapsed の scope ノードでも先頭行 + 子が出る
        await boot(page, doc('table', { a1: { collapsed: true } }));
        expect((await tableRows(page)).map((r) => r.id), '前提: 折りたたみで A1 の子が出ていない').toEqual(['A', 'A1', 'A2', 'B', 'B1']);
        await scopeViaOutlinerNode(page, 'A1');
        expect((await tableRows(page)).map((r) => r.id)).toEqual(['A1', 'A1a', 'A1b']);
    });
});
