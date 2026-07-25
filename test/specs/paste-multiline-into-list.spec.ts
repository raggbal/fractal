/**
 * TC-PML-01/02/03 — リスト項目への複数行プレーンテキスト paste が兄弟 <li> になる。
 * 修正前は複数行がリスト全体の後ろに <p> として漏れていた。
 */
import { test, expect, Page } from '@playwright/test';

async function boot(page: Page) {
    await page.goto('/standalone-editor.html');
    await page.waitForSelector('#editor');
    await page.evaluate(() => (document.getElementById('editor') as HTMLElement).focus());
}

// プレーンテキスト paste をシミュレート（text/plain のみ・内部 md ではない）
async function pastePlain(page: Page, text: string) {
    await page.evaluate((t) => {
        const editor = document.getElementById('editor')!;
        const clipboardData: any = {
            _data: { 'text/plain': t, 'text/html': '' },
            getData(type: string) { return this._data[type] || ''; },
            setData(type: string, v: string) { this._data[type] = v; },
            items: [],
        };
        const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
        Object.defineProperty(event, 'clipboardData', { value: clipboardData, writable: false, configurable: true });
        editor.dispatchEvent(event);
    }, text);
}

// editor 内の <ul>/<li> テキストを取得
async function listItems(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const lis = Array.from(document.querySelectorAll('#editor ul > li, #editor ol > li'));
        return lis.map(li => (li.textContent || '').trim());
    });
}

test.describe('複数行 paste をリストに (paste-multiline-into-list)', () => {
    // TC-PML-01: リスト項目に複数行 paste → 兄弟 li ★load-bearing
    test('TC-PML-01 リスト項目に3行 paste で3兄弟 li になる', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>item1</li></ul>';
            // item1 の末尾にカーソル
            const li = editor.querySelector('li')!;
            const range = document.createRange();
            range.selectNodeContents(li); range.collapse(false);
            const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
        });
        await pastePlain(page, 'foo\nbar\nbaz');
        await page.waitForTimeout(100);
        const items = await listItems(page);
        const r = await page.evaluate(() => ({
            // リスト外に <p> が漏れていない
            strayP: document.querySelectorAll('#editor > p').length,
            liCount: document.querySelectorAll('#editor ul > li').length,
        }));
        expect(items).toEqual(['item1', 'foo', 'bar', 'baz']);   // 各行が兄弟 li
        expect(r.liCount).toBe(4);
        expect(r.strayP).toBe(0);   // ★ リスト後ろに段落が漏れない（修正前は漏れる=RED）
    });

    // TC-PML-02: 1 行 paste は従来どおりリスト内（回帰）
    test('TC-PML-02 リスト項目に1行 paste は item 内に入る', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>item1 </li></ul>';
            const li = editor.querySelector('li')!;
            const range = document.createRange();
            range.selectNodeContents(li); range.collapse(false);
            const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
        });
        await pastePlain(page, 'single');
        await page.waitForTimeout(100);
        const r = await page.evaluate(() => ({
            liCount: document.querySelectorAll('#editor ul > li').length,
            firstLi: (document.querySelector('#editor ul > li')!.textContent || '').trim(),
            strayP: document.querySelectorAll('#editor > p').length,
        }));
        expect(r.liCount).toBe(1);              // li 増えない
        expect(r.firstLi).toContain('single');  // item 内に入る
        expect(r.strayP).toBe(0);
    });

    // TC-PML-06: 同 tick の二重 paste dispatch が 1 回だけ挿入される（listener 累積による二重挿入の coalesce）★load-bearing
    // ★再オープン③(TASK-19): notes モードで paste リスナーが累積し 1 Ctrl+V で複数発火 → 2 行→4 行だった。
    //   同 tick ガードで 1 物理 paste = 1 挿入に束ねる。ここでは同一 editor に 2 回連続 dispatch して 1 回分だけ入るのを検証。
    test('TC-PML-06 同 tick の二重 paste は 1 回だけ挿入（coalesce）', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>item1</li></ul>';
            const li = editor.querySelector('li')!;
            const range = document.createRange(); range.selectNodeContents(li); range.collapse(false);
            const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
            // listener 累積を模し、同 tick で paste を 2 回発火（本番は 2 リスナーが 1 イベントで発火）
            function fire() {
                const cd: any = { _d: { 'text/plain': 'foo\nbar', 'text/html': '' }, getData(t: string) { return this._d[t] || ''; }, setData(t: string, v: string) { this._d[t] = v; }, items: [] };
                const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
                Object.defineProperty(ev, 'clipboardData', { value: cd, writable: false, configurable: true });
                editor.dispatchEvent(ev);
            }
            fire(); fire();   // 同 tick 2 連射
        });
        await page.waitForTimeout(50);
        const items = await listItems(page);
        // ★ foo/bar が 1 回だけ（4 行でなく 3 行）= coalesce できている
        expect(items).toEqual(['item1', 'foo', 'bar']);
    });

    // TC-PML-03: 非リストの段落に複数行 paste は従来どおり段落（この分岐に落ちない）
    test('TC-PML-03 通常段落に複数行 paste は段落のまま（新 li 分岐に落ちない）', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<p>para</p>';
            const p = editor.querySelector('p')!;
            const range = document.createRange();
            range.selectNodeContents(p); range.collapse(false);
            const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
        });
        await pastePlain(page, 'aaa\nbbb');
        await page.waitForTimeout(100);
        const r = await page.evaluate(() => ({
            liCount: document.querySelectorAll('#editor li').length,
            pCount: document.querySelectorAll('#editor > p').length,
        }));
        expect(r.liCount).toBe(0);          // li は作られない
        expect(r.pCount).toBeGreaterThanOrEqual(2);  // 段落として挿入（従来経路）
    });
});
