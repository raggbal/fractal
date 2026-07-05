/**
 * Mindmap Mode — iteration 4 手動テスト気付き 5 件 (Wave 8, 2026-07-02)
 * TC-160c改, 162b改, 231b (#2#5 キー到達), 161b (#4 兄挿入), 147b/150c (#3 間隔), 133c (#1 title)
 *
 * 重要: 前回の偽陽性を避けるため、必ず実クリック→実キーのフローで検証する。
 *   box.click() で実選択 → page.keyboard.press/type で実キー押下。el.focus() 直呼び禁止。
 */

import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}
async function init(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(120);
}
function node(id: string, text: string, children: string[] = [], parentId: string | null = null, extra: any = {}) {
    return { id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [], ...extra };
}
// 実クリックで選択（非編集）
async function selectBox(page: import('@playwright/test').Page, id: string) {
    await page.locator(`.mindmap-node[data-node-id="${id}"] .mindmap-node-box`).click();
    await page.waitForTimeout(50);
}
async function editable(page: import('@playwright/test').Page, id: string) {
    return page.getAttribute(`.mindmap-node-text[data-node-id="${id}"]`, 'contenteditable');
}
async function modelNodes(page: import('@playwright/test').Page) {
    return page.evaluate(() => JSON.parse(JSON.stringify((window as any).Outliner.getModel().nodes)));
}
async function modelText(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => (window as any).Outliner.getModel().nodes[nid].text, id);
}

test.describe('iteration4 #5 Space で編集開始 (実フロー)', () => {
    test('TC-160c改 click→Space で contenteditable=true', async ({ page }) => {
        await setup(page);
        await init(page, { version: 1, viewMode: 'mindmap', rootIds: ['n1'], nodes: { n1: node('n1', 'Root') } });
        await selectBox(page, 'n1');
        expect(await editable(page, 'n1')).not.toBe('true'); // click 直後は非編集
        await page.keyboard.press('Space');
        await page.waitForTimeout(60);
        expect(await editable(page, 'n1')).toBe('true'); // Space で編集開始
    });

    test('TC-231b Space の編集開始が outliner document keydown に食われない', async ({ page }) => {
        await setup(page);
        await init(page, { version: 1, viewMode: 'mindmap', rootIds: ['n1'], nodes: { n1: node('n1', 'X') } });
        await selectBox(page, 'n1');
        await page.keyboard.press('Space');
        await page.waitForTimeout(60);
        const active = await page.evaluate(() => {
            const ae = document.activeElement as HTMLElement;
            return { cls: ae?.className, editable: ae?.getAttribute?.('contenteditable') };
        });
        expect(active.cls).toContain('mindmap-node-text');
        expect(active.editable).toBe('true');
    });
});

test.describe('iteration4 #2 編集中 Shift+Enter で改行 (実フロー)', () => {
    test('TC-162b改 click→Space→type→Shift+Enter→type→Enter で model.text に \\n', async ({ page }) => {
        await setup(page);
        await init(page, { version: 1, viewMode: 'mindmap', rootIds: ['n1'], nodes: { n1: node('n1', '') } });
        await selectBox(page, 'n1');
        await page.keyboard.press('Space');
        await page.waitForTimeout(50);
        await page.keyboard.type('L1');
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('L2');
        // commit 前に editable DOM が改行を持つ
        const domText = await page.evaluate(() => document.querySelector('.mindmap-node-text[data-node-id="n1"]')?.textContent);
        expect(domText).toContain('L1');
        expect(domText).toContain('L2');
        await page.keyboard.press('Enter'); // commit
        await page.waitForTimeout(80);
        const t = (await modelText(page, 'n1')).replace(/\r/g, '');
        expect(t).toBe('L1\nL2');
        // モード往復で保持
        await page.evaluate(() => { (window as any).Outliner.setViewMode('outliner'); (window as any).Outliner.setViewMode('mindmap'); });
        await page.waitForTimeout(80);
        expect((await modelText(page, 'n1')).replace(/\r/g, '')).toBe('L1\nL2');
    });
});

test.describe('iteration4 #4 カーソルOUT Shift+Enter で兄=直前挿入 (実フロー)', () => {
    function threeSibs() {
        return {
            version: 1, viewMode: 'mindmap', rootIds: ['p'],
            nodes: {
                p: node('p', 'P', ['a', 'b', 'c']),
                a: node('a', 'A', [], 'p'), b: node('b', 'B', [], 'p'), c: node('c', 'C', [], 'p')
            }
        };
    }
    test('TC-161b 中間ノード: 新ノードが直前(index 1)に入る、末尾でない', async ({ page }) => {
        await setup(page); await init(page, threeSibs());
        await selectBox(page, 'b');
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(80);
        const nodes = await modelNodes(page);
        const kids = nodes.p.children;
        // b の直前に新ノード → ['a', new, 'b', 'c']
        expect(kids.length).toBe(4);
        expect(kids.indexOf('b')).toBe(2);
        expect(kids[1]).not.toBe('b');
        expect(kids[1]).not.toBe('a'); // new node between a and b
        expect(kids[kids.length - 1]).toBe('c'); // 末尾は c のまま (末尾挿入バグでない)
    });
    test('TC-161b 先頭ノード: 新ノードが先頭(index 0)に入る', async ({ page }) => {
        await setup(page); await init(page, threeSibs());
        await selectBox(page, 'a');
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(80);
        const nodes = await modelNodes(page);
        const kids = nodes.p.children;
        expect(kids.length).toBe(4);
        expect(kids[0]).not.toBe('a'); // new node is now first
        expect(kids[1]).toBe('a');     // a pushed to index 1
    });
});

test.describe('iteration4 #3 複数行ノードの枠と間隔 (実フロー)', () => {
    test('TC-150c 複数行ノードが枠に収まり上下ノードと重ならない', async ({ page }) => {
        await setup(page);
        await init(page, {
            version: 1, viewMode: 'mindmap', rootIds: ['r'],
            nodes: {
                r: node('r', 'Root', ['c1', 'multi', 'c3']),
                c1: node('c1', 'Child1', [], 'r'),
                multi: node('multi', 'L1\nL2\nL3\nL4', [], 'r'),
                c3: node('c3', 'Child3', [], 'r')
            }
        });
        await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
        await page.waitForTimeout(200); // 2 パス
        const res = await page.evaluate(() => {
            function box(id: string) { return document.querySelector(`.mindmap-node[data-node-id="${id}"] .mindmap-node-box`) as HTMLElement; }
            const mb = box('multi');
            // 枠が実高さにフィット (縦はみ出しなし)
            const fit = mb.scrollHeight <= mb.clientHeight + 2;
            // multi と同じ側の隣接ノードと矩形が交差しないか
            function rect(id: string) { return (document.querySelector(`.mindmap-node[data-node-id="${id}"]`) as SVGGraphicsElement).getBoundingClientRect(); }
            const ids = ['c1', 'multi', 'c3'];
            let overlap = false;
            for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
                const A = rect(ids[i]), B = rect(ids[j]);
                const inter = !(A.right < B.left || B.right < A.left || A.bottom < B.top || B.bottom < A.top);
                if (inter) overlap = true;
            }
            return { fit, overlap };
        });
        expect(res.fit).toBe(true);       // 枠が複数行にフィット
        expect(res.overlap).toBe(false);  // 重ならない
    });
});

test.describe('iteration4 #1 title 中心ノード (実フロー)', () => {
    test('TC-133c title 設定時に中心ノードが子と重ならず配置', async ({ page }) => {
        await setup(page);
        await init(page, {
            version: 1, viewMode: 'mindmap', title: 'My Map', rootIds: ['n1', 'n2', 'n3'],
            nodes: { n1: node('n1', 'R1'), n2: node('n2', 'R2'), n3: node('n3', 'R3') }
        });
        await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
        await page.waitForTimeout(200);
        await expect(page.locator('.mindmap-node[data-mm-title="1"]')).toHaveCount(1);
        const overlap = await page.evaluate(() => {
            function rect(sel: string) { return (document.querySelector(sel) as SVGGraphicsElement).getBoundingClientRect(); }
            const title = rect('.mindmap-node[data-mm-title="1"]');
            let bad = false;
            ['n1', 'n2', 'n3'].forEach((id) => {
                const r = rect(`.mindmap-node[data-node-id="${id}"]`);
                const inter = !(title.right < r.left || r.right < title.left || title.bottom < r.top || r.bottom < title.top);
                if (inter) bad = true;
            });
            return bad;
        });
        expect(overlap).toBe(false);
    });
});
