/**
 * 2026-09-05（移動系の残セル R24..R28）— note tree / folder view / outliner 面の受け手
 *
 * TC-RC-01 linkedfd entry → tree .out 行 = sendFolderViewToOutliner(link, rels, outId) / md 行中央 = folderViewMoveIntoMdItem（dir は除外+通知）/ md 行上帯 = 従来の tree 登録
 * TC-RC-02 outliner node → tree linkedfd 行 = sendOutNodesToFolderLinkFromDrop(payload, linkId, '')（複数は nodeIds）
 * TC-RC-03 md 内リンク → tree linkedfd 行 = folderViewMoveFromMd(linkId, '', href, src, isSubpage)
 * TC-RC-04 Finder フォルダ → tree = notesRegisterExternalFolder(payload, parentId, index)
 * TC-RC-05 linkedfd entry → outliner 面 = sendFolderViewToOutliner(link, rels, null, targetNodeId, position)
 * TC-RC-06 outliner node → linkedfd 面（fv 単体マウント）= sendOutNodesToFolderLinkFromDrop(payload, linkId, dst)
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const STRUCTURE = {
    version: 1, rootIds: ['o1', 'o2', 'm1', 'm2', 'fl1'],
    items: {
        o1: { type: 'file', id: 'o1', title: 'out1', ext: 'out', filePath: '/n/o1.out' },
        o2: { type: 'file', id: 'o2', title: 'out2', ext: 'out', filePath: '/n/o2.out' },
        m1: { type: 'file', id: 'm1', title: 'md1', ext: 'md', filePath: '/n/m1.md' },
        m2: { type: 'file', id: 'm2', title: 'md2', ext: 'md', filePath: '/n/m2.md' },
        fl1: { type: 'file', id: 'fl1', title: 'Docs', ext: 'folder' },
    },
};
const FILES = [
    { filePath: '/n/o1.out', title: 'out1', id: 'o1', kind: 'out' },
    { filePath: '/n/o2.out', title: 'out2', id: 'o2', kind: 'out' },
    { filePath: '/n/m1.md', title: 'md1', id: 'm1', kind: 'md' },
    { filePath: '/n/m2.md', title: 'md2', id: 'm2', kind: 'md' },
    { filePath: '', title: 'Docs', id: 'fl1', kind: 'folder', broken: false },
];
const FV = 'application/x-fractal-folderview-entry';
const SUBTREE = 'application/x-fractal-out-node-subtree';
const MDSUB = 'application/x-fractal-md-subpage';
const MDFILE = 'application/x-fractal-md-filelink';

async function setup(page: Page): Promise<void> {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate(({ files, structure }) => { (window as any).__testApi.initNotesPanel(files, '/n/o1.out', structure); }, { files: FILES, structure: STRUCTURE });
    await page.waitForSelector('.file-panel-item[data-item-id="fl1"]', { timeout: 5000 });
}
function msgs(page: Page): Promise<any[]> { return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.notesMessages))); }
function types(list: any[]): string[] { return list.map((m) => m.type).filter((t) => t !== 'notifyError'); }
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

test('TC-RC-01 linkedfd entry → tree .out 行 = その outliner へ / md 行中央 = その md へ（dir 除外）/ md 上帯 = 従来の tree 登録', async ({ page }) => {
    await setup(page);
    const multi = { v: 1, folderLinkId: 'fl1', items: [{ relPath: 'a.md', isDir: false }, { relPath: 'dirA', isDir: true }, { relPath: 'b.pdf', isDir: false }] };
    let m = await dropExternal(page, { [FV]: multi }, 'o2', 0.5);
    expect(types(m), `out: ${types(m).join(',')}`).toEqual(['sendFolderViewToOutliner']);
    expect(m[0]).toMatchObject({ folderLinkId: 'fl1', relPaths: ['a.md', 'dirA', 'b.pdf'], outFileId: 'o2' });
    expect(await page.evaluate(() => (window as any).__lastZone), '.out 行に受け手ゾーンが出ない').toBe(true);
    m = await dropExternal(page, { [FV]: multi }, 'm2', 0.5);
    expect(types(m), `md center: ${types(m).join(',')}`).toEqual(['folderViewMoveIntoMdItem']);
    expect(m.find((x) => x.type === 'folderViewMoveIntoMdItem')).toMatchObject({ folderLinkId: 'fl1', relPaths: ['a.md', 'b.pdf'], targetMdId: 'm2' });
    expect(m.filter((x) => x.type === 'notifyError').length, 'dir 除外の通知').toBe(1);
    m = await dropExternal(page, { [FV]: { folderLinkId: 'fl1', relPath: 'a.md', isDir: false } }, 'm2', 0.1);
    expect(types(m), 'edge は従来の tree 登録（FR-FLV-20）').toEqual(['folderViewMoveToTree']);
});

test('TC-RC-02 outliner node → tree linkedfd 行 = sendOutNodesToFolderLinkFromDrop（複数は nodeIds・dst=\'\'）', async ({ page }) => {
    await setup(page);
    let m = await dropExternal(page, { [SUBTREE]: { outFileKey: '/n/o1.out', nodeId: 'na' } }, 'fl1', 0.5);
    expect(types(m), types(m).join(',')).toEqual(['sendOutNodesToFolderLinkFromDrop']);
    expect(m[0]).toMatchObject({ payload: { outFileKey: '/n/o1.out', nodeId: 'na' }, folderLinkId: 'fl1', dstDirRelPath: '' });
    expect(await page.evaluate(() => (window as any).__lastZone)).toBe(true);
    m = await dropExternal(page, { [SUBTREE]: { outFileKey: '/n/o1.out', nodeId: 'nb', nodeIds: ['na', 'nb'] } }, 'fl1', 0.1);
    expect(m[0].payload.nodeIds).toEqual(['na', 'nb']);
});

test('TC-RC-03 md 内リンク → tree linkedfd 行 = folderViewMoveFromMd(linkId, \'\', href, src, isSubpage)', async ({ page }) => {
    await setup(page);
    let m = await dropExternal(page, { [MDSUB]: { href: 'sub.md', sourceMdPath: '/n/src.md', title: 'Sub' } }, 'fl1', 0.5);
    expect(types(m)).toEqual(['folderViewMoveFromMd']);
    expect(m[0]).toMatchObject({ id: 'fl1', dstDirRelPath: '', href: 'sub.md', sourceMdPath: '/n/src.md', isSubpage: true });
    m = await dropExternal(page, { [MDFILE]: { href: 'files/doc.pdf', sourceMdPath: '/n/src.md' } }, 'fl1', 0.5);
    expect(m[0]).toMatchObject({ type: 'folderViewMoveFromMd', href: 'files/doc.pdf', isSubpage: false });
});

test('TC-RC-04 Finder フォルダ → tree = notesRegisterExternalFolder（中身を読んだ payload・drop 位置）', async ({ page }) => {
    await setup(page);
    const m = await page.evaluate(async () => {
        const w = window as any;
        w.__testApi.notesMessages.length = 0;
        function fileEntry(name: string, blob: any) { return { isDirectory: false, isFile: true, name, file: (ok: any) => ok(new File([blob], name)) }; }
        function dirEntry(name: string, children: any[]) { let done = false; return { isDirectory: true, isFile: false, name, createReader: () => ({ readEntries: (ok: any) => { if (done) { ok([]); return; } done = true; ok(children); } }) }; }
        const fake = dirEntry('proj', [fileEntry('index.md', '# Index'), dirEntry('sub', [fileEntry('doc.pdf', new Uint8Array([37, 80, 68, 70]))])]);
        const dst = document.querySelector('[data-item-id="m1"]') as HTMLElement;
        const r = dst.getBoundingClientRect();
        const dt: any = { types: ['Files'], files: [], getData: () => '', items: [{ kind: 'file', type: '', webkitGetAsEntry: () => fake, getAsFile: () => null }] };
        const ev = new DragEvent('drop', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.bottom - 2 });
        Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
        dst.dispatchEvent(ev);
        await new Promise((res) => setTimeout(res, 300));
        return JSON.parse(JSON.stringify(w.__testApi.notesMessages));
    });
    const reg = m.filter((x: any) => x.type === 'notesRegisterExternalFolder');
    expect(reg.length, `notesRegisterExternalFolder が 1 回でない: ${m.map((x: any) => x.type).join(',')}`).toBe(1);
    expect(reg[0].payload.name).toBe('proj');
    expect(reg[0].payload.files.map((f: any) => f.relPath).sort()).toEqual(['index.md', 'sub/doc.pdf']);
    expect(reg[0].parentId).toBeNull();
    expect(reg[0].index, 'm1（index 2）の下 = 3').toBe(3);
});

test('TC-RC-05 linkedfd entry → outliner 面 = sendFolderViewToOutliner(link, rels, null, targetNodeId, position)', async ({ page }) => {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.initOutliner !== undefined);
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({ version: 1, rootIds: ['a', 'b'], nodes: {
            a: { id: 'a', parentId: null, text: 'alpha', children: [] }, b: { id: 'b', parentId: null, text: 'bravo', children: [] } } });
    });
    await page.waitForSelector('.outliner-node[data-id="b"]');
    const m = await page.evaluate(async () => {
        const w = window as any;
        w.__testApi.notesMessages.length = 0;
        const dst = document.querySelector('.outliner-node[data-id="b"]') as HTMLElement;
        const dt = new DataTransfer();
        dt.setData('application/x-fractal-folderview-entry', JSON.stringify({ v: 1, folderLinkId: 'fl1', items: [{ relPath: 'dirA', isDir: true }, { relPath: 'x.md', isDir: false }] }));
        const r = dst.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.bottom - 2;   // after 帯
        dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        await new Promise((res) => setTimeout(res, 100));
        return JSON.parse(JSON.stringify(w.__testApi.notesMessages));
    });
    const s = m.filter((x: any) => x.type === 'sendFolderViewToOutliner');
    expect(s.length, `sendFolderViewToOutliner が 1 回でない: ${m.map((x: any) => x.type).join(',')}`).toBe(1);
    expect(s[0]).toMatchObject({ folderLinkId: 'fl1', relPaths: ['dirA', 'x.md'], outFileId: null, targetNodeId: 'b' });
    expect(['after', 'before', 'child']).toContain(s[0].position);
});

test('TC-RC-06 outliner node → linkedfd 面（fv 単体マウント）= sendOutNodesToFolderLinkFromDrop(payload, linkId, dst dir)', async ({ page }) => {
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../src/shared', rel), 'utf8');
    await page.goto('about:blank');
    await page.setContent('<!DOCTYPE html><html><head><meta charset="utf-8"><style>.fv-row{min-height:20px}</style></head><body><div class="notes-main-wrapper" style="position:relative;height:600px;"><div id="outlinerContainer">o</div><div id="markdownContainer" style="display:none">m</div></div></body></html>');
    await page.evaluate(() => { const w = window as any; w.__calls = []; w.__outlinerMessages = {}; w.notesHostBridge = new Proxy({}, { get: (_t, p: string) => (...a: any[]) => { w.__calls.push({ type: p, args: a }); } }); });
    await page.addScriptTag({ content: read('menu-placement.js') });
    await page.addScriptTag({ content: read('batch-payload.js') });
    await page.addScriptTag({ content: read('folder-view-dispatcher.js') });
    await page.addScriptTag({ content: read('notes-folder-view.js') });
    await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
    await page.evaluate(() => { window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries: [{ name: 'dirA', relPath: 'dirA', isDir: true }, { name: 'f1.txt', relPath: 'f1.txt', isDir: false }] }, '*'); });
    await page.waitForSelector('.fv-row', { timeout: 5000 });
    const calls = await page.evaluate(() => {
        const w = window as any;
        w.__calls.length = 0;
        const row = document.querySelector('.fv-row[data-rel="dirA"]') as HTMLElement;
        const dt = new DataTransfer();
        dt.setData('application/x-fractal-out-node-subtree', JSON.stringify({ outFileKey: '/n/o1.out', nodeId: 'na', nodeIds: ['na', 'nb'] }));
        dt.setData('application/x-fractal-out-node-assets', JSON.stringify({ v: 1, outFileKey: '/n/o1.out', nodeId: 'na', assets: [] }));
        const r = row.getBoundingClientRect();
        row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
        return JSON.parse(JSON.stringify(w.__calls));
    });
    const c = calls.filter((x: any) => x.type === 'sendOutNodesToFolderLinkFromDrop');
    expect(c.length, `呼び出し: ${calls.map((x: any) => x.type).join(',')}`).toBe(1);
    expect(c[0].args[0]).toMatchObject({ outFileKey: '/n/o1.out', nodeId: 'na', nodeIds: ['na', 'nb'] });
    expect(c[0].args[1]).toBe('fl1');
    expect(c[0].args[2], 'dir 行への drop はその dir が dst').toBe('dirA');
    expect(calls.filter((x: any) => x.type === 'notifyError').length, '不受理通知が出ている').toBe(0);
});
