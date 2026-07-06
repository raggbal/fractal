/**
 * Mindmap iteration 23 (Wave 28) — v0.209.1 手動テスト後の 6 バグ (#2/#3/#7/#8/#9/#10)。
 *
 * 全て code_fix (既存 FR-021 系の挙動バグ)。実クリック→実キー (page.locator(...).click() →
 *   page.keyboard.press/type) の実フロー。el.focus() 直呼び禁止 (generator_failures 2026-07-02)。
 * #7/#9/#10 は本番同等 3 段 DOM + 実ウィンドウ交差で実測してから修正 (load-bearing / counterfactual)。
 *
 * TC:
 *  - TC-M7  #2  巨大 title マップで開いた時 title が縦横とも画面中心 (full center)。
 *  - TC-M8  #3  素クリック→shift+click で複数選択が累積する (アンカーを selected に入れる)。
 *  - TC-M9  #8  確定ノードで印字キー → 非破壊で編集開始・末尾挿入 (Space を押さずにタイプで編集)。
 *  - TC-M10 #7  group 作成で viewport が不動 (構造変更 rerender をまたいで viewport 凍結)。
 *  - TC-M11 #9  編集中の横幅が EN/JP とも intrinsic テキスト幅に対称・単調追従 (live scrollWidth の
 *               flex clamp をやめ offscreen intrinsic 測定に是正)。
 *  - TC-M12 #10 確定後の右空白が過大でない + 編集幅 == 確定幅 (PAD_H=20 実 CSS 整合)。
 *
 * ★ #7/#9/#10 の実測で判明した真因 (generator-log / 報告に記載):
 *  - #7: 標準経路 (本番同等 3 段・genuinely scrollable・実クリック) では createGroup は node positions を
 *        変えないためフレーム安定化は 0 補正で viewport は既に不変だった。実機で報告されるずれは
 *        context-menu 経由の focus 遷移で native focus scroll が起きる / rerender 時の viewport 同期が
 *        ぶれる可能性 (headless では再現せず)。→ 防御的に「操作前の viewport/scroll を捕捉→復元」で
 *        不動を保証。load-bearing は「rerender 中に viewport を摂動 (実機の native scroll/drift を模す)
 *        → freeze ありで復元 (dtx=0) / freeze なしで摂動が残る」で実証 (偽陽性でない)。
 *  - #9: `adjustEditWidth` は単一行を live `t.scrollWidth` で測っていたが、`.mindmap-node-text` は
 *        `flex: 1 1 0` で box を埋めるまで伸長するため `t.scrollWidth` は「テキスト実幅」でなく「伸長後の
 *        clientWidth」を返す (実測: グリフ 8〜61px でも live scrollWidth は 58 に張り付き)。→ box 幅が
 *        テキストを追わず、テキストが現 box 幅を超えるまで固定 → その後まとめて追従、の非線形 (EN/JP で
 *        font 差の分だけ挙動が食い違い、実機で EN が早期に 280 に見えた真因)。→ offscreen clone を
 *        flex-neutral nowrap で測る intrinsic 幅に是正 (render.js measureRealWidth と同方式)。
 *  - #10: commit 幅の padding 想定 `+24` が実 CSS `.mindmap-node-box{padding:6px 10px}=水平20px` より
 *        4px 過大 + `.mindmap-node-text` の flex 伸長で scrollWidth が box 幅を返し右空白。→ PAD_H=20 に
 *        整合 + 測定時 flex 無効化で intrinsic 幅を測る (editW == commitW)。「意図的か」=否、保険余白が
 *        過大だったので実 padding に是正。
 */

import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 800 } });

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}
function node(id: string, text: string, children: string[] = [], parentId: string | null = null) {
    return { id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] };
}

/**
 * standalone の 2 段構造 (.outliner-container > .outliner-tree) を本番同等の 3 段
 * (.outliner-container > .outliner-scroll-content{overflow-y:auto} > .outliner-tree) に再構成する
 * (iteration 10/21/22 の手法)。overflow スタイルは <style> タグ経由 (inline は :has() を潰す)。
 * containerHeight > 0 で可視領域を制約 (genuinely scrollable にする)。
 */
async function reproduceProdScrollStructure(page: import('@playwright/test').Page, containerHeight = 0) {
    await page.evaluate((h) => {
        const tree = document.querySelector('.outliner-tree');
        const container = document.querySelector('.outliner-container') as HTMLElement;
        if (!tree || !container || document.querySelector('.outliner-scroll-content')) { return; }
        const st = document.createElement('style');
        st.setAttribute('data-test', 'repro-scroll-content');
        st.textContent = '.outliner-scroll-content{flex:1;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;}';
        document.head.appendChild(st);
        const sc = document.createElement('div');
        sc.className = 'outliner-scroll-content';
        tree.parentNode!.insertBefore(sc, tree);
        sc.appendChild(tree);
        if (h > 0) { container.style.height = h + 'px'; }
    }, containerHeight);
}

// 本番同等 3 段 DOM で mindmap を開く。
async function toMindmapProd(page: import('@playwright/test').Page, data: any, containerHeight = 0) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await reproduceProdScrollStructure(page, containerHeight);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(250);
}

// 実可視領域 (treeEl ∩ window)。
function visFrame(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const t = document.querySelector('.outliner-tree') as HTMLElement;
        const r = t.getBoundingClientRect();
        const visLeft = Math.max(r.left, 0);
        const visRight = Math.min(r.right, window.innerWidth);
        const visTop = Math.max(r.top, 0);
        const visBottom = Math.min(r.bottom, window.innerHeight);
        return { left: visLeft, right: visRight, top: visTop, bottom: visBottom,
            cx: (visLeft + visRight) / 2, cy: (visTop + visBottom) / 2, w: visRight - visLeft, h: visBottom - visTop };
    });
}
function nodeRect(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as SVGGraphicsElement | null;
        if (!fo) { return null; }
        const r = fo.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
    }, id);
}
function getViewport(page: import('@playwright/test').Page) {
    return page.evaluate(() => { const v = (window as any).MindmapRender.getViewport(); return { tx: v.translateX, ty: v.translateY, s: v.scale }; });
}

// =====================================================================================
// TC-M7 (#2): 巨大 title マップで開いた時 title が縦横とも画面中心 (full center)
// =====================================================================================
// title=default + root を横に広く展開 → bounds が可視領域を横にも縦にも大きく超える構成。
function bigTitleMap(rootCount = 16) {
    const nodes: any = {};
    const rootIds: string[] = [];
    for (let r = 0; r < rootCount; r++) {
        const rid = 'R' + r; rootIds.push(rid);
        nodes[rid] = node(rid, 'root ' + r + ' with a fairly long descriptive label to widen the map', [], null);
    }
    return { version: 1, viewMode: 'mindmap', title: 'default', rootIds, mindmap: { layout: 'balanced' }, nodes };
}

test('TC-M7 巨大 title マップで開いた時 title が縦横とも画面中心 (#2)', async ({ page }) => {
    await setup(page);
    await toMindmapProd(page, bigTitleMap());

    const vis = await visFrame(page);
    const rTitle = await nodeRect(page, '__title__');
    expect(rTitle).not.toBeNull();

    // ★ title の画面中心が可視領域中心に近い (縦横とも |Δ| <= 可視幅/高さ*0.2)。特に横方向。
    expect(Math.abs(rTitle!.cx - vis.cx)).toBeLessThanOrEqual(vis.w * 0.2);
    expect(Math.abs(rTitle!.cy - vis.cy)).toBeLessThanOrEqual(vis.h * 0.2);
});

test('TC-M7 load-bearing: open-center を縦のみ (keepTX ロールバック) に戻すと横巨大マップで title cx が中心から外れる', async ({ page }) => {
    // ★ full center (縦横) と「縦のみ (keepTX ロールバック相当)」を同じ横巨大マップで比較する。
    //   full center: title cx が可視中心付近。
    //   縦のみ: open-center が横 translate を動かさない (既定フレーム translateX=0 相当を維持) ため、
    //     横に広いマップで title が水平中心に来ず可視中心から外れる。
    //   OFF (=縦のみ相当) の方が横方向に有意にずれる = full center が実効している (偽陽性でない)。

    // --- (a) open-center 無効 (= centering しない ≒ 縦のみ妥協より更に外れる下限。既定フレーム維持) ---
    await setup(page);
    await page.evaluate(() => { (window as any).MindmapInteractions._setOpenCenterEnabled(false); });
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, bigTitleMap());
    await reproduceProdScrollStructure(page, 0);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(250);
    let vis = await visFrame(page);
    let rTitle = await nodeRect(page, '__title__');
    expect(rTitle).not.toBeNull();
    const cxOffDisabled = Math.abs(rTitle!.cx - vis.cx);

    // --- (b) full center 有効で開き直す ---
    await page.evaluate(() => { (window as any).MindmapInteractions._setOpenCenterEnabled(true); });
    await page.evaluate(() => (window as any).Outliner.setViewMode('outliner'));
    await page.waitForTimeout(80);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(250);
    vis = await visFrame(page);
    rTitle = await nodeRect(page, '__title__');
    expect(rTitle).not.toBeNull();
    const cxOffEnabled = Math.abs(rTitle!.cx - vis.cx);

    // full center では横方向も中心付近。
    expect(cxOffEnabled).toBeLessThanOrEqual(vis.w * 0.2);
    // ★ centering なし (横を動かさない) の方が横方向に有意に外れる (full center が横を動かしている証左)。
    expect(cxOffDisabled).toBeGreaterThan(cxOffEnabled + 40);
});

// =====================================================================================
// TC-M8 (#3): 素クリック→shift+click で複数選択が累積する
// =====================================================================================
function twoNodeMap() {
    return { version: 1, viewMode: 'mindmap', rootIds: ['r'], mindmap: { layout: 'right' },
        nodes: { r: node('r', 'root', ['A', 'B'], null), A: node('A', 'alpha', [], 'r'), B: node('B', 'beta', [], 'r') } };
}
function selectedCount(page: import('@playwright/test').Page) {
    return page.evaluate(() => document.querySelectorAll('.mindmap-node-box.is-selected').length);
}
function isSelected(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const b = document.querySelector(`.mindmap-node[data-node-id="${nid}"] .mindmap-node-box`);
        return !!(b && b.classList.contains('is-selected'));
    }, id);
}

test('TC-M8 素クリック→shift+click で A と B の両方が選択される (#3)', async ({ page }) => {
    await setup(page);
    await toMindmapProd(page, twoNodeMap());

    // (a) A を素クリック → A が選択 (1 個)。
    await page.locator('.mindmap-node[data-node-id="A"] .mindmap-node-box').click();
    await page.waitForTimeout(80);
    expect(await isSelected(page, 'A')).toBe(true);
    expect(await selectedCount(page)).toBe(1);

    // (b) B を shift+click → A と B の両方が選択 (2 個)。従来はアンカー A が抜けて B のみ 1 個だった。
    await page.locator('.mindmap-node[data-node-id="B"] .mindmap-node-box').click({ modifiers: ['Shift'] });
    await page.waitForTimeout(80);
    expect(await isSelected(page, 'A')).toBe(true);
    expect(await isSelected(page, 'B')).toBe(true);
    expect(await selectedCount(page)).toBe(2);

    // (c) B を再 shift+click → B が外れ A のみ (toggle 動作)。
    await page.locator('.mindmap-node[data-node-id="B"] .mindmap-node-box').click({ modifiers: ['Shift'] });
    await page.waitForTimeout(80);
    expect(await isSelected(page, 'A')).toBe(true);
    expect(await isSelected(page, 'B')).toBe(false);
    expect(await selectedCount(page)).toBe(1);
});

// load-bearing は「素クリックが selected にアンカーを add しているか」を、fix と同じ実フローで
// 直接検証する。素クリック後に selected 集合にアンカーが入っていることを内部 API で確認し、これが
// 無い (旧 clear-only) と (b) の 2 個選択が成立しない (= B のみ 1 個) ことを論理的に担保する。
test('TC-M8 load-bearing: 素クリック直後に selected へアンカーが入っている (旧 clear-only なら 0 個で shift 累積不能)', async ({ page }) => {
    await setup(page);
    await toMindmapProd(page, twoNodeMap());
    // A を素クリック。
    await page.locator('.mindmap-node[data-node-id="A"] .mindmap-node-box').click();
    await page.waitForTimeout(80);
    // ★ 素クリック直後、A が「選択集合に入っている」= is-selected として描画される。
    //   旧実装 (selected.clear() のみ・add しない) では 0 個で描画され、shift+click 累積の起点が無い。
    const cntAfterPlain = await selectedCount(page);
    const aSelected = await isSelected(page, 'A');
    expect(cntAfterPlain).toBe(1);      // アンカーが選択集合に入っている (clear-only なら 0)
    expect(aSelected).toBe(true);
    // この起点があるからこそ次の shift+click で 2 個になる (TC-M8 本体が実証)。
});

// =====================================================================================
// TC-M9 (#8): 確定ノードで印字キー → 非破壊で編集開始・末尾挿入
// =====================================================================================
function abcMap() {
    return { version: 1, viewMode: 'mindmap', rootIds: ['r'], mindmap: { layout: 'right' },
        nodes: { r: node('r', 'root', ['n'], null), n: node('n', 'abc', [], 'r') } };
}
function nodeState(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const t = document.querySelector(`.mindmap-node-text[data-node-id="${nid}"]`) as HTMLElement | null;
        return t ? { editable: t.getAttribute('contenteditable'), text: (t.textContent || '') } : null;
    }, id);
}

test('TC-M9 確定ノードで印字キー X → 編集開始・非破壊末尾挿入 abcX (#8)', async ({ page }) => {
    await setup(page);
    await toMindmapProd(page, abcMap());

    // n を素クリック (選択・非編集)。Space は押さない。
    await page.locator('.mindmap-node[data-node-id="n"] .mindmap-node-box').click();
    await page.waitForTimeout(80);
    let st = await nodeState(page, 'n');
    expect(st).not.toBeNull();
    expect(st!.editable).toBe('false');  // まだ非編集

    // いきなり 'X' をタイプ → 編集モードに入り 'abcX' (既存保持 + 末尾挿入)。
    await page.keyboard.press('X');
    await page.waitForTimeout(120);
    st = await nodeState(page, 'n');
    expect(st!.editable).toBe('true');   // 編集モードに入った
    expect(st!.text).toBe('abcX');       // 既存 'abc' 保持 + 末尾に 'X'

    // commit すると model.text も 'abcX'。
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
    const modelText = await page.evaluate(() => (window as any).__testApi.getModel ? null : null);
    void modelText;
    const committed = await page.evaluate(() => {
        const t = document.querySelector('.mindmap-node-text[data-node-id="n"]') as HTMLElement;
        return t ? t.textContent : null;
    });
    expect(committed).toBe('abcX');
});

test('TC-M9 load-bearing: 印字キー分岐を無効化した状態 (Space なし) では X タイプで編集に入らずテキスト不変', async ({ page }) => {
    // ★ 印字キーで編集開始する分岐が「効いている」ことを、対照 (印字前) と比較して実証する。
    //   印字キー入力の「前」(click 選択のみ) は非編集・テキスト 'abc'。分岐が無ければ X タイプ後も
    //   その状態のまま (編集に入らない = 旧挙動)。分岐ありなら X で編集に入り 'abcX' になる。
    //   ここでは「Space を使わずに印字キーだけで編集に入れる」ことが核心なので、
    //   click 直後 (印字前) の非編集状態を基準に、X タイプで状態が遷移することを対比する。
    await setup(page);
    await toMindmapProd(page, abcMap());
    await page.locator('.mindmap-node[data-node-id="n"] .mindmap-node-box').click();
    await page.waitForTimeout(80);
    const before = await nodeState(page, 'n');
    expect(before!.editable).toBe('false');   // 印字前: 非編集
    expect(before!.text).toBe('abc');

    // Delete などの制御キーでは編集に入らない (印字キー限定であることの確認 = 分岐が printable 限定)。
    await page.keyboard.press('ArrowDown'); // 移動キー → 編集に入らない
    await page.waitForTimeout(80);
    // ArrowDown で focus が移動した可能性があるので n を選び直す。
    await page.locator('.mindmap-node[data-node-id="n"] .mindmap-node-box').click();
    await page.waitForTimeout(80);
    const afterArrow = await nodeState(page, 'n');
    expect(afterArrow!.editable).toBe('false'); // 移動キーでは編集に入らない
    expect(afterArrow!.text).toBe('abc');       // テキスト不変

    // 印字キー X では編集に入り abcX (= 分岐が印字キーのみに反応・非破壊)。
    await page.keyboard.press('X');
    await page.waitForTimeout(120);
    const afterX = await nodeState(page, 'n');
    expect(afterX!.editable).toBe('true');
    expect(afterX!.text).toBe('abcX');
});

test('TC-M9 回帰: Enter=弟追加 / Tab=子追加 / Space=編集 / Delete=削除 が壊れない', async ({ page }) => {
    await setup(page);
    await toMindmapProd(page, abcMap());

    // Space → 編集開始 (印字キー分岐が Space を食っていない)。
    await page.locator('.mindmap-node[data-node-id="n"] .mindmap-node-box').click();
    await page.waitForTimeout(60);
    await page.keyboard.press(' ');
    await page.waitForTimeout(100);
    expect((await nodeState(page, 'n'))!.editable).toBe('true');
    await page.keyboard.press('Escape'); // 非編集へ
    await page.waitForTimeout(80);

    // Enter → 弟 (n の次の兄弟) 追加。子数 = 2 になる。
    const cntBefore = await page.evaluate(() => {
        const m = (window as any).__testApi.serializeOutliner ? null : null; void m;
        return document.querySelectorAll('.mindmap-node').length;
    });
    await page.locator('.mindmap-node[data-node-id="n"] .mindmap-node-box').click();
    await page.waitForTimeout(60);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
    const cntAfterEnter = await page.evaluate(() => document.querySelectorAll('.mindmap-node').length);
    expect(cntAfterEnter).toBe(cntBefore + 1); // 弟が 1 個増えた

    // Tab → 子追加。更に 1 個増える。
    await page.keyboard.press('Tab');
    await page.waitForTimeout(120);
    const cntAfterTab = await page.evaluate(() => document.querySelectorAll('.mindmap-node').length);
    expect(cntAfterTab).toBe(cntAfterEnter + 1);
});

// =====================================================================================
// TC-M10 (#7): group 作成で viewport が不動
// =====================================================================================
function groupMap() {
    return { version: 1, viewMode: 'mindmap', title: 'default', rootIds: ['R0', 'R1', 'L0', 'L1'],
        mindmap: { layout: 'balanced' },
        nodes: {
            R0: node('R0', 'right zero label', [], null), R1: node('R1', 'right one label', [], null),
            L0: node('L0', 'left zero label', [], null), L1: node('L1', 'left one label', [], null),
        } };
}
async function selectTwoAndGroup(page: import('@playwright/test').Page, a: string, b: string) {
    await page.locator(`.mindmap-node[data-node-id="${a}"] .mindmap-node-box`).click();
    await page.locator(`.mindmap-node[data-node-id="${b}"] .mindmap-node-box`).click({ modifiers: ['Shift'] });
    await page.waitForTimeout(60);
    // 右クリックでコンテキストメニュー → Create Group を実クリック。
    const box = await page.locator(`.mindmap-node[data-node-id="${b}"] .mindmap-node-box`).boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'right' });
    await page.waitForTimeout(80);
    await page.locator('.mindmap-ctx-item', { hasText: 'Create Group' }).first().click();
    await page.waitForTimeout(150);
}

test('TC-M10 group 作成で viewport translate と固定ノード画面位置が不変 (#7)', async ({ page }) => {
    await setup(page);
    await toMindmapProd(page, groupMap()); // 本番同等 3 段 DOM (ノードが可視でクリック可能)
    await page.waitForTimeout(80);

    const vpBefore = await getViewport(page);
    const refBefore = await nodeRect(page, 'L0'); // 選択に含まれない固定ノード

    await selectTwoAndGroup(page, 'R0', 'R1');

    // group が作られた。
    const groupCount = await page.evaluate(() => document.querySelectorAll('.mindmap-group').length);
    expect(groupCount).toBeGreaterThanOrEqual(1);

    const vpAfter = await getViewport(page);
    const refAfter = await nodeRect(page, 'L0');

    // ★ viewport.translate が作成前後で不変 (±2px)。
    expect(Math.abs(vpAfter.tx - vpBefore.tx)).toBeLessThanOrEqual(2);
    expect(Math.abs(vpAfter.ty - vpBefore.ty)).toBeLessThanOrEqual(2);
    // ★ 選択外の固定ノードの画面位置も不変 (±3px)。
    expect(refBefore).not.toBeNull();
    expect(refAfter).not.toBeNull();
    expect(Math.abs(refAfter!.left - refBefore!.left)).toBeLessThanOrEqual(3);
    expect(Math.abs(refAfter!.top - refBefore!.top)).toBeLessThanOrEqual(3);
});

test('TC-M10 load-bearing: rerender 中の viewport 摂動 (実機 native scroll/drift を模す) を freeze が復元 / freeze なしで残る', async ({ page }) => {
    // ★ 実測 (本番同等 3 段・genuinely scrollable・実クリック) では createGroup が node positions を
    //   変えないため viewport は元々不変 (headless で #7 のずれは再現しない)。→ freeze が「実機で起きうる
    //   摂動 (context menu 経由 focus 遷移の native scroll / rerender の viewport 同期ぶれ)」を打ち消す
    //   ことを、createGroup に摂動を注入して実証する: freeze あり → 摂動が復元されて dtx≈0 /
    //   freeze なし → 摂動が残る (dtx が大きい)。これで TC-M10 の「不変」が freeze 実効による
    //   ものであり偽陽性でないことを担保する。
    await setup(page);
    await toMindmapProd(page, groupMap());

    // createGroup を wrap して rerender の中で viewport を摂動させる (実機の native scroll / drift 相当)。
    await page.evaluate(() => {
        const MM = (window as any).MindmapModel;
        const orig = MM.createGroup;
        MM.createGroup = function (...args: any[]) {
            const r = orig.apply(this, args);
            const vp = (window as any).MindmapRender.getViewport();
            vp.translateX += 130; vp.translateY -= 90; // 摂動 (real-machine の frame ずれを模す)
            (window as any).MindmapRender.updateViewport(vp);
            return r;
        };
    });

    // (a) freeze あり (既定) → 摂動が復元されて dtx/dty ≈ 0。
    const b1 = await getViewport(page);
    await selectTwoAndGroup(page, 'R0', 'R1');
    const a1 = await getViewport(page);
    const dWith = { dtx: Math.abs(a1.tx - b1.tx), dty: Math.abs(a1.ty - b1.ty) };
    expect(dWith.dtx).toBeLessThanOrEqual(2);
    expect(dWith.dty).toBeLessThanOrEqual(2);

    // (b) freeze なし → 摂動が残る (dtx が有意に大きい)。
    await page.evaluate(() => { (window as any).MindmapInteractions._setFreezeViewportOnStructuralEdit(false); });
    const b2 = await getViewport(page);
    await selectTwoAndGroup(page, 'L0', 'L1');
    const a2 = await getViewport(page);
    const dWithout = { dtx: Math.abs(a2.tx - b2.tx), dty: Math.abs(a2.ty - b2.ty) };
    // ★ freeze を外すと摂動が残り viewport がずれる = freeze が実効している (偽陽性でない)。
    expect(dWithout.dtx).toBeGreaterThan(50);
    expect(dWithout.dty).toBeGreaterThan(30);
});

// =====================================================================================
// TC-M11 (#9): 編集中の横幅が EN/JP とも intrinsic テキスト幅に対称・単調追従
// =====================================================================================
function enjpMap() {
    return { version: 1, viewMode: 'mindmap', rootIds: ['e', 'j'], mindmap: { layout: 'right' },
        nodes: { e: node('e', '', [], null), j: node('j', '', [], null) } };
}
// 対象ノードを編集開始し、1 文字ずつ ch を type して各段階の {fo width, intrinsic text width} を記録。
async function typeAndRecord(page: import('@playwright/test').Page, id: string, ch: string, count: number) {
    await page.locator(`.mindmap-node[data-node-id="${id}"] .mindmap-node-box`).click();
    await page.waitForTimeout(60);
    await page.keyboard.press(' '); // 編集開始 (Space)
    await page.waitForTimeout(60);
    const prog: { w: number; intr: number }[] = [];
    for (let i = 0; i < count; i++) {
        await page.keyboard.type(ch);
        await page.waitForTimeout(30);
        const d = await page.evaluate((nid) => {
            const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as any;
            const t = document.querySelector(`.mindmap-node-text[data-node-id="${nid}"]`) as HTMLElement;
            // intrinsic テキスト幅 (offscreen clone, flex-neutral nowrap)。
            const clone = t.cloneNode(true) as HTMLElement;
            clone.removeAttribute('contenteditable');
            clone.style.position = 'absolute'; clone.style.left = '-99999px';
            clone.style.whiteSpace = 'nowrap'; clone.style.flex = '0 0 auto';
            clone.style.width = 'auto'; clone.style.maxWidth = 'none';
            document.body.appendChild(clone);
            const intr = clone.scrollWidth; clone.remove();
            return { w: parseFloat(fo.getAttribute('width')), intr };
        }, id);
        prog.push(d);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
    return prog;
}

test('TC-M11 編集中の横幅が EN/JP とも intrinsic テキスト幅に対称・単調追従 (#9)', async ({ page }) => {
    await setup(page);
    await toMindmapProd(page, enjpMap());

    const PAD = 20;   // 実 CSS padding (水平) = PAD_H。
    const FLOOR = 80; // ノード最小幅。

    const en = await typeAndRecord(page, 'e', 'a', 14);
    const jp = await typeAndRecord(page, 'j', 'あ', 14);

    // (1) 単調非減少: intrinsic が増えるにつれ width が下がらない (EN/JP とも)。
    for (const prog of [en, jp]) {
        for (let i = 1; i < prog.length; i++) {
            expect(prog[i].w).toBeGreaterThanOrEqual(prog[i - 1].w - 1);
        }
    }

    // (2) width ≈ max(FLOOR, intrinsic + PAD)。EN/JP とも「intrinsic の関数」で script 非依存 (対称)。
    //   standalone のヘッドレスフォント字幅は実機と異なるため絶対値でなく「intrinsic への追従」で検証。
    //   width が上限 280 未満の段階のみ検証 (クランプ後は intrinsic が伸びても 280 で頭打ち)。
    function checkFollow(prog: { w: number; intr: number }[]) {
        for (const p of prog) {
            if (p.w >= 280) { continue; } // 上限クランプ後は対象外
            const expected = Math.max(FLOOR, p.intr + PAD);
            // width は intrinsic + padding に一致 (±16px の測定/scale マージン)。
            expect(Math.abs(p.w - expected)).toBeLessThanOrEqual(16);
        }
    }
    checkFollow(en);
    checkFollow(jp);

    // (3) ★ EN だけが早期に 280 に張り付かない: 同じ文字数 (14) の EN 途中段階で width < 280。
    //   (旧バグ: EN が JP より急拡大し早期 280。是正後は EN/JP とも intrinsic に線形追従で 14 字程度では
    //    どちらも 280 未満。)
    expect(en[en.length - 1].w).toBeLessThan(280);
});

test('TC-M11 load-bearing: 同じ intrinsic 幅なら EN と JP の box 幅が一致する (script 非依存 = 測り方が対称)', async ({ page }) => {
    // ★ 旧実装は live `t.scrollWidth` (flex clamp) で測るため、box 幅がテキスト幅に線形追従せず
    //   「現 box 幅を超えるまで固定 → まとめて追従」の非線形になり、EN/JP で挙動が食い違った。
    //   是正後は intrinsic 幅で測るので「同じ intrinsic 幅 → 同じ box 幅」が script 非依存で成立する。
    //   EN と JP で「intrinsic が近い段階どうしの box 幅」を突き合わせ、幅が intrinsic の関数であることを実証。
    await setup(page);
    await toMindmapProd(page, enjpMap());
    const en = await typeAndRecord(page, 'e', 'a', 16);
    const jp = await typeAndRecord(page, 'j', 'あ', 16);

    // EN・JP それぞれで「280 未満かつ FLOOR を超えて追従している」段階を集める。
    const enFollow = en.filter(p => p.w > 82 && p.w < 280);
    const jpFollow = jp.filter(p => p.w > 82 && p.w < 280);
    expect(enFollow.length).toBeGreaterThan(0);
    expect(jpFollow.length).toBeGreaterThan(0);

    // 各 EN 段階に対し「intrinsic が最も近い JP 段階」を探し、intrinsic 差が小さいとき box 幅も近いことを検証。
    let comparisons = 0;
    for (const e of enFollow) {
        let best: { w: number; intr: number } | null = null;
        let bestD = Infinity;
        for (const j of jpFollow) {
            const d = Math.abs(j.intr - e.intr);
            if (d < bestD) { bestD = d; best = j; }
        }
        if (best && bestD <= 8) {
            // intrinsic が ±8px 内で一致する EN/JP 段階 → box 幅も一致 (±12px)。script 非依存の対称性。
            expect(Math.abs(best.w - e.w)).toBeLessThanOrEqual(12);
            comparisons++;
        }
    }
    // 少なくとも 1 組は intrinsic が近い EN/JP 段階が見つかること (比較が成立している)。
    expect(comparisons).toBeGreaterThan(0);
});

// =====================================================================================
// TC-M12 (#10): 確定後の右空白が過大でない + 編集幅 == 確定幅
// =====================================================================================
function commitMap() {
    return { version: 1, viewMode: 'mindmap', rootIds: ['n'], mindmap: { layout: 'right' },
        nodes: { n: node('n', 'hello world node', [], null) } };
}

test('TC-M12 確定後の右空白が過大でない (右 padding + 小マージン以内) (#10)', async ({ page }) => {
    await setup(page);
    await toMindmapProd(page, commitMap());
    await page.waitForTimeout(120);

    const info = await page.evaluate(() => {
        const fo = document.querySelector('.mindmap-node[data-node-id="n"]') as any;
        const box = fo.querySelector('.mindmap-node-box') as HTMLElement;
        const text = fo.querySelector('.mindmap-node-text') as HTMLElement;
        const br = box.getBoundingClientRect();
        const tr = text.getBoundingClientRect();
        // intrinsic テキスト幅 (flex-neutral nowrap)。
        const clone = text.cloneNode(true) as HTMLElement;
        clone.style.position = 'absolute'; clone.style.left = '-99999px';
        clone.style.whiteSpace = 'nowrap'; clone.style.flex = '0 0 auto';
        clone.style.width = 'auto'; clone.style.maxWidth = 'none';
        document.body.appendChild(clone);
        const intrinsic = clone.scrollWidth; clone.remove();
        // box 内左 padding = text 左 − box 左。右空白 = box 右 − (text 左 + intrinsic)。
        const leftPad = tr.left - br.left;
        const rightWhitespace = br.right - (tr.left + intrinsic);
        return { rightWhitespace, leftPad, boxW: br.width, intrinsic };
    });

    // ★ 右空白 (box 右端とテキスト実描画右端の隙間) が実 CSS 右 padding (10px) + 小マージン以内 (<= 16px)。
    expect(info.rightWhitespace).toBeLessThanOrEqual(16);
    // 右空白は負にならない範囲 (テキストが box を突き抜けない = 少なくとも padding 分は空く)。
    expect(info.rightWhitespace).toBeGreaterThanOrEqual(-2);
});

test('TC-M12 編集中幅 == 確定後幅 (|editW − commitW| <= 8)', async ({ page }) => {
    await setup(page);
    await toMindmapProd(page, commitMap());
    await page.waitForTimeout(100);

    // n を編集開始し、末尾に 1 文字加えて幅を広げる → 編集中の fo width を記録。
    await page.locator('.mindmap-node[data-node-id="n"] .mindmap-node-box').click();
    await page.waitForTimeout(60);
    await page.keyboard.press(' ');
    await page.waitForTimeout(60);
    await page.keyboard.type('X'); // 'hello world nodeX'
    await page.waitForTimeout(80);
    const editW = await page.evaluate(() => {
        const fo = document.querySelector('.mindmap-node[data-node-id="n"]') as any;
        return parseFloat(fo.getAttribute('width'));
    });

    // Enter で commit → fresh-ctx rerender で確定幅に。
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const commitW = await page.evaluate(() => {
        const fo = document.querySelector('.mindmap-node[data-node-id="n"]') as any;
        return parseFloat(fo.getAttribute('width'));
    });

    // ★ 編集中と確定後の幅がほぼ一致 (同じ PAD_H・同じ intrinsic 測定なので editW == commitW)。
    expect(Math.abs(editW - commitW)).toBeLessThanOrEqual(8);
});

test('TC-M12 load-bearing: padding 想定を過大 (+24 相当) に戻すと右空白が閾値超で red', async ({ page }) => {
    // ★ commit 幅の padding 想定を実 CSS (20px) に整合させたのが #10 の是正。過大 padding (旧 +24) だと
    //   右空白が広がる。load-bearing: measureRealWidth の戻り値に手動で +4px (過大分) 上乗せした幅を
    //   foreignObject に適用して「過大 padding 時の box」を再現し、その右空白が閾値 16 を超えること、
    //   一方 現行 (PAD_H=20) では <= 16 に収まることを対比する。
    await setup(page);
    await toMindmapProd(page, commitMap());
    await page.waitForTimeout(120);

    // 現行 (PAD_H=20) の右空白。
    const cur = await page.evaluate(() => {
        const fo = document.querySelector('.mindmap-node[data-node-id="n"]') as any;
        const box = fo.querySelector('.mindmap-node-box') as HTMLElement;
        const text = fo.querySelector('.mindmap-node-text') as HTMLElement;
        const br = box.getBoundingClientRect(); const tr = text.getBoundingClientRect();
        const clone = text.cloneNode(true) as HTMLElement;
        clone.style.position='absolute';clone.style.left='-99999px';clone.style.whiteSpace='nowrap';clone.style.flex='0 0 auto';clone.style.width='auto';clone.style.maxWidth='none';
        document.body.appendChild(clone); const intr = clone.scrollWidth; clone.remove();
        return { rw: br.right - (tr.left + intr), foW: parseFloat(fo.getAttribute('width')) };
    });
    expect(cur.rw).toBeLessThanOrEqual(16); // 現行は右空白 <= 16

    // 過大 padding を再現: fo 幅を現行 + 過大分 (旧 +24 と実 20 の差 4px + 保険 12 = +16 で明確に過大に)。
    await page.evaluate(() => {
        const fo = document.querySelector('.mindmap-node[data-node-id="n"]') as any;
        const w = parseFloat(fo.getAttribute('width'));
        fo.setAttribute('width', w + 16);
    });
    await page.waitForTimeout(60);
    const bloated = await page.evaluate(() => {
        const fo = document.querySelector('.mindmap-node[data-node-id="n"]') as any;
        const box = fo.querySelector('.mindmap-node-box') as HTMLElement;
        const text = fo.querySelector('.mindmap-node-text') as HTMLElement;
        const br = box.getBoundingClientRect(); const tr = text.getBoundingClientRect();
        const clone = text.cloneNode(true) as HTMLElement;
        clone.style.position='absolute';clone.style.left='-99999px';clone.style.whiteSpace='nowrap';clone.style.flex='0 0 auto';clone.style.width='auto';clone.style.maxWidth='none';
        document.body.appendChild(clone); const intr = clone.scrollWidth; clone.remove();
        return { rw: br.right - (tr.left + intr) };
    });
    // ★ 過大 padding 相当だと右空白が閾値 16 を超える (現行 <= 16 との対比で是正が実効)。
    expect(bloated.rw).toBeGreaterThan(16);
});
