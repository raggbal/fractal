/**
 * FR-TS-01/02/03: taskScope（タスクモードの checkbox 付与範囲）
 *
 * - ON 時に scope 選択ポップアップ（「トップレベルのみ」/「全てのノード」）を表示。
 *   前回 scope のボタンに autofocus（Enter 一発確定）。Esc / 外側クリックでキャンセル。
 * - scope は model + .out に taskScope: 'top' | 'all' として記録（'top' は byte 互換で出力しない）。
 * - OFF は scope 準拠で解除（top = root のみ・手動子 checkbox 温存 / all = 全解除）。
 * - ON 中に作る新規 node は scope に従って checkbox が付く。
 * - 旧 .out（taskScope 欠落・不正値）は 'top' 扱い（後方互換）。
 *
 * 対象TC: TC-TS-01〜07（design/system.md §4）。
 * model 層（read/serialize・新規 node）は OutlinerModel を直接 require して unit 検証。
 * ポップアップ / OFF / autofocus は standalone E2E で実 UI を駆動。
 */

import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OutlinerModel = require('../../src/webview/outliner-model.js');

const HTML = '/standalone-outliner.html';

// ---- E2E helpers ----

async function loadModel(page: any, data: any) {
    await page.evaluate((d: any) => {
        (window as any).__testApi.initOutliner(JSON.parse(JSON.stringify(d)));
    }, data);
    // init() は setTimeout(100) で focusFirstVisibleNode() を呼び最初の node に focus する。
    // popup の autofocus がそれに奪われないよう、init の focus が済むまで待ってから操作する
    // （production ではユーザーは load から十分後に toggle を押すので同じ状況）。
    await page.waitForTimeout(160);
}

function baseTree() {
    // r1 -> c1 (child) / r2 (root). 初期は checkbox 無し。
    return {
        version: 1,
        rootIds: ['r1', 'r2'],
        nodes: {
            r1: { id: 'r1', parentId: null, children: ['c1'], text: 'root one', tags: [], checked: null },
            c1: { id: 'c1', parentId: 'r1', children: [], text: 'child one', tags: [], checked: null },
            r2: { id: 'r2', parentId: null, children: [], text: 'root two', tags: [], checked: null },
        },
    };
}

async function popupVisible(page: any): Promise<boolean> {
    return await page.evaluate(() => !!document.querySelector('.outliner-task-scope-dialog'));
}

async function modelSnapshot(page: any) {
    return await page.evaluate(() => {
        const m = (window as any).Outliner.getModel();
        const checked: Record<string, any> = {};
        for (const id in m.nodes) { checked[id] = m.nodes[id].checked; }
        return { taskMode: m.taskMode, taskScope: m.taskScope, taskFilter: m.taskFilter, checked };
    });
}

test.describe('taskScope model 層 (unit)', () => {

    test('TC-TS-03 「トップのみ」= serialize に taskScope 無し (旧 .out byte 互換・counterfactual)', () => {
        const m = new OutlinerModel(baseTree());
        m.taskScope = 'top';
        m.taskMode = true;
        const out = m.serialize();
        // 'top' は既定なので出力されない（counterfactual: 出力すると旧 .out と byte 不一致 = RED）
        expect('taskScope' in out).toBe(false);
        expect(out.taskMode).toBe(true);
    });

    test('TC-TS-03b 「全て」= serialize に taskScope:"all"', () => {
        const m = new OutlinerModel(baseTree());
        m.taskScope = 'all';
        m.taskMode = true;
        const out = m.serialize();
        expect(out.taskScope).toBe('all');
    });

    test('TC-TS-03c taskMode OFF でも taskScope:"all" は次回デフォルトのため残す (FR-TS-02)', () => {
        const m = new OutlinerModel(baseTree());
        m.taskScope = 'all';
        m.taskMode = false;
        const out = m.serialize();
        expect('taskMode' in out).toBe(false);
        expect(out.taskScope).toBe('all');
    });

    test('TC-TS-06 旧 .out (taskScope 欠落) → "top" 扱い', () => {
        const m = new OutlinerModel(baseTree()); // taskScope キー無し
        expect(m.taskScope).toBe('top');
    });

    test('TC-TS-06b 不正値 taskScope → "top" 扱い (閉じた判定)', () => {
        const data = Object.assign(baseTree(), { taskScope: 'bogus' });
        const m = new OutlinerModel(data);
        expect(m.taskScope).toBe('top');
    });

    test('TC-TS-05 ON("all") 中の新規子 node は checked=false / ON("top") 中の子は null', () => {
        // all: 子階層でも checkbox が付く
        const mAll = new OutlinerModel(baseTree());
        mAll.taskMode = true;
        mAll.taskScope = 'all';
        const childAll = mAll.addNode('r1', null, 'new child');
        expect(childAll.checked).toBe(false);
        const rootAll = mAll.addNode(null, null, 'new root');
        expect(rootAll.checked).toBe(false);

        // top: 子階層は null・root は false
        const mTop = new OutlinerModel(baseTree());
        mTop.taskMode = true;
        mTop.taskScope = 'top';
        const childTop = mTop.addNode('r1', null, 'new child');
        expect(childTop.checked).toBe(null);
        const rootTop = mTop.addNode(null, null, 'new root');
        expect(rootTop.checked).toBe(false);

        // taskMode OFF なら scope に関わらず null
        const mOff = new OutlinerModel(baseTree());
        mOff.taskMode = false;
        mOff.taskScope = 'all';
        expect(mOff.addNode('r1', null, 'x').checked).toBe(null);
    });
});

test.describe('taskScope ポップアップ / OFF (E2E)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(HTML);
        await page.waitForSelector('.outliner-tree');
    });

    test('TC-TS-01 ON → ポップアップ表示・Esc → taskMode false・model 不変 (undo 汚染なし)', async ({ page }) => {
        await loadModel(page, baseTree());
        const before = await modelSnapshot(page);
        const undoBefore = await page.evaluate(() => {
            const b = document.querySelector('.outliner-undo-btn') as HTMLButtonElement;
            return b ? b.disabled : null;
        });

        // taskMode ボタンを実クリック → ポップアップが出る（この時点では taskMode 未変更）
        await page.locator('.outliner-task-mode-toggle-btn').click();
        await page.waitForTimeout(80);
        expect(await popupVisible(page)).toBe(true);
        const during = await modelSnapshot(page);
        expect(during.taskMode).toBe(false); // 確定するまで ON にならない

        // Esc でキャンセル
        await page.keyboard.press('Escape');
        await page.waitForTimeout(80);
        expect(await popupVisible(page)).toBe(false);

        const after = await modelSnapshot(page);
        expect(after.taskMode).toBe(false);
        expect(after.checked).toEqual(before.checked); // model 不変
        // undo が汚染されていない（キャンセルで saveSnapshot を呼ばない）
        const undoAfter = await page.evaluate(() => {
            const b = document.querySelector('.outliner-undo-btn') as HTMLButtonElement;
            return b ? b.disabled : null;
        });
        expect(undoAfter).toBe(undoBefore);
    });

    test('TC-TS-02 「全て」確定 → 全階層 checked=false・taskScope:"all"・filter=active', async ({ page }) => {
        await loadModel(page, baseTree());
        await page.locator('.outliner-task-mode-toggle-btn').click();
        await page.waitForTimeout(80);
        // 「全てのノード」ボタンを実クリックで確定
        await page.locator('.outliner-task-scope-dialog .outliner-task-scope-all').click();
        await page.waitForTimeout(120);

        const m = await modelSnapshot(page);
        expect(m.taskMode).toBe(true);
        expect(m.taskScope).toBe('all');
        expect(m.taskFilter).toBe('active');
        // 全階層 (root + 子) に checkbox
        expect(m.checked.r1).toBe(false);
        expect(m.checked.c1).toBe(false);
        expect(m.checked.r2).toBe(false);
        // serialize にも taskScope:'all'
        const ser = await page.evaluate(() => (window as any).Outliner.getModel().serialize());
        expect(ser.taskScope).toBe('all');
    });

    test('TC-TS-02b 「トップのみ」確定 → root のみ checked=false・子は null', async ({ page }) => {
        await loadModel(page, baseTree());
        await page.locator('.outliner-task-mode-toggle-btn').click();
        await page.waitForTimeout(80);
        await page.locator('.outliner-task-scope-dialog .outliner-task-scope-top').click();
        await page.waitForTimeout(120);

        const m = await modelSnapshot(page);
        expect(m.taskMode).toBe(true);
        expect(m.taskScope).toBe('top');
        expect(m.checked.r1).toBe(false);
        expect(m.checked.c1).toBe(null); // 子は付かない
        expect(m.checked.r2).toBe(false);
        // 'top' は serialize されない
        const ser = await page.evaluate(() => (window as any).Outliner.getModel().serialize());
        expect('taskScope' in ser).toBe(false);
    });

    test('TC-TS-04 scope="all" で OFF → 全解除', async ({ page }) => {
        // 'all' で ON 済みの状態を読み込む
        const data: any = Object.assign(baseTree(), { taskMode: true, taskScope: 'all' });
        data.nodes.r1.checked = false;
        data.nodes.c1.checked = false;
        data.nodes.r2.checked = false;
        await loadModel(page, data);
        // OFF（ポップアップは出ない）
        await page.locator('.outliner-task-mode-toggle-btn').click();
        await page.waitForTimeout(120);
        expect(await popupVisible(page)).toBe(false);
        const m = await modelSnapshot(page);
        expect(m.taskMode).toBe(false);
        expect(m.checked.r1).toBe(null);
        expect(m.checked.c1).toBe(null);
        expect(m.checked.r2).toBe(null);
    });

    test('TC-TS-04b scope="top" + 手動子 checkbox で OFF → 子 checkbox 温存', async ({ page }) => {
        // 'top' で ON 済み + 子 c1 に手動 checkbox を付けた状態
        const data: any = Object.assign(baseTree(), { taskMode: true, taskScope: 'top' });
        data.nodes.r1.checked = false;
        data.nodes.c1.checked = false; // 手動で付けた子 checkbox
        data.nodes.r2.checked = false;
        await loadModel(page, data);
        await page.locator('.outliner-task-mode-toggle-btn').click();
        await page.waitForTimeout(120);
        const m = await modelSnapshot(page);
        expect(m.taskMode).toBe(false);
        expect(m.checked.r1).toBe(null); // root は解除
        expect(m.checked.r2).toBe(null);
        expect(m.checked.c1).toBe(false); // 手動子 checkbox は温存
    });

    test('TC-TS-07 再 ON 時ポップアップのデフォルトフォーカス = 前回 scope のボタン', async ({ page }) => {
        // 前回 'all' を選んだ状態（OFF・taskScope='all' が残っている）を読み込む
        const data: any = Object.assign(baseTree(), { taskScope: 'all' });
        await loadModel(page, data);
        await page.locator('.outliner-task-mode-toggle-btn').click();
        await page.waitForTimeout(80);
        expect(await popupVisible(page)).toBe(true);
        // autofocus は 'all' ボタン
        const focusedScope = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement;
            return el ? el.getAttribute('data-scope') : null;
        });
        expect(focusedScope).toBe('all');
        // Enter 一発で 'all' 確定
        await page.keyboard.press('Enter');
        await page.waitForTimeout(120);
        const m = await modelSnapshot(page);
        expect(m.taskMode).toBe(true);
        expect(m.taskScope).toBe('all');

        // OFF に戻して 'top' で再確定 → 次回デフォルトが 'top' に更新される
        await page.locator('.outliner-task-mode-toggle-btn').click(); // OFF
        await page.waitForTimeout(120);
        await page.locator('.outliner-task-mode-toggle-btn').click(); // 再 ON
        await page.waitForTimeout(80);
        const focused2 = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement;
            return el ? el.getAttribute('data-scope') : null;
        });
        expect(focused2).toBe('all'); // taskScope はまだ 'all'（OFF でも残る）
        await page.locator('.outliner-task-scope-dialog .outliner-task-scope-top').click();
        await page.waitForTimeout(120);
        // OFF → 再 ON でデフォルトが 'top' に
        await page.locator('.outliner-task-mode-toggle-btn').click(); // OFF
        await page.waitForTimeout(120);
        await page.locator('.outliner-task-mode-toggle-btn').click(); // 再 ON
        await page.waitForTimeout(80);
        const focused3 = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement;
            return el ? el.getAttribute('data-scope') : null;
        });
        expect(focused3).toBe('top');
    });

    test('TC-TS-01b 外側クリックでキャンセル → taskMode false', async ({ page }) => {
        await loadModel(page, baseTree());
        await page.locator('.outliner-task-mode-toggle-btn').click();
        await page.waitForTimeout(80);
        expect(await popupVisible(page)).toBe(true);
        // dialog 外（tree 領域）をクリック
        await page.mouse.click(5, 400);
        await page.waitForTimeout(80);
        expect(await popupVisible(page)).toBe(false);
        const m = await modelSnapshot(page);
        expect(m.taskMode).toBe(false);
    });
});
