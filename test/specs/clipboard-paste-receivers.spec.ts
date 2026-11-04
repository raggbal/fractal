/**
 * W9 / W10 / W11 / W12（multi-file-dnd-clipboard-matrix）: clipboard の送り手と受け手（webview 側）。
 *
 * 送り手は本物のキー押下（tree / outliner の cmd+c・cmd+x）か本物の copy / cut イベント（md editor）で作り、
 * 受け手は本物の paste イベントで叩く（ツリー・linkedfd は document に配られるので body へ、md / outliner は要素へ）。
 * 1 回の貼り付け = host への message 1 本。移動か複製かは host が決める（ここでは「どの入口に何が渡るか」を見る）。
 *
 * TC-CBW-01 W10 ツリーの cmd+c / cmd+x: data-fractal-tree-clip に選択順の items（md / file / out / folder）と isCut
 * TC-CBW-02 W11 ツリーの cmd+v（ツリーの clip）: 行の後ろ / 仮想フォルダの中 / linkedfd 行 = その linkedfd / 元の行の上 = その後ろ
 * TC-CBW-03 W11 md の範囲選択の copy / cut → ツリー: pasteMdClip（選択の中のリンク全部）。linkedfd 行 = kind 'fv'
 * TC-CBW-04 W11 outliner の cmd+c / cmd+x → ツリー: pasteOutlinerClipToTree。linkedfd 行 = 既存の書き出し（cut の印つき）
 * TC-CBW-05 W11 / W12 linkedfd の cmd+c → ツリー: 行の後ろ = note へ / 別の linkedfd の行 = folderViewCopyAcrossLinks / 同じ行 = その中で複製
 * TC-CBW-06 W11 ツリーにフォーカスがある paste は linkedfd view が横取りしない（誤配送）
 * TC-CBW-07 W11 / W12 linkedfd view の cmd+v: ツリーの clip / md の clip / 別の linkedfd の clip
 * TC-CBW-08 W11 md editor（note md / sidepanel md）の cmd+v: linkedfd の clip = mode 'copy' / ツリーの clip = pasteTreeClip
 * TC-CBW-09 W11 outliner の cmd+v: ツリーの clip = pasteTreeClip（対象 node の直後）
 * TC-CBW-10 W9 outliner の単一 copy / 単一 cut / 複数 cut にも nodeIds。単一 cut は添付ファイルも外す
 * TC-CBW-11 W9 outliner の cut を md へ貼る → pasteOutlinerNodesWithAssets に isCut（copy は false）
 * TC-CBW-12 W9 outliner の cut を linkedfd へ貼る → cut の印（Store と突き合わせる text）を host へ
 * TC-CBW-13 W12 linkedfd の entry をツリーの別の linkedfd 行の中央帯へ D&D = folderViewCopyAcrossLinks（上下帯は従来）
 */
import { test, expect, Page } from '@playwright/test';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const FILES = [
    { filePath: '/n/o1.out', title: 'out1', id: 'o1', kind: 'out' },
    { filePath: '/n/m1.md', title: 'md1', id: 'm1', kind: 'md' },
    { filePath: '/n/m2.md', title: 'md2', id: 'm2', kind: 'md' },
    { filePath: '/n/files/a.pdf', title: 'a.pdf', id: 'f1', kind: 'file' },
    { filePath: '', title: 'Docs', id: 'fl1', kind: 'folder', broken: false },
    { filePath: '', title: 'Other', id: 'fl2', kind: 'folder', broken: false },
    { filePath: '/n/m3.md', title: 'md3', id: 'm3', kind: 'md' },
];
const STRUCTURE = {
    version: 1, rootIds: ['o1', 'm1', 'm2', 'f1', 'fl1', 'fl2', 'dirA'],
    items: {
        o1: { type: 'file', id: 'o1', title: 'out1' },
        m1: { type: 'file', id: 'm1', title: 'md1', ext: 'md' },
        m2: { type: 'file', id: 'm2', title: 'md2', ext: 'md' },
        f1: { type: 'file', id: 'f1', title: 'a.pdf', ext: 'file', filename: 'a.pdf' },
        fl1: { type: 'file', id: 'fl1', title: 'Docs', ext: 'folder' },
        fl2: { type: 'file', id: 'fl2', title: 'Other', ext: 'folder' },
        dirA: { type: 'folder', id: 'dirA', title: 'FolderA', childIds: ['m3'], collapsed: false },
        m3: { type: 'file', id: 'm3', title: 'md3', ext: 'md' },
    },
};
const MAIN = '.markdown-container .editor';
const SIDE = '.side-panel .editor, .side-panel-iframe-container .editor';
const MD = '# Cur\n\n[[Alpha]](alpha.md) and [📎 x.pdf](files/x.pdf) then [[Beta]](beta.md) end\n\nTail para\n';

function node(id: string, text: string, extra: any = {}) {
    return Object.assign({
        id, parentId: null, children: [], text, collapsed: false, subtext: '',
        images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [],
    }, extra);
}
const OUT_TREE = {
    version: 1, rootIds: ['na', 'nb', 'nc'],
    nodes: { na: node('na', 'alpha', { isPage: true, pageId: 'pgA' }), nb: node('nb', 'bravo', { filePath: 'files/b.pdf' }), nc: node('nc', 'charlie') },
};

async function boot(page: Page, currentFile = '/n/o1.out'): Promise<void> {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => { /* noop */ });
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate(({ files, structure, cur }) => { (window as any).__testApi.initNotesPanel(files, cur, structure); },
        { files: FILES, structure: STRUCTURE, cur: currentFile });
    await page.waitForSelector('.file-panel-item[data-item-id="fl2"]', { timeout: 5000 });
}
const msgs = (page: Page): Promise<any[]> => page.evaluate(() =>
    JSON.parse(JSON.stringify((window as any).__testApi.notesMessages.concat((window as any).__testApi.messages))));
const clear = (page: Page) => page.evaluate(() => {
    (window as any).__testApi.notesMessages.length = 0; (window as any).__testApi.messages.length = 0;
});
const ofType = async (page: Page, t: string) => (await msgs(page)).filter((m) => m.type === t);

/** ツリーの行を選んで（本番の click）ツリーにフォーカスを置く */
async function focusTreeRow(page: Page, id: string, meta = false): Promise<void> {
    await page.evaluate(({ i, m }) => {
        const el = document.querySelector(`.file-panel-item[data-item-id="${i}"]`) as HTMLElement;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: m, ctrlKey: m }));
        (document.getElementById('notesFileList') as HTMLElement).focus();
    }, { i: id, m: meta });
}
/** キーボード（↓）でツリーのフォーカスを id の行へ動かす（click と違い開かない = main pane の linkedfd view は出たまま） */
async function navTreeTo(page: Page, id: string): Promise<void> {
    for (let i = 0; i < 24; i++) {
        await page.evaluate(() => (document.getElementById('notesFileList') as HTMLElement).focus());
        await page.keyboard.press(i < 12 ? 'ArrowDown' : 'ArrowUp');
        if (await page.locator(`.file-panel-item.file-panel-selected[data-item-id="${id}"]`).count() > 0) { return; }
    }
    throw new Error('tree nav: ' + id + ' に届かない');
}
/** 本物の Chromium と同じく、選択の無い paste は document.body に配られる */
async function pasteToBody(page: Page, data: Record<string, string>): Promise<boolean> {
    return page.evaluate((d) => {
        const dt = new DataTransfer();
        for (const k of Object.keys(d)) { dt.setData(k, d[k]); }
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        document.body.dispatchEvent(ev);
        return ev.defaultPrevented;
    }, data);
}
/** OS clipboard の text/plain・text/html を読む */
async function readClipboard(page: Page): Promise<Record<string, string>> {
    return page.evaluate(async () => {
        const out: Record<string, string> = {};
        const items = await navigator.clipboard.read();
        for (const it of items) {
            for (const t of ['text/plain', 'text/html']) {
                if (it.types.includes(t)) { out[t] = await (await it.getType(t)).text(); }
            }
        }
        return out;
    });
}
const clipMeta = (html: string, attr: string) => {
    const m = (html || '').match(new RegExp(attr + '="([^"]*)"'));
    return m ? JSON.parse(decodeURIComponent(m[1])) : null;
};
/** 共有ヘルパ（本番の送り手と同じ）で clip の html を作る */
const buildClip = (page: Page, attr: string, meta: any, lines: string[]) =>
    page.evaluate(({ a, m, l }) => (window as any).__batchPayload.buildHtmlClip(a, m, l), { a: attr, m: meta, l: lines });

const TREE_CLIP = { v: 1, items: [{ kind: 'md', id: 'm1', filePath: '/n/m1.md', seq: 0 }, { kind: 'file', id: 'f1', filePath: null, seq: 1 }], isCut: false, copyId: 'c1' };

async function loadMainMd(page: Page, md = MD, filePath = '/n/cur.md'): Promise<void> {
    await page.evaluate(({ md, filePath }) => {
        const w = window as any;
        w.__hostMessageHandler({ type: 'updateData', kind: 'md', markdown: md, filePath, documentBaseUri: '' });
        w.__hostMessageHandler({ type: 'mainMdAssetContext', imageDir: '/n/images', fileDir: '/n/files', mdDir: '/n' });
    }, { md, filePath });
    await page.waitForSelector(`${MAIN} a[data-is-file-attachment="true"]`, { timeout: 5000 });
}
async function openSidePanel(page: Page, md = '# SP\n\nbody\n', filePath = '/n/sp.md'): Promise<void> {
    await page.evaluate(({ md, filePath }) => {
        (window as any).__hostMessageHandler({ type: 'openSidePanel', markdown: md, filePath, fileName: 'sp.md', toc: [], documentBaseUri: '' });
    }, { md, filePath });
    await page.waitForSelector(SIDE, { timeout: 5000 });
}
/** md editor の中の全リンクを範囲選択して、本物の copy / cut を起こし、積まれた clipboard を返す */
async function mdCopyAllLinks(page: Page, sel: string, kind: 'copy' | 'cut'): Promise<Record<string, string>> {
    return page.evaluate(({ s, k }) => {
        const ed = document.querySelector(s) as HTMLElement;
        const anchors = Array.from(ed.querySelectorAll('a[data-subpage="true"], a[data-is-file-attachment="true"]')) as HTMLElement[];
        const r = document.createRange();
        r.setStart(anchors[0].firstChild!, 0);
        const last = anchors[anchors.length - 1];
        r.setEnd(last.firstChild!, (last.firstChild!.textContent || '').length);
        const selObj = window.getSelection()!; selObj.removeAllRanges(); selObj.addRange(r);
        const dt = new DataTransfer();
        ed.dispatchEvent(new ClipboardEvent(k, { clipboardData: dt, bubbles: true, cancelable: true }));
        const out: Record<string, string> = {};
        for (const t of Array.from(dt.types)) { out[t] = dt.getData(t); }
        return out;
    }, { s: sel, k: kind });
}
async function showFv(page: Page, linkId = 'fl1'): Promise<void> {
    await page.evaluate((id) => {
        (window as any).__folderViewDispatcher.showFolderView(id, 'Docs');
        window.postMessage({ type: 'folderViewListResult', folderLinkId: id, relPath: '', entries: [
            { name: 'dirX', relPath: 'dirX', isDir: true }, { name: 'a.md', relPath: 'a.md', isDir: false },
            { name: 'b.pdf', relPath: 'b.pdf', isDir: false }] }, '*');
    }, linkId);
    await page.waitForSelector('.fv-row[data-rel="dirX"]', { timeout: 5000 });
}

test.describe('W10 ツリーの cmd+c / cmd+x（送り手）', () => {
    test('TC-CBW-01 選択順の items（md / file / out / folder link）と isCut が clipboard に載る。選択 0 件は何もしない', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
        await page.evaluate(() => (document.getElementById('notesFileList') as HTMLElement).focus());
        await page.keyboard.press(`${MOD}+c`);
        await page.waitForTimeout(150);
        expect((await readClipboard(page))['text/plain'], '選択 0 件なのに clipboard を上書きした').toBe('SENTINEL');

        // 逆順に選んでも描画順で載る
        await focusTreeRow(page, 'fl1');
        await focusTreeRow(page, 'f1', true);
        await focusTreeRow(page, 'm1', true);
        await focusTreeRow(page, 'o1', true);
        await page.keyboard.press(`${MOD}+c`);
        await page.waitForTimeout(250);
        let clip = await readClipboard(page);
        let meta = clipMeta(clip['text/html'], 'data-fractal-tree-clip');
        expect(meta, 'ツリーの cmd+c で data-fractal-tree-clip が載らない').not.toBeNull();
        expect(meta.items.map((it: any) => [it.kind, it.id])).toEqual([['out', 'o1'], ['md', 'm1'], ['file', 'f1'], ['folder', 'fl1']]);
        expect(meta.items[1].filePath).toBe('/n/m1.md');
        expect(meta.isCut).toBe(false);
        expect(clip['text/plain'], 'text/plain にパスが無い（外部アプリへの degrade）').toContain('/n/m1.md');

        await page.keyboard.press(`${MOD}+x`);
        await page.waitForTimeout(250);
        clip = await readClipboard(page);
        meta = clipMeta(clip['text/html'], 'data-fractal-tree-clip');
        expect(meta.isCut, 'cmd+x が cut にならない').toBe(true);
        expect(await page.locator('.file-panel-item[data-item-id="m1"]').count(), 'cut の時点で項目を消した（消すのは貼った先の host）').toBe(1);
    });
});

test.describe('W11 ツリーの cmd+v（受け手）', () => {
    test('TC-CBW-02 ツリーの clip: 行の後ろ / 仮想フォルダの中 / linkedfd 行 = その linkedfd / 元の行の上 = その後ろ', async ({ page }) => {
        await boot(page);
        const html = await buildClip(page, 'data-fractal-tree-clip', TREE_CLIP, ['/n/m1.md', 'a.pdf']);
        const items = TREE_CLIP.items;
        // 行の後ろ（m2 は root の 2 番目 → index 3）
        await focusTreeRow(page, 'm2'); await clear(page);
        expect(await pasteToBody(page, { 'text/html': html, 'text/plain': 'x' })).toBe(true);
        let p = await ofType(page, 'pasteTreeClip');
        expect(p.length, `msgs: ${(await msgs(page)).map((m) => m.type).join(',')}`).toBe(1);
        expect(p[0].clip).toEqual({ items, isCut: false });
        expect(p[0].target).toEqual({ kind: 'tree', parentId: null, index: 3 });
        // 元の行（m1）の上で貼る = その後ろ（その場複製）
        await focusTreeRow(page, 'm1'); await clear(page);
        await pasteToBody(page, { 'text/html': html, 'text/plain': 'x' });
        expect((await ofType(page, 'pasteTreeClip'))[0].target).toEqual({ kind: 'tree', parentId: null, index: 2 });
        // linkedfd の行 = その linkedfd の root へ（常に複製の host 入口）
        await focusTreeRow(page, 'fl1'); await clear(page);
        await pasteToBody(page, { 'text/html': html, 'text/plain': 'x' });
        const fv = await ofType(page, 'folderViewMoveInBatch');
        expect(fv.length).toBe(1);
        expect(fv[0]).toMatchObject({ id: 'fl1', dstDirRelPath: '', items: [{ srcKind: 'md', srcItemId: 'm1' }, { srcKind: 'file', srcItemId: 'f1' }] });
        expect(await ofType(page, 'pasteTreeClip')).toEqual([]);
        // 子の行（dirA の中の m3）= その親の中、m3 の後ろ
        await focusTreeRow(page, 'm3'); await clear(page);
        await pasteToBody(page, { 'text/html': html, 'text/plain': 'x' });
        expect((await ofType(page, 'pasteTreeClip'))[0].target).toEqual({ kind: 'tree', parentId: 'dirA', index: 1 });
        // 仮想フォルダの見出し（↑ で dirA の見出しへ）= そのフォルダの末尾
        await page.keyboard.press('ArrowUp');
        await clear(page);
        await pasteToBody(page, { 'text/html': html, 'text/plain': 'x', 'text/x-cut': '1' });
        expect((await ofType(page, 'pasteTreeClip'))[0].target).toEqual({ kind: 'tree', parentId: 'dirA', index: 1 });
        // ツリーにフォーカスが無ければ何もしない
        await page.evaluate(() => (document.activeElement as HTMLElement).blur());
        await clear(page);
        expect(await pasteToBody(page, { 'text/html': html, 'text/plain': 'x' }), 'ツリー外の paste を奪った').toBe(false);
        expect(await ofType(page, 'pasteTreeClip')).toEqual([]);
    });

    test('TC-CBW-03 md の範囲選択の copy / cut → ツリー = pasteMdClip（リンク全部・cut の印）。linkedfd 行 = kind fv', async ({ page }) => {
        await boot(page, '/n/cur.md');
        await loadMainMd(page);
        const copied = await mdCopyAllLinks(page, MAIN, 'copy');
        expect(copied['text/x-any-md-context'], '前提: md の copy に asset context が載らない').toBeTruthy();
        await focusTreeRow(page, 'm2'); await clear(page);
        expect(await pasteToBody(page, copied)).toBe(true);
        let p = await ofType(page, 'pasteMdClip');
        expect(p.length).toBe(1);
        for (const href of ['alpha.md', 'files/x.pdf', 'beta.md']) { expect(p[0].mdText, `選択の中の ${href} が運ばれない`).toContain(href); }
        expect(p[0].sourceContext).toEqual({ imageDir: '/n/images', fileDir: '/n/files', mdDir: '/n' });
        expect(p[0].isCut).toBe(false);
        expect(p[0].target).toEqual({ kind: 'tree', parentId: null, index: 3 });
        // cut → isCut / linkedfd 行 → kind fv
        const cut = await mdCopyAllLinks(page, MAIN, 'cut');
        await focusTreeRow(page, 'fl2'); await clear(page);
        await pasteToBody(page, cut);
        p = await ofType(page, 'pasteMdClip');
        expect(p[0].isCut, 'md の cut が cut として届かない').toBe(true);
        expect(p[0].target).toEqual({ kind: 'fv', folderLinkId: 'fl2', dstDirRelPath: '' });
    });

    test('TC-CBW-04 outliner の cmd+c / cmd+x → ツリー = pasteOutlinerClipToTree。linkedfd 行 = 書き出し（cut の印つき）', async ({ page }) => {
        await boot(page);
        // notes と同じく .out の絶対パス（outFileKey）付きで開く（linkedfd への書き出しが .out を特定するのに使う）
        await page.evaluate((t) => { (window as any).Outliner.init(t, '/n/o1.out'); }, OUT_TREE);
        await page.waitForSelector('.outliner-node[data-id="na"]');
        const t = (id: string) => page.locator(`.outliner-node[data-id="${id}"] .outliner-text`);
        await t('na').click();
        await t('na').click({ modifiers: [MOD as any] });
        await t('nb').click({ modifiers: [MOD as any] });
        await page.keyboard.press(`${MOD}+c`);
        await page.waitForTimeout(250);
        let clip = await readClipboard(page);
        await navTreeTo(page, 'm1'); await clear(page);
        expect(await pasteToBody(page, clip)).toBe(true);
        const p = await ofType(page, 'pasteOutlinerClipToTree');
        expect(p.length, `msgs: ${(await msgs(page)).map((m) => m.type).join(',')} / ${JSON.stringify(clip).slice(0, 300)}`).toBe(1);
        expect(p[0]).toMatchObject({ plainText: clip['text/plain'], isCut: false, parentId: null, index: 2 });
        // linkedfd 行 = 既存の「linkedfd に送る」入口（nodeIds つき）
        await navTreeTo(page, 'fl1'); await clear(page);
        await pasteToBody(page, clip);
        let g = await ofType(page, 'sendOutNodesToFolderLinkFromDrop');
        expect(g.length).toBe(1);
        expect(g[0].payload.nodeIds).toEqual(['na', 'nb']);
        expect(g[0].folderLinkId).toBe('fl1');
        expect(g[0].payload.clip, 'copy なのに cut の印を付けた').toBeUndefined();
        // cut → 印つき
        await t('na').click();
        await t('na').click({ modifiers: [MOD as any] });
        await t('nb').click({ modifiers: [MOD as any] });
        await page.keyboard.press(`${MOD}+x`);
        await page.waitForTimeout(250);
        clip = await readClipboard(page);
        await navTreeTo(page, 'fl1'); await clear(page);
        await pasteToBody(page, clip);
        g = await ofType(page, 'sendOutNodesToFolderLinkFromDrop');
        expect(g[0].payload.clip, 'cut の印が無い（host が .out から消えた node を書き出せない）').toEqual({ isCut: true, plainText: clip['text/plain'] });
        expect(g[0].payload.nodeIds, 'cut に nodeIds が無い').toEqual(['na', 'nb']);
        await navTreeTo(page, 'm1'); await clear(page);
        await pasteToBody(page, clip);
        expect((await ofType(page, 'pasteOutlinerClipToTree'))[0].isCut).toBe(true);
    });

    test('TC-CBW-05 linkedfd の cmd+c → ツリー: 行の後ろ = note へ / 別の linkedfd 行 = folderViewCopyAcrossLinks / 同じ行 = 中で複製', async ({ page }) => {
        await boot(page);
        const meta = { v: 1, folderLinkId: 'fl1', relPaths: ['a.md', 'b.pdf'], copyId: 'k' };
        const html = await buildClip(page, 'data-fractal-fv-clip', meta, meta.relPaths);
        await focusTreeRow(page, 'm2'); await clear(page);
        await pasteToBody(page, { 'text/html': html, 'text/plain': 'a.md\nb.pdf' });
        const t = await ofType(page, 'folderViewMoveToTreeBatch');
        expect(t.length).toBe(1);
        expect(t[0]).toMatchObject({ id: 'fl1', parentId: null, index: 3, items: [{ folderLinkId: 'fl1', relPath: 'a.md' }, { folderLinkId: 'fl1', relPath: 'b.pdf' }] });
        await focusTreeRow(page, 'fl2'); await clear(page);
        await pasteToBody(page, { 'text/html': html, 'text/plain': 'a.md\nb.pdf' });
        const x = await ofType(page, 'folderViewCopyAcrossLinks');
        expect(x).toEqual([{ type: 'folderViewCopyAcrossLinks', srcLinkId: 'fl1', relPaths: ['a.md', 'b.pdf'], dstLinkId: 'fl2', dstDirRelPath: '' }]);
        await focusTreeRow(page, 'fl1'); await clear(page);
        await pasteToBody(page, { 'text/html': html, 'text/plain': 'a.md\nb.pdf' });
        const c = await ofType(page, 'folderViewMoveBatch');
        expect(c.length).toBe(1);
        expect(c[0]).toMatchObject({ id: 'fl1', srcRelPaths: ['a.md', 'b.pdf'], dstDirRelPath: '', mode: 'copy' });
    });

    test('TC-CBW-06 ツリーにフォーカスがある paste は linkedfd view が横取りしない', async ({ page }) => {
        await boot(page);
        await showFv(page);
        const meta = { v: 1, folderLinkId: 'fl1', relPaths: ['a.md', 'b.pdf'], copyId: 'k' };
        const html = await buildClip(page, 'data-fractal-fv-clip', meta, meta.relPaths);
        await navTreeTo(page, 'm2'); await clear(page);
        expect(await page.locator('.fv-row[data-rel="b.pdf"]').isVisible(), '前提: linkedfd view が出たまま').toBe(true);
        await pasteToBody(page, { 'text/html': html, 'text/plain': 'a.md' });
        const all = await msgs(page);
        expect(all.filter((m) => m.type === 'folderViewMove' || m.type === 'folderViewMoveBatch'),
            'ツリーで押した cmd+v を linkedfd view が自分の中へ複製した（誤配送）').toEqual([]);
        expect(all.filter((m) => /folderViewMoveToTree/.test(m.type)).length, 'ツリーが受けていない').toBe(1);
        // フォーカスを linkedfd view へ移すと linkedfd が受ける（従来の H）
        await page.locator('.fv-row[data-rel="b.pdf"]').click();
        await clear(page);
        await pasteToBody(page, { 'text/html': html, 'text/plain': 'a.md' });
        const after = await msgs(page);
        expect(after.filter((m) => m.type === 'folderViewMoveBatch' && m.mode === 'copy').length, 'linkedfd にフォーカスを戻しても H が動かない').toBe(1);
        expect(after.filter((m) => /folderViewMoveToTree/.test(m.type)), 'linkedfd にフォーカスがあるのにツリーが受けた').toEqual([]);
    });
});

test.describe('W11 / W12 linkedfd view の cmd+v（受け手）', () => {
    test('TC-CBW-07 ツリーの clip = folderViewMoveInBatch / md の clip = pasteMdClip / 別の linkedfd の clip = folderViewCopyAcrossLinks', async ({ page }) => {
        await boot(page, '/n/cur.md');
        await loadMainMd(page);
        const copied = await mdCopyAllLinks(page, MAIN, 'copy');
        await showFv(page);
        await page.locator('.fv-row[data-rel="dirX"]').click();   // フォルダ行 = その中
        const treeHtml = await buildClip(page, 'data-fractal-tree-clip', TREE_CLIP, ['/n/m1.md', 'a.pdf']);
        await clear(page);
        expect(await pasteToBody(page, { 'text/html': treeHtml, 'text/plain': 'x' })).toBe(true);
        const b = await ofType(page, 'folderViewMoveInBatch');
        expect(b.length).toBe(1);
        expect(b[0]).toMatchObject({ id: 'fl1', dstDirRelPath: 'dirX', items: [{ srcKind: 'md', srcItemId: 'm1' }, { srcKind: 'file', srcItemId: 'f1' }] });
        await page.locator('.fv-row[data-rel="dirX"]').click();
        await clear(page);
        expect(await pasteToBody(page, copied), 'md の clip を受けない（旧実装は無音で無視）').toBe(true);
        const p = await ofType(page, 'pasteMdClip');
        expect(p.length).toBe(1);
        expect(p[0].target).toEqual({ kind: 'fv', folderLinkId: 'fl1', dstDirRelPath: 'dirX' });
        for (const href of ['alpha.md', 'files/x.pdf', 'beta.md']) { expect(p[0].mdText).toContain(href); }
        const other = { v: 1, folderLinkId: 'fl2', relPaths: ['q.txt', 'sub'], copyId: 'z' };
        const otherHtml = await buildClip(page, 'data-fractal-fv-clip', other, other.relPaths);
        await page.locator('.fv-row[data-rel="dirX"]').click();
        await clear(page);
        expect(await pasteToBody(page, { 'text/html': otherHtml, 'text/plain': 'q.txt' }), '別の linkedfd の clip を無音で無視した').toBe(true);
        expect(await ofType(page, 'folderViewCopyAcrossLinks')).toEqual([
            { type: 'folderViewCopyAcrossLinks', srcLinkId: 'fl2', relPaths: ['q.txt', 'sub'], dstLinkId: 'fl1', dstDirRelPath: 'dirX' }]);
    });
});

test.describe('W11 md editor / outliner の cmd+v（受け手）', () => {
    async function pasteInto(page: Page, sel: string, data: Record<string, string>): Promise<void> {
        await page.evaluate(({ s, d }) => {
            const ed = document.querySelector(s) as HTMLElement;
            const p = Array.from(ed.querySelectorAll('p')).pop() as HTMLElement;
            const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
            const so = window.getSelection()!; so.removeAllRanges(); so.addRange(r);
            const dt = new DataTransfer();
            for (const k of Object.keys(d)) { dt.setData(k, d[k]); }
            ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        }, { s: sel, d: data });
        await page.waitForTimeout(60);
    }
    test('TC-CBW-08 note md / sidepanel md: linkedfd の clip = folderViewMoveIntoMdBatch(mode copy) / ツリーの clip = pasteTreeClip', async ({ page }) => {
        await boot(page, '/n/cur.md');
        await loadMainMd(page);
        await openSidePanel(page);
        const fvMeta = { v: 1, folderLinkId: 'fl1', relPaths: ['a.md', 'b.pdf'], copyId: 'k' };
        const fvHtml = await buildClip(page, 'data-fractal-fv-clip', fvMeta, fvMeta.relPaths);
        const treeHtml = await buildClip(page, 'data-fractal-tree-clip', Object.assign({}, TREE_CLIP, { isCut: true }), ['/n/m1.md', 'a.pdf']);
        for (const [sel, mdPath, sp] of [[MAIN, '/n/cur.md', null], [SIDE, '/n/sp.md', '/n/sp.md']] as const) {
            await clear(page);
            await pasteInto(page, sel, { 'text/html': fvHtml, 'text/plain': 'a.md\nb.pdf' });
            const f = await ofType(page, 'folderViewMoveIntoMdBatch');
            expect(f, `${sel}: linkedfd の clip を受けない（旧実装は相対パスの文字が入るだけ）`).toEqual([
                { type: 'folderViewMoveIntoMdBatch', id: 'fl1', relPaths: ['a.md', 'b.pdf'], targetMdPath: mdPath, mode: 'copy' }]);
            const txt = await page.locator(sel).first().innerText();
            expect(txt, '相対パスの文字まで入った').not.toContain('b.pdf');
            await clear(page);
            await pasteInto(page, sel, { 'text/html': treeHtml, 'text/plain': '/n/m1.md\na.pdf' });
            const t = await ofType(page, 'pasteTreeClip');
            expect(t.length, `${sel}: ツリーの clip を受けない`).toBe(1);
            expect(t[0].clip).toEqual({ items: TREE_CLIP.items, isCut: true });
            expect(t[0].target).toEqual({ kind: 'md', sidePanelFilePath: sp });
        }
    });

    test('TC-CBW-09 outliner: ツリーの clip = pasteTreeClip（対象 node の直後）', async ({ page }) => {
        await boot(page);
        await page.evaluate((t) => { (window as any).__testApi.initOutliner(t); }, OUT_TREE);
        await page.waitForSelector('.outliner-node[data-id="nb"]');
        const html = await buildClip(page, 'data-fractal-tree-clip', TREE_CLIP, ['/n/m1.md', 'a.pdf']);
        await page.locator('.outliner-node[data-id="nb"] .outliner-text').click();
        await clear(page);
        const prevented = await page.evaluate((h) => {
            const el = document.querySelector('.outliner-node[data-id="nb"] .outliner-text') as HTMLElement;
            const dt = new DataTransfer(); dt.setData('text/html', h); dt.setData('text/plain', '/n/m1.md\na.pdf');
            const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
            el.dispatchEvent(ev);
            return ev.defaultPrevented;
        }, html);
        expect(prevented).toBe(true);
        const t = await ofType(page, 'pasteTreeClip');
        expect(t.length).toBe(1);
        expect(t[0].target).toEqual({ kind: 'outliner', outFileId: 'o1', targetNodeId: 'nb', position: 'after' });
        expect(await page.locator('.outliner-node').count(), 'パスの文字が node として入った').toBe(3);
    });
});

test.describe('W9 outliner の cut', () => {
    async function bootOutliner(page: Page): Promise<void> {
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => { /* noop */ });
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate((t) => { (window as any).__testApi.initOutliner(t); }, OUT_TREE);
        await page.waitForSelector('.outliner-node[data-id="nb"]');
    }
    const meta = async (page: Page) => clipMeta((await readClipboard(page))['text/html'], 'data-outliner-clipboard');

    test('TC-CBW-10 単一 copy / 単一 cut / 複数 cut にも nodeIds。単一 cut は添付ファイルも外す', async ({ page }) => {
        await bootOutliner(page);
        const t = (id: string) => page.locator(`.outliner-node[data-id="${id}"] .outliner-text`);
        await t('nc').click();
        await page.keyboard.press(`${MOD}+c`);
        await page.waitForTimeout(250);
        expect((await meta(page)).nodeIds, 'カーソルだけの copy に nodeIds が無い（linkedfd の cmd+v が何もしない）').toEqual(['nc']);
        await t('nb').click();
        await page.keyboard.press(`${MOD}+x`);
        await page.waitForTimeout(250);
        const m = await meta(page);
        expect(m.isCut).toBe(true);
        expect(m.nodeIds, '単一 cut に nodeIds が無い').toEqual(['nb']);
        expect(m.nodes[0].filePath, 'cut の clipboard に添付が載らない').toBe('files/b.pdf');
        const fp = await page.evaluate(() => (window as any).Outliner.getModel().getNode('nb').filePath);
        expect(fp, '単一 cut で添付ファイルが元 node に残った（実質複製）').toBeFalsy();
        expect(await page.locator('.outliner-node[data-id="nb"] .outliner-file-icon, .outliner-node[data-id="nb"] [class*="file-icon"]').count(),
            '元 node に 📎 アイコンが残った').toBe(0);
        // 複数 cut = 選択の根
        await t('na').click();
        await t('na').click({ modifiers: [MOD as any] });
        await t('nc').click({ modifiers: [MOD as any] });
        await page.keyboard.press(`${MOD}+x`);
        await page.waitForTimeout(250);
        expect((await meta(page)).nodeIds, '複数 cut に nodeIds が無い').toEqual(['na', 'nc']);
    });

    test('TC-CBW-11 outliner の cut を md へ貼る → pasteOutlinerNodesWithAssets に isCut（copy は false）', async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForSelector('#editor');
        const nodes = [{ text: 'paged', level: 0, isPage: true, pageId: 'p1', images: [], filePath: null }];
        for (const isCut of [true, false]) {
            const html = '<ul data-outliner-clipboard="' + encodeURIComponent(JSON.stringify({ nodes, isCut, copyId: 'q', nodeIds: ['x'] })) + '"><li>paged</li></ul>';
            await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
            await page.click('#editor');
            await page.evaluate((h) => {
                const dt = new DataTransfer(); dt.setData('text/html', h); dt.setData('text/plain', 'paged');
                (document.activeElement as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            }, html);
            await page.waitForTimeout(150);
            const hit = (await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages))))
                .filter((x: any) => x.type === 'pasteOutlinerNodesWithAssets');
            expect(hit.length).toBe(1);
            expect(hit[0].isCut, `cut=${isCut} が host に届かない（cut が常に複製になる）`).toBe(isCut);
        }
    });

    test('TC-CBW-12 outliner の cut を linkedfd へ貼る → cut の印（Store と突き合わせる text）を host へ', async ({ page }) => {
        await boot(page);
        await showFv(page);
        await page.locator('.fv-row[data-rel="dirX"]').click();
        const nodes = [{ text: 'bravo', level: 0, isPage: false, pageId: null, images: [], filePath: 'files/b.pdf' }];
        for (const isCut of [true, false]) {
            const html = '<ul data-outliner-clipboard="' + encodeURIComponent(JSON.stringify({ nodes, sourceOutFileKey: '/n/o1.out', isCut, copyId: 'q', nodeIds: ['nb'] })) + '"><li>bravo</li></ul>';
            await clear(page);
            await pasteToBody(page, { 'text/html': html, 'text/plain': 'bravo' });
            const g = await ofType(page, 'sendOutNodesToFolderLinkFromDrop');
            expect(g.length, 'cut の clipboard を linkedfd が受けない').toBe(1);
            expect(g[0].payload.nodeId).toBe('nb');
            if (isCut) { expect(g[0].payload.clip).toEqual({ isCut: true, plainText: 'bravo' }); }
            else { expect(g[0].payload.clip).toBeUndefined(); }
        }
    });
});

test.describe('W12 linkedfd → 別の linkedfd（D&D）', () => {
    test('TC-CBW-13 ツリーの別の linkedfd 行の中央帯 = folderViewCopyAcrossLinks / 自分の行 = 中で移動 / 上下帯 = 従来の兄弟登録', async ({ page }) => {
        await boot(page);
        await showFv(page);
        await page.locator('.fv-row[data-rel="a.md"]').click();
        await page.locator('.fv-row[data-rel="b.pdf"]').click({ modifiers: [MOD as any] });
        const drop = (rowId: string, ratio: number) => page.evaluate(({ id, r }) => {
            const w = window as any;
            w.__testApi.notesMessages.length = 0;
            const src = document.querySelector('.fv-row[data-rel="a.md"]') as HTMLElement;
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            const dst = document.querySelector(`.file-panel-item[data-item-id="${id}"]`) as HTMLElement;
            const rr = dst.getBoundingClientRect();
            const x = rr.left + rr.width / 2; const y = rr.top + rr.height * r;
            const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y });
            dst.dispatchEvent(over);
            const hl = dst.classList.contains('file-panel-drag-over-md-into-out');
            dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return { hl, accepted: over.defaultPrevented, msgs: JSON.parse(JSON.stringify(w.__testApi.notesMessages)) };
        }, { id: rowId, r: ratio });
        let r = await drop('fl2', 0.5);
        expect(r.accepted).toBe(true);
        expect(r.hl, '中央帯に「中へ」の表示が出ない').toBe(true);
        expect(r.msgs.filter((m: any) => m.type === 'folderViewCopyAcrossLinks')).toEqual([
            { type: 'folderViewCopyAcrossLinks', srcLinkId: 'fl1', relPaths: ['a.md', 'b.pdf'], dstLinkId: 'fl2', dstDirRelPath: '' }]);
        expect(r.msgs.filter((m: any) => /folderViewMoveToTree/.test(m.type)), '旧挙動（note ツリーの兄弟として複製）が残った').toEqual([]);
        r = await drop('fl1', 0.5);
        const mv = r.msgs.filter((m: any) => m.type === 'folderViewMoveBatch');
        expect(mv.length).toBe(1);
        expect(mv[0]).toMatchObject({ id: 'fl1', srcRelPaths: ['a.md', 'b.pdf'], dstDirRelPath: '' });
        expect(mv[0].mode === undefined || mv[0].mode === 'move').toBe(true);
        r = await drop('fl2', 0.1);
        expect(r.msgs.filter((m: any) => m.type === 'folderViewCopyAcrossLinks'), '上の帯まで中へ入れた').toEqual([]);
        expect(r.msgs.filter((m: any) => /folderViewMoveToTree/.test(m.type)).length, '上下帯の兄弟登録が壊れた').toBe(1);
    });
});
