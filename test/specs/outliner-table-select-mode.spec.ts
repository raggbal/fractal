/**
 * spec 20261106-1700-table-cell-select-mode — outliner の table モードを「セル選択モード（既定）→ 編集モード」の 2 段にする
 * D1  どのセルも既定は選択モード（カーソル無し・セルに枠）。編集モード = カーソルが入っている状態
 * D2  クリック 1 回 = 選択 / ダブルクリック = 編集（クリックした位置にカーソル）。セルの中のボタン類は今どおり押せる
 * D3  選択モード: 矢印（Cmd+矢印も同じ）で上下左右のセル、Tab / Shift+Tab で右 / 左、Enter / F2 で編集（カーソルは末尾）
 * D4  選択モードで文字を打つ: outline の列・文字 = 末尾に足す / Date・Date & Time = 打った数字から入れ直す / 選択肢 = セルの中のカーソル + 一覧
 * D5  選択モードの Delete / Backspace = セルを空にする（outline の列は文字だけ空・行は残す）。Cmd+Z で戻せる
 * D6  選択モードの Cmd+C / Cmd+X / Cmd+V = セルの中身（文字）のコピー / 切り取り / 貼り付け（置き換え。選択肢は名前で合わせる）
 * D7  編集モードの Enter は今までどおり（outline = 行を足す / 文字 = 改行 / 選択肢 = 付け外し / Date = 確定して選択モードへ）
 * D8  編集モードの Esc = 選択モードの同じセルへ（入れた内容は残す。Date の途中・不正は元の値）。選択モードの Esc は今どおり
 * D9  編集モードの矢印は端だけ隣のセル（Date の ↑↓ は数字を変えない）。移った先も編集モード
 * D10 選択肢の編集モード = セルの中にカーソルだけ。打つと一覧が出て絞り込み、一覧の間は ↑↓ / Enter、出ていなければ矢印はほかのセルと同じ
 * D11 table に切り替えたとき・初期化の「最初のノードに focus」は選択モード（focus のある行の outline の列）
 * 実マウス / 実キー（Playwright）で駆動する。IME は CDP の Input.imeSetComposition / insertText（keydown 229 → 変換 → 確定）で再現する。
 */
import { test, expect, Page } from '@playwright/test';

test.use({ locale: 'ja-JP' });
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const DATA = {
    version: 1, title: 'table', rootIds: ['n1', 'n2', 'n3'],
    columns: [
        { id: 'col_outliner', type: 'outliner', name: 'Outline', width: 220 },
        { id: 'c_txt', type: 'text', name: 'Text', width: 200 },
        { id: 'c_date', type: 'date', name: 'Date', width: 140 },
        { id: 'c_dt', type: 'datetime', name: 'Date & Time', width: 200 },
        {
            id: 'c_tag', type: 'multiselect', name: 'Tags', width: 220, options: [
                { id: 'o_red', label: '#red', color: 'red' },
                { id: 'o_blue', label: '#blue', color: 'blue' },
                { id: 'o_green', label: '#green', color: 'green' },
            ],
        },
    ],
    nodes: {
        n1: { id: 'n1', parentId: null, children: ['n1a'], text: 'row1', checked: false, columnValues: { c_txt: 'hello world', c_date: '2026-01-01', c_dt: '2026-01-01T09:30', c_tag: ['o_red'] } },
        n1a: { id: 'n1a', parentId: 'n1', children: [], text: 'child', columnValues: {} },
        n2: { id: 'n2', parentId: null, children: [], text: 'row2 #tagx', isPage: true, pageId: 'p2', columnValues: { c_txt: 'see [link](https://example.com/) here', c_date: '2026-02-02', c_dt: '', c_tag: ['o_blue', 'o_green'] } },
        n3: { id: 'n3', parentId: null, children: [], text: 'row3', filePath: 'files/doc.pdf', columnValues: { c_txt: '', c_date: '', c_dt: '', c_tag: [] } },
    },
};

async function boot(page: Page, data: any = DATA, mode: string | null = 'table') {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ d, m }) => {
        (window as any).__testApi.initOutliner(JSON.parse(JSON.stringify(d)));
        if (m) (window as any).Outliner.setViewMode(m);
    }, { d: data, m: mode });
    await page.waitForTimeout(250); // 初期化の「最初のノードに focus」（100ms 後）が済んでから触る
}

/** セルの selector。outline = 行の .outliner-node（outline の列のセル） */
function cell(kind: 'outline' | 'text' | 'date' | 'dt' | 'tag', id: string) {
    if (kind === 'outline') return `.outliner-tree > .outliner-node[data-id="${id}"]`;
    const col = { text: 'c_txt', date: 'c_date', dt: 'c_dt', tag: 'c_tag' }[kind];
    const cls = { text: 'outliner-cell-text', date: 'outliner-cell-date', dt: 'outliner-cell-date', tag: 'outliner-cell-multiselect' }[kind];
    return `.outliner-tree > .${cls}[data-node-id="${id}"][data-col-id="${col}"]`;
}
const outlineText = (id: string) => `.outliner-tree > .outliner-node[data-id="${id}"] .outliner-text`;

/** いまのモード: select = 受け口に focus + 枠が 1 つ / edit = セルの中に focus / none */
async function where(page: Page) {
    return page.evaluate(() => {
        const tree = document.querySelector('.outliner-tree') as HTMLElement;
        const ae = document.activeElement as HTMLElement | null;
        const desc = (c: HTMLElement) => {
            if (c.classList.contains('outliner-node')) return { kind: 'outline', id: c.dataset.id };
            const col = c.dataset.colId!;
            const kind = c.classList.contains('outliner-cell-text') ? 'text'
                : c.classList.contains('outliner-cell-multiselect') ? 'tag'
                    : col === 'c_dt' ? 'dt' : 'date';
            return { kind, id: c.dataset.nodeId };
        };
        const framed = Array.from(tree.querySelectorAll(':scope > .is-cell-selected')) as HTMLElement[];
        if (ae && ae.classList.contains('outliner-table-sel-proxy')) {
            return framed.length === 1 ? { mode: 'select', ...desc(framed[0]) } : { mode: 'select?', framed: framed.length };
        }
        if (ae && tree.contains(ae)) {
            let c: HTMLElement | null = ae;
            while (c && c.parentElement !== tree) c = c.parentElement;
            return { mode: 'edit', ...desc(c!), tag: ae.tagName, framed: framed.length };
        }
        return { mode: 'none', tag: ae ? ae.tagName : null, framed: framed.length };
    });
}

/** 編集中の caret の位置（contenteditable は文字数、input は selectionStart） */
async function caret(page: Page) {
    return page.evaluate(() => {
        const ae = document.activeElement as HTMLElement;
        if (ae.tagName === 'INPUT') return (ae as HTMLInputElement).selectionStart;
        const s = window.getSelection()!;
        const r = s.getRangeAt(0);
        const pre = r.cloneRange();
        pre.selectNodeContents(ae);
        pre.setEnd(r.startContainer, r.startOffset);
        return s.isCollapsed ? pre.toString().length : -1;
    });
}

/** 文字の index 文字目の左端（+1px）の座標 */
async function charPoint(page: Page, sel: string, index: number) {
    return page.evaluate(({ sel, index }) => {
        const el = document.querySelector(sel) as HTMLElement;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n = index; let t: Text | null = null;
        while ((t = walker.nextNode() as Text | null)) { if (n < t.length) break; n -= t.length; }
        const r = document.createRange(); r.setStart(t!, n); r.setEnd(t!, n + 1);
        const b = r.getBoundingClientRect();
        return { x: b.left + 1, y: b.top + b.height / 2 };
    }, { sel, index });
}

const node = (page: Page, id: string) => page.evaluate((id) => {
    const n = (window as any).__testApi.getModel().getNode(id);
    return n ? JSON.parse(JSON.stringify(n)) : null;
}, id);
const val = (page: Page, id: string, col: string) => page.evaluate(({ id, col }) => {
    const v = (window as any).__testApi.getModel().getNode(id).columnValues?.[col];
    return v === undefined || v === null ? (col === 'c_tag' ? [] : '') : JSON.parse(JSON.stringify(v));
}, { id, col });
const messages = (page: Page) => page.evaluate(() => (window as any).__testApi.messages.map((m: any) => ({ type: m.type, href: m.href, nodeId: m.nodeId })));
const clip = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const setClip = (page: Page, t: string) => page.evaluate((t) => navigator.clipboard.writeText(t), t);
const dropdownVisible = (page: Page) => page.evaluate(() => {
    const d = document.querySelector('.outliner-multiselect-dropdown') as HTMLElement | null;
    return !!d && d.style.display !== 'none' && d.getBoundingClientRect().height > 0;
});

test('TC-TSM-01 D1/D2 1 回のクリックはどのセルも選択モード（カーソル無し・枠 1 つ）。入力欄・一覧は開かない', async ({ page }) => {
    await boot(page);
    const targets: [string, any][] = [
        [outlineText('n1'), { kind: 'outline', id: 'n1' }],
        [cell('text', 'n1'), { kind: 'text', id: 'n1' }],
        [cell('date', 'n1'), { kind: 'date', id: 'n1' }],
        [cell('dt', 'n1'), { kind: 'dt', id: 'n1' }],
        [cell('tag', 'n2'), { kind: 'tag', id: 'n2' }],
        [cell('text', 'n3'), { kind: 'text', id: 'n3' }],
    ];
    for (const [sel, exp] of targets) {
        await page.locator(sel).click();
        expect(await where(page), sel).toEqual({ mode: 'select', ...exp });
        // カーソル（focus / caret）はセルの中に無い
        expect(await page.evaluate(() => document.querySelector('.outliner-tree')!.contains(document.activeElement))).toBe(false);
        await expect(page.locator('.outliner-cell-date-input')).toHaveCount(0);
        await expect(page.locator('.outliner-multiselect-input')).toHaveCount(0);
        expect(await dropdownVisible(page)).toBe(false);
    }
    // 枠が見える（box-shadow）
    const shadow = await page.locator(cell('text', 'n3')).evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow).not.toBe('none');
    // focus のある行は選んだセルの行
    expect(await page.evaluate(() => (window as any).Outliner.getFocusedNodeId())).toBe('n3');
});

test('TC-TSM-02 D2 ダブルクリック = 編集（クリックした位置にカーソル）。タグのダブルクリックは今どおり検索', async ({ page }) => {
    await boot(page);
    // 文字のセル: 'hello world' の 6 文字目（w）
    let p = await charPoint(page, cell('text', 'n1'), 6);
    await page.mouse.dblclick(p.x, p.y);
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'text', id: 'n1', framed: 0 });
    expect(await caret(page)).toBe(6);
    // outline の列: 'row1' の 2 文字目
    p = await charPoint(page, outlineText('n1'), 2);
    await page.mouse.dblclick(p.x, p.y);
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'outline', id: 'n1' });
    expect(await caret(page)).toBe(2);
    // Date: 表示 '2026-01-01' の 5 文字目 → 入力欄の同じ位置
    p = await charPoint(page, cell('date', 'n1') + ' .outliner-cell-date-display', 5);
    await page.mouse.dblclick(p.x, p.y);
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'date', id: 'n1', tag: 'INPUT' });
    await expect(page.locator(cell('date', 'n1') + ' input.outliner-cell-date-input')).toHaveValue('2026-01-01');
    expect(await caret(page)).toBe(5);
    // 選択肢: セルの中のカーソル（一覧は出さない）
    await page.locator(cell('tag', 'n1')).dblclick();
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'tag', id: 'n1', tag: 'INPUT' });
    await expect(page.locator(cell('tag', 'n1') + ' input.outliner-multiselect-input')).toBeFocused();
    expect(await dropdownVisible(page)).toBe(false);
    // タグのダブルクリック = 検索（今どおり）
    await page.locator(outlineText('n2') + ' .outliner-tag').dblclick();
    await expect(page.locator('.outliner-search-input')).toHaveValue('#tagx');
});

test('TC-TSM-03 D2 セルの中のボタン類（bullet・checkbox・page / file のアイコン・chip の ×・リンク）は今どおり押せる', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => { (window as any).__testApi.messages = []; });
    // bullet = 折りたたみ
    await page.locator(cell('outline', 'n1') + ' .outliner-bullet').click();
    await page.waitForTimeout(50);
    expect((await node(page, 'n1')).collapsed).toBe(true);
    await expect(page.locator(cell('outline', 'n1a'))).toHaveCount(0);
    expect(await where(page), 'bullet を押したあとも選択モード').toEqual({ mode: 'select', kind: 'outline', id: 'n1' });
    // checkbox
    await page.locator(cell('outline', 'n1') + ' .outliner-checkbox input').click();
    expect((await node(page, 'n1')).checked).toBe(true);
    expect(await where(page)).toEqual({ mode: 'select', kind: 'outline', id: 'n1' });
    // page のアイコン / file のアイコン
    await page.locator(cell('outline', 'n2') + ' .outliner-page-icon').click();
    await page.locator(cell('outline', 'n3') + ' .outliner-file-icon').click();
    await page.waitForTimeout(50);
    const msgs = await messages(page);
    expect(msgs).toContainEqual(expect.objectContaining({ type: 'openPageInSidePanel', nodeId: 'n2' }));
    expect(msgs).toContainEqual(expect.objectContaining({ type: 'openAttachedFile', nodeId: 'n3' }));
    // chip の × = このセルから外す
    await page.locator(cell('tag', 'n2') + ' .outliner-chip[data-opt-id="o_blue"] .outliner-chip-remove').click();
    expect(await val(page, 'n2', 'c_tag')).toEqual(['o_green']);
    expect(await where(page)).toEqual({ mode: 'select', kind: 'tag', id: 'n2' });
    // リンク = 開く（セルは選ぶ）
    await page.locator(cell('text', 'n2') + ' a').click();
    expect(await messages(page)).toContainEqual(expect.objectContaining({ type: 'openLink', href: 'https://example.com/' }));
    expect(await where(page)).toEqual({ mode: 'select', kind: 'text', id: 'n2' });
    // bullet は D&D の掴みのまま（選択モードでも mousedown を止めない）: n1 を n3 の下へ
    const b = (await page.locator(cell('outline', 'n1') + ' .outliner-bullet').boundingBox())!;
    const t = (await page.locator(cell('outline', 'n3')).boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 10, b.y + 30, { steps: 5 });
    await page.mouse.move(t.x + 60, t.y + t.height * 0.85, { steps: 8 });
    await page.mouse.up();
    expect(await page.evaluate(() => (window as any).__testApi.getModel().rootIds.slice())).toEqual(['n2', 'n3', 'n1']);
});

test('TC-TSM-04 D3 矢印（Cmd+矢印も）で 1 セルずつ・端では止まる。Tab / Shift+Tab で右 / 左。Enter / F2 で編集（末尾）', async ({ page }) => {
    await boot(page);
    await page.locator(cell('text', 'n1')).click();
    const steps: [string, any][] = [
        ['ArrowRight', { kind: 'date', id: 'n1' }], ['ArrowRight', { kind: 'dt', id: 'n1' }], ['ArrowRight', { kind: 'tag', id: 'n1' }],
        ['ArrowRight', { kind: 'tag', id: 'n1' }], // 右端
        ['ArrowDown', { kind: 'tag', id: 'n1a' }], ['ArrowLeft', { kind: 'dt', id: 'n1a' }], ['ArrowLeft', { kind: 'date', id: 'n1a' }],
        ['ArrowLeft', { kind: 'text', id: 'n1a' }], ['ArrowLeft', { kind: 'outline', id: 'n1a' }],
        ['ArrowLeft', { kind: 'outline', id: 'n1a' }], // 左端
        ['ArrowUp', { kind: 'outline', id: 'n1' }], ['ArrowUp', { kind: 'outline', id: 'n1' }], // 上端
        [`${MOD}+ArrowDown`, { kind: 'outline', id: 'n1a' }], [`${MOD}+ArrowDown`, { kind: 'outline', id: 'n2' }],
        [`${MOD}+ArrowRight`, { kind: 'text', id: 'n2' }], [`${MOD}+ArrowUp`, { kind: 'text', id: 'n1a' }],
        ['Tab', { kind: 'date', id: 'n1a' }], ['Tab', { kind: 'dt', id: 'n1a' }], ['Shift+Tab', { kind: 'date', id: 'n1a' }],
        ['ArrowDown', { kind: 'date', id: 'n2' }], ['ArrowDown', { kind: 'date', id: 'n3' }], ['ArrowDown', { kind: 'date', id: 'n3' }], // 下端
    ];
    for (const [key, exp] of steps) {
        await page.keyboard.press(key);
        expect(await where(page), key).toEqual({ mode: 'select', ...exp });
    }
    expect(await val(page, 'n3', 'c_date'), '選択モードの ↑↓ は値を変えない').toBe('');
    // Enter = 編集（カーソルは末尾）
    await page.locator(cell('text', 'n1')).click();
    await page.keyboard.press('Enter');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'text', id: 'n1' });
    expect(await caret(page)).toBe('hello world'.length);
    await page.keyboard.press('Escape');
    await page.keyboard.press('F2');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'text', id: 'n1' });
    expect(await caret(page)).toBe('hello world'.length);
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'outline', id: 'n1' });
    expect(await caret(page)).toBe('row1'.length);
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'date', id: 'n1', tag: 'INPUT' });
    expect(await caret(page)).toBe('2026-01-01'.length);
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('F2');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'tag', id: 'n1', tag: 'INPUT' });
    expect(await dropdownVisible(page)).toBe(false);
});

test('TC-TSM-05 D4 選択モードで文字を打つ: outline の列・文字は末尾に足す / Date は打った数字から / 選択肢はカーソル + 一覧', async ({ page }) => {
    await boot(page);
    await page.locator(outlineText('n1')).click();
    await page.keyboard.type('XY');
    expect((await node(page, 'n1')).text).toBe('row1XY');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'outline', id: 'n1' });
    expect(await caret(page)).toBe(6);
    await page.locator(cell('text', 'n1')).click();
    await page.keyboard.type('Z');
    expect(await val(page, 'n1', 'c_txt')).toBe('hello worldZ');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'text', id: 'n1' });
    // Date: 打った数字から入れ直す（そろうまでは保存しない）
    await page.locator(cell('date', 'n2')).click();
    await page.keyboard.type('2');
    await expect(page.locator(cell('date', 'n2') + ' input.outliner-cell-date-input')).toHaveValue('2');
    expect(await val(page, 'n2', 'c_date')).toBe('2026-02-02');
    await page.keyboard.type('0261231');
    await expect(page.locator(cell('date', 'n2') + ' input.outliner-cell-date-input')).toHaveValue('2026-12-31');
    expect(await val(page, 'n2', 'c_date')).toBe('2026-12-31');
    await page.locator(cell('dt', 'n3')).click();
    await page.keyboard.type('202701020304');
    expect(await val(page, 'n3', 'c_dt')).toBe('2027-01-02T03:04');
    // 数字以外は Date では何もしない（選択モードのまま）
    await page.locator(cell('date', 'n1')).click();
    await page.keyboard.type('a');
    expect(await where(page)).toEqual({ mode: 'select', kind: 'date', id: 'n1' });
    expect(await val(page, 'n1', 'c_date')).toBe('2026-01-01');
    // 選択肢: セルの中のカーソルに入り、一覧が出て絞り込む
    await page.locator(cell('tag', 'n3')).click();
    await page.keyboard.type('r');
    const input = page.locator(cell('tag', 'n3') + ' input.outliner-multiselect-input');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('r');
    expect(await dropdownVisible(page)).toBe(true);
    const items = await page.locator('.outliner-multiselect-dropdown .outliner-multiselect-item .outliner-chip').allTextContents();
    expect(items).toEqual(['#red', '#green']);
});

test('TC-TSM-06 D5 Delete / Backspace でセルを空にする（outline の列は文字だけ・行は残す）。Cmd+Z で戻る', async ({ page }) => {
    await boot(page);
    const cases: [string, string, string, any, any][] = [
        // [selector, key, col, before, after]
        [cell('text', 'n1'), 'Delete', 'c_txt', 'hello world', ''],
        [cell('date', 'n1'), 'Backspace', 'c_date', '2026-01-01', ''],
        [cell('dt', 'n1'), 'Delete', 'c_dt', '2026-01-01T09:30', ''],
        [cell('tag', 'n2'), 'Backspace', 'c_tag', ['o_blue', 'o_green'], []],
    ];
    for (const [sel, key, col, before, after] of cases) {
        const id = col === 'c_tag' ? 'n2' : 'n1';
        await page.locator(sel).click();
        const at = await where(page);
        await page.keyboard.press(key);
        expect(await val(page, id, col), sel + ' ' + key).toEqual(after);
        expect(await where(page), '選択モードのまま').toEqual(at);
        await page.keyboard.press(`${MOD}+z`);
        expect(await val(page, id, col), 'Cmd+Z で戻る').toEqual(before);
        expect(await where(page), 'Cmd+Z のあとも同じセルの選択モード').toEqual(at);
    }
    await expect(page.locator(cell('date', 'n1') + ' .outliner-cell-date-display')).toHaveText('2026-01-01');
    // outline の列: 文字だけ空にして行（ノード）は残す
    await page.locator(outlineText('n1')).click();
    await page.keyboard.press('Backspace');
    expect((await node(page, 'n1'))?.text).toBe('');
    expect((await node(page, 'n1'))?.children).toEqual(['n1a']);
    await expect(page.locator('.outliner-tree > .outliner-node')).toHaveCount(4);
    expect(await where(page)).toEqual({ mode: 'select', kind: 'outline', id: 'n1' });
    await page.keyboard.press(`${MOD}+z`);
    expect((await node(page, 'n1'))?.text).toBe('row1');
    await expect(page.locator(outlineText('n1'))).toHaveText('row1');
});

test('TC-TSM-07 D6 Cmd+C / Cmd+X / Cmd+V = セルの中身のコピー / 切り取り / 貼り付け（置き換え。選択肢は名前で合わせる）', async ({ page }) => {
    await boot(page);
    await page.locator(cell('text', 'n1')).click();
    await page.keyboard.press(`${MOD}+c`);
    expect(await clip(page)).toBe('hello world');
    await page.locator(cell('tag', 'n2')).click();
    await page.keyboard.press(`${MOD}+c`);
    expect(await clip(page)).toBe('#blue #green');
    await page.locator(cell('dt', 'n1')).click();
    await page.keyboard.press(`${MOD}+c`);
    expect(await clip(page)).toBe('2026-01-01 09:30');
    await page.locator(outlineText('n2')).click();
    await page.keyboard.press(`${MOD}+c`);
    expect(await clip(page)).toBe('row2 #tagx');
    // 貼り付け = 置き換え
    await page.locator(cell('text', 'n3')).click();
    await setClip(page, 'pasted text');
    await page.keyboard.press(`${MOD}+v`);
    expect(await val(page, 'n3', 'c_txt')).toBe('pasted text');
    expect(await where(page)).toEqual({ mode: 'select', kind: 'text', id: 'n3' });
    await page.locator(outlineText('n3')).click();
    await setClip(page, 'new title');
    await page.keyboard.press(`${MOD}+v`);
    expect((await node(page, 'n3')).text).toBe('new title');
    await expect(page.locator('.outliner-tree > .outliner-node')).toHaveCount(4);
    // Date: 日付として読める文字だけ（Date & Time の形でも日付だけ取る）。読めない文字は何もしない
    await page.locator(cell('date', 'n3')).click();
    await setClip(page, '2026-01-01 09:30');
    await page.keyboard.press(`${MOD}+v`);
    expect(await val(page, 'n3', 'c_date')).toBe('2026-01-01');
    await setClip(page, 'abc');
    await page.keyboard.press(`${MOD}+v`);
    expect(await val(page, 'n3', 'c_date')).toBe('2026-01-01');
    // 選択肢: 名前で既存の選択肢に合わせる（# は無くてよい・無い名前は捨てる）
    await page.locator(cell('tag', 'n3')).click();
    await setClip(page, '#blue, red, #nope');
    await page.keyboard.press(`${MOD}+v`);
    expect(await val(page, 'n3', 'c_tag')).toEqual(['o_blue', 'o_red']);
    // 切り取り = コピーして空にする。Cmd+Z で戻る
    await page.locator(cell('text', 'n1')).click();
    await page.keyboard.press(`${MOD}+x`);
    expect(await clip(page)).toBe('hello world');
    expect(await val(page, 'n1', 'c_txt')).toBe('');
    await page.keyboard.press(`${MOD}+z`);
    expect(await val(page, 'n1', 'c_txt')).toBe('hello world');
    // コピーしたセルを別のセルへ貼る
    await page.locator(cell('dt', 'n1')).click();
    await page.keyboard.press(`${MOD}+c`);
    await page.locator(cell('dt', 'n3')).click();
    await page.keyboard.press(`${MOD}+v`);
    expect(await val(page, 'n3', 'c_dt')).toBe('2026-01-01T09:30');
});

test('TC-TSM-08 D7 編集モードの Enter: outline = 行を足す / 文字 = 改行 / Date = 確定して選択モード / 選択肢 = 付け外し', async ({ page }) => {
    await boot(page);
    await page.locator(outlineText('n3')).click();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    const roots = await page.evaluate(() => (window as any).__testApi.getModel().rootIds.slice());
    expect(roots.length).toBe(4);
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'outline', id: roots[3] });
    // 文字: 改行（編集モードのまま同じセル）
    await page.locator(cell('text', 'n1')).click();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('next');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'text', id: 'n1' });
    expect(await val(page, 'n1', 'c_txt')).toBe('hello world\nnext');
    expect(await page.locator(cell('text', 'n1')).evaluate((el) => (el as HTMLElement).innerText)).toBe('hello world\nnext');
    // Date: 確定して選択モードへ
    await page.locator(cell('date', 'n3')).click();
    await page.keyboard.press('Enter');
    await page.keyboard.type('20261106');
    await page.keyboard.press('Enter');
    expect(await where(page)).toEqual({ mode: 'select', kind: 'date', id: 'n3' });
    expect(await val(page, 'n3', 'c_date')).toBe('2026-11-06');
    await expect(page.locator(cell('date', 'n3') + ' .outliner-cell-date-display')).toHaveText('2026-11-06');
    // 選択肢: 一覧の付け外し → 選択モードへ
    await page.locator(cell('tag', 'n3')).click();
    await page.keyboard.type('bl');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await val(page, 'n3', 'c_tag')).toEqual(['o_blue']);
    expect(await where(page)).toEqual({ mode: 'select', kind: 'tag', id: 'n3' });
    expect(await dropdownVisible(page)).toBe(false);
});

test('TC-TSM-09 D8 編集モードの Esc = 選択モードの同じセル（内容は残す・Date の途中 / 不正は戻す）。選択モードの Esc は検索・ノードの選択を外す', async ({ page }) => {
    await boot(page);
    await page.locator(outlineText('n1')).click();
    await page.keyboard.press('Enter');
    await page.keyboard.type('Q');
    await page.keyboard.press('Escape');
    expect(await where(page)).toEqual({ mode: 'select', kind: 'outline', id: 'n1' });
    expect((await node(page, 'n1')).text).toBe('row1Q');
    await page.locator(cell('text', 'n3')).dblclick();
    await page.keyboard.type('memo');
    await page.keyboard.press('Escape');
    expect(await where(page)).toEqual({ mode: 'select', kind: 'text', id: 'n3' });
    expect(await val(page, 'n3', 'c_txt')).toBe('memo');
    await expect(page.locator(cell('text', 'n3'))).toHaveText('memo');
    // Date: 途中・不正は元の値に戻す / そろった正しい値は残す
    await page.locator(cell('date', 'n2')).click();
    await page.keyboard.press('Enter');
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.type('2027');
    await page.keyboard.press('Escape');
    expect(await where(page)).toEqual({ mode: 'select', kind: 'date', id: 'n2' });
    expect(await val(page, 'n2', 'c_date')).toBe('2026-02-02');
    await expect(page.locator(cell('date', 'n2') + ' .outliner-cell-date-display')).toHaveText('2026-02-02');
    await page.keyboard.press('Enter');
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.type('20260230');
    await page.keyboard.press('Escape');
    expect(await val(page, 'n2', 'c_date')).toBe('2026-02-02');
    await page.locator(cell('date', 'n3')).click();
    await page.keyboard.type('20261106');
    await page.keyboard.press('Escape');
    expect(await where(page)).toEqual({ mode: 'select', kind: 'date', id: 'n3' });
    expect(await val(page, 'n3', 'c_date')).toBe('2026-11-06');
    // 選択肢: 一覧が出ていても Esc で抜ける（値は変えない）
    await page.locator(cell('tag', 'n3')).click();
    await page.keyboard.type('x');
    expect(await dropdownVisible(page)).toBe(true);
    await page.keyboard.press('Escape');
    expect(await where(page)).toEqual({ mode: 'select', kind: 'tag', id: 'n3' });
    expect(await dropdownVisible(page)).toBe(false);
    expect(await val(page, 'n3', 'c_tag')).toEqual([]);
    // 選択モードの Esc: 検索を外す（選択モードのまま）
    await page.locator('.outliner-search-input').fill('row2');
    await page.waitForTimeout(350);
    await expect(page.locator('.outliner-tree > .outliner-node')).toHaveCount(1);
    await page.locator(outlineText('n2')).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.outliner-search-input')).toHaveValue('');
    await expect(page.locator('.outliner-tree > .outliner-node')).toHaveCount(4);
    expect(await where(page)).toEqual({ mode: 'select', kind: 'outline', id: 'n2' });
    // 選択モードの Esc: ノードの選択（Cmd+click）を外す
    await page.locator(outlineText('n3')).click({ modifiers: [MOD as 'Meta' | 'Control'] });
    expect(await page.evaluate(() => (window as any).__fractalSelTrace.selectedIds())).toEqual(['n3']);
    expect(await where(page)).toEqual({ mode: 'select', kind: 'outline', id: 'n2' });
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (window as any).__fractalSelTrace.selectedIds())).toEqual([]);
    expect(await where(page)).toEqual({ mode: 'select', kind: 'outline', id: 'n2' });
});

test('TC-TSM-10 D9 編集モードの矢印は端だけ隣のセル。移った先も編集モード（Date は入力欄・選択肢はセルの中のカーソル）。Date の ↑↓ は数字を変えない', async ({ page }) => {
    await boot(page);
    await page.locator(cell('text', 'n1')).click();
    await page.keyboard.press('Enter'); // 末尾
    await page.keyboard.press('ArrowRight');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'date', id: 'n1', tag: 'INPUT' });
    expect(await caret(page), '→ で来たら先頭').toBe(0);
    await page.keyboard.press('ArrowDown');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'date', id: 'n1a', tag: 'INPUT' });
    expect(await val(page, 'n1', 'c_date'), '↓ で数字を変えない').toBe('2026-01-01');
    await page.keyboard.press('ArrowRight'); // 空の欄 = 末尾
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'dt', id: 'n1a', tag: 'INPUT' });
    await page.keyboard.press('ArrowRight');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'tag', id: 'n1a', tag: 'INPUT' });
    expect(await dropdownVisible(page)).toBe(false);
    await page.keyboard.press('ArrowUp');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'tag', id: 'n1', tag: 'INPUT' });
    await expect(page.locator(cell('tag', 'n1') + ' .outliner-chip')).toHaveCount(1);
    await page.keyboard.press('ArrowLeft'); // 空の入力欄の先頭
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'dt', id: 'n1', tag: 'INPUT' });
    expect(await caret(page), '← で来たら末尾').toBe('2026-01-01 09:30'.length);
    await page.keyboard.press('ArrowUp'); // 1 行目: 隣は無いが数字は変えない
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'dt', id: 'n1', tag: 'INPUT' });
    expect(await val(page, 'n1', 'c_dt')).toBe('2026-01-01T09:30');
    await page.keyboard.press('ArrowLeft'); // 途中は欄の中
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'dt', id: 'n1' });
    await page.keyboard.press('ArrowDown');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'dt', id: 'n1a', tag: 'INPUT' });
    expect(await val(page, 'n1', 'c_dt')).toBe('2026-01-01T09:30');
    // 文字のセルから ↓ で来ても、編集のまま（文字のセルは caret）
    await page.locator(cell('text', 'n1')).dblclick();
    await page.keyboard.press('ArrowDown');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'text', id: 'n1a' });
});

test('TC-TSM-11 D10 選択肢の編集モード: カーソルだけ → 打つと一覧（絞り込み）・↑↓ / Enter は一覧、一覧が無いときの矢印は隣のセル、Esc で抜ける', async ({ page }) => {
    await boot(page);
    await page.locator(cell('tag', 'n1')).dblclick();
    const input = page.locator(cell('tag', 'n1') + ' input.outliner-multiselect-input');
    await expect(input).toBeFocused();
    expect(await dropdownVisible(page), '文字を打つまで一覧は出さない').toBe(false);
    await expect(page.locator(cell('tag', 'n1') + ' .outliner-chip')).toHaveText(['#red×']);
    await page.keyboard.type('g');
    expect(await dropdownVisible(page)).toBe(true);
    const labels = () => page.locator('.outliner-multiselect-dropdown .outliner-multiselect-item .outliner-chip, .outliner-multiselect-dropdown .outliner-multiselect-create').allTextContents();
    expect(await labels()).toEqual(['#green', '+ Create #g']);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.outliner-multiselect-dropdown .is-highlighted .outliner-chip')).toHaveText('#green');
    expect(await where(page), '一覧の ↑↓ ではセルを移らない').toMatchObject({ mode: 'edit', kind: 'tag', id: 'n1' });
    await page.keyboard.press('Enter');
    expect(await val(page, 'n1', 'c_tag')).toEqual(['o_red', 'o_green']);
    expect(await where(page)).toEqual({ mode: 'select', kind: 'tag', id: 'n1' });
    // 打った文字を消すと一覧は消える
    await page.keyboard.press('Enter');
    await page.keyboard.type('b');
    expect(await dropdownVisible(page)).toBe(true);
    await page.keyboard.press('Backspace');
    expect(await dropdownVisible(page)).toBe(false);
    // 一覧が無いとき: ↓ は隣のセル（編集のまま）、← は先頭で隣
    await page.keyboard.press('ArrowDown');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'tag', id: 'n1a', tag: 'INPUT' });
    await page.keyboard.press('ArrowLeft');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'dt', id: 'n1a', tag: 'INPUT' });
    await page.keyboard.press('Escape');
    expect(await where(page)).toEqual({ mode: 'select', kind: 'dt', id: 'n1a' });
    // マウスで一覧の項目を押すと付け外し（編集は続く）。Esc で抜ける
    await page.locator(cell('tag', 'n3')).dblclick();
    await page.keyboard.type('#');
    await page.locator('.outliner-multiselect-dropdown .outliner-multiselect-item', { hasText: '#blue' }).click();
    expect(await val(page, 'n3', 'c_tag')).toEqual(['o_blue']);
    await expect(page.locator(cell('tag', 'n3') + ' input.outliner-multiselect-input')).toBeFocused();
    await expect(page.locator(cell('tag', 'n3') + ' .outliner-chip')).toHaveCount(1);
    await page.keyboard.press('Escape');
    expect(await where(page)).toEqual({ mode: 'select', kind: 'tag', id: 'n3' });
    await expect(page.locator('.outliner-multiselect-input')).toHaveCount(0);
});

test('TC-TSM-12 D11 初期化の「最初のノードに focus」・table への切り替えは選択モード（focus のある行の outline の列）', async ({ page }) => {
    // 保存された viewMode が table のまま開く → 先頭の行の outline の列
    await boot(page, { ...DATA, viewMode: 'table' }, null);
    expect(await where(page)).toEqual({ mode: 'select', kind: 'outline', id: 'n1' });
    // outliner で n2 を編集中に table へ → n2 の outline の列
    await boot(page, DATA, null);
    await page.locator('.outliner-node[data-id="n2"] .outliner-text').click();
    await page.evaluate(() => (window as any).Outliner.setViewMode('table'));
    expect(await where(page)).toEqual({ mode: 'select', kind: 'outline', id: 'n2' });
    // mindmap → table でも同じ（focus のある行 = n3）
    await page.evaluate(() => (window as any).Outliner.setViewMode('outliner'));
    await page.locator('.outliner-node[data-id="n3"] .outliner-text').click();
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.evaluate(() => (window as any).Outliner.setViewMode('table'));
    expect(await where(page)).toEqual({ mode: 'select', kind: 'outline', id: 'n3' });
    // table を出ると選択モードは終わる（受け口の focus・枠を残さない）
    await page.evaluate(() => (window as any).Outliner.setViewMode('outliner'));
    expect(await page.evaluate(() => !!document.activeElement?.classList.contains('outliner-table-sel-proxy'))).toBe(false);
    await expect(page.locator('.is-cell-selected')).toHaveCount(0);
});

/** CDP で IME の入力を再現する: keydown（keyCode 229）→ 変換中の文字 → 確定 */
async function imeType(page: Page, composing: string[], commit: string) {
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229, key: 'Process', code: 'KeyA' });
    for (const c of composing) {
        await client.send('Input.imeSetComposition', { text: c, selectionStart: c.length, selectionEnd: c.length });
    }
    await client.send('Input.insertText', { text: commit });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229, key: 'Process', code: 'KeyA' });
    await client.detach();
}

test('TC-TSM-13 D4 選択モードで IME を打つ: 変換はセルの中で始まる（文字・outline の列・選択肢）。Date は確定した数字で入れ直す', async ({ page }) => {
    await boot(page);
    await page.locator(cell('text', 'n1')).click();
    await imeType(page, ['か', 'かん'], '漢');
    expect(await val(page, 'n1', 'c_txt')).toBe('hello world漢');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'text', id: 'n1' });
    await page.locator(outlineText('n3')).click();
    await imeType(page, ['じ'], '字');
    expect((await node(page, 'n3')).text).toBe('row3字');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'outline', id: 'n3' });
    await page.locator(cell('tag', 'n3')).click();
    await imeType(page, ['あ'], 'あお');
    await expect(page.locator(cell('tag', 'n3') + ' input.outliner-multiselect-input')).toHaveValue('あお');
    expect(await dropdownVisible(page)).toBe(true);
    // Date: 受け口で変換し、確定した数字（全角も）で入れ直す
    await page.keyboard.press('Escape');
    await page.locator(cell('date', 'n3')).click();
    await imeType(page, ['２'], '２０２６１１０６');
    expect(await val(page, 'n3', 'c_date')).toBe('2026-11-06');
    await expect(page.locator(cell('date', 'n3') + ' input.outliner-cell-date-input')).toHaveValue('2026-11-06');
    // 受け口に変換の文字を残さない
    expect(await page.evaluate(() => (document.querySelector('.outliner-table-sel-proxy') as HTMLElement).textContent)).not.toContain('２');
});

test('TC-TSM-14 scope の先頭行も同じ操作（選択・編集・空にする）。outliner（非 table）のクリックは今どおりカーソル', async ({ page }) => {
    await boot(page);
    await page.locator(outlineText('n1')).click();
    await page.keyboard.press(`${MOD}+]`);
    await page.waitForTimeout(150);
    await expect(page.locator('.outliner-tree > .outliner-node.outliner-scope-header[data-id="n1"]')).toHaveCount(1);
    await page.locator(cell('text', 'n1')).click();
    expect(await where(page)).toEqual({ mode: 'select', kind: 'text', id: 'n1' });
    await page.keyboard.press('ArrowDown');
    expect(await where(page)).toEqual({ mode: 'select', kind: 'text', id: 'n1a' });
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowLeft');
    expect(await where(page)).toEqual({ mode: 'select', kind: 'outline', id: 'n1' });
    await page.keyboard.press('Delete');
    expect((await node(page, 'n1')).text).toBe('');
    await page.keyboard.press(`${MOD}+z`);
    expect((await node(page, 'n1')).text).toBe('row1');
    await page.keyboard.press('Enter');
    expect(await where(page)).toMatchObject({ mode: 'edit', kind: 'outline', id: 'n1' });
    // outliner（非 table）: クリックはカーソル（受け口・枠は出さない）
    await boot(page, DATA, null);
    await page.locator('.outliner-node[data-id="n2"] .outliner-text').click();
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).className)).toBe('outliner-text');
    await expect(page.locator('.is-cell-selected')).toHaveCount(0);
    await page.keyboard.type('!');
    expect((await node(page, 'n2')).text).toContain('!');
});

test('TC-TSM-15 選択モードから行のショートカット（Cmd+Shift+↓・Cmd+.・Shift+↓）が効く。行（ノード）を選んでいる間の Cmd+C / Delete は今どおり行に効く', async ({ page }) => {
    await boot(page);
    const roots = () => page.evaluate(() => (window as any).__testApi.getModel().rootIds.slice());
    const selIds = () => page.evaluate(() => (window as any).__fractalSelTrace.selectedIds());
    // Cmd+Shift+↓ = 行の移動（選択モードのまま）
    await page.locator(cell('text', 'n2')).click();
    await page.keyboard.press(`${MOD}+Shift+ArrowDown`);
    expect(await roots()).toEqual(['n1', 'n3', 'n2']);
    expect(await where(page)).toEqual({ mode: 'select', kind: 'text', id: 'n2' });
    // Cmd+. = 折りたたみ
    await page.locator(cell('date', 'n1')).click();
    await page.keyboard.press(`${MOD}+.`);
    expect((await node(page, 'n1')).collapsed).toBe(true);
    expect(await where(page)).toEqual({ mode: 'select', kind: 'date', id: 'n1' });
    // Shift+↓ = 行の範囲選択（1 回目は今の行だけ・2 回目で下へ）。セルの選択も下へ
    await page.keyboard.press('Shift+ArrowDown');
    expect(await selIds()).toEqual(['n1']);
    await page.keyboard.press('Shift+ArrowDown');
    expect(await selIds()).toEqual(['n1', 'n3']);
    expect(await where(page)).toEqual({ mode: 'select', kind: 'date', id: 'n3' });
    // 行を選んでいる間の Cmd+C = 行（ノード）のコピー（今どおり）
    await page.evaluate(() => { (window as any).__testApi.messages = []; });
    await page.keyboard.press(`${MOD}+c`);
    const saved = await page.evaluate(() => (window as any).__testApi.messages.find((m: any) => m.type === 'saveOutlinerClipboard'));
    expect(saved?.plainText).toContain('row1');
    expect(saved?.plainText).toContain('row3');
    // Delete = 選んだ行の削除（今どおり）。選択モードは残った行へ。Cmd+Z で戻る
    await page.keyboard.press('Delete');
    expect(await roots()).toEqual(['n2']);
    expect(await where(page)).toEqual({ mode: 'select', kind: 'date', id: 'n2' });
    await page.keyboard.press(`${MOD}+z`);
    expect(await roots()).toEqual(['n1', 'n3', 'n2']);
    expect((await where(page) as any).mode).toBe('select');
});
