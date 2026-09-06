/**
 * TASK-87 — note tree **内**の複数選択移動（送り手 = webview / notes-file-panel.js）
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-TMV-01 / 裁定 R38）
 *
 * TC-TMV-05 複数選択 → folder ヘッダ中央 = `moveItems` 1 回（folder の中へ全件）
 * TC-TMV-06 複数選択 → item の上/下帯 = `moveItems` 1 回（挿入位置は調整前 index）。`.out` も運ぶ = 除外通知が出ない
 * TC-TMV-07 単一 drag は従来どおり `moveItem`（回帰）
 * TC-TMV-08 谷間（listEl）drop も `moveItems` 1 回（線どおりの位置）
 *
 * 🔴 counterfactual（pre-fix 実測 = rc.19）: いずれの経路も `moveItem` **1 件だけ**が飛び、
 * 選択した残りは動かなかった（ユーザー報告「複数選択して場所移動したり、folder にいれたり、などできない」）。
 */
import { test, expect, Page } from '@playwright/test';

const STRUCTURE = {
    version: 1,
    rootIds: ['o1', 'm1', 'm2', 'd1', 'm3'],
    items: {
        o1: { type: 'file', id: 'o1', title: 'out1', ext: 'out', filePath: '/n/o1.out' },
        m1: { type: 'file', id: 'm1', title: 'md1', ext: 'md', filePath: '/n/m1.md' },
        m2: { type: 'file', id: 'm2', title: 'md2', ext: 'md', filePath: '/n/m2.md' },
        m3: { type: 'file', id: 'm3', title: 'md3', ext: 'md', filePath: '/n/m3.md' },
        // 折りたたんでおく: drop の ratio は **folder wrapper の rect** で計算されるため（既存実装）、
        // 展開して children を抱えた wrapper ではヘッダ上の座標が上帯（before）に落ちる。
        d1: { type: 'folder', id: 'd1', title: 'folder1', childIds: ['m4'], collapsed: true },
        m4: { type: 'file', id: 'm4', title: 'md4', ext: 'md', filePath: '/n/m4.md' },
    },
};
const FILES = [
    { filePath: '/n/o1.out', title: 'out1', id: 'o1', kind: 'out' },
    { filePath: '/n/m1.md', title: 'md1', id: 'm1', kind: 'md' },
    { filePath: '/n/m2.md', title: 'md2', id: 'm2', kind: 'md' },
    { filePath: '/n/m3.md', title: 'md3', id: 'm3', kind: 'md' },
    { filePath: '/n/m4.md', title: 'md4', id: 'm4', kind: 'md' },
];

async function setup(page: Page): Promise<void> {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate(({ files, structure }) => {
        (window as any).__testApi.initNotesPanel(files, '/n/o1.out', structure);
    }, { files: FILES, structure: STRUCTURE });
    await page.waitForSelector('.file-panel-item[data-item-id="m3"]', { timeout: 5000 });
}

function msgs(page: Page): Promise<any[]> {
    return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.notesMessages)));
}

/** cmd+click で単品トグル選択（FR-MSEL-03 rev2。開かない）。 */
async function toggleSelect(page: Page, ids: string[]): Promise<void> {
    for (const id of ids) {
        await page.evaluate((i) => {
            const el = document.querySelector(`.file-panel-item[data-file-id="${i}"]`) as HTMLElement;
            if (!el) { throw new Error('item が無い: ' + i); }
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true, ctrlKey: true }));
        }, id);
    }
    const sel = await page.evaluate(() => Array.from(document.querySelectorAll('.file-panel-item.file-panel-selected'))
        .map((el) => (el as HTMLElement).dataset.fileId));
    expect(sel, '前提: 選択集合が作られている').toEqual(ids);
}

/**
 * tree 内部 drag。`dstSel` は CSS セレクタ（folder はヘッダが drop target）。
 * `gap=true` なら dstSel で dragover（線を出す）→ listEl へ drop（谷間経路）。
 */
async function dragInternal(
    page: Page, srcId: string, dstSel: string, ratio: number, opts?: { gap?: boolean }
): Promise<any[]> {
    await page.evaluate(({ srcId, dstSel, ratio, gap }) => {
        (window as any).__testApi.notesMessages.length = 0;
        const srcRow = document.querySelector(`.file-panel-item[data-item-id="${srcId}"]`) as HTMLElement;
        const dst = document.querySelector(dstSel) as HTMLElement;
        if (!srcRow || !dst) { throw new Error('src/dst が無い: ' + srcId + ' / ' + dstSel); }
        const dt = new DataTransfer();
        srcRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        const r = dst.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height * ratio;
        dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        const dropTarget = gap ? (document.getElementById('notesFileList') as HTMLElement) : dst;
        const dr = dropTarget.getBoundingClientRect();
        dropTarget.dispatchEvent(new DragEvent('drop', {
            bubbles: true, cancelable: true, dataTransfer: dt,
            clientX: gap ? dr.left + dr.width / 2 : x,
            clientY: gap ? dr.bottom - 1 : y,
        }));
        // dropEffect は合成イベントでは 'none' 固定 = 除外通知の発火条件を満たさないため、
        // 「通知が出ない」の検証は drop 時点（dispatchTreeMove の clear）で行う。
        srcRow.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    }, { srcId, dstSel, ratio, gap: !!opts?.gap });
    await page.waitForTimeout(80);
    return msgs(page);
}

test.describe('note tree 内の複数選択移動（FR-TMV-01 / TASK-87）', () => {

    test('TC-TMV-05 複数選択 → folder ヘッダ中央 = moveItems 1 回で全件がフォルダへ', async ({ page }) => {
        await setup(page);
        await toggleSelect(page, ['m1', 'm3']);
        const m = await dragInternal(page, 'm1', '.file-panel-folder[data-item-id="d1"] > .file-panel-folder-header', 0.4);
        const moves = m.filter((x) => x.type === 'moveItems' || x.type === 'moveItem');
        expect(moves.map((x) => x.type), `bridge 呼び出し: ${JSON.stringify(m)}`).toEqual(['moveItems']);
        expect(moves[0]).toMatchObject({ itemIds: ['m1', 'm3'], targetParentId: 'd1', index: 0 });
    });

    test('TC-TMV-06 複数選択 → item の上帯 / 下帯 = moveItems 1 回（.out も運ぶ = 除外通知なし）', async ({ page }) => {
        await setup(page);
        // o1（.out）を含む選択 — ツリー内移動では `.out` も動く（FR-MSEL-04 R3 の除外は外部面向けのみ）
        await toggleSelect(page, ['o1', 'm1']);
        // m3（rootIds index 4）の上帯 → 抜く前の index 4 に入る
        let m = await dragInternal(page, 'm1', '.file-panel-item[data-item-id="m3"]', 0.1);
        let moves = m.filter((x) => x.type === 'moveItems' || x.type === 'moveItem');
        expect(moves.map((x) => x.type), `上帯: ${JSON.stringify(m)}`).toEqual(['moveItems']);
        expect(moves[0]).toMatchObject({ itemIds: ['o1', 'm1'], targetParentId: null, index: 4 });
        expect(m.filter((x) => x.type === 'notifyError'), '.out の除外通知は出さない').toEqual([]);

        // 下帯 → index 5（末尾）
        m = await dragInternal(page, 'm1', '.file-panel-item[data-item-id="m3"]', 0.9);
        moves = m.filter((x) => x.type === 'moveItems' || x.type === 'moveItem');
        expect(moves.map((x) => x.type), `下帯: ${JSON.stringify(m)}`).toEqual(['moveItems']);
        expect(moves[0]).toMatchObject({ itemIds: ['o1', 'm1'], targetParentId: null, index: 5 });
    });

    test('TC-TMV-07 単一 drag は従来どおり moveItem（回帰）', async ({ page }) => {
        await setup(page);
        // 選択 1 件（cmd+click 1 回）でも単一経路
        await toggleSelect(page, ['m1']);
        let m = await dragInternal(page, 'm1', '.file-panel-folder[data-item-id="d1"] > .file-panel-folder-header', 0.4);
        expect(m.filter((x) => x.type === 'moveItems' || x.type === 'moveItem').map((x) => x.type)).toEqual(['moveItem']);
        expect(m.find((x) => x.type === 'moveItem')).toMatchObject({ itemId: 'm1', targetParentId: 'd1', index: 0 });

        // 選択集合の外の行を掴んだ場合も単一（選択は m1 のまま = drag では変わらない / 掴むのは m2）
        expect(await page.evaluate(() => Array.from(document.querySelectorAll('.file-panel-item.file-panel-selected'))
            .map((el) => (el as HTMLElement).dataset.fileId)), '選択は m1 のまま').toEqual(['m1']);
        m = await dragInternal(page, 'm2', '.file-panel-item[data-item-id="m3"]', 0.9);
        expect(m.filter((x) => x.type === 'moveItems' || x.type === 'moveItem').map((x) => x.type)).toEqual(['moveItem']);
        expect(m.find((x) => x.type === 'moveItem')).toMatchObject({ itemId: 'm2', targetParentId: null });
    });

    test('TC-TMV-08 谷間（listEl）drop も moveItems 1 回（線どおりの位置）', async ({ page }) => {
        await setup(page);
        await toggleSelect(page, ['m1', 'm2']);
        const m = await dragInternal(page, 'm1', '.file-panel-item[data-item-id="m3"]', 0.9, { gap: true });
        const moves = m.filter((x) => x.type === 'moveItems' || x.type === 'moveItem');
        expect(moves.map((x) => x.type), `谷間: ${JSON.stringify(m)}`).toEqual(['moveItems']);
        expect(moves[0]).toMatchObject({ itemIds: ['m1', 'm2'], targetParentId: null, index: 5 });
    });
});
