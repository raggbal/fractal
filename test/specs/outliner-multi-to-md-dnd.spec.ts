/**
 * W8（multi-file-dnd-clipboard-matrix）: outliner の複数選択（と bullet）→ md editor（note md / sidepanel md）。
 *
 * 選択中に bullet / page アイコン / file アイコンのどこを掴んでも、選択中の page / file node を**全部**運ぶ
 *（x-fractal-out-node-assets の items を md editor が読み、host へ attachOutNodeAssetsToMd を 1 回）。
 * 選択外のアイコンを掴んだら従来どおり 1 件（attachOutNodeFileToMd / importOutPageNodeToMd）。
 * icon drag にも選択の根（nodeIds）を載せた subtree payload を積み、ツリーの .out 行 / linkedfd 行と linkedfd view が
 * bullet を掴んだときと同じ集合を動かす。
 *
 * 送り手 = 本番の dragstart（standalone-outliner.html の outliner.js / mindmap-render.js）。積まれた DataTransfer を
 * そのまま standalone-notes.html の md editor / ツリー / linkedfd view へ本物の DOM drop で落とす
 *（webview 間 D&D の実体と同じ payload 経路 — outliner-multiselect-tree-dnd-e2e.spec.ts と同じ方法）。
 *
 * TC-OMW-01 複数選択の bullet → sidepanel md = attachOutNodeAssetsToMd 1 回（items = 選択順、宛先 = sidepanel の md）
 * TC-OMW-02 複数選択の page アイコン / file アイコン → sidepanel md = 同じ 1 回（掴んだ 1 件だけにならない）
 * TC-OMW-03 複数選択 → note md（main pane）= 同じ 1 回（sidePanelFilePath なし）
 * TC-OMW-04 選択外のアイコン → 従来の単一経路 / 単体の bullet（page 付き）→ batch（以前は何も起きなかった）
 * TC-OMW-05 複数選択の icon drag は subtree に選択の根を載せる → ツリーの .out 行 / linkedfd 行 / linkedfd view が bullet と同じ集合
 * TC-OMW-06 mindmap の page / file icon も複数選択なら選択集合の添付 + 選択の根を積む（outliner と同じ関数）
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
/** n1 = 素の node / n2 = page / n3 = file / n4 = 選択外の page */
const TREE = {
    version: 1, rootIds: ['n1', 'n2', 'n3', 'n4'],
    nodes: {
        n1: n('n1', 'plain'),
        n2: n('n2', 'haspage', { isPage: true, pageId: 'page-2' }),
        n3: n('n3', 'hasfile', { filePath: 'files/a.pdf' }),
        n4: n('n4', 'other', { isPage: true, pageId: 'page-4' }),
    },
};
const SEL_ITEMS = [
    { nodeId: 'n2', assets: [{ kind: 'page', pageId: 'page-2' }] },
    { nodeId: 'n3', assets: [{ kind: 'file', filePath: 'files/a.pdf' }] },
];

const FILES = [
    { filePath: '/n/o1.out', title: 'out1', id: 'o1', kind: 'out' },
    { filePath: '/n/o2.out', title: 'out2', id: 'o2', kind: 'out' },
    { filePath: '', title: 'Docs', id: 'fl1', kind: 'folder', broken: false },
];
const STRUCTURE = {
    version: 1, rootIds: ['o1', 'o2', 'fl1'],
    items: {
        o1: { type: 'file', id: 'o1', title: 'out1', ext: 'out', filePath: '/n/o1.out' },
        o2: { type: 'file', id: 'o2', title: 'out2', ext: 'out', filePath: '/n/o2.out' },
        fl1: { type: 'file', id: 'fl1', title: 'Docs', ext: 'folder' },
    },
};
const MAIN = '.markdown-container .editor';
const SIDE = '.side-panel .editor, .side-panel-iframe-container .editor';
const MD = '# Cur\n\nfirst para\n\nTail para\n';

/** 送り手: outliner を開き（selectIds があれば cmd+click で複数選択）、grabSel の要素で本番の dragstart を起こす */
async function capture(page: Page, grabSel: string, selectIds: string[] | null): Promise<Record<string, string>> {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate(() => {
        if (!document.querySelector('.notes-layout')) {
            const d = document.createElement('div'); d.className = 'notes-layout'; document.body.appendChild(d);
        }
    });
    await page.evaluate(({ t, key }) => { (window as any).__testApi.initOutliner(t, key); }, { t: TREE, key: OUT_KEY });
    await page.waitForSelector('.outliner-node', { timeout: 5000 });
    if (selectIds) {
        await page.locator(`.outliner-node[data-id="${selectIds[0]}"] .outliner-text`).click();
        for (const id of selectIds) {
            await page.locator(`.outliner-node[data-id="${id}"] .outliner-text`).click({ modifiers: ['Meta'] });
        }
    }
    return await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement;
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: r.left + 2, clientY: r.top + 2 }));
        const dt = new DataTransfer();
        el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const map: Record<string, string> = {};
        for (const t of Array.from(dt.types)) { map[t] = dt.getData(t); }
        return map;
    }, grabSel);
}
const bullet = (id: string) => `.outliner-node[data-id="${id}"] .outliner-bullet`;
const pageIcon = (id: string) => `.outliner-node[data-id="${id}"] .outliner-page-icon`;
const fileIcon = (id: string) => `.outliner-node[data-id="${id}"] .outliner-file-icon`;

async function openNotes(page: Page): Promise<void> {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate(({ files, structure }) => { (window as any).__testApi.initNotesPanel(files, '/n/o1.out', structure); }, { files: FILES, structure: STRUCTURE });
    await page.waitForSelector('.file-panel-item[data-item-id="fl1"]', { timeout: 5000 });
}
async function openSidePanel(page: Page): Promise<void> {
    await page.evaluate((md) => {
        (window as any).__hostMessageHandler({ type: 'openSidePanel', markdown: md, filePath: '/n/sp.md', fileName: 'sp.md', toc: [], documentBaseUri: '' });
    }, MD);
    await page.waitForFunction((sel) => !!document.querySelector(sel), SIDE, { timeout: 5000 });
    await page.waitForTimeout(100);
}
async function loadMainMd(page: Page): Promise<void> {
    await page.evaluate((md) => {
        (window as any).__hostMessageHandler({ type: 'updateData', kind: 'md', markdown: md, filePath: '/n/cur.md', documentBaseUri: '' });
    }, MD);
    await page.waitForFunction((sel) => {
        const ed = document.querySelector(sel);
        return !!(ed && (ed.textContent || '').indexOf('Tail') >= 0);
    }, MAIN, { timeout: 5000 });
}

/** 捕まえた payload を sel の要素（md なら "Tail para" の段落）へ dragover → drop し、host への message を返す */
async function dropRaw(page: Page, raw: Record<string, string>, sel: string, ratio = 0.5, mdTail = false): Promise<any[]> {
    await page.evaluate(({ raw, sel, ratio, mdTail }) => {
        const w = window as any;
        w.__testApi.notesMessages.length = 0;
        w.__testApi.messages.length = 0;
        let dst = document.querySelector(sel) as HTMLElement;
        if (mdTail) {
            dst = Array.from(dst.querySelectorAll('p')).find((p) => (p.textContent || '').indexOf('Tail') >= 0) as HTMLElement;
        }
        const dt = new DataTransfer();
        for (const k of Object.keys(raw)) { dt.setData(k, raw[k]); }
        const r = dst.getBoundingClientRect();
        const x = r.left + Math.min(20, r.width / 2), y = r.top + r.height * ratio;
        dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    }, { raw, sel, ratio, mdTail });
    await page.waitForTimeout(80);
    return await page.evaluate(() => {
        const w = window as any;
        return JSON.parse(JSON.stringify(w.__testApi.notesMessages)).concat(JSON.parse(JSON.stringify(w.__testApi.messages)));
    });
}
const MD_TYPES = ['attachOutNodeAssetsToMd', 'attachOutNodeFileToMd', 'importOutPageNodeToMd'];
function mdCalls(msgs: any[]): any[] { return msgs.filter((m) => MD_TYPES.indexOf(m.type) >= 0); }

test.describe('W8: outliner の複数選択 → md editor', () => {
    test('TC-OMW-01 複数選択の bullet → sidepanel md = attachOutNodeAssetsToMd 1 回（選択順）', async ({ page }) => {
        const raw = await capture(page, bullet('n1'), ['n1', 'n2', 'n3']);
        expect(JSON.parse(raw[AS]).items).toEqual(SEL_ITEMS);
        await openNotes(page);
        await openSidePanel(page);
        const calls = mdCalls(await dropRaw(page, raw, SIDE, 0.5, true));
        expect(calls.map((m) => m.type), `md 宛て: ${calls.map((m) => m.type).join(',')}`).toEqual(['attachOutNodeAssetsToMd']);
        expect(calls[0].sidePanelFilePath).toBe('/n/sp.md');
        expect(calls[0].payload.items, '選択中の page / file が全部載らない').toEqual(SEL_ITEMS);
        expect(calls[0].payload.outFileKey).toBe(OUT_KEY);
    });

    test('TC-OMW-02 複数選択の page アイコン / file アイコン → sidepanel md も同じ 1 回（掴んだ 1 件だけにならない）', async ({ page }) => {
        for (const grab of [pageIcon('n2'), fileIcon('n3')]) {
            const raw = await capture(page, grab, ['n1', 'n2', 'n3']);
            await openNotes(page);
            await openSidePanel(page);
            const calls = mdCalls(await dropRaw(page, raw, SIDE, 0.5, true));
            expect(calls.map((m) => m.type), `${grab}: ${calls.map((m) => m.type).join(',')}`).toEqual(['attachOutNodeAssetsToMd']);
            expect(calls[0].payload.items).toEqual(SEL_ITEMS);
            expect(calls[0].sidePanelFilePath).toBe('/n/sp.md');
        }
    });

    test('TC-OMW-03 複数選択 → note md（main pane）= 同じ 1 回（宛先は currentFile）', async ({ page }) => {
        const raw = await capture(page, fileIcon('n3'), ['n1', 'n2', 'n3']);
        await openNotes(page);
        await loadMainMd(page);
        const calls = mdCalls(await dropRaw(page, raw, MAIN, 0.5, true));
        expect(calls.map((m) => m.type)).toEqual(['attachOutNodeAssetsToMd']);
        expect(calls[0].sidePanelFilePath, 'main md 宛てに sidepanel のパスが付いた').toBe(null);
        expect(calls[0].payload.items).toEqual(SEL_ITEMS);
    });

    test('TC-OMW-04 選択外のアイコン → 従来の単一経路 / 単体の page node の bullet → batch', async ({ page }) => {
        // 選択（n1..n3）の外の n4 の page アイコン = 1 件だけ（従来どおり）
        let raw = await capture(page, pageIcon('n4'), ['n1', 'n2', 'n3']);
        expect(raw[AS], '選択外なのに選択集合を積んだ').toBeUndefined();
        await openNotes(page);
        await openSidePanel(page);
        let calls = mdCalls(await dropRaw(page, raw, SIDE, 0.5, true));
        expect(calls.map((m) => m.type)).toEqual(['importOutPageNodeToMd']);
        expect(calls[0].payload.pageId).toBe('page-4');
        // 選択なしの file アイコン = 1 件だけ
        raw = await capture(page, fileIcon('n3'), null);
        await openNotes(page);
        await openSidePanel(page);
        calls = mdCalls(await dropRaw(page, raw, SIDE, 0.5, true));
        expect(calls.map((m) => m.type)).toEqual(['attachOutNodeFileToMd']);
        // 選択なしの bullet（page 付き node）= 添付 payload を batch で（以前は md に落としても何も起きなかった）
        raw = await capture(page, bullet('n2'), null);
        await openNotes(page);
        await openSidePanel(page);
        calls = mdCalls(await dropRaw(page, raw, SIDE, 0.5, true));
        expect(calls.map((m) => m.type), 'bullet を md に落としても何も起きない').toEqual(['attachOutNodeAssetsToMd']);
        expect(calls[0].payload.assets).toEqual([{ kind: 'page', pageId: 'page-2' }]);
        expect(calls[0].payload.items).toBeUndefined();
    });
});

test.describe('W8: icon drag も選択の根を運ぶ（ツリー / linkedfd が bullet と同じ集合）', () => {
    test('TC-OMW-05 icon drag の subtree.nodeIds = 選択の根 → .out 行 / linkedfd 行が bullet と同じ nodeIds', async ({ page }) => {
        const rawBullet = await capture(page, bullet('n1'), ['n1', 'n2', 'n3']);
        const rawIcon = await capture(page, pageIcon('n2'), ['n1', 'n2', 'n3']);
        expect(JSON.parse(rawBullet[SUB]).nodeIds).toEqual(['n1', 'n2', 'n3']);
        expect(rawIcon[SUB], 'icon drag に subtree payload が無い').toBeTruthy();
        expect(JSON.parse(rawIcon[SUB]).nodeIds, 'icon drag の nodeIds が選択の根でない').toEqual(['n1', 'n2', 'n3']);
        // 選択の外の icon は従来どおり subtree を積まない
        const rawOutside = await capture(page, pageIcon('n4'), ['n1', 'n2', 'n3']);
        expect(rawOutside[SUB]).toBeUndefined();

        await openNotes(page);
        const result: Record<string, any> = {};
        for (const [name, raw] of [['bullet', rawBullet], ['icon', rawIcon]] as const) {
            const toOut = (await dropRaw(page, raw, '.file-panel-item[data-item-id="o2"]', 0.5)).filter((m) => m.type === 'notesMoveOutNodeSubtreeIntoOut');
            const toFd = (await dropRaw(page, raw, '.file-panel-item[data-item-id="fl1"]', 0.5)).filter((m) => m.type === 'sendOutNodesToFolderLinkFromDrop');
            expect(toOut.length, `${name} → .out 行`).toBe(1);
            expect(toFd.length, `${name} → linkedfd 行`).toBe(1);
            result[name] = { out: toOut[0].payload.nodeIds, fd: toFd[0].payload.nodeIds };
        }
        expect(result.icon.out, 'icon と bullet で .out 行へ動く集合が違う').toEqual(result.bullet.out);
        expect(result.icon.fd, 'icon と bullet で linkedfd 行へ動く集合が違う').toEqual(result.bullet.fd);
        expect(result.icon.out).toEqual(['n1', 'n2', 'n3']);
    });

    test('TC-OMW-06 mindmap の page / file icon も複数選択なら選択集合の添付 + 選択の根を積む', async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate(() => {
            if (!document.querySelector('.notes-layout')) {
                const d = document.createElement('div'); d.className = 'notes-layout'; d.style.display = 'none'; document.body.appendChild(d);
            }
        });
        const mm = {
            version: 1, viewMode: 'mindmap', title: 'T', rootIds: ['r'],
            nodes: {
                r: n('r', 'Root', { children: ['a', 'p1', 'f1'] }),
                a: n('a', 'AAA', { parentId: 'r' }),
                p1: n('p1', 'PageNode', { parentId: 'r', isPage: true, pageId: 'pg-1' }),
                f1: n('f1', 'FileNode', { parentId: 'r', filePath: 'files/doc.pdf' }),
            },
        };
        await page.evaluate((d) => { (window as any).__testApi.initOutliner(d, '/n/o1.out'); }, mm);
        await page.waitForTimeout(250);
        for (const [id, mod] of [['a', false], ['p1', true], ['f1', true]] as const) {
            await page.locator(`.mindmap-node[data-node-id="${id}"] .mindmap-node-box`).click(mod ? { modifiers: ['Meta'] } : {});
            await page.waitForTimeout(80);
        }
        for (const id of ['p1', 'f1']) {
            const got = await page.evaluate((nid) => {
                const icon = document.querySelector(`.mindmap-node[data-node-id="${nid}"] .mindmap-node-icon`) as HTMLElement;
                const dt = new DataTransfer();
                icon.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
                const read = (m: string) => { const s = dt.getData(m); return s ? JSON.parse(s) : null; };
                return { assets: read('application/x-fractal-out-node-assets'), subtree: read('application/x-fractal-out-node-subtree') };
            }, id);
            expect(got.assets, `mindmap の ${id} icon が選択集合の添付を積まない`).toBeTruthy();
            expect(got.assets.items.map((it: any) => it.nodeId)).toEqual(['p1', 'f1']);
            expect(got.subtree && got.subtree.nodeIds, `mindmap の ${id} icon が選択の根を積まない`).toEqual(['a', 'p1', 'f1']);
        }
    });
});
