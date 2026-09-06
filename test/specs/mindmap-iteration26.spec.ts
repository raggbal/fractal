/**
 * Mindmap iteration 26 — Delete 後の active 後継移動 (Wave 31 / TASK-69)
 *   TC-M17: 確定ノードで Delete するとノード+子孫は消えるが active が残らず連続操作できなかった。
 *           削除後 active を 上の兄 → 下の弟 → 親 の優先順で残存ノードへ移す。
 *
 * 根本原因 (session-log「iteration 26」): Delete 分岐が removeNode→rerender するだけで、
 *   削除後の active(focusedNodeId) を残存ノードへ移していなかった。→ deleteSuccessorId(model,nodeId)
 *   で削除前に後継を算出 (兄→弟→親) し、削除後 focusNode(successorId,false)。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() 直呼び禁止。実クリック→実キー。
 */

import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 900, height: 700 } });

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

function node(id: string, text: string, children: string[] = [], parentId: string | null = null) {
    return { id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] };
}

// P(子 c1,c2,c3 ; c2 は子 c2a) + Q。init し直しで独立させるため毎回同じ構造を返す。
function model() {
    return {
        version: 1, viewMode: 'mindmap', rootIds: ['P', 'Q'],
        nodes: {
            P: node('P', 'P', ['c1', 'c2', 'c3']),
            Q: node('Q', 'Q'),
            c1: node('c1', 'C1', [], 'P'),
            c2: node('c2', 'C2', ['c2a'], 'P'),
            c3: node('c3', 'C3', [], 'P'),
            c2a: node('c2a', 'C2A', [], 'c2'),
        },
    };
}

async function toMindmap(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(JSON.parse(JSON.stringify(d))); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(250);
}

function activeId(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const fo = document.querySelector('.mindmap-node-box.is-focused');
        const n = fo && fo.closest('.mindmap-node');
        return n ? n.getAttribute('data-node-id') : null;
    });
}

function exists(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((id) => !!document.querySelector('.mindmap-node[data-node-id="' + id + '"]'), id);
}

/**
 * ★2026-09-05 / 裁定 R34 (FR-MMT-01): title が空でも中心ノード (__title__) が出るようになり、
 *   mindmap を開いた直後の open-centering が全マップで走る。中心から遠いノードは可視領域の外に
 *   出るため、Playwright の click が親コンテナに intercept されて操作できない (mindmap の
 *   transform 内なので Playwright の自動 scrollIntoView も効かない)。click 前に対象ノードを
 *   可視領域中央へ pan してから操作する (検証対象は click 後の挙動なので前提整えに影響はない)。
 */
async function panNodeIntoView(page: import('@playwright/test').Page, id: string) {
    await page.evaluate((nid) => {
        const MR = (window as any).MindmapRender;
        const fo = document.querySelector('.mindmap-node[data-node-id="' + nid + '"]') as any;
        const tree = document.querySelector('.outliner-tree') as HTMLElement;
        if (!fo || !tree) { return; }
        const nr = fo.getBoundingClientRect();
        const tr = tree.getBoundingClientRect();
        // ★ getViewport() の**同一オブジェクト**を書き換えて渡す (新リテラルだと
        //   mindmap-interactions が掴んだ参照と別物になり pan/zoom 保存復元がずれる)。
        const v = MR.getViewport();
        v.translateX += (tr.left + tr.right) / 2 - (nr.left + nr.right) / 2;
        v.translateY += (tr.top + tr.bottom) / 2 - (nr.top + nr.bottom) / 2;
        MR.updateViewport(v);
    }, id);
    await page.waitForTimeout(80);
}

async function clickDelete(page: import('@playwright/test').Page, id: string) {
    await panNodeIntoView(page, id);
    await page.locator('.mindmap-node[data-node-id="' + id + '"] .mindmap-node-box').click();
    await page.waitForTimeout(80);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(150);
}

test('TC-M17 (a) 上の兄がいれば兄が active + 子孫も削除', async ({ page }) => {
    await setup(page);
    await toMindmap(page, model());
    await clickDelete(page, 'c2');
    expect(await activeId(page)).toBe('c1'); // 上の兄
    expect(await exists(page, 'c2')).toBe(false);
    expect(await exists(page, 'c2a')).toBe(false); // 子孫も削除
});

test('TC-M17 (b) 上の兄がなく下の弟がいれば弟が active', async ({ page }) => {
    await setup(page);
    await toMindmap(page, model());
    await clickDelete(page, 'c1');
    expect(await activeId(page)).toBe('c2'); // 下の弟
});

test('TC-M17 (c) 兄弟がいなければ親が active', async ({ page }) => {
    await setup(page);
    await toMindmap(page, model());
    await clickDelete(page, 'c2a');
    expect(await activeId(page)).toBe('c2'); // 親
});

test('TC-M17 (d) 連続 Delete が可能 (active が残るので2回目も効く)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, model());
    await clickDelete(page, 'c2'); // → active c1
    expect(await activeId(page)).toBe('c1');
    // active があるので click せずにそのまま Delete → c1 も削除、active が別ノードへ
    await page.keyboard.press('Delete');
    await page.waitForTimeout(150);
    expect(await exists(page, 'c1')).toBe(false); // 連続操作で c1 も消えた
    const a2 = await activeId(page);
    expect(a2).not.toBeNull();       // active が残っている (連続操作可能)
    expect(a2).not.toBe('c1');
});

test('TC-M17 load-bearing: 後継 focus が無いと Delete 後に active(is-focused) が消える', async ({ page }) => {
    await setup(page);
    await toMindmap(page, model());
    await clickDelete(page, 'c2');
    // 修正後は必ず active が残る (c1)。null なら「後継 focus を移していない」= 退行。
    expect(await activeId(page)).not.toBeNull();
});
