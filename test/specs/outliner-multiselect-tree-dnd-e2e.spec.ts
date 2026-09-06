/**
 * 複数選択 outliner node → note tree への D&D を **送り手と受け手を繋いで** 検証する
 *（sprint 20260901-075849 / 裁定 R32 / FR-MSD-01。TC-MSD-01..06）
 *
 * 実機報告（rc.15）: 「outliner の複数選択状態で note filetree への D&D が動かない。
 * filetree / その上の md・out・linkedfd に落とせるはずでは？」
 *
 * 原因: 送り手（outliner.js `buildNodeAssetsPayload`）は **掴んだ node 自身**の添付を `assets`、
 * **選択集合全体**の添付を `items` に積む。素の text node（添付なし）のバレットを掴むと
 * `assets: []` + `items: [...]` になるが、受け手（notes-file-panel.js `readOutNodeAssetsPayload`）が
 * `assets.length === 0` で payload を捨てていたため、選択集合ごと無視されて **完全無反応**だった。
 * さらに subtree payload だけが残って末尾の内部移動経路まで落ち、`moveItem(null, ...)` という
 * 偽の message を送っていた（md / file item の上下帯）。
 *
 * 🔴 既存 TC が payload を**手書き**していたためこのクラスは構造的に見えなかった。
 * ここでは **本番の dragstart が実際に積んだ DataTransfer の中身**をそのまま受け手へ流す
 *（同一 page で outliner → notes へ goto。webview 間 D&D の実体と同じ payload 経路）。
 *
 * counterfactual: 受け手の受理条件を旧 `assets.length === 0 → null` に戻すと
 * TC-MSD-01（余白）/ 03（md 中央）/ 05（上下帯）が RED。
 */
import { test, expect, Page } from '@playwright/test';

const SUB = 'application/x-fractal-out-node-subtree';
const AS = 'application/x-fractal-out-node-assets';
const OUT_KEY = '/n/o1.out';

function n(id: string, text: string, extra: any = {}) {
    return Object.assign({
        id, parentId: null, children: [], text, collapsed: false, subtext: '',
        images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [],
    }, extra);
}
/** n1 = 素の node（添付なし）/ n2 = page md 付き / n3 = 添付ファイル付き */
const TREE = {
    version: 1, rootIds: ['n1', 'n2', 'n3'],
    nodes: {
        n1: n('n1', 'plain'),
        n2: n('n2', 'haspage', { isPage: true, pageId: 'page-2' }),
        n3: n('n3', 'hasfile', { filePath: 'files/a.pdf' }),
    },
};
/** 添付を 1 つも持たない選択集合（counterfactual 用） */
const TREE_NO_ASSETS = {
    version: 1, rootIds: ['n1', 'n2', 'n3'],
    nodes: { n1: n('n1', 'a'), n2: n('n2', 'b'), n3: n('n3', 'c') },
};

const STRUCTURE = {
    version: 1, rootIds: ['o1', 'o2', 'm1', 'm2', 'fl1', 'f1'],
    items: {
        o1: { type: 'file', id: 'o1', title: 'out1', ext: 'out', filePath: '/n/o1.out' },
        o2: { type: 'file', id: 'o2', title: 'out2', ext: 'out', filePath: '/n/o2.out' },
        m1: { type: 'file', id: 'm1', title: 'md1', ext: 'md', filePath: '/n/m1.md' },
        m2: { type: 'file', id: 'm2', title: 'md2', ext: 'md', filePath: '/n/m2.md' },
        fl1: { type: 'file', id: 'fl1', title: 'Docs', ext: 'folder' },
        f1: { type: 'file', id: 'f1', title: 'file1', ext: 'file', filename: 'a.pdf' },
    },
};
const FILES = [
    { filePath: '/n/o1.out', title: 'out1', id: 'o1', kind: 'out' },
    { filePath: '/n/o2.out', title: 'out2', id: 'o2', kind: 'out' },
    { filePath: '/n/m1.md', title: 'md1', id: 'm1', kind: 'md' },
    { filePath: '/n/m2.md', title: 'md2', id: 'm2', kind: 'md' },
    { filePath: '', title: 'Docs', id: 'fl1', kind: 'folder', broken: false },
    { filePath: '', title: 'file1', id: 'f1', kind: 'file' },
];

/**
 * 送り手側: outliner を開き、3 node を cmd+click で選択して `grabId` のバレットから
 * 本番の dragstart を発火し、DataTransfer に積まれた MIME → 文字列をそのまま返す。
 */
async function capturePayload(page: Page, grabId: string, tree: any = TREE): Promise<Record<string, string>> {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    // 添付 payload は notes モード限定（`.notes-layout` の存在で判定）— 本番の notes 面と同じ条件を作る
    await page.evaluate(() => {
        if (!document.querySelector('.notes-layout')) {
            const d = document.createElement('div'); d.className = 'notes-layout'; document.body.appendChild(d);
        }
    });
    await page.evaluate(({ t, key }) => { (window as any).__testApi.initOutliner(t, key); }, { t: tree, key: OUT_KEY });
    await page.waitForSelector('.outliner-node', { timeout: 5000 });
    await page.locator('.outliner-node[data-id="n1"] .outliner-text').click();
    for (const id of ['n1', 'n2', 'n3']) {
        await page.locator(`.outliner-node[data-id="${id}"] .outliner-text`).click({ modifiers: ['Meta'] });
    }
    const out = await page.evaluate((grabId) => {
        const bullet = document.querySelector(`.outliner-node[data-id="${grabId}"] .outliner-bullet`) as HTMLElement;
        const r = bullet.getBoundingClientRect();
        bullet.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: r.left + 2, clientY: r.top + 2 }));
        const dt = new DataTransfer();
        bullet.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const map: Record<string, string> = {};
        for (const t of Array.from(dt.types)) { map[t] = dt.getData(t); }
        return map;
    }, grabId);
    return out;
}

/** 受け手側: note tree を開く */
async function openTree(page: Page): Promise<void> {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate(({ files, structure }) => { (window as any).__testApi.initNotesPanel(files, '/n/o1.out', structure); }, { files: FILES, structure: STRUCTURE });
    await page.waitForSelector('.file-panel-item[data-item-id="fl1"]', { timeout: 5000 });
}

/** 捕まえた payload を CSS セレクタの item / 余白へ dragover → drop し、host への message を返す */
async function dropRaw(page: Page, raw: Record<string, string>, sel: string, ratio: number): Promise<any[]> {
    await page.evaluate(({ raw, sel, ratio }) => {
        (window as any).__testApi.notesMessages.length = 0;
        const dst = document.querySelector(sel) as HTMLElement;
        const dt = new DataTransfer();
        for (const k of Object.keys(raw)) { dt.setData(k, raw[k]); }
        const r = dst.getBoundingClientRect();
        const x = r.left + Math.min(20, r.width / 2), y = r.top + r.height * ratio;
        dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    }, { raw, sel, ratio });
    await page.waitForTimeout(80);
    return await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.notesMessages)));
}
function types(list: any[]): string[] { return list.map((m) => m.type).filter((t) => t !== 'notifyError'); }

test('TC-MSD-01 素の node を掴んだ複数選択 drag が tree 余白で選択集合ぶんの添付を登録する', async ({ page }) => {
    const raw = await capturePayload(page, 'n1');
    // 送り手の契約（この形が受け手に届く）: 掴んだ node は添付なし → assets 空 / items に 2 件
    const ap = JSON.parse(raw[AS]);
    expect(ap.assets, '掴んだ素の node 自身の添付は無い').toEqual([]);
    expect(ap.items.map((it: any) => it.nodeId), '選択集合の添付持ちが載る').toEqual(['n2', 'n3']);

    await openTree(page);
    const m = await dropRaw(page, raw, '#notesFileList', 0.98);
    expect(types(m), `余白 drop: ${types(m).join(',')}`).toEqual(['notesRegisterNodeAssets']);
    expect(m[0].payload.items.map((it: any) => it.nodeId)).toEqual(['n2', 'n3']);
});

test('TC-MSD-02 同じ drag を .out item に落とすと選択集合の root すべてが move される', async ({ page }) => {
    const raw = await capturePayload(page, 'n1');
    await openTree(page);
    const m = await dropRaw(page, raw, '[data-item-id="o2"]', 0.5);
    expect(types(m)).toEqual(['notesMoveOutNodeSubtreeIntoOut']);
    expect(m[0].payload.nodeIds).toEqual(['n1', 'n2', 'n3']);
});

test('TC-MSD-03 同じ drag を md item 中央に落とすと選択集合の添付が md へ渡る', async ({ page }) => {
    const raw = await capturePayload(page, 'n1');
    await openTree(page);
    const m = await dropRaw(page, raw, '[data-item-id="m2"]', 0.5);
    expect(types(m)).toEqual(['notesAttachOutNodeAssetsToMdItem']);
    expect(m[0].targetMdId).toBe('m2');
    // 旧実装は assets 空の payload に落として items を捨てていた（= 1 件も運べない）
    expect(m[0].payload.items.map((it: any) => it.nodeId)).toEqual(['n2', 'n3']);
});

test('TC-MSD-04 同じ drag を linkedfd item に落とすと選択集合が linkedfd へ送られる', async ({ page }) => {
    const raw = await capturePayload(page, 'n1');
    await openTree(page);
    const m = await dropRaw(page, raw, '[data-item-id="fl1"]', 0.5);
    expect(types(m)).toEqual(['sendOutNodesToFolderLinkFromDrop']);
    expect(m[0].payload.nodeIds).toEqual(['n1', 'n2', 'n3']);
    expect(m[0].folderLinkId).toBe('fl1');
});

test('TC-MSD-05 md / file item の上下帯は兄弟登録（偽の moveItem を送らない）', async ({ page }) => {
    const raw = await capturePayload(page, 'n1');
    await openTree(page);
    for (const sel of ['[data-item-id="m2"]', '[data-item-id="f1"]']) {
        const m = await dropRaw(page, raw, sel, 0.1);
        expect(types(m), `${sel} 上帯: ${types(m).join(',')}`).toEqual(['notesRegisterNodeAssets']);
        expect(types(m), '内部移動の moveItem に落ちない').not.toContain('moveItem');
    }
});

test('TC-MSD-06 添付持ち node を掴んだ場合も同じ 4 面が動く（回帰）+ 添付ゼロ選択は無反応', async ({ page }) => {
    const raw = await capturePayload(page, 'n2');
    const ap = JSON.parse(raw[AS]);
    expect(ap.assets.length, '掴んだ node 自身の添付も載る').toBe(1);
    await openTree(page);
    expect(types(await dropRaw(page, raw, '#notesFileList', 0.98))).toEqual(['notesRegisterNodeAssets']);
    expect(types(await dropRaw(page, raw, '[data-item-id="o2"]', 0.5))).toEqual(['notesMoveOutNodeSubtreeIntoOut']);
    expect(types(await dropRaw(page, raw, '[data-item-id="m2"]', 0.5))).toEqual(['notesAttachOutNodeAssetsToMdItem']);
    expect(types(await dropRaw(page, raw, '[data-item-id="fl1"]', 0.5))).toEqual(['sendOutNodesToFolderLinkFromDrop']);

    // counterfactual: 選択集合が添付を 1 つも持たないなら添付 MIME 自体を積まない = 余白 drop は無反応
    const bare = await capturePayload(page, 'n1', TREE_NO_ASSETS);
    expect(Object.keys(bare)).not.toContain(AS);
    expect(Object.keys(bare)).toContain(SUB);
    await openTree(page);
    expect(types(await dropRaw(page, bare, '#notesFileList', 0.98))).toEqual([]);
    expect(types(await dropRaw(page, bare, '[data-item-id="m2"]', 0.1)), '偽の moveItem を送らない').toEqual([]);
    // subtree だけの drag でも .out item への move は従来どおり効く
    expect(types(await dropRaw(page, bare, '[data-item-id="o2"]', 0.5))).toEqual(['notesMoveOutNodeSubtreeIntoOut']);
});
