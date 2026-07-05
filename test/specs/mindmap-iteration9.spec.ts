/**
 * Mindmap iteration 9 — 編集中のノード横幅リアルタイム拡張 (Wave 13 / FR-021-A7)
 * TC-W1 (改行なし長文で横幅拡張 / load-bearing), TC-W2 (上限280頭打ち→折り返し),
 * TC-W3 (改行ありは横伸びしない=A6維持), TC-W4 (横方向リアルタイム追従)
 *
 * 方針: 現状は編集中 foreignObject 幅固定で pre-wrap 折り返し（縦伸び）。commit 時に
 * estimateMeasure(上限280)で横に広がる。A7 はその横伸びを編集中にリアルタイム化する。
 * 編集開始時 \n なしなら is-editing-nowrap を付与し nowrap → input で foreignObject width を
 * min(280, 必要幅)に更新。上限到達 or \n 入力で pre-wrap に戻す。子孫は translateX 追従。
 *
 * テスト方針: 必ず page.locator(...).click()（実選択）→ page.keyboard.press()/type()（実キー）。
 * el.focus() 直呼び禁止。幅は foreignObject(.mindmap-node[data-node-id]) の rect.width で測る。
 */

import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}
function node(id: string, text: string, children: string[] = [], parentId: string | null = null) {
    return { id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] };
}
async function toMindmap(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(150);
}
function foRect(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as SVGGraphicsElement | null;
        if (!fo) { return null; }
        const r = fo.getBoundingClientRect();
        return { width: Math.round(r.width), left: Math.round(r.left) };
    }, id);
}
function hasNowrap(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const t = document.querySelector(`.mindmap-node-text[data-node-id="${nid}"]`);
        return !!(t && t.classList.contains('is-editing-nowrap'));
    }, id);
}

test('TC-W1 (#A7 load-bearing) 改行なし長文で編集中に横幅がリアルタイムで広がる', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: { r: node('r', 'Root', ['n1']), n1: node('n1', 'x', [], 'r') }
    });
    await page.locator('.mindmap-node[data-node-id="n1"] .mindmap-node-box').click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(60);
    const before = await foRect(page, 'n1');
    // 改行なし・280px 上限には未達の長さ
    await page.keyboard.type('これは折り返さずに横に伸びる一文です');
    await page.waitForTimeout(120);
    const after = await foRect(page, 'n1');
    const nowrap = await hasNowrap(page, 'n1');
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    // 編集中に横幅が広がっている
    expect(after!.width).toBeGreaterThan(before!.width);
    // 横伸びモードに入っている（改行なし）
    expect(nowrap).toBe(true);
    // 上限内（280 * scale 相当 + マージン。scale=1 想定だが余裕を持たせる）
    expect(after!.width).toBeLessThanOrEqual(300);
});

test('TC-W2 (#A7) 上限 280px で頭打ち → 折り返して縦伸び', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: { r: node('r', 'Root', ['n1']), n1: node('n1', 'x', [], 'r') }
    });
    await page.locator('.mindmap-node[data-node-id="n1"] .mindmap-node-box').click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(60);
    // 280px を確実に超える非常に長い改行なし文字列
    await page.keyboard.type('あ'.repeat(120));
    await page.waitForTimeout(150);
    const after = await foRect(page, 'n1');
    const nowrap = await hasNowrap(page, 'n1');
    // 幅が 280 相当で頭打ち（それ以上増えない）
    expect(after!.width).toBeLessThanOrEqual(290);
    expect(after!.width).toBeGreaterThanOrEqual(250);
    // 上限到達で横伸びモードを抜け pre-wrap へ（折り返して縦伸び）
    expect(nowrap).toBe(false);
});

test('TC-W3 (#A7 A6維持) 改行ありは横伸びしない', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: { r: node('r', 'Root', ['n1']), n1: node('n1', '', [], 'r') }
    });
    await page.locator('.mindmap-node[data-node-id="n1"] .mindmap-node-box').click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(60);
    await page.keyboard.type('abc');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('def');
    await page.waitForTimeout(120);
    // 改行があるので横伸びモードに入っていない
    const nowrap = await hasNowrap(page, 'n1');
    expect(nowrap).toBe(false);
    // commit 後に改行が保存されている（FR-021-A6/C13 維持）
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const text = (await page.evaluate(() => (window as any).Outliner.getModel().nodes.n1.text)).replace(/\r/g, '');
    expect(text).toBe('abc\ndef');
});

test('TC-W4 (#A7 横追従) 編集中の横幅拡張で同 side 子孫が translateX で押し出される', async ({ page }) => {
    await setup(page);
    // layout='right' の鎖 r → parent → child（child が parent より深い x を持つ）
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        mindmap: { layout: 'right' },
        nodes: {
            r: node('r', 'Root', ['parent']),
            parent: node('parent', 'P', ['child'], 'r'),
            child: node('child', 'Child', [], 'parent')
        }
    });
    const childBefore = await foRect(page, 'child');
    await page.locator('.mindmap-node[data-node-id="parent"] .mindmap-node-box').click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(60);
    // parent に改行なし長文（280 未満で幅が広がる）
    await page.keyboard.type('横に伸びる親ノードのテキスト');
    await page.waitForTimeout(120);
    const childAfter = await foRect(page, 'child');
    const childTransform = await page.evaluate(() => {
        const fo = document.querySelector('.mindmap-node[data-node-id="child"]') as HTMLElement | null;
        return fo ? (fo.style.transform || '') : '';
    });
    const parentEditable = await page.evaluate(() =>
        document.querySelector('.mindmap-node-text[data-node-id="parent"]')?.getAttribute('contenteditable'));
    // 編集ノード parent は編集中
    expect(parentEditable).toBe('true');
    expect(childBefore).not.toBeNull();
    expect(childAfter).not.toBeNull();
    // child が右へ押し出されている（left 増加 or transform に translateX）
    const movedByLeft = childAfter!.left > childBefore!.left + 2;
    const movedByTransform = /translate(X)?\(\s*[1-9]/.test(childTransform) || /translate\(\s*[1-9]/.test(childTransform);
    expect(movedByLeft || movedByTransform).toBe(true);
});
