/**
 * Mindmap iteration 8 — #C commit 後に周囲ノードが元位置に戻り拡張ノードと重なる (Wave 12 / TASK-35)
 * TC-C1 (load-bearing / 実機再現), TC-C2 (単一行初期状態の回帰ガード)
 *
 * 根本原因: 初期 render で多行/添付ノードがあると needsRealMeasure()=true → 2 パス目 render が
 * 再帰実行され、その中で MindmapInteractions.attach が走る。結果 runtime.rerender クロージャが
 * capture する ctx は _secondPass=true + 編集前に凍結された _realDims。commit 時の rerender が
 * この stale ctx を使うため 2 パス再計測がスキップされ、伸びたノードで下方ノードが重なる。
 * 修正: rerender クロージャを _secondPass/_realDims を除外した fresh ctx で render を呼ぶ形に変更。
 *
 * テスト方針: 必ず page.locator(...).click()（実選択）→ page.keyboard.press()/type()（実キー）。
 * el.focus() 直呼び禁止（プログラム的フォーカスは実機のイベント到達を保証しない）。
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

/**
 * mid ノードを実クリックで選択 → Space で編集開始 → 10 行に拡張 → Enter で commit。
 */
async function expandMidToTenLinesAndCommit(page: import('@playwright/test').Page) {
    await page.locator('.mindmap-node[data-node-id="mid"] .mindmap-node-box').click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(60);
    for (let i = 1; i <= 10; i++) {
        await page.keyboard.type('line' + i);
        if (i < 10) { await page.keyboard.press('Shift+Enter'); }
    }
    // 編集中の位置調整反映を待つ
    await page.waitForTimeout(120);
    // Enter で commit（カーソル OUT）
    await page.keyboard.press('Enter');
    // commit 後の再レイアウト反映を待つ
    await page.waitForTimeout(200);
}

/** commit 後の mid box / bottom box の重なり判定（同側のときのみ有効）。 */
async function measureMidBottom(page: import('@playwright/test').Page) {
    return await page.evaluate(() => {
        function box(id: string) {
            return (document.querySelector(`.mindmap-node[data-node-id="${id}"] .mindmap-node-box`) as HTMLElement).getBoundingClientRect();
        }
        const mid = box('mid'), bottom = box('bottom');
        // 同側判定: 左端が近い（同じ x 帯に縦積み）
        const sameSide = Math.abs(mid.left - bottom.left) < 80;
        // 縦の隙間（正なら重ならない、負なら overlap）
        const gap = bottom.top - mid.bottom;
        // iteration 27 (TASK-71): 編集中信号は is-editing クラス (committed active も
        // contenteditable=true になったため)。'true'/'false' 互換で返す。
        const midEl = document.querySelector('.mindmap-node-text[data-node-id="mid"]');
        const midEditable = midEl && midEl.classList.contains('is-editing') ? 'true' : 'false';
        return { sameSide, gap: Math.round(gap), midEditable };
    });
}

test('TC-C1 (#C load-bearing) 多行初期ノードで 2 パス強制 → mid 拡張 → Enter commit 後に下ノードと重ならない', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: {
            r: node('r', 'Root', ['top', 'mid', 'bottom']),
            // top を初めから複数行にして初期 render で needsRealMeasure()=true を強制（実機と同条件）
            top: node('top', 'Pre\nExisting\nMultiline', [], 'r'),
            mid: node('mid', 'Mid', [], 'r'),
            bottom: node('bottom', 'Bottom', [], 'r')
        }
    });
    await expandMidToTenLinesAndCommit(page);
    const res = await measureMidBottom(page);
    // commit 後は編集終了（非編集）
    expect(res.midEditable).not.toBe('true');
    // 同側のとき: bottom が編集前位置に戻らず、伸びた mid の下に押し下げられている
    // 修正前は bottom が編集前位置に戻り gap≈-148（overlap=true）。修正後は gap >= -2。
    if (res.sameSide) {
        expect(res.gap).toBeGreaterThanOrEqual(-2);
    }
});

test('TC-C2 (#C 回帰ガード) 単一行初期状態でも commit 後に重ならない', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: {
            r: node('r', 'Root', ['top', 'mid', 'bottom']),
            // 全て単一行（2 パス非発火の従来ケース = 既存 TC-150e 相当）
            top: node('top', 'Top', [], 'r'),
            mid: node('mid', 'Mid', [], 'r'),
            bottom: node('bottom', 'Bottom', [], 'r')
        }
    });
    await expandMidToTenLinesAndCommit(page);
    const res = await measureMidBottom(page);
    expect(res.midEditable).not.toBe('true');
    if (res.sameSide) {
        expect(res.gap).toBeGreaterThanOrEqual(-2);
    }
});
