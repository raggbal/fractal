/**
 * folder-view-dnd.spec.ts — WV-DND（TASK-09 / real mouse）
 *
 * sprint 20260817-053313-notetree-local-folder-view
 * TC-FLV-39(W1) / 40(W2 送信端 payload) / 41(W2 受信端) / 42(W3) / 43(W4) / 46(W5) / 48(W6)
 *
 * ハーネス: standalone-notes.html（folder view + file panel + md pane が同一 document —
 * 本番 notes webview と同じ MIME 直達構造）。drag 可否は real mouse（page.mouse down→move→up —
 * 合成 DragEvent は drag 開始可否を検証できない: generator_failures 2026-08-10/12）。
 * payload **契約**（TC-FLV-40/46②）のみ合成 dragstart で DataTransfer を読む（開始可否は W1 で実証済み）。
 * cross 面ソース（md アンカー / tree item）の dragstart 実発火は既存 sprint の real mouse TC が番人
 * （TC-MX 系）— 本 spec の W6/W4 は受信端配線を synthetic source div + real mouse drop で検証する。
 */
import { test, expect, Page } from '@playwright/test';

const FV_MIME = 'application/x-fractal-folderview-entry';

const fileList = [
    { filePath: '/note/doc.md', title: 'Doc', id: 'mdDoc', kind: 'md' },
    { filePath: '', title: 'Att', id: 'fileF', kind: 'file' },
    { filePath: '/note/plan.out', title: 'Plan', id: 'outPlan', kind: 'out' },
    { filePath: '', title: 'Docs Link', id: 'flTree', kind: 'folder', broken: false },
];
const structure = {
    version: 1,
    rootIds: ['mdDoc', 'fileF', 'outPlan', 'flTree', 'grp'],
    items: {
        mdDoc: { type: 'file', id: 'mdDoc', title: 'Doc', ext: 'md', filePath: '/note/doc.md' },
        fileF: { type: 'file', id: 'fileF', title: 'Att', ext: 'file' },
        outPlan: { type: 'file', id: 'outPlan', title: 'Plan', ext: 'out', filePath: '/note/plan.out' },
        flTree: { type: 'file', id: 'flTree', title: 'Docs Link', ext: 'folder' },
        grp: { type: 'folder', id: 'grp', title: 'Grp', childIds: [], collapsed: false },
    },
};

const FV_ENTRIES = [
    { name: 'dirA', relPath: 'dirA', isDir: true },
    { name: 'a.txt', relPath: 'a.txt', isDir: false },
    { name: 'b.md', relPath: 'b.md', isDir: false },
];

async function setup(page: Page, opts?: { showFolderView?: boolean }): Promise<void> {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready && (window as any).__folderViewDispatcher);
    await page.evaluate(({ fileList, structure }) => {
        const w = window as any;
        w.__testApi.initNotesPanel(fileList, null, structure);
        // 台帳 #6-18 の明示 recorder を実 bridge（panel init に渡った同一参照）へ差し込む
        //（Proxy 禁止 — 実在しないメソッド呼び出しを TypeError で顕在化: generator_failures 2026-08-09）
        w.__dndCalls = [];
        ['folderViewList', 'folderViewSearch', 'folderViewOpen', 'folderViewMove',
         'folderViewMoveIn', 'folderViewMoveToTree', 'folderViewMoveIntoMd', 'folderViewMoveFromMd',
         'notifyError'].forEach((k) => {
            w.notesHostBridge[k] = (...args: any[]) => { w.__dndCalls.push({ type: k, args }); };
        });
    }, { fileList, structure });
    await page.waitForTimeout(150);
    if (opts?.showFolderView !== false) {
        await page.evaluate((entries) => {
            (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs');
            window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries }, '*');
        }, FV_ENTRIES);
        await page.waitForSelector('.fv-row[data-rel="a.txt"]', { timeout: 5000 });
    }
}

function calls(page: Page, type?: string) {
    return page.evaluate((t) => {
        const c = (window as any).__dndCalls;
        return t ? c.filter((x: any) => x.type === t) : c;
    }, type);
}

async function resetCalls(page: Page): Promise<void> {
    await page.evaluate(() => { (window as any).__dndCalls.length = 0; });
}

/** real mouse drag: src セレクタ中心 → dst セレクタ（ratio = 縦位置）→ up */
async function realDrag(page: Page, srcSel: string, dstSel: string, ratio = 0.5, assertMidDrag?: (page: Page) => Promise<void>): Promise<void> {
    const src = await page.locator(srcSel).boundingBox();
    const dst = await page.locator(dstSel).boundingBox();
    if (!src || !dst) { throw new Error(`boundingBox 不可: ${srcSel} → ${dstSel}`); }
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    await page.mouse.move(src.x + src.width / 2 + 12, src.y + src.height / 2 + 4, { steps: 4 });
    await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height * ratio, { steps: 10 });
    await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height * ratio);
    if (assertMidDrag) { await assertMidDrag(page); }
    await page.mouse.up();
    await page.waitForTimeout(120);
}

/** フォルダビュー内に視覚残留（highlight・root 強調の 2 系統）が無いこと */
async function expectNoFvVisualResidue(page: Page): Promise<void> {
    expect(await page.locator('.fv-drop-into').count(), 'フォルダ highlight 残留なし').toBe(0);
    expect(await page.locator('.fv-tree.fv-drop-root').count(), 'root 強調残留なし').toBe(0);
}

test.describe('TC-FLV-39 — W1: ビュー内移動（real mouse・one-shot・視覚残留なし）', () => {

    test('a.txt → dirA 行: dragstart 実発火（mid-drag highlight）→ folderViewMove 送出 → 残留なし', async ({ page }) => {
        await setup(page);
        await resetCalls(page);
        await realDrag(page, '.fv-row[data-rel="a.txt"]', '.fv-row[data-rel="dirA"]', 0.5, async (p) => {
            // mid-drag: dragstart→dragover が実際に発火している（合成でない）ことの実証
            expect(await p.locator('.fv-row[data-rel="dirA"].fv-drop-into').count(), 'drag 中の dir highlight').toBe(1);
        });
        const mv = await calls(page, 'folderViewMove');
        expect(mv.length).toBe(1);
        expect(mv[0].args).toEqual(['fl1', 'a.txt', 'dirA']);
        await expectNoFvVisualResidue(page);
    });

    test('2 連続 drag: 2 回目が 1 回目の解決を引き継がない（one-shot clear）', async ({ page }) => {
        await setup(page);
        await resetCalls(page);
        await realDrag(page, '.fv-row[data-rel="a.txt"]', '.fv-row[data-rel="dirA"]');
        await realDrag(page, '.fv-row[data-rel="b.md"]', '.fv-row[data-rel="dirA"]');
        const mv = await calls(page, 'folderViewMove');
        expect(mv.length).toBe(2);
        expect(mv[1].args, '2 回目は b.md（stale a.txt を引き継がない）').toEqual(['fl1', 'b.md', 'dirA']);
        await expectNoFvVisualResidue(page);
    });

    test('外れ drop（ビュー外の header）: bridge 不発 + 視覚残留なし', async ({ page }) => {
        await setup(page);
        await resetCalls(page);
        // 一度 dirA 上を通過して highlight を作ってから、外（fv-header）で drop
        const src = await page.locator('.fv-row[data-rel="a.txt"]').boundingBox();
        const mid = await page.locator('.fv-row[data-rel="dirA"]').boundingBox();
        const out = await page.locator('.fv-header').boundingBox();
        await page.mouse.move(src!.x + 20, src!.y + src!.height / 2);
        await page.mouse.down();
        await page.mouse.move(mid!.x + mid!.width / 2, mid!.y + mid!.height / 2, { steps: 6 });
        await page.mouse.move(out!.x + out!.width / 2, out!.y + out!.height / 2, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(120);
        expect((await calls(page, 'folderViewMove')).length, '外れ drop で move 不発').toBe(0);
        await expectNoFvVisualResidue(page);
    });

    test('同一親への drop / 自己子孫への dir drop は no-op（bridge 不発）', async ({ page }) => {
        await setup(page);
        await resetCalls(page);
        // a.txt をルート余白（同一親 = root）へ
        const tree = await page.locator('.fv-tree').boundingBox();
        const src = await page.locator('.fv-row[data-rel="a.txt"]').boundingBox();
        await page.mouse.move(src!.x + 20, src!.y + src!.height / 2);
        await page.mouse.down();
        await page.mouse.move(tree!.x + tree!.width / 2, tree!.y + tree!.height - 10, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(120);
        expect((await calls(page, 'folderViewMove')).length, '同一親 = no-op').toBe(0);
        // dirA を dirA 自身へ
        await realDrag(page, '.fv-row[data-rel="dirA"]', '.fv-row[data-rel="dirA"]');
        expect((await calls(page, 'folderViewMove')).length, '自己 drop = no-op').toBe(0);
        await expectNoFvVisualResidue(page);
    });
});

test.describe('TC-FLV-40 — W2 送信端: payload 契約（合成 dragstart で DataTransfer を読む）', () => {

    test('FV MIME payload = {folderLinkId, relPath, isDir} のみ・絶対パス不含', async ({ page }) => {
        await setup(page);
        const read = async (rel: string) => page.evaluate((r) => {
            const row = document.querySelector(`.fv-row[data-rel="${r}"]`) as HTMLElement;
            const dt = new DataTransfer();
            row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const raw = dt.getData('application/x-fractal-folderview-entry');
            row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return { raw, types: Array.from(dt.types || []) };
        }, rel);
        const file = await read('a.txt');
        const p1 = JSON.parse(file.raw);
        expect(Object.keys(p1).sort()).toEqual(['folderLinkId', 'isDir', 'relPath']);
        expect(p1).toEqual({ folderLinkId: 'fl1', relPath: 'a.txt', isDir: false });
        expect(file.raw.includes('/home/'), '絶対パス不含（INV-4）').toBe(false);
        const dir = await read('dirA');
        expect(JSON.parse(dir.raw)).toEqual({ folderLinkId: 'fl1', relPath: 'dirA', isDir: true });
    });
});

test.describe('TC-FLV-41 — W2 受信端: フォルダビュー → Note ツリー（real mouse）', () => {

    test('tree item 上（前半）→ folderViewMoveToTree(前挿入)', async ({ page }) => {
        await setup(page);
        await resetCalls(page);
        await realDrag(page, '.fv-row[data-rel="a.txt"]', '[data-item-id="mdDoc"]', 0.25);
        const mt = await calls(page, 'folderViewMoveToTree');
        expect(mt.length).toBe(1);
        expect(mt[0].args).toEqual(['fl1', 'a.txt', null, 0]);
    });

    test('フォルダ内（folder header 中央帯）→ フォルダ末尾に folderViewMoveToTree', async ({ page }) => {
        await setup(page);
        await resetCalls(page);
        // 空フォルダの children は高さ 0 のため、into-folder はヘッダ中央帯（0.25-0.60 — Feature B と同帯）
        await realDrag(page, '.fv-row[data-rel="b.md"]', '.file-panel-folder[data-folder-id="grp"] .file-panel-folder-header', 0.45);
        const mt = await calls(page, 'folderViewMoveToTree');
        expect(mt.length).toBe(1);
        expect(mt[0].args).toEqual(['fl1', 'b.md', 'grp', 0]);
    });

    test('ルート余白 → ルート末尾に folderViewMoveToTree', async ({ page }) => {
        await setup(page);
        await resetCalls(page);
        // listEl の最下部余白へ
        const list = await page.locator('#notesFileList').boundingBox();
        const src = await page.locator('.fv-row[data-rel="a.txt"]').boundingBox();
        await page.mouse.move(src!.x + 20, src!.y + src!.height / 2);
        await page.mouse.down();
        await page.mouse.move(list!.x + list!.width / 2, list!.y + list!.height - 8, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(120);
        const mt = await calls(page, 'folderViewMoveToTree');
        expect(mt.length).toBe(1);
        expect(mt[0].args).toEqual(['fl1', 'a.txt', null, 5]);
    });

    test('isDir=true の drop → 不受理通知 + bridge 不発', async ({ page }) => {
        await setup(page);
        await resetCalls(page);
        await realDrag(page, '.fv-row[data-rel="dirA"]', '[data-item-id="mdDoc"]', 0.25);
        expect((await calls(page, 'folderViewMoveToTree')).length, 'bridge 不発').toBe(0);
        expect((await calls(page, 'notifyError')).length, '不受理通知').toBe(1);
    });
});

test.describe('TC-FLV-42 — W3: Note ツリー → フォルダビュー（real mouse）', () => {

    test('md item → dirA 行 → folderViewMoveIn(md)', async ({ page }) => {
        await setup(page);
        await resetCalls(page);
        await realDrag(page, '[data-item-id="mdDoc"]', '.fv-row[data-rel="dirA"]');
        const mi = await calls(page, 'folderViewMoveIn');
        expect(mi.length).toBe(1);
        expect(mi[0].args).toEqual(['fl1', 'dirA', 'md', 'mdDoc']);
        await expectNoFvVisualResidue(page);
    });

    test('file item → ルート余白 → folderViewMoveIn(file, dst="")', async ({ page }) => {
        await setup(page);
        await resetCalls(page);
        const tree = await page.locator('.fv-tree').boundingBox();
        const src = await page.locator('[data-item-id="fileF"]').boundingBox();
        await page.mouse.move(src!.x + src!.width / 2, src!.y + src!.height / 2);
        await page.mouse.down();
        await page.mouse.move(tree!.x + tree!.width / 2, tree!.y + tree!.height - 10, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(120);
        const mi = await calls(page, 'folderViewMoveIn');
        expect(mi.length).toBe(1);
        expect(mi[0].args).toEqual(['fl1', '', 'file', 'fileF']);
    });

    test('.out item / folder item の drop → 不受理通知 + bridge 不発', async ({ page }) => {
        await setup(page);
        await resetCalls(page);
        await realDrag(page, '[data-item-id="outPlan"]', '.fv-row[data-rel="dirA"]');
        expect((await calls(page, 'folderViewMoveIn')).length).toBe(0);
        expect((await calls(page, 'notifyError')).length, '.out = 不受理通知').toBe(1);
        await resetCalls(page);
        await realDrag(page, '[data-item-id="flTree"]', '.fv-row[data-rel="dirA"]');
        expect((await calls(page, 'folderViewMoveIn')).length).toBe(0);
        expect((await calls(page, 'notifyError')).length, 'folder item = 不受理通知').toBe(1);
        await expectNoFvVisualResidue(page);
    });
});

/** synthetic drag source（cross 面ソースの dragstart 実発火は既存 sprint real mouse TC が番人） */
async function makeDragSource(page: Page, mime: string, payload: any): Promise<void> {
    await page.evaluate(({ mime, payload }) => {
        const div = document.createElement('div');
        div.id = 'testDragSrc';
        div.textContent = 'src';
        div.draggable = true;
        div.style.cssText = 'position:fixed; top:4px; right:4px; z-index:9999; background:#fc0; padding:4px;';
        div.addEventListener('dragstart', (e) => {
            e.dataTransfer!.setData(mime, JSON.stringify(payload));
            e.dataTransfer!.effectAllowed = 'copyMove';
        });
        document.body.appendChild(div);
    }, { mime, payload });
}

test.describe('TC-FLV-43 — W4 受信端: FV entry → md 本文（editor.js 新 MIME 分岐）', () => {

    test('FV MIME を md editor へ real mouse drop → folderViewMoveIntoMd(id, relPath, targetMdPath)', async ({ page }) => {
        await setup(page, { showFolderView: false });
        await page.evaluate(() => {
            (window as any).__testApi.mdDispatcher.loadMarkdown('# Target\n\ntext', '/x/target.md', '');
        });
        await page.waitForSelector('.markdown-container .editor', { timeout: 5000 });
        await makeDragSource(page, FV_MIME, { folderLinkId: 'fl1', relPath: 'docs/r.pdf', isDir: false });
        await resetCalls(page);
        await realDrag(page, '#testDragSrc', '.markdown-container .editor', 0.4);
        const mm = await calls(page, 'folderViewMoveIntoMd');
        expect(mm.length).toBe(1);
        expect(mm[0].args).toEqual(['fl1', 'docs/r.pdf', '/x/target.md']);
        // 挿入エコー（insertSubpageLink/insertImageHtml/insertFileLink）と view refresh は
        // host 単体 TC-FLV-15〜17（test/unit/folder-view-fsops.spec.ts）+ 既存挿入 spec が番人
    });

    test('isDir=true の drop → 不受理通知 + bridge 不発', async ({ page }) => {
        await setup(page, { showFolderView: false });
        await page.evaluate(() => {
            (window as any).__testApi.mdDispatcher.loadMarkdown('# Target\n\ntext', '/x/target.md', '');
        });
        await page.waitForSelector('.markdown-container .editor', { timeout: 5000 });
        await makeDragSource(page, FV_MIME, { folderLinkId: 'fl1', relPath: 'dirA', isDir: true });
        await resetCalls(page);
        await realDrag(page, '#testDragSrc', '.markdown-container .editor', 0.4);
        expect((await calls(page, 'folderViewMoveIntoMd')).length).toBe(0);
        expect((await calls(page, 'notifyError')).length).toBe(1);
    });
});

test.describe('TC-FLV-48 — W6 受信端: md アンカー → フォルダビュー（既存 2 MIME）', () => {

    test('📎 filelink MIME → dirA 行 → folderViewMoveFromMd(isSubpage=false)', async ({ page }) => {
        await setup(page);
        await makeDragSource(page, 'application/x-fractal-md-filelink', { href: 'files/a.pdf', sourceMdPath: '/x/src.md' });
        await resetCalls(page);
        await realDrag(page, '#testDragSrc', '.fv-row[data-rel="dirA"]');
        const fm = await calls(page, 'folderViewMoveFromMd');
        expect(fm.length).toBe(1);
        expect(fm[0].args).toEqual(['fl1', 'dirA', 'files/a.pdf', '/x/src.md', false]);
    });

    test('subpage MIME → ルート余白 → folderViewMoveFromMd(isSubpage=true)', async ({ page }) => {
        await setup(page);
        await makeDragSource(page, 'application/x-fractal-md-subpage', { href: 'sub.md', sourceMdPath: '/x/src.md', title: 'Sub' });
        await resetCalls(page);
        const tree = await page.locator('.fv-tree').boundingBox();
        const src = await page.locator('#testDragSrc').boundingBox();
        await page.mouse.move(src!.x + src!.width / 2, src!.y + src!.height / 2);
        await page.mouse.down();
        await page.mouse.move(tree!.x + tree!.width / 2, tree!.y + tree!.height - 10, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(120);
        const fm = await calls(page, 'folderViewMoveFromMd');
        expect(fm.length).toBe(1);
        expect(fm[0].args).toEqual(['fl1', '', 'sub.md', '/x/src.md', true]);
    });

    test('他 MIME（outliner node 系）→ 不受理通知 + bridge 不発', async ({ page }) => {
        await setup(page);
        await makeDragSource(page, 'application/x-fractal-out-node-file', { outFileKey: '/x/a.out', nodeId: 'n1' });
        await resetCalls(page);
        await realDrag(page, '#testDragSrc', '.fv-row[data-rel="dirA"]');
        expect((await calls(page, 'folderViewMoveFromMd')).length).toBe(0);
        expect((await calls(page, 'folderViewMoveIn')).length).toBe(0);
        expect((await calls(page, 'notifyError')).length).toBe(1);
        await expectNoFvVisualResidue(page);
    });
});

test.describe('TC-FLV-46 — W5: tree 内 folder item 並べ替え（regression）+ dragstart MIME 制約', () => {

    test('① folder item を real mouse で並べ替え → 既存 moveItem 経路（regression）', async ({ page }) => {
        await setup(page, { showFolderView: false });
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; (window as any).__testApi.messages.length = 0; });
        await realDrag(page, '[data-item-id="flTree"]', '[data-item-id="mdDoc"]', 0.2);
        const msgs = await page.evaluate(() =>
            JSON.parse(JSON.stringify(((window as any).__testApi.notesMessages || []).concat((window as any).__testApi.messages || []))));
        const move = msgs.filter((m: any) => m.type === 'moveItem');
        expect(move.length).toBe(1);
        expect(move[0].itemId).toBe('flTree');
        expect(move[0].index).toBe(0);
    });

    test('② folder item dragstart の DataTransfer types に面間 D&D 用 MIME を含まない', async ({ page }) => {
        await setup(page, { showFolderView: false });
        const types = await page.evaluate(() => {
            const el = document.querySelector('[data-item-id="flTree"]') as HTMLElement;
            const dt = new DataTransfer();
            el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const t = Array.from(dt.types || []);
            el.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return t;
        });
        expect(types).not.toContain('application/x-fractal-tree-file');
        expect(types).not.toContain('application/x-fractal-tree-md');
        expect(types).not.toContain('application/x-fractal-folderview-entry');
    });
});
