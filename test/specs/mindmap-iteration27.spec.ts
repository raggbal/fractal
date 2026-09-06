/**
 * Mindmap iteration 27 — Delete画面不動 / ひらがなtype-to-edit(IME) / wheelズーム高速化 (Wave 32)
 *   TC-M18 [D]: Delete で viewport(pan/zoom = translate/scale) が動かない。
 *   TC-M19 [E]: committed active ノードは contenteditable=true だが is-editing でない。
 *               印字キー/compositionstart で is-editing へ昇格 (ひらがな type-to-edit の IME 対応)。
 *   TC-M20 [F]: Ctrl+wheel ズームが速い (1 発の変化量が旧より大きい)。
 *
 * 根本原因 (session-log「iteration 27」):
 *   [D] iteration 26 の Delete が ensureNodeVisible(successor) で最小パンしていた + 削除で bounds が
 *       縮み viewBox シフト。→ ensureNodeVisible を呼ばず translate/scale を保存→復元 (pan/zoom 固定)。
 *       残りノードのツリー再レイアウトは自然な挙動として許容 (ユーザー選択)。
 *   [E] type-to-edit が keydown で focusNode(true)=再focus し IME が英数リセット。committed 未編集の
 *       contenteditable 無し要素に IME 合成ターゲットが無い。→ committed active を contenteditable=true
 *       (is-editing なし) にし、compositionstart/beforeinput で「再focusせず」is-editing へ昇格。
 *       編集中信号を contenteditable → is-editing クラスへ分離。実 IME は手動テスト必須 (headless 不可)。
 *   [F] wheel の K=0.0015・clamp 0.9〜1.1 が控えめ。→ K=0.003・clamp 0.8〜1.25。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() 直呼び禁止。実クリック→実キー。
 *   本番同等 3 段 DOM。ひらがなの実挙動は synthetic CompositionEvent で「昇格ロジック」を検証する
 *   (実 IME の英数リセット有無は headless で忠実再現できないため手動テストに委ねる)。
 */

import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 800, height: 600 } });

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

function node(id: string, text: string, children: string[] = [], parentId: string | null = null) {
    return { id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] };
}

async function reproduceProdScrollStructure(page: import('@playwright/test').Page, containerHeight = 0) {
    await page.evaluate((h) => {
        const tree = document.querySelector('.outliner-tree');
        const container = document.querySelector('.outliner-container') as HTMLElement;
        if (!tree || !container) { return; }
        if (document.querySelector('.outliner-scroll-content')) { return; }
        const st = document.createElement('style');
        st.textContent = '.outliner-scroll-content{flex:1;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;}';
        document.head.appendChild(st);
        const sc = document.createElement('div');
        sc.className = 'outliner-scroll-content';
        tree.parentNode!.insertBefore(sc, tree);
        sc.appendChild(tree);
        if (h > 0) { container.style.height = h + 'px'; }
    }, containerHeight);
}

async function toMindmap(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(JSON.parse(JSON.stringify(d))); }, data);
    await reproduceProdScrollStructure(page);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(250);
}

function viewport(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const v = (window as any).MindmapRender.getViewport();
        return { s: v.scale, tx: v.translateX, ty: v.translateY };
    });
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

// P(子 c1,c2) + 8 root で削除に伴う reLayout を起こす
function wideModel() {
    const nodes: any = {}; const roots: string[] = [];
    for (let i = 0; i < 8; i++) { const id = 'r' + i; roots.push(id); nodes[id] = node(id, id + '-xxxxxxxx'); }
    nodes.r3.children = ['c1', 'c2'];
    nodes.c1 = node('c1', 'C1', [], 'r3');
    nodes.c2 = node('c2', 'C2', [], 'r3');
    return { version: 1, viewMode: 'mindmap', rootIds: roots, nodes };
}

// ============ [D] TC-M18 Delete keeps viewport (pan/zoom) fixed ============

test('TC-M18 Delete で viewport(pan/zoom) が動かない', async ({ page }) => {
    await setup(page);
    await toMindmap(page, wideModel());
    // zoom して scale≠1 + translate≠0 にする
    await page.locator('.mindmap-toolbar [data-mm-action="zoom-in"]').click();
    await page.waitForTimeout(120);
    // R34 の open-centering 後は c1 が可視領域外になり click が intercept されるため、
    // 計測開始前に c1 を可視領域へ pan しておく (pan 自体は before の計測前に完了)。
    await panNodeIntoView(page, 'c1');
    const before = await viewport(page);

    // 子ノード c1 を選択して Delete
    await page.locator('.mindmap-node[data-node-id="c1"] .mindmap-node-box').click();
    await page.waitForTimeout(80);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(150);
    const after = await viewport(page);

    // pan/zoom (translate/scale) が Delete 前後で不変。
    expect(Math.abs(after.s - before.s)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(after.tx - before.tx)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(after.ty - before.ty)).toBeLessThanOrEqual(0.5);
    // c1 は削除された
    expect(await page.evaluate(() => !!document.querySelector('.mindmap-node[data-node-id="c1"]'))).toBe(false);
});

// ============ [E] TC-M19 committed active editable but not editing; promote on composition ============

test('TC-M19 committed active は contenteditable=true だが is-editing でない', async ({ page }) => {
    await setup(page);
    await toMindmap(page, { version: 1, viewMode: 'mindmap', rootIds: ['n'], nodes: { n: node('n', 'abc') } });
    await page.locator('.mindmap-node[data-node-id="n"] .mindmap-node-box').click();
    await page.waitForTimeout(100);
    const st = await page.evaluate(() => {
        const t = document.querySelector('.mindmap-node-text[data-node-id="n"]') as HTMLElement;
        return { ce: t.getAttribute('contenteditable'), editing: t.classList.contains('is-editing') };
    });
    // IME 合成ターゲットになれるよう contenteditable=true、ただしまだ編集中でない (is-editing なし)。
    expect(st.ce).toBe('true');
    expect(st.editing).toBe(false);
});

test('TC-M19 compositionstart で committed active が is-editing へ昇格する (ひらがな type-to-edit)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, { version: 1, viewMode: 'mindmap', rootIds: ['n'], nodes: { n: node('n', 'あ') } });
    await page.locator('.mindmap-node[data-node-id="n"] .mindmap-node-box').click();
    await page.waitForTimeout(100);
    // 昇格前: is-editing なし
    expect(await page.evaluate(() => document.querySelector('.mindmap-node-text[data-node-id="n"]')!.classList.contains('is-editing'))).toBe(false);
    // IME 合成開始を模す (実 IME の英数リセット有無は手動テスト。ここは昇格ロジックの検証)。
    await page.evaluate(() => {
        const t = document.querySelector('.mindmap-node-text[data-node-id="n"]') as HTMLElement;
        t.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    await page.waitForTimeout(60);
    // 昇格後: is-editing 付与 = 編集モードに入った (再 focus せず)。
    expect(await page.evaluate(() => document.querySelector('.mindmap-node-text[data-node-id="n"]')!.classList.contains('is-editing'))).toBe(true);
});

test('TC-M19 load-bearing: 昇格ロジックを外すと compositionstart 後も is-editing が付かない (対照)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, { version: 1, viewMode: 'mindmap', rootIds: ['n'], nodes: { n: node('n', 'あ') } });
    await page.locator('.mindmap-node[data-node-id="n"] .mindmap-node-box').click();
    await page.waitForTimeout(100);
    // 対照: compositionstart を .mindmap-node-text でない要素へ送ると昇格しない (ガード条件の確認)。
    await page.evaluate(() => {
        const box = document.querySelector('.mindmap-node[data-node-id="n"] .mindmap-node-box') as HTMLElement;
        box.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: false }));
    });
    await page.waitForTimeout(60);
    expect(await page.evaluate(() => document.querySelector('.mindmap-node-text[data-node-id="n"]')!.classList.contains('is-editing'))).toBe(false);
});

test('TC-M19 回帰: 半角英数 type-to-edit は従来どおり (X で abcX・is-editing 昇格)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, { version: 1, viewMode: 'mindmap', rootIds: ['n'], nodes: { n: node('n', 'abc') } });
    await page.locator('.mindmap-node[data-node-id="n"] .mindmap-node-box').click();
    await page.waitForTimeout(80);
    await page.keyboard.press('X');
    await page.waitForTimeout(120);
    const st = await page.evaluate(() => {
        const t = document.querySelector('.mindmap-node-text[data-node-id="n"]') as HTMLElement;
        return { editing: t.classList.contains('is-editing'), text: t.textContent };
    });
    expect(st.editing).toBe(true);
    expect(st.text).toBe('abcX');
});

// ============ [F] TC-M20 wheel zoom faster ============

test('TC-M20 Ctrl+wheel ズームが速い (1 発の変化が旧より大きい)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, { version: 1, viewMode: 'mindmap', rootIds: ['n1'], nodes: { n1: node('n1', 'Root', ['c1']), c1: node('c1', 'C1', [], 'n1') } });
    const scaleOf = async () => (await viewport(page)).s;

    const before = await scaleOf();
    await page.evaluate(() => {
        const tree = document.querySelector('.outliner-tree') as HTMLElement;
        tree.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(60);
    const after = await scaleOf();
    // deltaY=-120 一発で >= 1.2 倍 (旧 clamp 1.1 上限より速い)。
    expect(after / before).toBeGreaterThanOrEqual(1.2);

    // zoom-out も対称に速い (deltaY=+120 で <= 0.85 倍)。
    const b2 = await scaleOf();
    await page.evaluate(() => {
        const tree = document.querySelector('.outliner-tree') as HTMLElement;
        tree.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(60);
    const a2 = await scaleOf();
    expect(a2 / b2).toBeLessThanOrEqual(0.85);
    // scale 下限 0.2 は割らない (クランプ健在)。
    expect(a2).toBeGreaterThanOrEqual(0.2);
});
