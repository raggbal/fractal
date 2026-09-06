/**
 * 2026-09-04 手動テスト (1) の直接修正 — note ツリーの **cmd/ctrl+click 単品トグル選択** と
 * **ツリー内 item（`.out` / md / linkedfd）への複数選択 D&D**
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-MSEL-03 rev2 / FR-MSEL-04 rev3）
 *
 * TC-MSEL-33（トグル）/ TC-MSEL-34（→ .out item）/ TC-MSEL-35（→ md item）/ TC-MSEL-36（→ linkedfd item）/
 * TC-MSEL-37（選択集合の上・帯外は no-op / 従来の兄弟挿入）。
 *
 * 裁定（ユーザー 2026-09-04）: ツリーで複数選択するとメインペインの内容が選択に追従するため
 * 「コンテンツ領域の 3 面へ複数 D&D」は成立しない → **ツリー内の受け手 item** へ落とす。
 * 旧 FR-CT-01（cmd+click = webview 内タブ）は右クリック「Open in new tab」に一本化（ADRL-0108 supersede）。
 *
 * 🔴 counterfactual: 実装前は cmd+click が openFileInTab を飛ばし選択は不変（TC-MSEL-33 RED）、
 * 複数選択で .out item に落とすと drag した 1 件だけ notesImportMdIntoOut（TC-MSEL-34 RED）。
 */
import { test, expect, Page } from '@playwright/test';

const STRUCTURE = {
    version: 1,
    rootIds: ['o1', 'm1', 'f1', 'm2', 'o2', 'm3', 'fl1'],
    items: {
        o1: { type: 'file', id: 'o1', title: 'out1', ext: 'out' },
        m1: { type: 'file', id: 'm1', title: 'md1', ext: 'md' },
        f1: { type: 'file', id: 'f1', title: 'file1', ext: 'file', filename: 'a.pdf' },
        m2: { type: 'file', id: 'm2', title: 'md2', ext: 'md' },
        o2: { type: 'file', id: 'o2', title: 'out2', ext: 'out' },
        m3: { type: 'file', id: 'm3', title: 'md3', ext: 'md' },
        fl1: { type: 'file', id: 'fl1', title: 'Docs', ext: 'folder' },
    },
};
const FILES = [
    { filePath: '/n/o1.out', title: 'out1', id: 'o1', kind: 'out' },
    { filePath: '/n/m1.md', title: 'md1', id: 'm1', kind: 'md' },
    { filePath: '', title: 'file1', id: 'f1', kind: 'file' },
    { filePath: '/n/m2.md', title: 'md2', id: 'm2', kind: 'md' },
    { filePath: '/n/o2.out', title: 'out2', id: 'o2', kind: 'out' },
    { filePath: '/n/m3.md', title: 'md3', id: 'm3', kind: 'md' },
    { filePath: '', title: 'Docs', id: 'fl1', kind: 'folder', broken: false },
];

async function setup(page: Page): Promise<void> {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate(({ files, structure }) => {
        (window as any).__testApi.initNotesPanel(files, '/n/o1.out', structure);
    }, { files: FILES, structure: STRUCTURE });
    await page.waitForSelector('.file-panel-item[data-file-id="fl1"]', { timeout: 5000 });
    await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
}

function selectedIds(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('.file-panel-item.file-panel-selected'))
            .map((el) => (el as HTMLElement).dataset.fileId || ''));
}
function messages(page: Page): Promise<any[]> {
    return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.notesMessages)));
}
async function clickItem(page: Page, id: string, mods?: { shift?: boolean; meta?: boolean; ctrl?: boolean }): Promise<void> {
    await page.evaluate(({ i, m }) => {
        const el = document.querySelector(`.file-panel-item[data-file-id="${i}"]`) as HTMLElement;
        el.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true, shiftKey: !!m?.shift, metaKey: !!m?.meta, ctrlKey: !!m?.ctrl,
        }));
    }, { i: id, m: mods || {} });
    await page.waitForTimeout(30);
}

/** 選択内の行 srcId を drag 起点にして dstId の指定 ratio に dragover → drop → dragend（本番と同じ HTML5 経路）。 */
async function dragTo(page: Page, srcId: string, dstId: string, ratio: number): Promise<any[]> {
    await page.evaluate(({ srcId, dstId, ratio }) => {
        const src = document.querySelector(`[data-item-id="${srcId}"]`) as HTMLElement;
        const dst = document.querySelector(`[data-item-id="${dstId}"]`) as HTMLElement;
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        const r = dst.getBoundingClientRect();
        const y = r.top + r.height * ratio;
        const x = r.left + r.width / 2;
        dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        (window as any).__lastOverHasZone = dst.classList.contains('file-panel-drag-over-md-into-out');
        dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    }, { srcId, dstId, ratio });
    await page.waitForTimeout(100);
    return messages(page);
}

test.describe('TC-MSEL-33 cmd/ctrl+click = 単品トグル選択（開かない）', () => {
    test('cmd+click で加算・再 cmd+click で除外。openFile / openFileInTab は飛ばない', async ({ page }) => {
        await setup(page);
        await clickItem(page, 'm1');
        await clickItem(page, 'm3', { meta: true });
        expect(await selectedIds(page), 'cmd+click で不連続選択にならない').toEqual(['m1', 'm3']);
        await clickItem(page, 'f1', { ctrl: true });   // win/linux
        expect(await selectedIds(page), '描画順に正規化されている').toEqual(['m1', 'f1', 'm3']);
        await clickItem(page, 'm1', { meta: true });   // 除外
        expect(await selectedIds(page)).toEqual(['f1', 'm3']);
        const msgs = await messages(page);
        // 修飾なし click の openFile 1 件だけ。cmd+click は**開かない**（旧 FR-CT-01 の openFileInTab も飛ばない）
        expect(msgs.filter((m) => m.type === 'openFileInTab').length, 'cmd+click が webview 内タブを開いた（旧挙動）').toBe(0);
        expect(msgs.filter((m) => m.type === 'openFile').length).toBe(1);
    });

    test('cmd+click 後の shift+click は直近のトグル行を anchor に範囲を取る', async ({ page }) => {
        await setup(page);
        await clickItem(page, 'm1');
        await clickItem(page, 'm2', { meta: true });   // anchor = m2
        await clickItem(page, 'm3', { shift: true });  // m2..m3 = m2, o2, m3
        expect(await selectedIds(page)).toEqual(['m2', 'o2', 'm3']);
    });

    test('folder link / .out の cmd+click もトグル（フォルダビューは開かない・タブも開かない）', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => {
            const w = window as any;
            w.__dispCalls = [];
            const d = w.__folderViewDispatcher;
            if (d) { const orig = d.showFolderView; d.showFolderView = (...a: any[]) => { w.__dispCalls.push(a); return orig?.apply(d, a); }; }
        });
        await clickItem(page, 'fl1', { meta: true });
        await clickItem(page, 'o2', { meta: true });
        expect(await selectedIds(page)).toEqual(['o2', 'fl1']);
        expect(await page.evaluate(() => (window as any).__dispCalls.length), 'cmd+click でフォルダビューが開いた').toBe(0);
        expect((await messages(page)).filter((m) => m.type === 'openFileInTab').length).toBe(0);
    });
});

test.describe('TC-MSEL-34 複数選択 → ツリー内 .out item（中央帯）= 結合 batch 1 回', () => {
    test('md + file を選んで o2 の中央へ → notesImportTreeItemsIntoOutItemBatch(items 選択順, o2)', async ({ page }) => {
        await setup(page);
        await clickItem(page, 'm1');
        await clickItem(page, 'f1', { meta: true });
        await clickItem(page, 'm2', { meta: true });
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
        const msgs = await dragTo(page, 'f1', 'o2', 0.5);
        expect(await page.evaluate(() => (window as any).__lastOverHasZone), 'dragover で受け手ゾーンの highlight が出ない').toBe(true);
        const batch = msgs.filter((m) => m.type === 'notesImportTreeItemsIntoOutItemBatch');
        expect(batch.length, `結合 batch が 1 回でない: ${msgs.map((m) => m.type).join(',')}`).toBe(1);
        expect(batch[0].targetOutId).toBe('o2');
        expect(batch[0].items.map((it: any) => [it.kind, it.id]), '選択順（描画順）で結合されていない')
            .toEqual([['md', 'm1'], ['file', 'f1'], ['md', 'm2']]);
        // 旧挙動（drag した 1 件だけ単一 bridge）が残っていない
        expect(msgs.filter((m) => m.type === 'notesImportMdIntoOut' || m.type === 'notesImportFileIntoOut').length).toBe(0);
        expect(msgs.filter((m) => m.type === 'moveItem').length, '兄弟挿入に落ちた').toBe(0);
    });

    test('単一 md → .out 中央は従来の単一 bridge（既存 TC-DD 系の契約を壊さない）', async ({ page }) => {
        await setup(page);
        const msgs = await dragTo(page, 'm1', 'o2', 0.5);
        expect(msgs.filter((m) => m.type === 'notesImportMdIntoOut').length).toBe(1);
        expect(msgs.filter((m) => m.type === 'notesImportTreeItemsIntoOutItemBatch').length).toBe(0);
    });
});

test.describe('TC-MSEL-35 複数選択 → ツリー内 md item（中央帯）= attachTreeItemsIntoMdItemBatch 1 回', () => {
    test('md + file を m3 の中央へ', async ({ page }) => {
        await setup(page);
        await clickItem(page, 'm1');
        await clickItem(page, 'f1', { meta: true });
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
        const msgs = await dragTo(page, 'm1', 'm3', 0.5);
        const batch = msgs.filter((m) => m.type === 'attachTreeItemsIntoMdItemBatch');
        expect(batch.length, `batch が 1 回でない: ${msgs.map((m) => m.type).join(',')}`).toBe(1);
        expect(batch[0].targetMdId).toBe('m3');
        expect(batch[0].items.map((it: any) => [it.kind, it.id])).toEqual([['md', 'm1'], ['file', 'f1']]);
        expect(msgs.filter((m) => m.type === 'moveItem').length).toBe(0);
    });
});

test.describe('TC-MSEL-36 → ツリー内 linkedfd item（中央帯）= root へ複製（folderViewMoveIn 経路）', () => {
    test('複数 → folderViewMoveInBatch(fl1, "", [{srcKind, srcItemId}…]) 1 回', async ({ page }) => {
        await setup(page);
        await clickItem(page, 'm2');
        await clickItem(page, 'f1', { meta: true });
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
        const msgs = await dragTo(page, 'm2', 'fl1', 0.5);
        const batch = msgs.filter((m) => m.type === 'folderViewMoveInBatch');
        expect(batch.length, `batch が 1 回でない: ${msgs.map((m) => m.type).join(',')}`).toBe(1);
        expect(batch[0].id).toBe('fl1');
        expect(batch[0].dstDirRelPath, 'root 直下（dst=""）でない').toBe('');
        expect(batch[0].items).toEqual([{ srcKind: 'file', srcItemId: 'f1' }, { srcKind: 'md', srcItemId: 'm2' }]);
        expect(msgs.filter((m) => m.type === 'moveItem').length).toBe(0);
    });

    test('単一 md → linkedfd 中央 = folderViewMoveIn(fl1, "", "md", id)（従来は兄弟挿入で複製できなかった）', async ({ page }) => {
        await setup(page);
        const msgs = await dragTo(page, 'm3', 'fl1', 0.5);
        const one = msgs.filter((m) => m.type === 'folderViewMoveIn');
        expect(one.length, `folderViewMoveIn が 1 回でない: ${msgs.map((m) => m.type).join(',')}`).toBe(1);
        expect(one[0]).toMatchObject({ folderLinkId: 'fl1', dstDirRelPath: '', srcKind: 'md', srcItemId: 'm3' });
        expect(msgs.filter((m) => m.type === 'moveItem').length).toBe(0);
    });

    test('.out だけの選択は payload に載らないので linkedfd に落としても bridge を呼ばない', async ({ page }) => {
        await setup(page);
        await clickItem(page, 'o1');
        await clickItem(page, 'o2', { meta: true });
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
        const msgs = await dragTo(page, 'o1', 'fl1', 0.5);
        expect(msgs.filter((m) => /folderViewMoveIn/.test(m.type)).length).toBe(0);
    });
});

test.describe('TC-MSEL-37 no-op と帯外', () => {
    test('選択集合の中の item の上には落とせない（bridge も moveItem も飛ばない）', async ({ page }) => {
        await setup(page);
        await clickItem(page, 'm1');
        await clickItem(page, 'o2', { meta: true });
        await clickItem(page, 'm3', { meta: true });
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
        const msgs = await dragTo(page, 'm1', 'o2', 0.5);
        expect(msgs.map((m) => m.type).filter((t) => t !== 'notifyError'), '空振り（何も呼ばない）になっていない').toEqual([]);
    });

    test('複数選択でも上端 10% は従来の兄弟挿入（drag した 1 件の moveItem）', async ({ page }) => {
        await setup(page);
        await clickItem(page, 'm1');
        await clickItem(page, 'f1', { meta: true });
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
        const msgs = await dragTo(page, 'm1', 'o2', 0.1);
        expect(msgs.filter((m) => m.type === 'notesImportTreeItemsIntoOutItemBatch').length).toBe(0);
        expect(msgs.filter((m) => m.type === 'moveItem').length).toBe(1);
    });
});
