/**
 * outliner の cmd+c に nodeIds を additive（FR-CBD-03 / DOM-OutlinerClipCopy / DOM-ClipPayload）
 * sprint 20260906-095357-outliner-selmode-cmda-linkedfd-multimove / TASK-10
 *
 * G（outliner → linkedfd の clipboard 複写）の**送り手**。実体は載せず識別子だけを
 * 既存の `data-outliner-clipboard` メタ（text/html の先頭タグ）に additive で足す。
 *
 * 🔴 生の `selectedNodeIds` を渡さない（HM-9）: host の `buildExportNodesFromOutData` に
 *    祖先-子孫の重複排除が無いため、生集合を渡すと子孫が「祖先の children」と「トップレベル entry」の
 *    2 箇所に出力されて linkedfd に二重書き出しされる。必ず `selectionExportRoots()`（可視順 + 最上位のみ）を通す。
 */
import { test, expect, Page } from '@playwright/test';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

function n(id: string, text: string, extra: any = {}) {
    return Object.assign({
        id, parentId: null, children: [], text, collapsed: false, subtext: '',
        images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [],
    }, extra);
}

/** a > a1 / b / c（a 展開済み）。可視 = a, a1, b, c */
const TREE = {
    version: 1, rootIds: ['a', 'b', 'c'],
    nodes: {
        a: n('a', 'alpha', { children: ['a1'] }),
        a1: n('a1', 'alpha-1', { parentId: 'a' }),
        b: n('b', 'bravo'),
        c: n('c', 'charlie', { images: ['images/pic.png'] }),   // 直付き画像あり（裁定 R22 の対象）
    },
};

async function setup(page: Page, tree: any = TREE): Promise<void> {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => { /* 一部環境で不要 */ });
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate((t) => { (window as any).__testApi.initOutliner(t); }, tree);
    await page.waitForSelector('.outliner-node', { timeout: 5000 });
    await page.waitForFunction(() => {
        const ae = document.activeElement as HTMLElement | null;
        return !!ae && ae.classList.contains('outliner-text');
    }, undefined, { timeout: 5000 }).catch(() => { /* noop */ });
}

const text = (page: Page, id: string) => page.locator(`.outliner-node[data-id="${id}"] .outliner-text`);

/** 指定 id を cmd+click で選択集合に入れる（修飾なし click は選択をクリアする） */
async function selectIds(page: Page, ids: string[]) {
    await text(page, ids[0]).click();
    for (const id of ids) { await text(page, id).click({ modifiers: [MOD as any] }); }
    expect(await page.locator('.outliner-node.is-selected').count(), `前提: ${ids.length} 件選択`).toBe(ids.length);
}

/** OS clipboard の text/html から `data-outliner-clipboard` メタを取り出す */
async function clipMeta(page: Page): Promise<any> {
    return page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        for (const it of items) {
            if (it.types.includes('text/html')) {
                const html = await (await it.getType('text/html')).text();
                const m = html.match(/data-outliner-clipboard="([^"]*)"/);
                if (m) { try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; } }
            }
        }
        return null;
    });
}

test('TC-CBD-20 複数選択の cmd+c で nodeIds が clipboard メタに載る（可視順）', async ({ page }) => {
    await setup(page);
    await selectIds(page, ['a', 'b', 'c']);
    await page.keyboard.press(`${MOD}+c`);
    await page.waitForTimeout(250);
    const meta = await clipMeta(page);
    expect(meta, 'clipboard の text/html に data-outliner-clipboard メタが無い').not.toBeNull();
    expect(meta.nodeIds, 'nodeIds が payload に載っていない（G の送り手が成立しない）').toEqual(['a', 'b', 'c']);
    expect(meta.sourceOutFileKey !== undefined, '既存フィールド sourceOutFileKey が失われた').toBe(true);
    expect(Array.isArray(meta.nodes), '既存フィールド nodes が失われた').toBe(true);
});

test('TC-CBD-21 親子跨ぎ選択では nodeIds が親だけ（二重書き出しの番人 / HM-9）', async ({ page }) => {
    await setup(page);
    await selectIds(page, ['a', 'a1', 'b']);     // 親 a と その子 a1 の両方
    await page.keyboard.press(`${MOD}+c`);
    await page.waitForTimeout(250);
    const meta = await clipMeta(page);
    expect(meta.nodeIds,
        '子孫が nodeIds に含まれている（生の selectedNodeIds を渡している = host に重複排除が無いので linkedfd に二重書き出しされる）')
        .toEqual(['a', 'b']);
});

test('TC-CBD-22 nodeIds の追加は既存 clipboard 契約に対して inert', async ({ page }) => {
    await setup(page);
    await selectIds(page, ['b', 'c']);
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await page.keyboard.press(`${MOD}+c`);
    await page.waitForTimeout(250);
    // host への既存 message は形が変わっていない（nodes/plainText/isCut のみ）
    const msgs = await page.evaluate(() =>
        (window as any).__testApi.messages.filter((m: any) => m.type === 'saveOutlinerClipboard'));
    expect(msgs.length, 'saveOutlinerClipboard が送られていない').toBe(1);
    expect(msgs[0].nodes.length, '既存の nodes payload が壊れた').toBe(2);
    // outliner 内 paste で node 構造が従来どおり増える
    const before = await page.locator('.outliner-node').count();
    await text(page, 'a').click();
    await page.waitForTimeout(80);
    await page.evaluate(async () => {
        const el = document.activeElement as HTMLElement;
        const items = await navigator.clipboard.read();
        let html = ''; let plain = '';
        for (const it of items) {
            if (it.types.includes('text/html')) { html = await (await it.getType('text/html')).text(); }
            if (it.types.includes('text/plain')) { plain = await (await it.getType('text/plain')).text(); }
        }
        const dt = new DataTransfer();
        dt.setData('text/plain', plain);
        dt.setData('text/html', html);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(300);
    expect(await page.locator('.outliner-node').count(), 'outliner 内 paste で node が増えていない（既存契約が壊れた）')
        .toBeGreaterThan(before);
});

test('TC-CBD-28 nodeIds は識別子のみ（実体・直付き画像を payload に載せない / 裁定 R22）', async ({ page }) => {
    await setup(page);
    await selectIds(page, ['c']);                 // c は images を持つ
    await page.keyboard.press(`${MOD}+c`);
    await page.waitForTimeout(250);
    const meta = await clipMeta(page);
    expect(meta.nodeIds, 'nodeIds が識別子の配列でない').toEqual(['c']);
    expect(meta.nodeIds.every((x: any) => typeof x === 'string'),
        'nodeIds に文字列以外（実体 payload）が混入している — 転送対象の決定は host 側の既存収集器に委ねる').toBe(true);
});

test('TC-CBD-29 mindmap view でも同じ keydown を通るので nodeIds が載る（面差を作らない）', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { (window as any).Outliner.setViewMode('mindmap'); });
    await page.waitForSelector('.mindmap-node', { timeout: 5000 });
    // mindmap 面で全 node 選択（FR-OSM-06 rev1 = 1 段階免除）→ cmd+c
    await page.evaluate(() => {
        const el = (document.querySelector('.mindmap-node') as HTMLElement)
            || (document.querySelector('.outliner-tree') as HTMLElement) || document.body;
        el.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'a', code: 'KeyA', bubbles: true, cancelable: true, metaKey: true, ctrlKey: true,
        }));
    });
    await page.waitForTimeout(150);
    // mindmap 面では `.outliner-node` は描画されない（選択は `.mindmap-node-box.is-selected`）。
    // DOM ではなく **cmd+c の payload に nodeIds が載るか**で判定する（面差の有無が本 TC の趣旨）。
    const mmSelected = await page.evaluate(() =>
        document.querySelectorAll('.mindmap-node-box.is-selected, .mindmap-node.is-selected').length);
    expect(mmSelected, 'mindmap で Cmd+A の全 node 選択が効いていない（FR-OSM-06 rev1 の免除）').toBeGreaterThan(0);
    await page.keyboard.press(`${MOD}+c`);
    await page.waitForTimeout(250);
    const meta = await clipMeta(page);
    expect(meta && Array.isArray(meta.nodeIds),
        'mindmap 面で nodeIds が載らない（送り手を面ごとに分けると「複数選択なのに 1 件しか移らない」面差が再発する）').toBe(true);
    expect(meta.nodeIds.length).toBeGreaterThan(0);
});
