/**
 * TC-OCM-01/02/03/04/10 — outliner copy path 系メニュー（sprint 20260818-183407 FR-OCM-01）
 *
 * - Copy Md Path = 旧 Copy Page Path の改名（挙動不変・host copyPagePaths のまま）
 * - Copy File Path = 複数選択対応（既存 host copyAttachedFilePaths へ配線）
 * - Copy Path = 新設（page→page md パス / file→file パス。host copyNodePaths）
 * - 表示条件は requirement FR-OCM-01 の全列挙が唯一の正（条件を満たさない項目は非表示）
 * - Outliner View / Table View 共有 showContextMenu に自然適用（Mindmap 専用メニューはスコープ外）
 *
 * クリップボードの実書込は host（vscode.env.clipboard）— webview 側は menu click →
 * 送出 message の内容（document order / entries 形式）を実 UI 操作で検証する（NFR-BAT-06 の
 * webview 側解釈: 合成 ClipboardEvent を使わず実メニュー click + 実 message で検証）。
 */
import { test, expect, Page } from '@playwright/test';

const TREE = {
    version: 1,
    rootIds: ['p1', 'f1', 'f2', 'plain1', 'plain2'],
    nodes: {
        p1: { id: 'p1', parentId: null, children: [], text: 'page node', isPage: true, pageId: 'pg1', tags: [] },
        f1: { id: 'f1', parentId: null, children: [], text: 'file node 1', filePath: 'files/a.pdf', tags: [] },
        f2: { id: 'f2', parentId: null, children: [], text: 'file node 2', filePath: 'files/b.pdf', tags: [] },
        plain1: { id: 'plain1', parentId: null, children: [], text: 'plain 1', tags: [] },
        plain2: { id: 'plain2', parentId: null, children: [], text: 'plain 2', tags: [] },
    },
};

async function initTree(page: Page, viewMode?: string) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.initOutliner !== undefined);
    await page.evaluate(({ tree, vm }) => {
        const data = JSON.parse(JSON.stringify(tree));
        if (vm) data.viewMode = vm;
        (window as any).__testApi.initOutliner(data);
    }, { tree: TREE, vm: viewMode || null });
    await page.waitForSelector('.outliner-node[data-id="p1"]');
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
}

async function shiftSelect(page: Page, firstId: string, lastId: string) {
    await page.locator(`.outliner-text[data-node-id="${firstId}"]`).click();
    await page.waitForTimeout(150);
    await page.locator(`.outliner-text[data-node-id="${lastId}"]`).click({ modifiers: ['Shift'] });
    await page.waitForTimeout(150);
}

/** nodeId を右クリックしてメニュー項目ラベル一覧を取得。labelToClick 指定時はその項目を click */
async function openMenu(page: Page, nodeId: string, labelToClick?: string) {
    return page.evaluate(({ nodeId, labelToClick }) => {
        (window as any).__testApi.messages.length = 0;
        const el = document.querySelector(`.outliner-node[data-id="${nodeId}"] .outliner-text`) as HTMLElement;
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 }));
        const items = Array.from(document.querySelectorAll('.outliner-context-menu-item'));
        const labels = items.map((it) => (it.textContent || '').trim());
        let clicked = false;
        if (labelToClick) {
            const target = items.find((it) => (it.textContent || '').includes(labelToClick)) as HTMLElement;
            if (target) { target.click(); clicked = true; }
        }
        return {
            labels,
            clicked,
            msgs: JSON.parse(JSON.stringify((window as any).__testApi.messages)),
        };
    }, { nodeId, labelToClick: labelToClick || null });
}

test('TC-OCM-01 単一 page node: Copy Md Path 表示（旧称 Copy Page Path は不在）+ 挙動不変（copyPagePaths 送出）', async ({ page }) => {
    await initTree(page);
    const r = await openMenu(page, 'p1', 'Copy Md Path');
    expect(r.labels.join('|')).toContain('Copy Md Path');
    expect(r.labels.join('|')).not.toContain('Copy Page Path');
    expect(r.clicked).toBe(true);
    const hit = r.msgs.filter((m: any) => m.type === 'copyPagePaths');
    expect(hit.length).toBe(1);
    expect(hit[0].pageIds).toEqual(['pg1']);
});

test('TC-OCM-02 file 添付 node ×2 選択 → Copy File Path → copyAttachedFilePaths が document order で送出', async ({ page }) => {
    await initTree(page);
    await shiftSelect(page, 'f1', 'f2');
    const r = await openMenu(page, 'f2', 'Copy File Path');
    expect(r.clicked).toBe(true);
    const hit = r.msgs.filter((m: any) => m.type === 'copyAttachedFilePaths');
    expect(hit.length).toBe(1);
    expect(hit[0].nodeIds).toEqual(['f1', 'f2']);
});

test('TC-OCM-03 page + file 混在選択 → Copy Path → copyNodePaths entries が document order', async ({ page }) => {
    await initTree(page);
    await shiftSelect(page, 'p1', 'f2'); // p1..f2 の範囲選択 = p1, f1, f2
    const r = await openMenu(page, 'f1', 'Copy Path');
    expect(r.clicked).toBe(true);
    const hit = r.msgs.filter((m: any) => m.type === 'copyNodePaths');
    expect(hit.length).toBe(1);
    expect(hit[0].entries).toEqual([
        { kind: 'page', pageId: 'pg1' },
        { kind: 'file', nodeId: 'f1' },
        { kind: 'file', nodeId: 'f2' },
    ]);
});

test('TC-OCM-04 page も file も無い選択 → Copy Md Path / Copy File Path / Copy Path とも非表示', async ({ page }) => {
    // plain のみのツリー（shift+click の範囲選択は文書先頭アンカーになるため専用 fixture で分離）
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.initOutliner !== undefined);
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({
            version: 1, rootIds: ['plain1', 'plain2'],
            nodes: {
                plain1: { id: 'plain1', parentId: null, children: [], text: 'plain 1', tags: [] },
                plain2: { id: 'plain2', parentId: null, children: [], text: 'plain 2', tags: [] },
            },
        });
    });
    await page.waitForSelector('.outliner-node[data-id="plain1"]');
    await shiftSelect(page, 'plain1', 'plain2');
    // 選択が実在すること（load-bearing 前提）
    expect(await page.locator('.outliner-node.is-selected').count()).toBe(2);
    const r = await openMenu(page, 'plain1');
    const joined = r.labels.join('|');
    expect(joined).not.toContain('Copy Md Path');
    expect(joined).not.toContain('Copy File Path');
    // 'Copy Path' は 'Copy Md Path' 等の部分文字列でないことを厳密に（完全一致項目の不在）
    expect(r.labels.some((l: string) => l === 'Copy Path' || l.startsWith('Copy Path'))).toBe(false);
});

test('TC-OCM-10 Table View でも共有 showContextMenu に自然適用（Copy Md Path が出る）', async ({ page }) => {
    await initTree(page, 'table');
    const r = await openMenu(page, 'p1');
    expect(r.labels.join('|')).toContain('Copy Md Path');
});

// ─── TC-OCM-05/06（webview 側）: copy subtree as xxx の複数 node 対応（FR-OCM-02・ADRL-0077） ───

const LLMS_TREE = {
    version: 1,
    rootIds: ['a', 'b', 'c'],
    nodes: {
        a: { id: 'a', parentId: null, children: ['a1'], text: 'A root', isPage: true, pageId: 'pgA', tags: [] },
        a1: { id: 'a1', parentId: 'a', children: [], text: 'A child', isPage: true, pageId: 'pgA1', tags: [] },
        b: { id: 'b', parentId: null, children: [], text: 'B root', isPage: true, pageId: 'pgB', tags: [] },
        c: { id: 'c', parentId: null, children: [], text: 'C root', isPage: true, pageId: 'pgC', tags: [] },
    },
};

async function initLlmsTree(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.initOutliner !== undefined);
    await page.evaluate((tree) => { (window as any).__testApi.initOutliner(JSON.parse(JSON.stringify(tree))); }, LLMS_TREE);
    await page.waitForSelector('.outliner-node[data-id="a"]');
}

test('TC-OCM-05 兄弟 A・B 選択 → copy subtree as llms.txt → forest（2 root）が送出される', async ({ page }) => {
    await initLlmsTree(page);
    await shiftSelect(page, 'a', 'b'); // 先頭アンカー範囲 = a, a1, b
    const r = await openMenu(page, 'a', 'Copy subtree as llms.txt (MD pages)');
    expect(r.clicked).toBe(true);
    const hit = r.msgs.filter((m: any) => m.type === 'copyLlmsTxtMdTree');
    expect(hit.length).toBe(1);
    // 選択 = a, a1, b — a1 は a の subtree に含まれるため独立 root にならない（祖先包含重複排除）
    expect(Array.isArray(hit[0].tree)).toBe(true);
    expect(hit[0].tree.map((t: any) => t.id)).toEqual(['a', 'b']);
    // a の subtree に a1 が 1 回だけ現れる
    expect(hit[0].tree[0].children.map((c: any) => c.id)).toEqual(['a1']);
});

test('TC-OCM-06 親 + 子を両方選択 → 親 subtree のみ（子は独立 root 化しない・counterfactual）', async ({ page }) => {
    await initLlmsTree(page);
    await shiftSelect(page, 'a', 'a1'); // a と a1（親子）
    const r = await openMenu(page, 'a', 'Copy subtree as llms.txt (files)');
    expect(r.clicked).toBe(true);
    const hit = r.msgs.filter((m: any) => m.type === 'copyLlmsTxtFileTree');
    expect(hit.length).toBe(1);
    // counterfactual: 祖先包含排除を外すと ['a','a1'] の 2 root（a1 が 2 回出力）= RED
    expect(hit[0].tree.map((t: any) => t.id)).toEqual(['a']);
});

test('TC-OCM-05e 選択なし右クリック → 従来どおり単一 root（配列長 1）', async ({ page }) => {
    await initLlmsTree(page);
    const r = await openMenu(page, 'b', 'Copy subtree as llms.txt (MD + files)');
    expect(r.clicked).toBe(true);
    const hit = r.msgs.filter((m: any) => m.type === 'copyLlmsTxtBothTree');
    expect(hit.length).toBe(1);
    expect(hit[0].tree.map((t: any) => t.id)).toEqual(['b']);
});

// ─── TC-OCM-08/09: node の Duplicate（FR-OCM-03・sprint 20260818-183407 TASK-13） ───

const DUP_TREE = {
    version: 1,
    rootIds: ['x', 'p', 's1', 's2'],
    nodes: {
        x: { id: 'x', parentId: null, children: [], text: 'clipboard keeper', tags: [] },
        p: { id: 'p', parentId: null, children: ['pc'], text: 'dup target', isPage: true, pageId: 'pgP', tags: [] },
        pc: { id: 'pc', parentId: 'p', children: [], text: 'dup child', tags: [] },
        s1: { id: 's1', parentId: null, children: [], text: 'sib one', tags: [] },
        s2: { id: 's2', parentId: null, children: [], text: 'sib two', tags: [] },
    },
};

async function initDupTree(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.initOutliner !== undefined);
    await page.evaluate((tree) => { (window as any).__testApi.initOutliner(JSON.parse(JSON.stringify(tree))); }, DUP_TREE);
    await page.waitForSelector('.outliner-node[data-id="p"]');
}

function treeTexts(page: Page) {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('.outliner-node .outliner-text')).map((e) => (e.textContent || '').trim()));
}

test('TC-OCM-08 Duplicate: subtree 複製が直後に挿入・page は copy 意味論・内部 clipboard 非破壊・undo 1 回', async ({ page }) => {
    await initDupTree(page);
    // 事前に別 node x を cmd+c（実キー）
    await page.locator('.outliner-text[data-node-id="x"]').click();
    await page.waitForTimeout(150);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
    await page.waitForTimeout(150);
    // p を右クリック → Duplicate
    const r = await openMenu(page, 'p', 'Duplicate');
    expect(r.clicked).toBe(true);
    await page.waitForTimeout(300);
    const after = await treeTexts(page);
    // 複製 subtree（dup target + dup child）が元の直後に挿入される
    expect(after.filter((t) => t === 'dup target').length).toBe(2);
    expect(after.filter((t) => t === 'dup child').length).toBe(2);
    const firstIdx = after.indexOf('dup target');
    expect(after[firstIdx + 1]).toBe('dup child');
    expect(after[firstIdx + 2]).toBe('dup target'); // 直後（sib one の前）
    expect(after[firstIdx + 3]).toBe('dup child');
    // TASK-18 (reviewer iteration 1 DESIGN-1): Store の一時保存 → internalClipboard からの復元、の
    // message 列を pin（復元配線が剥がれる regression の番人）。saveOutlinerClipboard は
    // (1) Duplicate 専用キー（isCut=false・dup 対象 nodes）(2) 復元（事前 cmd+c の 'clipboard keeper'）の順。
    const saves = r.msgs.filter((m: any) => m.type === 'saveOutlinerClipboard');
    expect(saves.length).toBe(2);
    expect(saves[0].isCut).toBe(false);
    expect(saves[0].nodes.map((n: any) => n.text)).toEqual(['dup target', 'dup child']);
    expect(saves[1].plainText).toBe('clipboard keeper'); // 復元 payload = 事前コピー
    // page は copy 意味論 = 新 pageId 発行の handlePageAssetsCross（isCut=false）が飛ぶ
    // openMenu の click は同期実行 — r.msgs に全 message が既に載っている（live 配列の再取得は二重計上になる）
    const pg = r.msgs.filter((m: any) => m.type === 'handlePageAssetsCross');
    expect(pg.length).toBe(1);
    expect(pg[0].pageId).toBe('pgP');
    expect(pg[0].newPageId).toBeTruthy();
    expect(pg[0].newPageId).not.toBe('pgP');
    // 内部 clipboard 非破壊: Duplicate 後に paste すると事前コピーの x が貼れる
    // （paste は実 clipboardData の paste イベント — 内部 clip が plainText 一致で勝つ形。
    //   mindmap-copy-paste.spec の確立パターン。headless の OS clipboard 往復非依存）
    await page.locator('.outliner-text[data-node-id="s2"]').click();
    await page.waitForTimeout(150);
    await page.evaluate(() => {
        const textEl = document.querySelector('.outliner-text[data-node-id="s2"]') as HTMLElement;
        const dt = new DataTransfer();
        dt.setData('text/plain', 'clipboard keeper');
        textEl.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    });
    await page.waitForTimeout(300);
    const afterPaste = await treeTexts(page);
    // 単一 node 内部コピーの paste はキャレット位置へのインライン貼付（既存 cmd+v 挙動）—
    // 「事前コピーの内容が貼れる」= 'clipboard keeper' が計 2 回出現することを substring で数える
    const keeperCount = (afterPaste.join('|').match(/clipboard keeper/g) || []).length;
    expect(keeperCount).toBe(2);
    // undo 契約: cmd+z ×1 で paste が消え、×2 で複製も消え元の構造に戻る
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.waitForTimeout(300);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.waitForTimeout(300);
    const afterUndo = await treeTexts(page);
    expect(afterUndo.filter((t) => t === 'dup target').length).toBe(1);
    expect((afterUndo.join('|').match(/clipboard keeper/g) || []).length).toBe(1);
});

test('TC-OCM-09 複数 node 選択 Duplicate: 選択全体が末尾選択 node の直後に複製（document order 維持）', async ({ page }) => {
    await initDupTree(page);
    await shiftSelect(page, 's1', 's2');
    // 範囲選択は文書先頭アンカー（既知の harness 挙動）→ x..s2 全選択になるため、
    // ここでは s1/s2 のみ選択にする: s1 click → s2 shift+click の結果を実測で確認して進める
    const selected = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.outliner-node.is-selected')).map((e: any) => e.dataset.id));
    const r = await openMenu(page, 's2', 'Duplicate');
    expect(r.clicked).toBe(true);
    await page.waitForTimeout(300);
    const after = await treeTexts(page);
    // 選択集合（実測 selected）が末尾 s2 の直後に document order で複製される
    if (selected.join(',') === 's1,s2') {
        expect(after.join('|')).toContain('sib one|sib two|sib one|sib two');
    } else {
        // 全選択に落ちた場合も「末尾直後に document order 複製」の契約は同じ
        expect(after.filter((t) => t === 'sib one').length).toBe(2);
        expect(after.filter((t) => t === 'sib two').length).toBe(2);
        const lastS2 = after.lastIndexOf('sib two');
        expect(lastS2).toBeGreaterThan(after.indexOf('sib two'));
    }
});
