/**
 * 2026-09-04（rc.7 手動テスト）— note tree の **`.out` item / md item を drop 先**にする経路（受け手 = notes-file-panel.js）。
 *
 * TC-TGT-01 tree md → md item 中央 = subpage 登録（notesLinkMdIntoMd）/ 上下帯 = 従来の兄弟挿入
 * TC-TGT-02 outliner node（subtree+添付）→ .out item = その outliner へ move（添付の兄弟登録にならない）。自分の .out は no-op
 * TC-TGT-03 outliner node → md item 中央 = 添付を md へ（notesAttachOutNodeAssetsToMdItem）/ 上下帯 = 従来の兄弟登録
 * TC-TGT-04 page アイコン payload → .out = move / → md 中央 = 添付（page）を md へ
 * TC-TGT-05 md editor の subpage リンク → .out 中央 = page node（notesImportMdLinkIntoOutItem）/ 上下帯 = 従来の tree 登録 / → md 中央 = リンク移動
 * TC-TGT-06 md editor の 📎 リンク → .out 中央 / md 中央
 *
 * 🔴 counterfactual: 実装前は (02) が notesRegisterNodeAssets（兄弟登録）、(01)(03)(04 md)(05)(06) は兄弟挿入 / tree 登録に落ちて RED。
 */
import { test, expect, Page } from '@playwright/test';

const STRUCTURE = {
    version: 1,
    rootIds: ['o1', 'o2', 'm1', 'm2', 'f1'],
    items: {
        o1: { type: 'file', id: 'o1', title: 'out1', ext: 'out', filePath: '/n/o1.out' },
        o2: { type: 'file', id: 'o2', title: 'out2', ext: 'out', filePath: '/n/o2.out' },
        m1: { type: 'file', id: 'm1', title: 'md1', ext: 'md', filePath: '/n/m1.md' },
        m2: { type: 'file', id: 'm2', title: 'md2', ext: 'md', filePath: '/n/m2.md' },
        f1: { type: 'file', id: 'f1', title: 'file1', ext: 'file', filename: 'a.pdf' },
    },
};
const FILES = [
    { filePath: '/n/o1.out', title: 'out1', id: 'o1', kind: 'out' },
    { filePath: '/n/o2.out', title: 'out2', id: 'o2', kind: 'out' },
    { filePath: '/n/m1.md', title: 'md1', id: 'm1', kind: 'md' },
    { filePath: '/n/m2.md', title: 'md2', id: 'm2', kind: 'md' },
    { filePath: '', title: 'file1', id: 'f1', kind: 'file' },
];
const SUBTREE = 'application/x-fractal-out-node-subtree';
const ASSETS = 'application/x-fractal-out-node-assets';
const PAGE = 'application/x-fractal-out-node-page';
const NODEFILE = 'application/x-fractal-out-node-file';
const MDSUB = 'application/x-fractal-md-subpage';
const MDFILE = 'application/x-fractal-md-filelink';

async function setup(page: Page): Promise<void> {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate(({ files, structure }) => { (window as any).__testApi.initNotesPanel(files, '/n/o1.out', structure); }, { files: FILES, structure: STRUCTURE });
    await page.waitForSelector('.file-panel-item[data-item-id="f1"]', { timeout: 5000 });
}
function msgs(page: Page): Promise<any[]> { return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.notesMessages))); }
function types(list: any[]): string[] { return list.map((m) => m.type).filter((t) => t !== 'notifyError'); }

/** 外部 payload（MIME マップ）を tree item の指定 ratio に dragover → drop。 */
async function dropExternal(page: Page, data: Record<string, any>, targetId: string, ratio: number): Promise<any[]> {
    await page.evaluate(({ data, targetId, ratio }) => {
        (window as any).__testApi.notesMessages.length = 0;
        const dst = document.querySelector(`[data-item-id="${targetId}"]`) as HTMLElement;
        const dt = new DataTransfer();
        for (const k of Object.keys(data)) { dt.setData(k, JSON.stringify(data[k])); }
        const r = dst.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height * ratio;
        dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        (window as any).__lastZone = dst.classList.contains('file-panel-drag-over-md-into-out');
        dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    }, { data, targetId, ratio });
    await page.waitForTimeout(80);
    return msgs(page);
}
/** tree 内部 drag（dragItemId 状態）を作って target の ratio に drop。 */
async function dropInternal(page: Page, srcId: string, dstId: string, ratio: number): Promise<any[]> {
    await page.evaluate(({ srcId, dstId, ratio }) => {
        (window as any).__testApi.notesMessages.length = 0;
        const src = document.querySelector(`[data-item-id="${srcId}"]`) as HTMLElement;
        const dst = document.querySelector(`[data-item-id="${dstId}"]`) as HTMLElement;
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        const r = dst.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height * ratio;
        dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    }, { srcId, dstId, ratio });
    await page.waitForTimeout(80);
    return msgs(page);
}

const NODE_A = { outFileKey: '/n/o1.out', nodeId: 'na' };
const ASSETS_A = { v: 1, outFileKey: '/n/o1.out', nodeId: 'na', assets: [{ kind: 'file', filePath: 'files/a.pdf' }] };

test('TC-TGT-01 tree md → md item 中央 = notesLinkMdIntoMd / 上帯 = 従来の兄弟挿入', async ({ page }) => {
    await setup(page);
    let m = await dropInternal(page, 'm1', 'm2', 0.5);
    expect(types(m), `center: ${types(m).join(',')}`).toEqual(['notesLinkMdIntoMd']);
    expect(m[0]).toMatchObject({ dragItemId: 'm1', targetMdId: 'm2' });
    m = await dropInternal(page, 'm1', 'm2', 0.1);
    expect(types(m), 'edge は兄弟挿入のまま').toEqual(['moveItem']);
});

test('TC-TGT-02 outliner node（subtree + 添付）→ .out item = move（添付の兄弟登録にならない）。自分の .out は no-op', async ({ page }) => {
    await setup(page);
    for (const ratio of [0.5, 0.1]) {
        const m = await dropExternal(page, { [SUBTREE]: NODE_A, [ASSETS]: ASSETS_A }, 'o2', ratio);
        expect(types(m), `ratio=${ratio}: ${types(m).join(',')}`).toEqual(['notesMoveOutNodeSubtreeIntoOut']);
        expect(m[0].payload).toMatchObject({ outFileKey: '/n/o1.out', nodeId: 'na' });
        expect(m[0].targetOutFilePath).toBe('/n/o2.out');
    }
    expect(await page.evaluate(() => (window as any).__lastZone), '.out item に受け手ゾーンの highlight が出ない').toBe(true);
    // 複数選択（assets.items / subtree.nodeIds）→ nodeIds が渡る
    const multi = await dropExternal(page, {
        [SUBTREE]: { outFileKey: '/n/o1.out', nodeId: 'nb', nodeIds: ['na', 'nb'] },
        [ASSETS]: { ...ASSETS_A, nodeId: 'nb', items: [{ nodeId: 'na', assets: ASSETS_A.assets }, { nodeId: 'nb', assets: [{ kind: 'page', pageId: 'p' }] }] },
    }, 'o2', 0.5);
    expect(multi[0].payload.nodeIds).toEqual(['na', 'nb']);
    // 自分自身の .out → 何も呼ばない
    const self = await dropExternal(page, { [SUBTREE]: NODE_A, [ASSETS]: ASSETS_A }, 'o1', 0.5);
    expect(types(self)).toEqual([]);
});

test('TC-TGT-03 outliner node → md item 中央 = notesAttachOutNodeAssetsToMdItem / 上帯 = 従来の添付兄弟登録', async ({ page }) => {
    await setup(page);
    let m = await dropExternal(page, { [SUBTREE]: NODE_A, [ASSETS]: ASSETS_A }, 'm2', 0.5);
    expect(types(m), `center: ${types(m).join(',')}`).toEqual(['notesAttachOutNodeAssetsToMdItem']);
    expect(m[0].payload).toMatchObject({ nodeId: 'na' });
    expect(m[0].targetMdId).toBe('m2');
    expect(await page.evaluate(() => (window as any).__lastZone)).toBe(true);
    m = await dropExternal(page, { [SUBTREE]: NODE_A, [ASSETS]: ASSETS_A }, 'm2', 0.1);
    expect(types(m), 'edge は従来の添付 → 兄弟 item 登録').toEqual(['notesRegisterNodeAssets']);
});

test('TC-TGT-04 page アイコン payload → .out = move / → md 中央 = page を md へ', async ({ page }) => {
    await setup(page);
    const pagePayload = { outFileKey: '/n/o1.out', nodeId: 'na', pageId: 'pg', title: 'T' };
    let m = await dropExternal(page, { [PAGE]: pagePayload }, 'o2', 0.5);
    expect(types(m)).toEqual(['notesMoveOutNodeSubtreeIntoOut']);
    m = await dropExternal(page, { [PAGE]: pagePayload }, 'm2', 0.5);
    expect(types(m)).toEqual(['notesAttachOutNodeAssetsToMdItem']);
    expect(m[0].payload.assets).toEqual([{ kind: 'page', pageId: 'pg' }]);
    m = await dropExternal(page, { [PAGE]: pagePayload }, 'm2', 0.1);
    expect(types(m), 'edge は従来の Feature B（md item 化）').toEqual(['notesImportOutPageNodeAsMd']);
    // file アイコン payload → md 中央 = host が添付を .out から集める（assets 空）
    m = await dropExternal(page, { [NODEFILE]: NODE_A }, 'm2', 0.5);
    expect(types(m)).toEqual(['notesAttachOutNodeAssetsToMdItem']);
    expect(m[0].payload.assets).toEqual([]);
});

test('TC-TGT-05 md editor の subpage リンク → .out 中央 = page node / 上帯 = 従来の tree 登録 / → md 中央 = リンク移動', async ({ page }) => {
    await setup(page);
    const sp = { href: 'sub.md', sourceMdPath: '/n/src.md', title: 'Sub' };
    let m = await dropExternal(page, { [MDSUB]: sp }, 'o2', 0.5);
    expect(types(m), `center: ${types(m).join(',')}`).toEqual(['notesImportMdLinkIntoOutItem']);
    expect(m[0]).toMatchObject({ kind: 'subpage', targetOutId: 'o2' });
    expect(m[0].payload.href).toBe('sub.md');
    m = await dropExternal(page, { [MDSUB]: sp }, 'o2', 0.1);
    expect(types(m), 'edge は従来どおり tree item 登録').toEqual(['notesRegisterSubpageFromMd']);
    m = await dropExternal(page, { [MDSUB]: sp }, 'm2', 0.5);
    expect(types(m)).toEqual(['notesLinkMdLinkIntoMdItem']);
    expect(m[0]).toMatchObject({ kind: 'subpage', targetMdId: 'm2' });
});

test('TC-TGT-06 md editor の 📎 リンク → .out 中央 / md 中央', async ({ page }) => {
    await setup(page);
    const fl = { href: 'files/doc.pdf', sourceMdPath: '/n/src.md' };
    let m = await dropExternal(page, { [MDFILE]: fl }, 'o2', 0.5);
    expect(types(m)).toEqual(['notesImportMdLinkIntoOutItem']);
    expect(m[0].kind).toBe('file');
    m = await dropExternal(page, { [MDFILE]: fl }, 'm2', 0.5);
    expect(types(m)).toEqual(['notesLinkMdLinkIntoMdItem']);
    expect(m[0].kind).toBe('file');
    m = await dropExternal(page, { [MDFILE]: fl }, 'm2', 0.1);
    expect(types(m), 'edge は従来の tree 登録').toEqual(['notesRegisterFileFromMdLink']);
});
