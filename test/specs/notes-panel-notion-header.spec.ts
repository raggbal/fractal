/**
 * notes-panel-notion-header — Notes 左パネルを Notion 風に（spec 20261016-1411-notes-panel-notion-header）
 *
 *   ヘッダー行 [☰ 開閉][note 名] → 検索行 [検索 BOX][Aa][W][.*] → タブ行 [Notes][Tools]([Results])
 *   Search タブは廃止（検索 BOX は常設）。検索すると Results タブが Tools の右に現れる。
 *   Cmd+K（非 mac は Ctrl+K）は Notes webview 内のどこからでも検索 BOX へ（window capture）。
 *   md エディタの Cmd+K = リンク挿入は廃止（単体 md では処理せず VS Code へ素通し）。
 *
 * 1 AC = 1 test。title は必ず「AC-n 」で始める（verify は -g "AC-n " — 末尾空白で AC-1 と AC-10.. を分ける）。
 *
 * ハーネス（AC ごとに選ぶ）:
 *   - standalone-notes.html（notes パネル + outliner + md + sidepanel を本番と同じ順で inline した build 成果物。
 *     `npm run test:build:all` で再生成）: レイアウト・実キー入力・Cmd+K の起点 3 面（パネル / outliner / md）。
 *     bridge.togglePanel は `__testApi.notesMessages` に記録される。bridge.search は no-op（Enter 経路で
 *     Results タブが出ることはこれで足りる）。init が 2 回走ること（読み込み時 + テストの initNotesPanel）は
 *     このハーネスの既定の状態（notes-file-panel.spec.ts と同じ）。
 *   - 単体パネル（about:blank + generateNotesFilePanelHtml の CSS/HTML + 現ソースの notes-file-panel.js +
 *     明示メソッド集合の recorder bridge — doc-search-panel.spec.ts と同型。Proxy は使わない）:
 *     bridge.search の呼び出し記録と、host 側の onSearchStart / onSearchPartial / onSearchEnd の駆動（0 件・後着結果）。
 *   - standalone-editor.html（notes-file-panel.js を含まない単体 md）: md 側で Cmd+K を処理しないこと（AC-9）。
 *   - node 側 require / ソース読み: shortcut-list.js（AC-12）、i18n locale（AC-18）。
 *
 * 合成 KeyboardEvent は実キー入力で表現できないもの（defaultPrevented の読み取り / isComposing / keyCode 229）にだけ使う。
 * 否定の assert はセレクタ完全一致の count（例: .file-panel-tab[data-tab="search"] が 0 件）で書く — 部分一致にしない。
 */
import { test, expect, Page, Locator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const PANEL = '#notesFilePanel';
const SEARCH = '#notesSearchInput';
const RESULTS_TAB = '#filePanelTabResults';
const tabSel = (name: string) => `#notesFilePanel .file-panel-tab[data-tab="${name}"]`;
const ACTIVE = /(^|\s)active(\s|$)/;
const COLLAPSED = /(^|\s)collapsed(\s|$)/;

const EMPTY_STRUCTURE = { version: 1, rootIds: [], items: {} };
const TWO_FILES = [
    { filePath: '/test/file1.out', title: 'File1', id: 'file1' },
    { filePath: '/test/file2.out', title: 'File2', id: 'file2' },
];
const TWO_FILES_STRUCTURE = {
    version: 1,
    rootIds: ['file1', 'file2'],
    items: {
        file1: { type: 'file', id: 'file1', title: 'File1' },
        file2: { type: 'file', id: 'file2', title: 'File2' },
    },
};
const MD_FILE = '/Users/test/notes/noteA/page-main.md';

// ───────────────────────── standalone-notes.html ─────────────────────────

async function bootNotes(page: Page): Promise<void> {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

/** 本番と同じ notesFilePanel.init 経路でパネルを（再）初期化する（panelWidth / note 名を渡せる）。 */
async function initPanel(page: Page, opts: { files?: any[]; current?: string | null; structure?: any; width?: number | null; noteName?: string }): Promise<void> {
    await page.evaluate((o) => {
        (window as any).__testApi.initNotesPanel(o.files, o.current, o.structure, o.width, o.noteName);
    }, {
        files: opts.files || [],
        current: opts.current || null,
        structure: opts.structure || EMPTY_STRUCTURE,
        width: opts.width || null,
        noteName: opts.noteName || '',
    });
}

/** outliner に root ノードを並べ、init の遅延 focus（setTimeout 100 → 先頭ノード）が済むまで待つ。 */
async function initOutlinerNodes(page: Page, texts: string[]): Promise<Locator> {
    await page.evaluate((list) => {
        const nodes: Record<string, any> = {};
        const rootIds: string[] = [];
        list.forEach((t, i) => {
            const id = 'n' + (i + 1);
            rootIds.push(id);
            nodes[id] = { id, parentId: null, children: [], text: t, tags: [] };
        });
        (window as any).__testApi.initOutliner({ version: 1, rootIds, nodes });
    }, texts);
    const nodeTexts = page.locator('.outliner-tree .outliner-node .outliner-text');
    await expect(nodeTexts).toHaveCount(texts.length);
    // 非空データの init は setTimeout(100) で先頭ノードへ focus する。それが済んでから操作する（focus の奪い合いを避ける）
    await expect(nodeTexts.first()).toBeFocused();
    return nodeTexts;
}

/** md メインペインを開く（notes-md-cmdf-search.spec.ts と同じ updateData kind:'md' 経路）。 */
async function openMainMd(page: Page, markdown: string, expectText: string): Promise<Locator> {
    await page.evaluate(({ md, fp }) => {
        (window as any).__hostMessageHandler({ type: 'updateData', kind: 'md', markdown: md, filePath: fp, documentBaseUri: '' });
    }, { md: markdown, fp: MD_FILE });
    const ed = page.locator('.markdown-container .editor');
    await expect(ed).toContainText(expectText);
    return ed;
}

/** outliner の sidepanel md を開く（integration-sidepanel-* と同じ openSidePanel 経路）。 */
async function openSidePanelMd(page: Page, markdown: string, expectText: string): Promise<Locator> {
    await page.evaluate((md) => {
        (window as any).__hostMessageHandler({
            type: 'openSidePanel', markdown: md, filePath: '/Users/test/notes/noteA/side.md',
            fileName: 'side.md', toc: [], documentBaseUri: '',
        });
    }, markdown);
    await expect(page.locator('.side-panel')).toHaveClass(/(^|\s)open(\s|$)/);
    const ed = page.locator('.side-panel .editor');
    await expect(ed).toContainText(expectText);
    return ed;
}

/** root 内の最初の `word` を選択する（選択の用意だけ。検証対象の操作は実キー入力で行う）。 */
async function selectWord(page: Page, rootSel: string, word: string): Promise<void> {
    const ok = await page.evaluate(({ rootSel, word }) => {
        const root = document.querySelector(rootSel);
        if (!root) { return false; }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = walker.nextNode())) {
            const i = (n as Text).data.indexOf(word);
            if (i >= 0) {
                const r = document.createRange();
                r.setStart(n, i);
                r.setEnd(n, i + word.length);
                const s = window.getSelection()!;
                s.removeAllRanges();
                s.addRange(r);
                return true;
            }
        }
        return false;
    }, { rootSel, word });
    expect(ok, `"${word}" が ${rootSel} に無い`).toBe(true);
}

/** root 内の選択範囲を「root 先頭からの文字オフセット」で返す（root 外 / 選択なしは null）。 */
function selectionIn(page: Page, rootSel: string): Promise<{ start: number; end: number; text: string } | null> {
    return page.evaluate((sel) => {
        const root = document.querySelector(sel);
        const s = window.getSelection();
        if (!root || !s || s.rangeCount === 0) { return null; }
        const r = s.getRangeAt(0);
        if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) { return null; }
        const pre = document.createRange();
        pre.selectNodeContents(root);
        pre.setEnd(r.startContainer, r.startOffset);
        const start = pre.toString().length;
        return { start, end: start + r.toString().length, text: r.toString() };
    }, rootSel);
}

function inputSelection(page: Page): Promise<{ start: number | null; end: number | null; value: string }> {
    return page.evaluate(() => {
        const i = document.getElementById('notesSearchInput') as HTMLInputElement;
        return { start: i.selectionStart, end: i.selectionEnd, value: i.value };
    });
}

function activeIsBody(page: Page): Promise<boolean> {
    return page.evaluate(() => document.activeElement === document.body);
}

async function blurAll(page: Page): Promise<void> {
    await page.evaluate(() => {
        const ae = document.activeElement as HTMLElement | null;
        if (ae && ae !== document.body && typeof ae.blur === 'function') { ae.blur(); }
    });
    expect(await activeIsBody(page), 'body に focus が無い（前提崩れ）').toBe(true);
}

/** spec の mac 判定（/Mac|iPhone|iPad|iPod/ — navigator.platform 優先）をページ内で評価する。 */
function isMacPage(page: Page): Promise<boolean> {
    return page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent));
}

/**
 * 合成の Cmd+K（mac）/ Ctrl+K（非 mac）keydown を target に dispatch する。
 * 実キー入力では読めない defaultPrevented と、document まで伝播したか（bubble 段の document = md / outliner の
 * 委譲ハンドラと同じ位置）を返す。isComposing / keyCode 229 もここでだけ作る。
 */
function dispatchModK(page: Page, targetSel: string, extra: { isComposing?: boolean; keyCode229?: boolean } = {}) {
    return page.evaluate(({ targetSel, extra }) => {
        const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
        const target = document.querySelector(targetSel) || document.body;
        const ev = new KeyboardEvent('keydown', {
            key: 'k', code: 'KeyK', metaKey: isMac, ctrlKey: !isMac,
            isComposing: !!extra.isComposing, bubbles: true, cancelable: true,
        });
        if (extra.keyCode229) { Object.defineProperty(ev, 'keyCode', { get: () => 229 }); }
        let reachedDocument = 0;
        const probe = (e: Event) => { if (e === ev) { reachedDocument++; } };
        document.addEventListener('keydown', probe);
        target.dispatchEvent(ev);
        document.removeEventListener('keydown', probe);
        const ae = document.activeElement as HTMLElement | null;
        return { defaultPrevented: ev.defaultPrevented, reachedDocument, activeId: ae ? ae.id : null };
    }, { targetSel, extra });
}

/** パネル幅を詰めたときの各行の溢れと、ボタン類がパネルの表示域（overflow:hidden の内側）に収まっているか。 */
function measurePanelRows(page: Page) {
    return page.evaluate(() => {
        const panel = document.getElementById('notesFilePanel') as HTMLElement;
        const pr = panel.getBoundingClientRect();
        const inner = { left: pr.left + panel.clientLeft, right: pr.left + panel.clientLeft + panel.clientWidth };
        const q = (sel: string) => document.querySelector(sel) as HTMLElement;
        const row = (sel: string) => { const el = q(sel); return { sw: el.scrollWidth, cw: el.clientWidth }; };
        const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height }; };
        const title = q('#notesTitleLabel');
        return {
            inlineWidth: panel.style.width,
            inner,
            rows: {
                header: row('#notesFilePanel .file-panel-header'),
                searchBar: row('#notesSearchBar'),
                tabs: row('#notesFilePanel .file-panel-tabs'),
            },
            buttons: ['#filePanelCollapse', '#notesSearchClear', '#notesSearchCase', '#notesSearchWord', '#notesSearchRegex']
                .map((s) => Object.assign({ sel: s }, box(q(s)))),
            input: box(q('#notesSearchInput')),
            title: Object.assign({ sw: title.scrollWidth, cw: title.clientWidth, textOverflow: getComputedStyle(title).textOverflow }, box(title)),
            visibleTabs: Array.from(panel.querySelectorAll('.file-panel-tabs .file-panel-tab'))
                .filter((t) => getComputedStyle(t).display !== 'none')
                .map((t) => Object.assign({ tab: (t as HTMLElement).dataset.tab || '' }, box(t))),
        };
    });
}

// ───────────────────────── 単体パネル（recorder bridge） ─────────────────────────

/**
 * 現ソースの notes-body-html（CSS/HTML）+ notes-file-panel.js を about:blank に載せ、明示メソッド集合の
 * recorder bridge で init する。bridge 呼び出しは window.__calls、host 側コールバックは
 * window.__onSearchStart / __onSearchPartial / __onSearchEnd に取り出す（テストが host 役で駆動する）。
 */
async function bootPanelUnit(page: Page, opts: { files?: any[]; structure?: any } = {}): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { generateNotesFilePanelHtml } = require('../../src/shared/notes-body-html.js');
    const panel = generateNotesFilePanelHtml({ collapsed: false, messages: {} });
    const panelJs = fs.readFileSync(path.join(ROOT, 'src/shared/notes-file-panel.js'), 'utf8');
    await page.goto('about:blank');
    await page.setContent(
        '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<style>' + panel.css + '</style>' +
        '</head><body><div class="notes-layout">' + panel.html + '</div></body></html>');
    await page.evaluate(() => {
        const w = window as any;
        w.__outlinerMessages = {};
        w.__calls = [];
        const rec = (type: string) => function () {
            const args = Array.prototype.slice.call(arguments);
            w.__calls.push({ type, args });
            if (type === 'onSearchStart') { w.__onSearchStart = args[0]; }
            if (type === 'onSearchPartial') { w.__onSearchPartial = args[0]; }
            if (type === 'onSearchEnd') { w.__onSearchEnd = args[0]; }
        };
        // 実 bridge（notes-host-bridge.js）に在るメソッドのうち本 spec が触る経路だけを明示定義（Proxy 禁止）
        w.__bridge = {
            onSearchStart: rec('onSearchStart'),
            onSearchPartial: rec('onSearchPartial'),
            onSearchEnd: rec('onSearchEnd'),
            search: rec('search'),
            jumpToNode: rec('jumpToNode'),
            jumpToMdPage: rec('jumpToMdPage'),
            openFile: rec('openFile'),
            togglePanel: rec('togglePanel'),
            savePanelWidth: rec('savePanelWidth'),
            toggleFolder: rec('toggleFolder'),
        };
    });
    await page.addScriptTag({ content: panelJs });
    await page.evaluate((o) => {
        const w = window as any;
        w.notesFilePanel.init(w.__bridge, o.files, null, o.structure, null, 'MyNote');
        w.__calls = [];   // init 中の登録呼び出しを捨て、操作による呼び出しだけを観測する
    }, { files: opts.files || [], structure: opts.structure || EMPTY_STRUCTURE });
    expect(await page.evaluate(() => typeof (window as any).__onSearchStart), 'onSearchStart の登録が無い').toBe('function');
}

/** recorder bridge の type 別呼び出し引数（関数を含む登録系は除く用途で使う）。 */
function bridgeCalls(page: Page, type: string): Promise<any[][]> {
    return page.evaluate((t) => (window as any).__calls
        .filter((c: any) => c.type === t)
        .map((c: any) => JSON.parse(JSON.stringify(c.args))), type);
}

// ───────────────────────── locale（AC-18） ─────────────────────────

const LOCALES = ['en', 'ja', 'es', 'fr', 'ko', 'zh-cn', 'zh-tw'];

/** `key: '...'` / `key: "..."` の値を取り出す（locale ファイルは平の object literal）。無ければ null。 */
function localeString(src: string, key: string): string | null {
    const re = new RegExp("(?:^|[\\s{,])['\"]?" + key + "['\"]?\\s*:\\s*(?:'((?:\\\\.|[^'\\\\\\n])*)'|\"((?:\\\\.|[^\"\\\\\\n])*)\")", 'm');
    const m = src.match(re);
    if (!m) { return null; }
    return m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : null);
}

// ═════════════════════════════════════════════════════════════════════════

test.describe('Notes 左パネル — Notion 風ヘッダー / 常設検索 BOX / アイコンタブ / Cmd+K', () => {

    test('AC-1 header: the ☰ collapse button comes first and the note name sits right next to it on the same row', async ({ page }) => {
        await bootNotes(page);
        await initPanel(page, { noteName: 'Research Notes' });

        const header = page.locator('#notesFilePanel .file-panel-header');
        const btn = page.locator('#filePanelCollapse');
        const title = page.locator('#notesTitleLabel');
        await expect(title).toHaveText('Research Notes');
        await expect(btn).toBeVisible();
        await expect(title).toBeVisible();

        // DOM: 開閉ボタンがヘッダー行の先頭要素、note 名も同じヘッダー行の中
        const dom = await page.evaluate(() => {
            const h = document.querySelector('#notesFilePanel .file-panel-header') as HTMLElement;
            const first = h.firstElementChild as HTMLElement | null;
            return {
                firstId: first ? first.id : null,
                titleInHeader: h.contains(document.getElementById('notesTitleLabel')),
                btnInHeader: h.contains(document.getElementById('filePanelCollapse')),
            };
        });
        expect(dom).toEqual({ firstId: 'filePanelCollapse', titleInHeader: true, btnInHeader: true });

        // レイアウト: ボタンが左・note 名がその右隣・縦位置が同じ行
        const b = (await btn.boundingBox())!;
        const t = (await title.boundingBox())!;
        const h = (await header.boundingBox())!;
        expect(b.x + b.width, 'ボタンの右端が note 名の左端より右にある').toBeLessThanOrEqual(t.x + 0.5);
        expect(t.x - (b.x + b.width), 'note 名がボタンの隣に無い（間が空きすぎ）').toBeLessThanOrEqual(16);
        expect(Math.abs((b.y + b.height / 2) - (t.y + t.height / 2)), '同じ行に並んでいない').toBeLessThanOrEqual(4);
        expect(b.x - h.x, 'ボタンがヘッダー左端に無い').toBeLessThanOrEqual(16);
        for (const r of [b, t]) {
            expect(r.y).toBeGreaterThanOrEqual(h.y - 0.5);
            expect(r.y + r.height).toBeLessThanOrEqual(h.y + h.height + 0.5);
        }

        // note 名クリックで rename に入る挙動は位置が変わっても同じ（Esc で取消）
        await title.click();
        await expect(title).toHaveAttribute('contenteditable', 'true');
        await page.keyboard.press('Escape');
        await expect(title).not.toHaveAttribute('contenteditable', 'true');
        await expect(title).toHaveText('Research Notes');
    });

    test('AC-2 search row: the box is between the header and the tabs; Aa / W / .* live inside the box, hidden until focus, then at its right end on one row', async ({ page }) => {
        await bootNotes(page);
        const input = page.locator(SEARCH);

        // 初期表示（Notes タブ）で検索 BOX が見えている — Search タブを開かなくてよい
        await expect(page.locator(tabSel('notes'))).toHaveClass(ACTIVE);
        await expect(input).toBeVisible();
        await expect(page.locator('#notesSearchBar #notesSearchInput')).toHaveCount(1);
        await expect(page.locator('#filePanelContentSearch #notesSearchInput')).toHaveCount(0);
        const OPTS = ['#notesSearchCase', '#notesSearchWord', '#notesSearchRegex'];
        for (const id of OPTS) {
            // D13: BOX の中（入力欄と同じ .file-panel-search-box の子孫）
            await expect(page.locator('#notesSearchBar .file-panel-search-box ' + id)).toHaveCount(1);
            await expect(page.locator(id), `非 focus で ${id} が見えている`).toBeHidden();
        }

        await input.click();
        for (const id of OPTS) await expect(page.locator(id)).toBeVisible();
        const r = await page.evaluate(() => {
            const box = (sel: string) => {
                const b = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
                return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
            };
            return {
                header: box('#notesFilePanel .file-panel-header'),
                tabs: box('#notesFilePanel .file-panel-tabs'),
                input: box('#notesSearchInput'),
                aa: box('#notesSearchCase'), w: box('#notesSearchWord'), re: box('#notesSearchRegex'),
            };
        });
        expect(r.input.top, '検索 BOX がヘッダーより上').toBeGreaterThanOrEqual(r.header.bottom - 0.5);
        expect(r.input.bottom, '検索 BOX がタブ行より下').toBeLessThanOrEqual(r.tabs.top + 0.5);
        for (const [name, b] of [['Aa', r.aa], ['W', r.w], ['.*', r.re]] as const) {
            const cy = (b.top + b.bottom) / 2;
            expect(cy, `${name} が BOX と同じ行に無い`).toBeGreaterThan(r.input.top);
            expect(cy, `${name} が BOX と同じ行に無い`).toBeLessThan(r.input.bottom);
            expect(b.left, `${name} が BOX の左外`).toBeGreaterThanOrEqual(r.input.left - 0.5);
            expect(b.right, `${name} が BOX の右外`).toBeLessThanOrEqual(r.input.right + 0.5);
        }
        expect(r.aa.right).toBeLessThanOrEqual(r.w.left + 0.5);
        expect(r.w.right).toBeLessThanOrEqual(r.re.left + 0.5);
        expect(r.input.right - r.re.right, '.* が BOX の右端に無い').toBeLessThanOrEqual(8);

        // 常設: Tools タブに切り替えても BOX は見えたまま
        await page.locator(tabSel('tools')).click();
        await expect(page.locator(tabSel('tools'))).toHaveClass(ACTIVE);
        await expect(input).toBeVisible();
    });

    test('AC-22 the box is narrower than the row until focused, then fills the row; Aa toggles without stealing focus; blur hides every in-box button but keeps the option state', async ({ page }) => {
        await bootNotes(page);
        const input = page.locator(SEARCH);
        const width = () => page.evaluate(() => {
            const bar = document.getElementById('notesSearchBar') as HTMLElement;
            const cs = getComputedStyle(bar);
            const inner = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
            return { box: (document.querySelector('#notesSearchBar .file-panel-search-box') as HTMLElement).getBoundingClientRect().width, inner };
        });
        const before = await width();
        expect(before.inner - before.box, '非 focus の BOX が行いっぱい（狭くなっていない）').toBeGreaterThanOrEqual(50);

        await input.click();
        await expect.poll(async () => { const w = await width(); return Math.abs(w.inner - w.box); }, { message: 'focus で BOX が行いっぱいに伸びない' }).toBeLessThanOrEqual(1);

        const aa = page.locator('#notesSearchCase');
        await aa.click();
        await expect(aa).toHaveClass(/(^|\s)active(\s|$)/);
        await expect(input, 'Aa を押したら BOX の focus が外れた').toBeFocused();

        await page.keyboard.type('File');
        await expect(page.locator('#notesSearchClear')).toBeVisible();
        // Tab で BOX の中のボタンへ移っても隠れない（:focus-within）
        await page.keyboard.press('Tab');
        await expect(page.locator('#notesSearchInline :focus')).toHaveCount(1);
        await expect(aa).toBeVisible();
        // focus を外す（ツリーへ）: 文字が残っていても BOX 内のボタンは全部隠れ、BOX は元の幅へ
        await page.locator('#notesFileList').focus();
        for (const id of ['#notesSearchClear', '#notesSearchCase', '#notesSearchWord', '#notesSearchRegex']) {
            await expect(page.locator(id), `非 focus で ${id} が見えている`).toBeHidden();
        }
        await expect(input).toHaveValue('File');
        await expect.poll(async () => { const w = await width(); return w.inner - w.box; }, { message: 'blur で BOX が元の幅に戻らない' }).toBeGreaterThanOrEqual(50);
        // ON の設定は保たれる
        await input.click();
        await expect(aa).toHaveClass(/(^|\s)active(\s|$)/);
    });

    test('AC-3 tabs: only Notes and Tools at start (no data-tab="search"); only the active tab shows its label, others are icon-only', async ({ page }) => {
        await bootNotes(page);
        await expect(page.locator('.file-panel-tab[data-tab="search"]')).toHaveCount(0);

        const visibleTabs = page.locator('#notesFilePanel .file-panel-tabs .file-panel-tab:visible');
        await expect(visibleTabs).toHaveCount(2);
        expect(await visibleTabs.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab))).toEqual(['notes', 'tools']);
        // Results タブは在るが、検索するまで出ない
        await expect(page.locator(RESULTS_TAB)).toHaveCount(1);
        await expect(page.locator(RESULTS_TAB)).toBeHidden();

        const notes = page.locator(tabSel('notes'));
        const tools = page.locator(tabSel('tools'));
        const label = (l: Locator) => l.locator('.file-panel-tab-label');

        await expect(notes).toHaveClass(ACTIVE);
        await expect(tools).not.toHaveClass(ACTIVE);
        await expect(label(notes)).toBeVisible();
        await expect(label(notes)).toHaveText('Notes');
        await expect(label(tools)).toBeHidden();
        await expect(tools.locator('svg')).toBeVisible();   // 非選択 = アイコンのみ
        // ラベルは title / aria-label に残る
        await expect(notes).toHaveAttribute('title', 'Notes');
        await expect(notes).toHaveAttribute('aria-label', 'Notes');
        await expect(tools).toHaveAttribute('title', 'Tools');
        await expect(tools).toHaveAttribute('aria-label', 'Tools');

        // Tools をクリック → 逆転
        await tools.click();
        await expect(tools).toHaveClass(ACTIVE);
        await expect(notes).not.toHaveClass(ACTIVE);
        await expect(label(tools)).toBeVisible();
        await expect(label(tools)).toHaveText('Tools');
        await expect(label(notes)).toBeHidden();
        await expect(notes.locator('svg')).toBeVisible();
        await expect(page.locator('#filePanelContentTools')).toBeVisible();
        await expect(page.locator('#filePanelContentNotes')).toBeHidden();
    });

    test('AC-4 Enter in the box calls bridge.search and shows the Results tab right of Tools as the active tab with the results pane (also for 0 hits)', async ({ page }) => {
        await bootPanelUnit(page);
        const input = page.locator(SEARCH);
        const results = page.locator(RESULTS_TAB);

        await input.click();
        await page.keyboard.type('zebra');
        // D6: 打鍵では検索しない・Results タブもまだ無い
        expect(await bridgeCalls(page, 'search')).toHaveLength(0);
        await expect(results).toBeHidden();

        await page.keyboard.press('Enter');
        const calls = await bridgeCalls(page, 'search');
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('zebra');

        await expect(results).toBeVisible();
        await expect(results).toHaveAttribute('data-tab', 'results');
        await expect(results).toHaveClass(ACTIVE);
        await expect(results.locator('.file-panel-tab-label')).toBeVisible();
        await expect(page.locator(tabSel('notes'))).not.toHaveClass(ACTIVE);
        await expect(page.locator(tabSel('tools'))).not.toHaveClass(ACTIVE);
        await expect(page.locator('#filePanelContentSearch')).toBeVisible();
        await expect(page.locator('#filePanelContentNotes')).toBeHidden();
        await expect(page.locator('#filePanelContentTools')).toBeHidden();

        // Tools の右・同じ行
        const pos = await page.evaluate(() => {
            const box = (sel: string) => {
                const b = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
                return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
            };
            return {
                notes: box('#notesFilePanel .file-panel-tab[data-tab="notes"]'),
                tools: box('#notesFilePanel .file-panel-tab[data-tab="tools"]'),
                results: box('#filePanelTabResults'),
            };
        });
        expect(pos.tools.left).toBeGreaterThanOrEqual(pos.notes.right - 0.5);
        expect(pos.results.left, 'Results タブが Tools の右に無い').toBeGreaterThanOrEqual(pos.tools.right - 0.5);
        const mid = (b: { top: number; bottom: number }) => (b.top + b.bottom) / 2;
        expect(Math.abs(mid(pos.results) - mid(pos.tools)), 'Results タブが Tools と同じ行に無い').toBeLessThanOrEqual(3);

        // host の応答が 0 件でも Results タブは出たまま（件数 0 を表示）
        await page.evaluate(() => { const w = window as any; w.__onSearchStart(1); w.__onSearchEnd(1); });
        await expect(page.locator('#notesSearchCount')).toHaveText(/^\s*0\b/);
        await expect(results).toBeVisible();
        await expect(results).toHaveClass(ACTIVE);
        await expect(page.locator('#filePanelContentSearch')).toBeVisible();

        // host の検索開始通知（onSearchStart）だけでも同じく Results を出す（Enter 経路と冪等）
        await bootPanelUnit(page);
        await page.evaluate(() => {
            (document.getElementById('notesSearchInput') as HTMLInputElement).value = 'zebra';
            (window as any).__onSearchStart(5);
        });
        await expect(page.locator(RESULTS_TAB)).toBeVisible();
        await expect(page.locator(RESULTS_TAB)).toHaveClass(ACTIVE);
        await expect(page.locator('#filePanelContentSearch')).toBeVisible();
        await expect(page.locator('#filePanelContentNotes')).toBeHidden();
    });

    test('AC-5 the Results tab stays icon-only after switching to Notes, brings the results back on click, and disappears when the box is emptied', async ({ page }) => {
        await bootNotes(page);
        const input = page.locator(SEARCH);
        const results = page.locator(RESULTS_TAB);
        const notes = page.locator(tabSel('notes'));
        const tools = page.locator(tabSel('tools'));

        await input.click();
        await page.keyboard.type('alpha');
        await page.keyboard.press('Enter');
        await expect(results).toBeVisible();
        await expect(results).toHaveClass(ACTIVE);

        // Notes へ → Results タブはアイコンのみで残る
        await notes.click();
        await expect(notes).toHaveClass(ACTIVE);
        await expect(results).toBeVisible();
        await expect(results).not.toHaveClass(ACTIVE);
        await expect(results.locator('.file-panel-tab-label')).toBeHidden();
        await expect(results.locator('svg')).toBeVisible();
        await expect(page.locator('#filePanelContentNotes')).toBeVisible();
        await expect(page.locator('#filePanelContentSearch')).toBeHidden();

        // Results をクリック → 結果に戻る
        await results.click();
        await expect(results).toHaveClass(ACTIVE);
        await expect(page.locator('#filePanelContentSearch')).toBeVisible();
        await expect(page.locator('#filePanelContentNotes')).toBeHidden();

        // Results 表示中に BOX を空にする → タブが消えて Notes に戻る
        await input.selectText();
        await page.keyboard.press('Backspace');
        await expect(input).toHaveValue('');
        await expect(results).toBeHidden();
        await expect(notes).toHaveClass(ACTIVE);
        await expect(page.locator('#filePanelContentNotes')).toBeVisible();
        await expect(page.locator('#filePanelContentSearch')).toBeHidden();

        // Results を表示していないとき（Tools）に空にする → タブは消えるが Tools のまま
        await input.click();
        await page.keyboard.type('bravo');
        await page.keyboard.press('Enter');
        await expect(results).toHaveClass(ACTIVE);
        await tools.click();
        await expect(tools).toHaveClass(ACTIVE);
        await input.selectText();
        await page.keyboard.press('Backspace');
        await expect(input).toHaveValue('');
        await expect(results).toBeHidden();
        await expect(tools).toHaveClass(ACTIVE);
        await expect(page.locator('#filePanelContentTools')).toBeVisible();
    });

    test('AC-6 Cmd/Ctrl+K from the tree or body focuses the box with its text selected (defaultPrevented), expands a collapsed panel first; Shift/Alt/other-modifier/IME variants do nothing', async ({ page }) => {
        await bootNotes(page);
        await initPanel(page, { files: TWO_FILES, current: '/test/file1.out', structure: TWO_FILES_STRUCTURE, width: 260 });
        const input = page.locator(SEARCH);
        const tree = page.locator('#notesFileList');
        const panel = page.locator(PANEL);
        await input.fill('foo bar');
        const isMac = await isMacPage(page);

        // (a) パネル内（ツリー）に focus → 実キー Cmd+K（mac）/ Ctrl+K
        await tree.focus();
        await expect(tree).toBeFocused();
        await page.evaluate(() => (document.getElementById('notesSearchInput') as HTMLInputElement).setSelectionRange(2, 2));
        await page.keyboard.press('ControlOrMeta+k');
        await expect(input).toBeFocused();
        expect(await inputSelection(page), '既存テキストが全選択されていない').toEqual({ start: 0, end: 7, value: 'foo bar' });

        // (b) body に focus
        await blurAll(page);
        await page.evaluate(() => (document.getElementById('notesSearchInput') as HTMLInputElement).setSelectionRange(1, 1));
        await page.keyboard.press('ControlOrMeta+k');
        await expect(input).toBeFocused();
        expect(await inputSelection(page)).toEqual({ start: 0, end: 7, value: 'foo bar' });

        // (c) keydown は defaultPrevented（VS Code の chord 待ちに流さない）+ document の委譲ハンドラへ伝播しない
        await tree.focus();
        await expect(tree).toBeFocused();
        const fromTree = await dispatchModK(page, '#notesFileList');
        expect(fromTree.defaultPrevented, 'Cmd/Ctrl+K が preventDefault されていない').toBe(true);
        expect(fromTree.reachedDocument, 'Cmd/Ctrl+K が document まで伝播した（stopPropagation 無し）').toBe(0);
        expect(fromTree.activeId).toBe('notesSearchInput');
        await blurAll(page);
        const fromBody = await dispatchModK(page, 'body');
        expect(fromBody.defaultPrevented).toBe(true);
        expect(fromBody.activeId).toBe('notesSearchInput');

        // (d) パネルが collapsed → 既存の開閉経路（collapsed 解除 + 幅復元 + togglePanel(false)）で開いてから focus
        await page.locator('#filePanelCollapse').click();
        await expect(panel).toHaveClass(COLLAPSED);
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
        await blurAll(page);
        await page.keyboard.press('ControlOrMeta+k');
        await expect(panel).not.toHaveClass(COLLAPSED);
        await expect(input).toBeFocused();
        expect(await inputSelection(page)).toEqual({ start: 0, end: 7, value: 'foo bar' });
        const toggles = await page.evaluate(() => (window as any).__testApi.notesMessages
            .filter((m: any) => m.type === 'togglePanel')
            .map((m: any) => ({ type: m.type, collapsed: m.collapsed })));
        expect(toggles, 'bridge.togglePanel(false) が 1 回だけ届いていない').toEqual([{ type: 'togglePanel', collapsed: false }]);
        expect(await page.evaluate(() => (document.getElementById('notesFilePanel') as HTMLElement).style.width),
            '開いたときに保存済みのパネル幅が戻っていない').toBe('260px');

        // (e) 反応しない組み合わせ: Cmd+Shift+K（code block）/ Cmd+Alt+K / 他 OS の修飾キー / IME 変換中
        const negatives = ['ControlOrMeta+Shift+k', 'ControlOrMeta+Alt+k', isMac ? 'Control+k' : 'Meta+k'];
        for (const combo of negatives) {
            await tree.focus();
            await expect(tree).toBeFocused();
            await page.keyboard.press(combo);
            await expect(input, `${combo} で検索 BOX に focus した`).not.toBeFocused();
            await expect(tree, `${combo} で focus が動いた`).toBeFocused();
        }
        await tree.focus();
        const composing = await dispatchModK(page, '#notesFileList', { isComposing: true });
        expect(composing, 'IME 変換中（isComposing）の Cmd/Ctrl+K に反応した').toEqual({ defaultPrevented: false, reachedDocument: 1, activeId: 'notesFileList' });
        const kc229 = await dispatchModK(page, '#notesFileList', { keyCode229: true });
        expect(kc229, 'IME 変換中（keyCode 229）の Cmd/Ctrl+K に反応した').toEqual({ defaultPrevented: false, reachedDocument: 1, activeId: 'notesFileList' });
    });

    test('AC-7 Cmd/Ctrl+K while editing an outliner node focuses the box and leaves the node text unchanged', async ({ page }) => {
        await bootNotes(page);
        const nodeTexts = await initOutlinerNodes(page, ['alpha bravo', 'charlie delta']);
        const target = nodeTexts.nth(1);
        await target.click();
        await expect(target).toBeFocused();
        await page.keyboard.press('End');

        const snapshot = () => page.evaluate(() => ({
            texts: Array.from(document.querySelectorAll('.outliner-tree .outliner-node .outliner-text')).map((e) => e.textContent),
            nodeCount: document.querySelectorAll('.outliner-tree .outliner-node').length,
        }));
        const before = await snapshot();
        expect(before).toEqual({ texts: ['alpha bravo', 'charlie delta'], nodeCount: 2 });

        await page.keyboard.press('ControlOrMeta+k');
        await expect(page.locator(SEARCH)).toBeFocused();
        expect(await snapshot(), 'Cmd/Ctrl+K でノードが変わった').toEqual(before);
    });

    test('AC-8 Cmd/Ctrl+K while editing the md pane focuses the box and inserts no link into the md', async ({ page }) => {
        await bootNotes(page);
        const ed = await openMainMd(page, '# Title\n\nalpha bravo charlie\n', 'alpha bravo charlie');
        await ed.click();
        await expect(ed).toBeFocused();
        await selectWord(page, '.markdown-container .editor', 'bravo');   // 旧挙動ならここが <a href="#">bravo</a> になる

        const htmlBefore = await ed.innerHTML();
        const mdBefore = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(mdBefore).toContain('alpha bravo charlie');

        await page.keyboard.press('ControlOrMeta+k');
        await expect(page.locator(SEARCH)).toBeFocused();
        await expect(page.locator('.markdown-container .editor a')).toHaveCount(0);
        expect(await ed.innerHTML(), 'md の DOM が変わった').toBe(htmlBefore);
        const mdAfter = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(mdAfter, 'md にリンク記法が入った').toBe(mdBefore);
        expect(mdAfter).not.toContain('](');
    });

    test('AC-9 standalone md editor: Cmd/Ctrl+K inserts no link and the keydown is not defaultPrevented (passes through to VS Code)', async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate(() => (window as any).__testApi.setMarkdown('hello world\n'));
        const ed = page.locator('#editor');
        await expect(ed).toContainText('hello world');
        await ed.click();
        await selectWord(page, '#editor', 'world');
        const mdBefore = await page.evaluate(() => (window as any).__testApi.getMarkdown());

        // 実キー: リンクが入らない
        await page.keyboard.press('ControlOrMeta+k');
        await expect(page.locator('#editor a')).toHaveCount(0);
        const mdAfter = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(mdAfter, 'md にリンク記法が入った').toBe(mdBefore);
        expect(mdAfter).not.toContain('](');

        // 合成（defaultPrevented の読み取り）: md は Cmd/Ctrl+K を処理しない = preventDefault しない
        await expect(ed).toBeFocused();
        const r = await dispatchModK(page, '#editor');
        expect(r.defaultPrevented, 'md が Cmd/Ctrl+K を preventDefault した（VS Code へ素通しにならない）').toBe(false);
        await expect(page.locator('#editor a')).toHaveCount(0);

        // 対照: 同じハーネスで修飾キー + K の経路は生きている（Cmd/Ctrl+Shift+K = code block は従来どおり）
        await ed.click();
        await selectWord(page, '#editor', 'world');
        await page.keyboard.press('ControlOrMeta+Shift+k');
        await expect(page.locator('#editor pre')).toHaveCount(1);
    });

    test('AC-10 Esc returns focus to the element focused before Cmd/Ctrl+K; Esc after entering by click only blurs; neither switches tabs', async ({ page }) => {
        await bootNotes(page);
        const nodeTexts = await initOutlinerNodes(page, ['alpha', 'bravo']);
        const input = page.locator(SEARCH);
        const tools = page.locator(tabSel('tools'));

        // Tools タブを表示しておく（旧挙動「Esc → Notes タブ」が混ざれば見える）
        await tools.click();
        await expect(tools).toHaveClass(ACTIVE);

        // Cmd+K で入る → Esc → 直前の focus（outliner のノード）へ戻る
        const origin = nodeTexts.nth(1);
        await origin.click();
        await expect(origin).toBeFocused();
        await page.keyboard.press('ControlOrMeta+k');
        await expect(input).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(origin).toBeFocused();
        await expect(tools).toHaveClass(ACTIVE);
        await expect(page.locator('#filePanelContentTools')).toBeVisible();
        await expect(page.locator('#filePanelContentNotes')).toBeHidden();

        // クリックで入る → Esc → blur のみ（どこにも focus を移さない）
        await input.click();
        await expect(input).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(input).not.toBeFocused();
        expect(await activeIsBody(page), 'クリックで入った Esc が blur 以外のことをした').toBe(true);
        await expect(tools).toHaveClass(ACTIVE);

        // 戻り先は BOX に居る間だけ: Cmd+K → 他所をクリック → BOX をクリック → Esc は blur のみ
        await origin.click();
        await page.keyboard.press('ControlOrMeta+k');
        await expect(input).toBeFocused();
        await page.locator('#filePanelContentTools .file-panel-section-title').first().click();
        await expect(input).not.toBeFocused();
        await input.click();
        await expect(input).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(input).not.toBeFocused();
        expect(await activeIsBody(page), 'BOX を離れた後も古い戻り先へ focus した').toBe(true);
        await expect(tools).toHaveClass(ACTIVE);
    });

    test('AC-11 at 140px the header, search row and tab row do not overflow and ☰ / Aa / W / .* stay inside the panel', async ({ page }) => {
        await bootNotes(page);
        await initPanel(page, { width: 140, noteName: 'A rather long note folder name that has to be ellipsized' });
        await page.locator(SEARCH).fill('a search query that is much wider than the box');
        // D15: focus で BOX が行いっぱいに伸びきるのを待ってから測る
        await expect.poll(() => page.evaluate(() => {
            const bar = document.getElementById('notesSearchBar') as HTMLElement;
            const cs = getComputedStyle(bar);
            const inner = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
            return Math.abs(inner - (document.querySelector('#notesSearchBar .file-panel-search-box') as HTMLElement).getBoundingClientRect().width);
        })).toBeLessThanOrEqual(1);

        const m = await measurePanelRows(page);
        expect(m.inlineWidth, '前提: パネル幅 140px').toBe('140px');
        for (const [name, row] of Object.entries(m.rows)) {
            expect(row.sw, `${name} 行が横に溢れている（scrollWidth > clientWidth）`).toBeLessThanOrEqual(row.cw);
        }
        for (const b of m.buttons) {
            expect(b.width, `${b.sel} の幅が 0`).toBeGreaterThan(0);
            expect(b.left, `${b.sel} がパネルの左外`).toBeGreaterThanOrEqual(m.inner.left - 0.5);
            expect(b.right, `${b.sel} がパネルの右外（切れている）`).toBeLessThanOrEqual(m.inner.right + 0.5);
        }
        // D13: focus 中の ✕ / Aa / W / .* は BOX の中に収まる / 名前は ellipsis で収まる
        expect(m.input.width).toBeGreaterThan(0);
        for (const b of m.buttons.filter((x) => x.sel !== '#filePanelCollapse')) {
            expect(b.left, `${b.sel} が BOX の左外`).toBeGreaterThanOrEqual(m.input.left - 0.5);
            expect(b.right, `${b.sel} が BOX の右外`).toBeLessThanOrEqual(m.input.right + 0.5);
        }
        expect(m.title.textOverflow).toBe('ellipsis');
        expect(m.title.sw, '前提: 長い note 名が切り詰められている').toBeGreaterThan(m.title.cw);
        expect(m.title.right).toBeLessThanOrEqual(m.inner.right + 0.5);
        for (const t of m.visibleTabs) {
            expect(t.right, `${t.tab} タブがパネルの右外`).toBeLessThanOrEqual(m.inner.right + 0.5);
        }
    });

    test('AC-12 shortcut list: the md list has no Cmd+K insert-link item; md and outliner each list Cmd+K note search', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const SL = require('../../src/shared/shortcut-list.js');
        type Item = { keys: string; desc: string; category: string };
        const flat = (groups: any[]): Item[] => groups.flatMap((g: any) =>
            g.items.map((it: any) => ({ keys: it.keys, desc: it.desc, category: g.category })));
        const md = flat(SL.getList('md'));
        const outliner = flat(SL.getList('outliner'));
        // 前提（空振り防止）: リストが中身を持ち、Cmd+Shift+K（code block）は残っている
        expect(md.length).toBeGreaterThan(10);
        expect(outliner.length).toBeGreaterThan(10);
        expect(md.some((i) => i.keys === 'Cmd+Shift+K')).toBe(true);

        // md から Cmd+K の Insert link が消えた（keys は完全一致で見る）
        expect(md.filter((i) => i.keys === 'Cmd+K' && /link/i.test(i.desc))).toEqual([]);

        for (const [name, list] of [['md', md], ['outliner', outliner]] as const) {
            const cmdK = list.filter((i) => i.keys === 'Cmd+K');
            expect(cmdK, `${name}: Cmd+K の項目が 1 つでない`).toHaveLength(1);
            expect(cmdK[0].category, `${name}: Cmd+K が search カテゴリに無い`).toBe('search');
            expect(cmdK[0].desc).toMatch(/search/i);
            expect(cmdK[0].desc).toMatch(/notes/i);
        }
    });

    test('AC-14 late results after emptying the box do not bring the Results tab back; an Explore jump to Notes keeps it icon-only', async ({ page }) => {
        await bootPanelUnit(page, {
            files: [{ id: 'o1', filePath: '/n/Plan.out', title: 'Plan', kind: 'out' }],
            structure: { version: 1, rootIds: ['o1'], items: { o1: { type: 'file', id: 'o1', title: 'Plan' } } },
        });
        const input = page.locator(SEARCH);
        const results = page.locator(RESULTS_TAB);
        const notes = page.locator(tabSel('notes'));

        // 検索中（host が結果を流している途中）に BOX を空にする
        await input.click();
        await page.keyboard.type('Plan');
        await page.keyboard.press('Enter');
        await page.evaluate(() => (window as any).__onSearchStart(7));
        await expect(results).toBeVisible();
        await expect(results).toHaveClass(ACTIVE);
        await input.selectText();
        await page.keyboard.press('Backspace');
        await expect(input).toHaveValue('');
        await expect(results).toBeHidden();
        await expect(notes).toHaveClass(ACTIVE);

        // 同じ検索（searchId 7）の後着結果が来ても Results タブは再表示されない
        await page.evaluate(() => {
            const w = window as any;
            w.__onSearchPartial(7, {
                fileId: 'o9', fileTitle: 'Plan', fileType: 'out',
                matches: [{ field: 'text', lineText: 'Plan memo', matchStart: 0, matchEnd: 4, nodeId: 'n1' }],
            });
            w.__onSearchEnd(7);
        });
        await expect(results).toBeHidden();
        await expect(notes).toHaveClass(ACTIVE);
        await expect(page.locator('#filePanelContentNotes')).toBeVisible();
        await expect(page.locator('#filePanelContentSearch')).toBeHidden();

        // Explore（名前）結果クリック → Notes タブへジャンプしても Results タブはアイコンのみで残る
        await input.click();
        await page.keyboard.type('Plan');
        await page.keyboard.press('Enter');
        await page.evaluate(() => (window as any).__onSearchStart(8));   // Explore 節は onSearchStart で client 側描画
        await expect(results).toHaveClass(ACTIVE);
        const exploreHit = page.locator('#notesSearchResults .file-panel-search-section').first()
            .locator('.file-panel-search-match', { hasText: 'Plan' });
        await expect(exploreHit).toHaveCount(1);
        await exploreHit.click();
        await expect(notes).toHaveClass(ACTIVE);
        await expect(page.locator('#filePanelContentNotes')).toBeVisible();
        await expect(page.locator('#filePanelContentSearch')).toBeHidden();
        await expect(results).toBeVisible();
        await expect(results).not.toHaveClass(ACTIVE);
        await expect(results.locator('.file-panel-tab-label')).toBeHidden();
    });

    test('AC-15 the search box shows no shortcut hint (no ⌘K / Ctrl+K text or kbd element in the search row)', async ({ page }) => {
        await bootNotes(page);
        const bar = page.locator('#notesSearchBar');
        await expect(bar).toBeVisible();
        await expect(page.locator('#notesSearchKbd')).toHaveCount(0);
        await expect(bar.locator('kbd')).toHaveCount(0);
        const text = (await bar.innerText()).replace(/\s+/g, ' ');
        expect(text, '検索行にショートカット表記が出ている').not.toMatch(/⌘\s*K|Ctrl\s*\+\s*K/i);
        await expect(page.locator(SEARCH)).not.toHaveAttribute('placeholder', /⌘|Ctrl\s*\+\s*K/i);
    });

    test('AC-21 typing shows a clear (✕) button at the right end of the box; clicking it empties the box, hides the Results tab and keeps focus in the box', async ({ page }) => {
        await bootNotes(page);
        const input = page.locator(SEARCH);
        const clear = page.locator('#notesSearchClear');
        await expect(input).toHaveValue('');
        await expect(clear).toBeHidden();

        await input.click();
        await page.keyboard.type('File');
        await expect(clear).toBeVisible();
        // D14: ✕ は Aa の左（BOX の中）。BOX の伸長（D15 の transition）中に測らないよう、1 回の evaluate で同時に測る
        await page.waitForTimeout(250);
        const g = await page.evaluate(() => {
            const r = (sel: string) => (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
            return { ib: r('#notesSearchInput'), cb: r('#notesSearchClear'), ab: r('#notesSearchCase') };
        });
        expect(g.cb.left, '✕ が BOX の左外').toBeGreaterThanOrEqual(g.ib.left - 0.5);
        expect(g.cb.right, '✕ が Aa の左に無い').toBeLessThanOrEqual(g.ab.left + 0.5);
        expect(g.ab.left - g.cb.right, '✕ と Aa が離れすぎ').toBeLessThanOrEqual(6);

        await page.keyboard.press('Enter');
        const results = page.locator('.file-panel-tab[data-tab="results"]');
        await expect(results).toBeVisible();

        // 140px でも ✕ 表示中の検索行がはみ出さない
        const overflow = await page.evaluate(() => {
            const panel = document.getElementById('notesFilePanel') as HTMLElement;
            panel.style.width = '140px';
            const bar = document.getElementById('notesSearchBar') as HTMLElement;
            const pb = panel.getBoundingClientRect();
            const xb = (document.getElementById('notesSearchClear') as HTMLElement).getBoundingClientRect();
            return { over: bar.scrollWidth - bar.clientWidth, clearInside: xb.right <= pb.right + 0.5 && xb.width > 0 };
        });
        expect(overflow.over, '140px で検索行がはみ出した').toBeLessThanOrEqual(0);
        expect(overflow.clearInside, '140px で ✕ がパネル外').toBe(true);

        await clear.click();
        await expect(input).toHaveValue('');
        await expect(input).toBeFocused();
        await expect(clear).toBeHidden();
        await expect(results).toBeHidden();
        await expect(page.locator('.file-panel-tab[data-tab="notes"]')).toHaveClass(/(^|\s)active(\s|$)/);
    });

    test('AC-16 Enter during IME composition neither calls bridge.search nor shows the Results tab', async ({ page }) => {
        await bootPanelUnit(page);
        const input = page.locator(SEARCH);
        await input.click();
        await page.keyboard.type('henkan');

        // 実キーでは IME 変換中を表現できない → isComposing / keyCode 229 の Enter だけ合成する
        const r = await page.evaluate(() => {
            const el = document.getElementById('notesSearchInput') as HTMLInputElement;
            const composing = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true });
            el.dispatchEvent(composing);
            const kc229 = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
            Object.defineProperty(kc229, 'keyCode', { get: () => 229 });
            el.dispatchEvent(kc229);
            return (window as any).__calls.filter((c: any) => c.type === 'search').length;
        });
        expect(r, 'IME 変換中の Enter で bridge.search が呼ばれた').toBe(0);
        await expect(page.locator(RESULTS_TAB)).toBeHidden();
        await expect(page.locator(tabSel('notes'))).toHaveClass(ACTIVE);
        await expect(page.locator('#filePanelContentSearch')).toBeHidden();

        // 対照: 確定後の Enter は検索して Results を出す
        await page.keyboard.press('Enter');
        expect(await bridgeCalls(page, 'search')).toHaveLength(1);
        await expect(page.locator(RESULTS_TAB)).toBeVisible();
        await expect(page.locator(RESULTS_TAB)).toHaveClass(ACTIVE);
    });

    test('AC-17 at 140px with the Results tab shown the tab row and search row still do not overflow', async ({ page }) => {
        await bootNotes(page);
        await initPanel(page, { width: 140, noteName: 'Note' });
        const input = page.locator(SEARCH);
        await input.click();
        await page.keyboard.type('alpha');
        await page.keyboard.press('Enter');
        await expect(page.locator(RESULTS_TAB)).toBeVisible();

        // Results 選択（ラベル付き pill）/ Notes 選択 / Tools 選択 のどれでも溢れない
        for (const active of ['results', 'notes', 'tools']) {
            await page.locator(tabSel(active)).click();
            await expect(page.locator(tabSel(active))).toHaveClass(ACTIVE);
            const m = await measurePanelRows(page);
            expect(m.inlineWidth, '前提: パネル幅 140px').toBe('140px');
            expect(m.visibleTabs.map((t) => t.tab), `${active}: Results タブが出ていない`).toEqual(['notes', 'tools', 'results']);
            expect(m.rows.tabs.sw, `${active}: タブ行が横に溢れている`).toBeLessThanOrEqual(m.rows.tabs.cw);
            expect(m.rows.searchBar.sw, `${active}: 検索行が横に溢れている`).toBeLessThanOrEqual(m.rows.searchBar.cw);
            for (const t of m.visibleTabs) {
                expect(t.width, `${active}: ${t.tab} タブの幅が 0`).toBeGreaterThan(0);
                expect(t.left, `${active}: ${t.tab} タブがパネルの左外`).toBeGreaterThanOrEqual(m.inner.left - 0.5);
                expect(t.right, `${active}: ${t.tab} タブがパネルの右外`).toBeLessThanOrEqual(m.inner.right + 0.5);
            }
            for (const b of m.buttons) {
                expect(b.right, `${active}: ${b.sel} がパネルの右外`).toBeLessThanOrEqual(m.inner.right + 0.5);
            }
        }
    });

    test('AC-18 all 7 locales define notesTabResults and insertLink no longer mentions Ctrl+K / Cmd+K', () => {
        const dir = path.join(ROOT, 'src/i18n/locales');
        for (const lang of LOCALES) {
            const src = fs.readFileSync(path.join(dir, lang + '.ts'), 'utf8');
            const results = localeString(src, 'notesTabResults');
            expect(results, `${lang}.ts に notesTabResults が無い`).not.toBeNull();
            expect((results || '').trim().length, `${lang}.ts の notesTabResults が空`).toBeGreaterThan(0);
            const insertLink = localeString(src, 'insertLink');
            expect(insertLink, `${lang}.ts に insertLink が無い（前提崩れ）`).not.toBeNull();
            expect((insertLink || '').trim().length).toBeGreaterThan(0);
            expect(insertLink, `${lang}.ts の insertLink にショートカット表記が残っている`).not.toMatch(/(Ctrl|Cmd|⌘)\s*\+?\s*K/i);
        }
        // D11: ja は「検索結果」/ en は HTML の fallback と同じ「Results」
        expect(localeString(fs.readFileSync(path.join(dir, 'ja.ts'), 'utf8'), 'notesTabResults')).toBe('検索結果');
        expect(localeString(fs.readFileSync(path.join(dir, 'en.ts'), 'utf8'), 'notesTabResults')).toBe('Results');
    });

    test('AC-19 md text selected → Cmd/Ctrl+K → Esc returns focus to the md with the same selection range', async ({ page }) => {
        await bootNotes(page);
        const ed = await openMainMd(page, '# Title\n\nalpha bravo charlie\n', 'alpha bravo charlie');
        await ed.click();
        await expect(ed).toBeFocused();
        await selectWord(page, '.markdown-container .editor', 'bravo');
        const before = await selectionIn(page, '.markdown-container .editor');
        expect(before && before.text).toBe('bravo');

        await page.keyboard.press('ControlOrMeta+k');
        await expect(page.locator(SEARCH)).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(ed).toBeFocused();
        expect(await selectionIn(page, '.markdown-container .editor'), '選択範囲が Cmd+K 前と違う').toEqual(before);
        await expect(page.locator('.markdown-container .editor a')).toHaveCount(0);
    });

    test('AC-20 Cmd/Ctrl+K while editing the outliner sidepanel md focuses the box and inserts no link into the sidepanel md', async ({ page }) => {
        await bootNotes(page);
        const ed = await openSidePanelMd(page, 'delta echo foxtrot\n', 'delta echo foxtrot');
        await ed.click();
        await expect(ed).toBeFocused();
        await selectWord(page, '.side-panel .editor', 'echo');   // 旧挙動ならここが <a href="#">echo</a> になる
        const htmlBefore = await ed.innerHTML();

        await page.keyboard.press('ControlOrMeta+k');
        await expect(page.locator(SEARCH)).toBeFocused();
        await expect(page.locator('.side-panel .editor a')).toHaveCount(0);
        expect(await ed.innerHTML(), 'sidepanel md の DOM が変わった').toBe(htmlBefore);
        await expect(ed).toContainText('delta echo foxtrot');
    });
});
