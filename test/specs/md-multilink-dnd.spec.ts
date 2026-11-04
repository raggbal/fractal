/**
 * W1 / W2 / W4（multi-file-dnd-clipboard-matrix）: md の範囲選択に入った複数の 📎 / subpage リンクのドラッグ。
 *
 * 選択の中のどのリンクを掴んでも、選択中のリンクを**全部**運ぶ（間の文字は運ばず元に残る）。
 * 掴んだリンクが選択の外なら従来どおり 1 件。行き先には選択順に 1 件ずつ並ぶ。
 * 送り手 = 本番の dragstart（editor.js）。受け手は全部、本物の DOM drop で叩く。
 *
 * TC-MML-01  dragstart: 範囲選択の中のリンクを掴む → 種類ごとの MIME に {v:1, sourceMdPath, items:[{href,title?,seq}]}
 * TC-MML-01c dragstart の target がリンクの中の Text（選択範囲ごとのドラッグ）でも同じ
 * TC-MML-02  dragstart: 選択の外のリンク / 選択が無い → 従来の単一 payload（items なし）
 * TC-MML-03  同じ md の中で落とす → 選択中のリンク全部が drop 位置へ 1 行 1 リンク・選択順に動く（文字は残る）
 * TC-MML-04  main md → sidepanel md / sidepanel md → main md = attachMdLinksToMdBatch 1 回（選択順）
 * TC-MML-05  → ツリーの余白 / folder 行の中央帯 / 行の前後 = notesRegisterFromMdLinksBatch 1 回
 * TC-MML-06  → ツリーの md 行 / .out 行 / linkedfd 行 = linkMdLinksIntoMdItemBatch / importMdLinksIntoOutItemBatch / folderViewMoveFromMdBatch
 * TC-MML-07  sidepanel md → note outliner = importMdLinksIntoOutBatch 1 回（drop 位置つき）
 * TC-MML-08  sidepanel md → linkedfd view = folderViewMoveFromMdBatch 1 回
 */
import { test, expect, Page } from '@playwright/test';

const MDSUB = 'application/x-fractal-md-subpage';
const MDFILE = 'application/x-fractal-md-filelink';

const FILES = [
    { filePath: '/n/o1.out', title: 'out1', id: 'o1', kind: 'out' },
    { filePath: '/n/o2.out', title: 'out2', id: 'o2', kind: 'out' },
    { filePath: '/n/m2.md', title: 'md2', id: 'm2', kind: 'md' },
    { filePath: '', title: 'Docs', id: 'fl1', kind: 'folder', broken: false },
];
const STRUCTURE = {
    version: 1, rootIds: ['o1', 'o2', 'm2', 'fl1', 'dirA'],
    items: {
        o1: { type: 'file', id: 'o1', title: 'out1', ext: 'out', filePath: '/n/o1.out' },
        o2: { type: 'file', id: 'o2', title: 'out2', ext: 'out', filePath: '/n/o2.out' },
        m2: { type: 'file', id: 'm2', title: 'md2', ext: 'md', filePath: '/n/m2.md' },
        fl1: { type: 'file', id: 'fl1', title: 'Docs', ext: 'folder' },
        dirA: { type: 'folder', id: 'dirA', title: 'FolderA', childIds: [], collapsed: true },
    },
};
// 1 段落に subpage / 📎 / subpage と文字が混ざる（間の文字は運ばない）
const MD = '# Cur\n\n[[Alpha]](alpha.md) and [📎 x.pdf](files/x.pdf) then [[Beta]](beta.md) end\n\nTail para\n';
const SEL_ORDER = [
    { kind: 'subpage', href: 'alpha.md', title: 'Alpha' },
    { kind: 'file', href: 'files/x.pdf' },
    { kind: 'subpage', href: 'beta.md', title: 'Beta' },
];
const MAIN = '.markdown-container .editor';
const SIDE = '.side-panel .editor, .side-panel-iframe-container .editor';

async function boot(page: Page, currentFile = '/n/o1.out'): Promise<void> {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ files, structure, cur }) => { (window as any).__testApi.initNotesPanel(files, cur, structure); },
        { files: FILES, structure: STRUCTURE, cur: currentFile });
    await page.waitForSelector('.file-panel-item[data-item-id="fl1"]', { timeout: 5000 });
}
async function loadMainMd(page: Page, md = MD, filePath = '/n/cur.md'): Promise<void> {
    await page.evaluate(({ md, filePath }) => {
        (window as any).__hostMessageHandler({ type: 'updateData', kind: 'md', markdown: md, filePath, documentBaseUri: '' });
    }, { md, filePath });
    await page.waitForSelector(`${MAIN} a[data-is-file-attachment="true"]`, { timeout: 5000 });
}
async function openSidePanel(page: Page, md = MD, filePath = '/n/sp.md'): Promise<void> {
    await page.evaluate(({ md, filePath }) => {
        (window as any).__hostMessageHandler({ type: 'openSidePanel', markdown: md, filePath, fileName: 'sp.md', toc: [], documentBaseUri: '' });
    }, { md, filePath });
    await page.waitForFunction(({ sel, needLinks }) => {
        const ed = document.querySelector(sel);
        return !!(ed && (!needLinks || ed.querySelector('a[data-is-file-attachment="true"]')));
    }, { sel: SIDE, needLinks: md.indexOf('📎') >= 0 }, { timeout: 5000 });
}

/**
 * editorSel の中で、最初のリンクの頭から最後のリンクの尻までを選択（selectFirst..selectLast は anchors の index）し、
 * grabIndex 番目のリンクで本番の dragstart を起こして dstSel の ratio 位置へ dragover / drop する。
 * 戻り値 = DataTransfer の中身と host への message（notesMessages + messages）。
 */
async function dragFromSelection(page: Page, opts: {
    editorSel: string; grabIndex: number; dstSel: string; ratio: number;
    selectFirst?: number; selectLast?: number; noSelection?: boolean; dropX?: 'left' | 'center';
}): Promise<{ data: Record<string, any>; msgs: any[] }> {
    return page.evaluate((o) => {
        const w = window as any;
        w.__testApi.notesMessages.length = 0;
        w.__testApi.messages.length = 0;
        const ed = document.querySelector(o.editorSel) as HTMLElement;
        const anchors = Array.from(ed.querySelectorAll('a[data-subpage="true"], a[data-is-file-attachment="true"]')) as HTMLElement[];
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        if (!o.noSelection) {
            const r = document.createRange();
            r.setStart(anchors[o.selectFirst ?? 0].firstChild!, 0);
            const last = anchors[o.selectLast ?? anchors.length - 1];
            r.setEnd(last.firstChild!, (last.firstChild!.textContent || '').length);
            sel.addRange(r);
        }
        const grab = anchors[o.grabIndex];
        const dt = new DataTransfer();
        grab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const data: Record<string, any> = {};
        for (const t of Array.from(dt.types)) { try { data[t] = JSON.parse(dt.getData(t)); } catch { data[t] = dt.getData(t); } }
        const dst = document.querySelector(o.dstSel) as HTMLElement;
        if (dst) {
            const rr = dst.getBoundingClientRect();
            const x = o.dropX === 'left' ? rr.left + Math.min(20, rr.width / 2) : rr.left + rr.width / 2;
            const y = rr.top + rr.height * o.ratio;
            dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
            dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        }
        grab.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        const msgs = JSON.parse(JSON.stringify(w.__testApi.notesMessages)).concat(JSON.parse(JSON.stringify(w.__testApi.messages)));
        return { data, msgs };
    }, opts);
}
const TAIL = '[data-test-tail]';
/** 「Tail para」の段落に印を付ける（drop 先） */
async function markTail(page: Page): Promise<void> {
    await page.evaluate((sel) => {
        const p = Array.from((document.querySelector(sel) as HTMLElement).querySelectorAll('p')).find((x) => (x.textContent || '').indexOf('Tail') >= 0)!;
        p.setAttribute('data-test-tail', '1');
    }, MAIN);
}
const SINGLE_TYPES = ['attachMdFileLinkToMd', 'linkMdSubpageToMd', 'notesRegisterSubpageFromMd', 'notesRegisterFileFromMdLink',
    'notesImportMdLinkIntoOutItem', 'notesLinkMdLinkIntoMdItem', 'folderViewMoveFromMd', 'importMdFileLinkIntoOut', 'importMdSubpageIntoOut'];
function singles(msgs: any[]): any[] { return msgs.filter((m) => SINGLE_TYPES.indexOf(m.type) >= 0); }

test.describe('W1: md の dragstart が選択中のリンクを全部積む', () => {
    test('TC-MML-01 範囲選択の中の 📎 を掴む → filelink / subpage の両 MIME に items（seq = 選択順）', async ({ page }) => {
        await boot(page);
        await loadMainMd(page);
        const { data } = await dragFromSelection(page, { editorSel: MAIN, grabIndex: 1, dstSel: '#none', ratio: 0.5 });
        expect(data[MDFILE], 'filelink MIME が無い').toBeTruthy();
        expect(data[MDSUB], '選択中の subpage が subpage MIME に載らない').toBeTruthy();
        expect(data[MDFILE]).toMatchObject({ v: 1, sourceMdPath: '/n/cur.md', href: 'files/x.pdf', items: [{ href: 'files/x.pdf', seq: 1 }] });
        expect(data[MDSUB].sourceMdPath).toBe('/n/cur.md');
        expect(data[MDSUB].items).toEqual([{ href: 'alpha.md', title: 'Alpha', seq: 0 }, { href: 'beta.md', title: 'Beta', seq: 2 }]);
        // 受け手の正典で 1 本に戻すと選択順（間の文字 "and" / "then" は入らない）
        const merged = await page.evaluate((d) => (window as any).__batchPayload.mergeMdLinksBySeq(d.f, d.s), { f: data[MDFILE], s: data[MDSUB] });
        expect(merged).toEqual({ sourceMdPath: '/n/cur.md', items: SEL_ORDER });
    });

    test('TC-MML-01b subpage を掴んでも同じ（どのリンクを掴んでも全部）', async ({ page }) => {
        await boot(page);
        await loadMainMd(page);
        const { data } = await dragFromSelection(page, { editorSel: MAIN, grabIndex: 2, dstSel: '#none', ratio: 0.5 });
        expect(data[MDSUB].href, '最上位 href は掴んだリンク（旧い受け手向け）').toBe('beta.md');
        expect(data[MDSUB].items.length).toBe(2);
        expect(data[MDFILE].items.length).toBe(1);
    });

    test('TC-MML-01c 選択範囲ごとのドラッグ（target = リンクの中の Text）でも全部積む', async ({ page }) => {
        await boot(page);
        await loadMainMd(page);
        const data = await page.evaluate((sel) => {
            const ed = document.querySelector(sel) as HTMLElement;
            const anchors = Array.from(ed.querySelectorAll('a[data-subpage="true"], a[data-is-file-attachment="true"]')) as HTMLElement[];
            const r = document.createRange();
            r.setStart(anchors[0].firstChild!, 0);
            r.setEnd(anchors[2].firstChild!, (anchors[2].firstChild!.textContent || '').length);
            const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
            const dt = new DataTransfer();
            anchors[1].firstChild!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            const out: Record<string, any> = {};
            for (const t of Array.from(dt.types)) { out[t] = JSON.parse(dt.getData(t)); }
            return out;
        }, MAIN);
        expect(data[MDFILE] && data[MDFILE].items, 'Text が target だと何も積まれない').toEqual([{ href: 'files/x.pdf', seq: 1 }]);
        expect(data[MDSUB].items.length).toBe(2);
    });

    test('TC-MML-02 選択の外のリンク / 選択なし → 従来の単一 payload', async ({ page }) => {
        await boot(page);
        await loadMainMd(page);
        // 選択 = Alpha..x.pdf、掴む = Beta（選択の外）
        let r = await dragFromSelection(page, { editorSel: MAIN, grabIndex: 2, selectFirst: 0, selectLast: 1, dstSel: '#none', ratio: 0.5 });
        expect(r.data[MDSUB]).toEqual({ href: 'beta.md', sourceMdPath: '/n/cur.md', title: 'Beta' });
        expect(r.data[MDFILE], '選択の外を掴んだのに 📎 が積まれた').toBeUndefined();
        r = await dragFromSelection(page, { editorSel: MAIN, grabIndex: 1, noSelection: true, dstSel: '#none', ratio: 0.5 });
        expect(r.data[MDFILE]).toEqual({ href: 'files/x.pdf', sourceMdPath: '/n/cur.md' });
        expect(r.data[MDSUB]).toBeUndefined();
    });
});

test.describe('W2: 同じ md の中で落とすと選択中のリンクが全部動く', () => {
    test('TC-MML-03 Tail 段落へ落とす → 3 本が 1 行ずつ選択順に並び、間の文字は元の段落に残る', async ({ page }) => {
        await boot(page);
        await loadMainMd(page);
        await markTail(page);
        await dragFromSelection(page, { editorSel: MAIN, grabIndex: 1, dstSel: TAIL, ratio: 0.5, dropX: 'center' });
        const state = await page.evaluate((sel) => {
            const ed = document.querySelector(sel) as HTMLElement;
            const ps = Array.from(ed.querySelectorAll('p')).map((p) => ({
                text: (p.textContent || '').replace(/\s+/g, ' ').trim(),
                links: Array.from(p.querySelectorAll('a')).map((a) => a.getAttribute('href')),
            }));
            return ps;
        }, MAIN);
        const src = state.find((p) => p.text.indexOf('and') >= 0);
        expect(src, `元の段落が無い: ${JSON.stringify(state)}`).toBeTruthy();
        expect(src!.links, '元の段落にリンクが残った（掴んだ 1 件しか動いていない）').toEqual([]);
        expect(src!.text).toContain('then');
        const tailIdx = state.findIndex((p) => p.text === 'Tail para');
        expect(tailIdx).toBeGreaterThanOrEqual(0);
        const moved = state.slice(tailIdx + 1, tailIdx + 4).map((p) => p.links);
        expect(moved, `Tail の後ろに 1 行 1 リンクで選択順: ${JSON.stringify(state)}`).toEqual([['alpha.md'], ['files/x.pdf'], ['beta.md']]);
        // host へは何も送らない（同じ md の中 = DOM の並べ替えだけ）
        const sent = await page.evaluate(() => (window as any).__testApi.notesMessages.map((m: any) => m.type));
        expect(sent.filter((t: string) => /MdLinks|MdFileLink|MdSubpage/.test(t))).toEqual([]);
    });

    test('TC-MML-03b 単一ドラッグは従来どおり caret の位置へ inline で動く', async ({ page }) => {
        await boot(page);
        await loadMainMd(page);
        await markTail(page);
        await dragFromSelection(page, { editorSel: MAIN, grabIndex: 1, noSelection: true, dstSel: TAIL, ratio: 0.5, dropX: 'center' });
        const tail = await page.evaluate((sel) => {
            const ps = Array.from((document.querySelector(sel) as HTMLElement).querySelectorAll('p'));
            const p = ps.find((x) => (x.textContent || '').indexOf('Tail') >= 0)!;
            return Array.from(p.querySelectorAll('a')).map((a) => a.getAttribute('href'));
        }, MAIN);
        expect(tail).toEqual(['files/x.pdf']);
    });
});

test.describe('W4: md editor（他の md）が items[] を読んで batch bridge を 1 回', () => {
    test('TC-MML-04 main md → sidepanel md（sidePanelFilePath 付き）', async ({ page }) => {
        await boot(page);
        await loadMainMd(page);
        await openSidePanel(page, '# SP\n\nbody\n');
        const { msgs } = await dragFromSelection(page, { editorSel: MAIN, grabIndex: 0, dstSel: SIDE, ratio: 0.5 });
        const b = msgs.filter((m) => m.type === 'attachMdLinksToMdBatch');
        expect(b.length, `batch が 1 回でない: ${msgs.map((m) => m.type).join(',')}`).toBe(1);
        expect(b[0].payload).toEqual({ sourceMdPath: '/n/cur.md', items: SEL_ORDER });
        expect(b[0].sidePanelFilePath).toBe('/n/sp.md');
        expect(singles(msgs), '単一 bridge も呼ばれた（二重処理）').toEqual([]);
    });

    test('TC-MML-04b sidepanel md（送り手）→ main md（sidePanelFilePath なし）', async ({ page }) => {
        await boot(page);
        await loadMainMd(page, '# Main\n\n[📎 y.pdf](files/y.pdf)\n\nbody\n');
        await openSidePanel(page);
        const { data, msgs } = await dragFromSelection(page, { editorSel: SIDE, grabIndex: 2, dstSel: MAIN, ratio: 0.8 });
        expect(data[MDSUB].sourceMdPath, 'sidepanel の dragstart が自分の md を sourceMdPath にしていない').toBe('/n/sp.md');
        const b = msgs.filter((m) => m.type === 'attachMdLinksToMdBatch');
        expect(b.length, msgs.map((m) => m.type).join(',')).toBe(1);
        expect(b[0].payload).toEqual({ sourceMdPath: '/n/sp.md', items: SEL_ORDER });
        expect(b[0].sidePanelFilePath).toBeNull();
        expect(singles(msgs)).toEqual([]);
    });
});

test.describe('W4: ツリーの受け手が items[] を読んで batch bridge を 1 回', () => {
    test('TC-MML-05 余白 / folder 行の中央帯 / 行の前後 = notesRegisterFromMdLinksBatch（選択順・挿入位置）', async ({ page }) => {
        await boot(page);
        await loadMainMd(page);
        // folder 行の中央帯 = フォルダの中（W5 と同じ帯）
        let { msgs } = await dragFromSelection(page, { editorSel: MAIN, grabIndex: 1,
            dstSel: '.file-panel-folder[data-item-id="dirA"] > .file-panel-folder-header', ratio: 0.45, dropX: 'left' });
        let b = msgs.filter((m) => m.type === 'notesRegisterFromMdLinksBatch');
        expect(b.length, msgs.map((m) => m.type).join(',')).toBe(1);
        expect(b[0].payload).toEqual({ sourceMdPath: '/n/cur.md', items: SEL_ORDER });
        expect(b[0].parentId).toBe('dirA');
        expect(singles(msgs)).toEqual([]);
        // md 行の上帯 = 兄弟として前に
        ({ msgs } = await dragFromSelection(page, { editorSel: MAIN, grabIndex: 0, dstSel: '[data-item-id="m2"]', ratio: 0.1 }));
        b = msgs.filter((m) => m.type === 'notesRegisterFromMdLinksBatch');
        expect(b.length, msgs.map((m) => m.type).join(',')).toBe(1);
        expect(b[0].parentId).toBeNull();
        expect(b[0].index).toBe(STRUCTURE.rootIds.indexOf('m2'));
        // ツリーの余白
        ({ msgs } = await dragFromSelection(page, { editorSel: MAIN, grabIndex: 2, dstSel: '.file-panel-list', ratio: 0.98 }));
        b = msgs.filter((m) => m.type === 'notesRegisterFromMdLinksBatch');
        expect(b.length, `余白: ${msgs.map((m) => m.type).join(',')}`).toBe(1);
        expect(b[0].payload.items).toEqual(SEL_ORDER);
        expect(singles(msgs)).toEqual([]);
    });

    test('TC-MML-06 md 行 / .out 行の中央帯・linkedfd 行 = それぞれの batch bridge 1 回', async ({ page }) => {
        await boot(page);
        await loadMainMd(page);
        let { msgs } = await dragFromSelection(page, { editorSel: MAIN, grabIndex: 1, dstSel: '[data-item-id="m2"]', ratio: 0.5 });
        let b = msgs.filter((m) => m.type === 'linkMdLinksIntoMdItemBatch');
        expect(b.length, `md 行: ${msgs.map((m) => m.type).join(',')}`).toBe(1);
        expect(b[0]).toMatchObject({ payload: { sourceMdPath: '/n/cur.md', items: SEL_ORDER }, targetMdId: 'm2' });
        expect(singles(msgs)).toEqual([]);
        ({ msgs } = await dragFromSelection(page, { editorSel: MAIN, grabIndex: 1, dstSel: '[data-item-id="o2"]', ratio: 0.5 }));
        b = msgs.filter((m) => m.type === 'importMdLinksIntoOutItemBatch');
        expect(b.length, `.out 行: ${msgs.map((m) => m.type).join(',')}`).toBe(1);
        expect(b[0]).toMatchObject({ payload: { items: SEL_ORDER }, targetOutId: 'o2' });
        expect(singles(msgs)).toEqual([]);
        ({ msgs } = await dragFromSelection(page, { editorSel: MAIN, grabIndex: 1, dstSel: '[data-item-id="fl1"]', ratio: 0.2 }));
        b = msgs.filter((m) => m.type === 'folderViewMoveFromMdBatch');
        expect(b.length, `linkedfd 行: ${msgs.map((m) => m.type).join(',')}`).toBe(1);
        expect(b[0]).toMatchObject({ id: 'fl1', dstDirRelPath: '', payload: { sourceMdPath: '/n/cur.md', items: SEL_ORDER } });
        expect(singles(msgs)).toEqual([]);
    });
});

test.describe('W4: outliner / linkedfd view が items[] を読む', () => {
    test('TC-MML-07 sidepanel md → note outliner の node = importMdLinksIntoOutBatch 1 回（drop 位置つき）', async ({ page }) => {
        await boot(page, '/n/o1.out');
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({ version: 1, rootIds: ['a', 'b'], nodes: {
                a: { id: 'a', parentId: null, text: 'alpha', children: [] }, b: { id: 'b', parentId: null, text: 'bravo', children: [] } } });
        });
        await page.waitForSelector('.outliner-node[data-id="b"]');
        await openSidePanel(page);
        const { msgs } = await dragFromSelection(page, { editorSel: SIDE, grabIndex: 1, dstSel: '.outliner-node[data-id="b"]', ratio: 0.9 });
        const b = msgs.filter((m) => m.type === 'importMdLinksIntoOutBatch');
        expect(b.length, `outliner: ${msgs.map((m) => m.type).join(',')}`).toBe(1);
        expect(b[0].payload).toEqual({ sourceMdPath: '/n/sp.md', items: SEL_ORDER });
        expect(b[0].targetNodeId).toBe('b');
        expect(b[0].outFileId, 'outFileId が無い').toBeTruthy();
        expect(singles(msgs)).toEqual([]);
    });

    test('TC-MML-08 sidepanel md → linkedfd view の dir 行 = folderViewMoveFromMdBatch 1 回', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => {
            const w = window as any;
            w.__folderViewDispatcher.showFolderView('fl1', 'Docs');
            window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries: [
                { name: 'dirA', relPath: 'dirA', isDir: true }, { name: 'f1.txt', relPath: 'f1.txt', isDir: false }] }, '*');
        });
        await page.waitForSelector('.fv-row[data-rel="dirA"]', { timeout: 5000 });
        await openSidePanel(page);
        const { msgs } = await dragFromSelection(page, { editorSel: SIDE, grabIndex: 0, dstSel: '.fv-row[data-rel="dirA"]', ratio: 0.5 });
        const b = msgs.filter((m) => m.type === 'folderViewMoveFromMdBatch');
        expect(b.length, `fv: ${msgs.map((m) => m.type).join(',')}`).toBe(1);
        expect(b[0]).toMatchObject({ id: 'fl1', dstDirRelPath: 'dirA', payload: { sourceMdPath: '/n/sp.md', items: SEL_ORDER } });
        expect(singles(msgs)).toEqual([]);
    });
});

test.describe('W3: host の batch が返す挿入指示を md editor が 1 行 1 リンクで入れる', () => {
    // notes の sidepanel への中継は main pane が outliner でも md でも outliner.js が持つ。両方の main pane で確かめる
    for (const [label, cur] of [['main pane = outliner', '/n/o1.out'], ['main pane = md', '/n/cur.md']] as const) {
    test(`TC-MML-09 insertSubpageLink（asBlock）×2 + insertFileLink → main / sidepanel とも 3 行に分かれる（${label}）`, async ({ page }) => {
        await boot(page, cur);
        await loadMainMd(page, '# Main\n\n[📎 y.pdf](files/y.pdf)\n\nbody\n');
        await openSidePanel(page, '# SP\n\nbody\n');
        for (const [sel, sp] of [[MAIN, null], [SIDE, '/n/sp.md']] as const) {
            const lines = await page.evaluate(({ sel, sp }) => {
                const ed = document.querySelector(sel) as HTMLElement;
                const body = Array.from(ed.querySelectorAll('p')).find((p) => (p.textContent || '').indexOf('body') >= 0)!;
                const r = document.createRange(); r.selectNodeContents(body); r.collapse(false);
                const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
                const h = (window as any).__hostMessageHandler;
                const extra = sp ? { sidePanelFilePath: sp } : {};
                h(Object.assign({ type: 'insertSubpageLink', markdownPath: 'alpha.md', title: 'Alpha', asBlock: true }, extra));
                h(Object.assign({ type: 'insertFileLink', markdownPath: 'files/x.pdf', fileName: 'x.pdf' }, extra));
                h(Object.assign({ type: 'insertSubpageLink', markdownPath: 'beta.md', title: 'Beta', asBlock: true }, extra));
                return Array.from(ed.querySelectorAll('p')).map((p) => Array.from(p.querySelectorAll('a')).map((a) => a.getAttribute('href')))
                    .filter((l) => l.length > 0 && l[0] !== 'files/y.pdf');
            }, { sel, sp });
            expect(lines, `${sel}: 1 行 1 リンクでない`).toEqual([['alpha.md'], ['files/x.pdf'], ['beta.md']]);
        }
    });
    }
});
