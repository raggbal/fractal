/**
 * outliner の table モード（2026-11-06 ユーザー依頼）
 * (1) 素の矢印でセル間を移動: ↑ = 1 行目にいるとき上のセル / ↓ = 最後の行にいるとき下のセル /
 *     ← = 先頭（1 行目の左端）のとき左のセル / → = 末尾（最後の行の右端）のとき右のセル。それ以外はセルの中でカーソルが動く
 * (2) Date & Time: 日付だけ選んでも消えない（時刻が空なら 00:00）。欄を離れても・ウィンドウがフォーカスを失っても消えない
 * (3) 日付を数字で打つと年が 4 桁で止まる（6 桁にならない）
 * (4) Date / Date & Time の ↑↓ は年月日・時刻を変えずにセル移動。矢印でセルに来たときは表示のまま（カレンダーを開かない）
 * TC-TKD-01〜06 / TC-TKD-07 カレンダー・時刻のボタンはブラウザの picker の印を直接押す形（VS Code の webview = cross-origin の iframe では showPicker() が使えない）
 */
import { test, expect, Page } from '@playwright/test';

// 日付の欄の並び（年 → 月 → 日）は locale で変わる。ユーザーの環境（日本語）に合わせる
test.use({ locale: 'ja-JP' });
const SELECT_ALL = process.platform === 'darwin' ? 'Meta+a' : 'Control+a';

const LONG = 'これは長い文章で、セルの幅では 1 行に収まらずに折り返して 2 行以上になるはずのテキストです。さらに少し足しておきます。';
const DATA = {
    version: 1, title: 'table', rootIds: ['n1', 'n2', 'n3'],
    columns: [
        { id: 'col_outliner', type: 'outliner', name: 'Outline', width: 220 },
        { id: 'c_txt', type: 'text', name: 'Text', width: 160 },
        { id: 'c_date', type: 'date', name: 'Date', width: 140 },
        { id: 'c_dt', type: 'datetime', name: 'Date & Time', width: 220 },
    ],
    nodes: {
        n1: { id: 'n1', parentId: null, children: [], text: 'row1', columnValues: { c_txt: 'short1', c_date: '2026-01-01', c_dt: '2026-01-01T09:30' } },
        n2: { id: 'n2', parentId: null, children: [], text: 'row2', columnValues: { c_txt: LONG, c_date: '2026-02-02', c_dt: '' } },
        n3: { id: 'n3', parentId: null, children: [], text: 'row3', columnValues: { c_txt: 'short3', c_date: '', c_dt: '' } },
    },
};

async function setup(page: Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); (window as any).Outliner.setViewMode('table'); }, DATA);
    await page.waitForSelector('.outliner-tree[data-view-mode="table"] .outliner-cell-text');
    await page.waitForTimeout(250); // 初期化の「最初のノードに focus」（100ms 後）が済んでから触る
}
const cell = (type: string, nodeId: string, colId?: string) =>
    type === 'outline' ? `.outliner-node[data-id="${nodeId}"] .outliner-text`
        : `.outliner-cell-${type}[data-node-id="${nodeId}"]${colId ? `[data-col-id="${colId}"]` : ''}`;
/** いま focus のあるセル（node id と列の種類） */
async function where(page: Page) {
    return page.evaluate(() => {
        const a = document.activeElement as HTMLElement;
        const c = a.closest('.outliner-cell-text, .outliner-cell-date, .outliner-cell-multiselect, .outliner-node') as HTMLElement;
        if (!c) return null;
        if (c.classList.contains('outliner-node')) return { kind: 'outline', id: c.dataset.id };
        return { kind: c.className.split(' ')[0].replace('outliner-cell-', ''), id: c.dataset.nodeId, col: c.dataset.colId, editing: a.tagName === 'INPUT' };
    });
}
async function caretOffset(page: Page) {
    return page.evaluate(() => { const s = window.getSelection()!; const r = s.getRangeAt(0); const pre = r.cloneRange(); pre.selectNodeContents(document.activeElement!); pre.setEnd(r.startContainer, r.startOffset); return pre.toString().length; });
}
async function setCaret(page: Page, sel: string, where: 'start' | 'end' | number) {
    await page.locator(sel).click();
    await page.evaluate(({ sel, where }) => {
        const el = document.querySelector(sel) as HTMLElement; el.focus();
        const r = document.createRange(); const s = window.getSelection()!;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const texts: Text[] = []; let t: Node | null; while ((t = walker.nextNode())) texts.push(t as Text);
        if (where === 'start' || texts.length === 0) { r.setStart(el, 0); }
        else if (where === 'end') { const last = texts[texts.length - 1]; r.setStart(last, last.length); }
        else { let n = where as number; for (const tx of texts) { if (n <= tx.length) { r.setStart(tx, n); break; } n -= tx.length; } }
        r.collapse(true); s.removeAllRanges(); s.addRange(r);
    }, { sel, where });
}
const cellValue = (page: Page, id: string, col: string) => page.evaluate(({ id, col }) => (window as any).__testApi.getModel().getNode(id).columnValues?.[col] ?? '', { id, col });

test('TC-TKD-01 (1) 文字のセル: 1 行目で ↑ は上のセル、2 行目以降の ↑ はセルの中でカーソルが上の行へ', async ({ page }) => {
    await setup(page);
    await setCaret(page, cell('text', 'n2'), 'end'); // 長い文章（折り返して 2 行以上）の最後
    await page.keyboard.press('ArrowUp');
    expect(await where(page), '最後の行からの ↑ はまだ同じセル').toMatchObject({ kind: 'text', id: 'n2' });
    // 1 行目まで上がると、次の ↑ で上のセル
    for (let i = 0; i < 6 && (await where(page))!.id === 'n2'; i++) {
        await page.keyboard.press('ArrowUp');
    }
    expect(await where(page)).toMatchObject({ kind: 'text', id: 'n1' });
    // ↓: 1 行のセルは最後の行なので下のセルへ（来たら先頭）
    await page.keyboard.press('ArrowDown');
    expect(await where(page)).toMatchObject({ kind: 'text', id: 'n2' });
    expect(await caretOffset(page)).toBe(0);
    await page.keyboard.press('ArrowDown');
    expect(await where(page), '1 行目からの ↓ はまだ同じセル（2 行以上ある）').toMatchObject({ kind: 'text', id: 'n2' });
});

test('TC-TKD-02 (1) ← は先頭のとき左のセル・→ は末尾のとき右のセル。途中ではカーソルが動く', async ({ page }) => {
    await setup(page);
    await setCaret(page, cell('text', 'n1'), 2);
    await page.keyboard.press('ArrowLeft');
    expect(await where(page)).toMatchObject({ kind: 'text', id: 'n1' });
    expect(await caretOffset(page)).toBe(1);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft'); // 先頭からの ←
    expect(await where(page)).toMatchObject({ kind: 'outline', id: 'n1' });
    // outline 列の末尾で → は右のセル（文字のセルの先頭へ）
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowRight');
    expect(await where(page)).toMatchObject({ kind: 'text', id: 'n1' });
    expect(await caretOffset(page)).toBe(0);
    await setCaret(page, cell('text', 'n1'), 'end');
    await page.keyboard.press('ArrowRight');
    expect(await where(page), '末尾からの → は右の date のセル（表示のまま）').toMatchObject({ kind: 'date', id: 'n1', col: 'c_date', editing: false });
});

test('TC-TKD-03 (1) outline 列: ↓ / ↑ で上下の行の outline、date の表示からは 4 方向ともセル移動', async ({ page }) => {
    await setup(page);
    await setCaret(page, cell('outline', 'n1'), 'end');
    await page.keyboard.press('ArrowDown');
    expect(await where(page)).toMatchObject({ kind: 'outline', id: 'n2' });
    await page.keyboard.press('ArrowUp');
    expect(await where(page)).toMatchObject({ kind: 'outline', id: 'n1' });
    // date の表示（矢印で来た）: カレンダーは開かず、4 方向ともセル移動
    await setCaret(page, cell('text', 'n2'), 'end');
    await page.keyboard.press('ArrowRight');
    expect(await where(page)).toMatchObject({ kind: 'date', id: 'n2', editing: false });
    await expect(page.locator(cell('date', 'n2') + ' input')).toHaveCount(0);
    await page.keyboard.press('ArrowDown');
    expect(await where(page)).toMatchObject({ kind: 'date', id: 'n3' });
    await page.keyboard.press('ArrowRight');
    expect(await where(page)).toMatchObject({ kind: 'date', id: 'n3', col: 'c_dt' });
    await page.keyboard.press('ArrowLeft');
    expect(await where(page)).toMatchObject({ kind: 'date', id: 'n3', col: 'c_date' });
});

test('TC-TKD-04 (4) date の入力中も ↑↓ は数字を変えずにセル移動。Enter / 数字で入力を始める', async ({ page }) => {
    await setup(page);
    await page.locator(cell('date', 'n2', 'c_date')).focus();
    await page.keyboard.press('Enter');
    const inp2 = page.locator(cell('date', 'n2', 'c_date') + ' input.outliner-cell-date-input');
    await expect(inp2).toBeFocused();
    await expect(inp2).toHaveValue('2026-02-02');
    await page.keyboard.press('ArrowUp');
    expect(await where(page)).toMatchObject({ kind: 'date', id: 'n1', col: 'c_date', editing: false });
    expect(await cellValue(page, 'n2', 'c_date'), '↑ で年月日を変えない').toBe('2026-02-02');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    expect(await where(page)).toMatchObject({ kind: 'date', id: 'n2', col: 'c_date' });
    expect(await cellValue(page, 'n1', 'c_date')).toBe('2026-01-01');
    // datetime の入力中も ↓ はセル移動（時刻を変えない）。← は先頭でないので欄の中
    await page.locator(cell('date', 'n1', 'c_dt')).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(cell('date', 'n1', 'c_dt') + ' input.outliner-cell-date-input')).toHaveValue('2026-01-01 09:30');
    await page.keyboard.press('ArrowLeft');
    expect(await where(page), '末尾から ← は欄の中').toMatchObject({ kind: 'date', id: 'n1', col: 'c_dt', editing: true });
    await page.keyboard.press('ArrowDown');
    expect(await where(page)).toMatchObject({ kind: 'date', id: 'n2', col: 'c_dt' });
    expect(await cellValue(page, 'n1', 'c_dt'), '時刻を変えない').toBe('2026-01-01T09:30');
    // 表示のまま数字を打つと入力が始まる
    await page.keyboard.press('2');
    await expect(page.locator(cell('date', 'n2', 'c_dt') + ' input.outliner-cell-date-input')).toHaveValue('2');
});

test('TC-TKD-05 (3) 日付を数字で打つと年は 4 桁で止まって月・日（時・分）へ進む', async ({ page }) => {
    await setup(page);
    await page.locator(cell('date', 'n3', 'c_date')).focus();
    await page.keyboard.press('Enter');
    const inp = page.locator(cell('date', 'n3', 'c_date') + ' input.outliner-cell-date-input');
    await expect(inp).toBeFocused();
    await page.keyboard.type('202611');
    await expect(inp, '年は 4 桁で区切って月へ').toHaveValue('2026-11');
    expect(await cellValue(page, 'n3', 'c_date'), '途中は保存しない').toBe('');
    await page.keyboard.type('06');
    await expect(inp).toHaveValue('2026-11-06');
    expect(await cellValue(page, 'n3', 'c_date')).toBe('2026-11-06');
    await page.keyboard.type('99'); // それ以上は入らない
    await expect(inp).toHaveValue('2026-11-06');
    // datetime: 12 桁で時・分まで。8 桁で Enter なら 00:00
    await page.locator(cell('date', 'n3', 'c_dt')).focus();
    await page.keyboard.press('Enter');
    const dt = page.locator(cell('date', 'n3', 'c_dt') + ' input.outliner-cell-date-input');
    await expect(dt).toBeFocused();
    await page.keyboard.type('202702031405');
    await expect(dt).toHaveValue('2027-02-03 14:05');
    expect(await cellValue(page, 'n3', 'c_dt')).toBe('2027-02-03T14:05');
    await page.keyboard.press('Enter');
    await page.locator(cell('date', 'n2', 'c_dt')).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.type('20260304');
    await page.keyboard.press('Enter');
    expect(await cellValue(page, 'n2', 'c_dt')).toBe('2026-03-04T00:00');
    // 不正な日付（2 月 30 日）は保存せず、欄を離れたら元の値に戻る
    await page.locator(cell('date', 'n2', 'c_date')).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press(SELECT_ALL);
    await page.keyboard.type('20260230');
    await page.keyboard.press('Enter');
    expect(await cellValue(page, 'n2', 'c_date')).toBe('2026-02-02');
});

test('TC-TKD-06 (2) カレンダー / 時刻で選ぶとその場で保存。Date & Time は日付だけでも消えない（00:00）。欄を離れても残る', async ({ page }) => {
    await setup(page);
    await page.locator(cell('date', 'n2', 'c_dt')).click();
    await expect(page.locator(cell('date', 'n2', 'c_dt') + ' input.outliner-cell-date-input')).toBeFocused();
    await expect(page.locator(cell('date', 'n2', 'c_dt') + ' .outliner-cell-date-picker-btn')).toHaveCount(2);
    // カレンダーで日付を選んだのと同じ（隠した native の date に値が入り input / change が来る）
    const natDate = page.locator(cell('date', 'n2', 'c_dt') + ' .outliner-cell-date-picker--date input');
    await natDate.evaluate((el: HTMLInputElement) => { el.value = '2026-11-06'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(await cellValue(page, 'n2', 'c_dt')).toBe('2026-11-06T00:00');
    await expect(page.locator(cell('date', 'n2', 'c_dt') + ' input.outliner-cell-date-input')).toHaveValue('2026-11-06 00:00');
    // picker が閉じてウィンドウごとフォーカスを失う（relatedTarget なし）→ 消えない
    await page.evaluate(() => { (document.activeElement as HTMLElement).dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null })); });
    await page.waitForTimeout(50);
    expect(await cellValue(page, 'n2', 'c_dt')).toBe('2026-11-06T00:00');
    // 時刻を選ぶ → 日付はそのまま時刻だけ変わる
    const natTime = page.locator(cell('date', 'n2', 'c_dt') + ' .outliner-cell-date-picker--time input');
    await natTime.evaluate((el: HTMLInputElement) => { el.value = '14:05'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(await cellValue(page, 'n2', 'c_dt')).toBe('2026-11-06T14:05');
    // 別のセルへ移る → 表示に残る
    await page.locator(cell('text', 'n1')).click();
    await page.waitForTimeout(50);
    expect(await cellValue(page, 'n2', 'c_dt')).toBe('2026-11-06T14:05');
    await expect(page.locator(cell('date', 'n2', 'c_dt') + ' .outliner-cell-date-display')).toHaveText('2026-11-06 14:05');
    // Date の列: カレンダーで選んで欄を離れると残る
    await page.locator(cell('date', 'n3', 'c_date')).click();
    const natDate2 = page.locator(cell('date', 'n3', 'c_date') + ' .outliner-cell-date-picker--date input');
    await natDate2.evaluate((el: HTMLInputElement) => { el.value = '2026-12-24'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.locator(cell('text', 'n1')).click();
    await page.waitForTimeout(50);
    await expect(page.locator(cell('date', 'n3', 'c_date') + ' .outliner-cell-date-display')).toHaveText('2026-12-24');
    // 打っている途中で欄を離れても、元の値は消えない
    await page.locator(cell('date', 'n3', 'c_date')).click();
    await page.keyboard.press(SELECT_ALL);
    await page.keyboard.type('2027');
    await page.locator(cell('text', 'n1')).click();
    await page.waitForTimeout(50);
    expect(await cellValue(page, 'n3', 'c_date')).toBe('2026-12-24');
});

test('TC-TKD-07 カレンダー・時刻のボタンは native の picker の印を直接押す（showPicker を使わない）。選んだら文字の欄へ戻る', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
        // VS Code の webview（cross-origin の iframe）と同じく showPicker() を禁止する。呼ばれたら印を残す
        (window as any).__showPickerCalls = 0;
        (HTMLInputElement.prototype as any).showPicker = function () { (window as any).__showPickerCalls++; throw new DOMException('cross-origin', 'SecurityError'); };
    });
    await page.locator(cell('date', 'n2', 'c_dt')).click();
    for (const kind of ['date', 'time']) {
        const r = await page.evaluate(({ k }) => {
            const wrap = document.querySelector('.outliner-cell-date[data-node-id="n2"][data-col-id="c_dt"] .outliner-cell-date-picker--' + k) as HTMLElement;
            const b = wrap.getBoundingClientRect();
            const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) as HTMLInputElement;
            const nat = wrap.querySelector('input') as HTMLInputElement;
            const ind = getComputedStyle(nat, '::-webkit-calendar-picker-indicator');
            return { hitIsNative: hit === nat, type: nat.type, pe: getComputedStyle(nat).pointerEvents, disp: getComputedStyle(nat).display, w: nat.getBoundingClientRect().width, indPos: ind.position };
        }, { k: kind });
        expect(r.hitIsNative, kind + ' のボタンの真ん中を押すと native の ' + kind + ' に当たる').toBe(true);
        expect(r.type).toBe(kind);
        expect(r.pe).not.toBe('none');
        expect(r.disp).not.toBe('none');
        expect(r.w).toBeGreaterThan(10);
        expect(r.indPos, 'picker の印をボタン全体に広げる').toBe('absolute');
    }
    // 実際にマウスで押す → native に focus（編集は続く）。picker で選ぶ → 保存して文字の欄へ戻る
    const wrapDate = page.locator(cell('date', 'n2', 'c_dt') + ' .outliner-cell-date-picker--date');
    await wrapDate.click();
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).type)).toBe('date');
    await expect(page.locator(cell('date', 'n2', 'c_dt') + ' input.outliner-cell-date-input'), '編集は続く').toHaveCount(1);
    await page.locator(cell('date', 'n2', 'c_dt') + ' .outliner-cell-date-picker--date input').evaluate((el: HTMLInputElement) => { el.value = '2026-07-08'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForTimeout(50);
    expect(await cellValue(page, 'n2', 'c_dt')).toBe('2026-07-08T00:00');
    await expect(page.locator(cell('date', 'n2', 'c_dt') + ' input.outliner-cell-date-input')).toBeFocused();
    expect(await page.evaluate(() => (window as any).__showPickerCalls), 'showPicker は呼ばない').toBe(0);
});
