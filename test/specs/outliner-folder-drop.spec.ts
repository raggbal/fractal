/**
 * 2026-09-05（ユーザー依頼）— outliner editor への**フォルダ** D&D = Import folder（FR-DFI-01）
 *
 * TC-DFI-01 importFolderResult に position が付くと drop 位置（before / after / child / root-end）へ dir node 木が入る
 * TC-DFI-02 position 無し（メニュー由来）は従来どおり対象 node の子末尾
 * TC-DFI-03 Finder フォルダ drop: items の DirectoryEntry を FileSystem API で再帰読み取りし dropFolderEntriesImport を送る
 *           （md=text / image=dataUrl / file=base64、relPath はフォルダ相対、旧 host には従来の rejected 通知）
 * TC-DFI-04 Explorer フォルダ drop（uri-list）は従来どおり dropVscodeUrisImport に URI を渡す（host が dir を判別 = unit 側）
 *
 * 🔴 counterfactual: 実装前は (01) が子末尾に入り、(03) は notifyDropFolderRejected のみで RED。
 */
import { test, expect, Page } from '@playwright/test';

function n(id: string, text: string, extra: any = {}) {
    return Object.assign({
        id, parentId: null, children: [], text, collapsed: false, subtext: '',
        images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [],
    }, extra);
}
const TREE = { version: 1, rootIds: ['a', 'b', 'c'], nodes: { a: n('a', 'alpha'), b: n('b', 'bravo'), c: n('c', 'charlie') } };
const ENTRIES = [
    { kind: 'dir', name: 'docs', children: [{ kind: 'md', name: 'inner.md', pageId: 'p-inner' }, { kind: 'file', name: 'r.pdf', filePath: 'files/r.pdf' }] },
    { kind: 'md', name: 'memo.md', pageId: 'p-memo' },
];

async function setup(page: Page): Promise<void> {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate(() => {
        if (!document.querySelector('.notes-layout')) { const d = document.createElement('div'); d.className = 'notes-layout'; document.body.appendChild(d); }
    });
    await page.evaluate((t) => { (window as any).__testApi.initOutliner(t); }, TREE);
    await page.waitForSelector('.outliner-node', { timeout: 5000 });
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
}
function rootTexts(page: Page): Promise<string[]> {
    return page.evaluate(() => { const m = (window as any).Outliner.getModel(); return m.rootIds.map((id: string) => m.getNode(id).text); });
}
async function applyResult(page: Page, targetNodeId: string | null, position: string | null): Promise<void> {
    await page.evaluate(({ targetNodeId, position, entries }) => {
        const msg: any = { type: 'importFolderResult', targetNodeId, entries, skipped: 0 };
        if (position) { msg.position = position; }
        (window as any).__hostMessageHandler(msg);
    }, { targetNodeId, position, entries: ENTRIES });
    await page.waitForTimeout(100);
}

test.describe('TC-DFI-01 importFolderResult の position（drop 位置へ）', () => {
    test("after: b の直後に docs, memo（順序保持・docs の子 2 件）", async ({ page }) => {
        await setup(page);
        await applyResult(page, 'b', 'after');
        expect(await rootTexts(page)).toEqual(['alpha', 'bravo', 'docs', 'memo', 'charlie']);
        const kids = await page.evaluate(() => {
            const m = (window as any).Outliner.getModel();
            const docs = m.rootIds.map((id: string) => m.getNode(id)).find((x: any) => x.text === 'docs');
            return docs.children.map((id: string) => { const k = m.getNode(id); return [k.text, !!k.isPage, k.filePath]; });
        });
        expect(kids).toEqual([['inner', true, null], ['r.pdf', false, 'files/r.pdf']]);
    });
    test('before: b の直前', async ({ page }) => {
        await setup(page);
        await applyResult(page, 'b', 'before');
        expect(await rootTexts(page)).toEqual(['alpha', 'docs', 'memo', 'bravo', 'charlie']);
    });
    test('child: b の子先頭', async ({ page }) => {
        await setup(page);
        await applyResult(page, 'b', 'child');
        expect(await rootTexts(page)).toEqual(['alpha', 'bravo', 'charlie']);
        const kids = await page.evaluate(() => { const m = (window as any).Outliner.getModel(); return m.getNode('b').children.map((id: string) => m.getNode(id).text); });
        expect(kids).toEqual(['docs', 'memo']);
    });
    test('root-end / target 無し: root 末尾', async ({ page }) => {
        await setup(page);
        await applyResult(page, null, 'root-end');
        expect(await rootTexts(page)).toEqual(['alpha', 'bravo', 'charlie', 'docs', 'memo']);
    });
});

test('TC-DFI-02 position 無し（メニュー由来）は従来どおり対象 node の子末尾', async ({ page }) => {
    await setup(page);
    await applyResult(page, 'b', null);
    expect(await rootTexts(page)).toEqual(['alpha', 'bravo', 'charlie']);
    const kids = await page.evaluate(() => { const m = (window as any).Outliner.getModel(); return m.getNode('b').children.map((id: string) => m.getNode(id).text); });
    expect(kids).toEqual(['docs', 'memo']);
});

/** 合成 DirectoryEntry 木（FileSystem API の最小サブセット: isDirectory / name / createReader().readEntries / file()） */
const FAKE_TREE_JS = `
    function fileEntry(name, blob) { return { isDirectory: false, isFile: true, name: name, file: function(ok) { ok(new File([blob], name)); } }; }
    function dirEntry(name, children) {
        return { isDirectory: true, isFile: false, name: name, createReader: function() {
            var done = false;
            return { readEntries: function(ok) { if (done) { ok([]); return; } done = true; ok(children); } };
        } };
    }
    window.__fakeDir = dirEntry('proj', [
        fileEntry('index.md', '# Index'),
        dirEntry('sub', [ fileEntry('pic.png', new Uint8Array([137, 80, 78, 71])), fileEntry('doc.pdf', new Uint8Array([37, 80, 68, 70])) ]),
    ]);
`;

test('TC-DFI-03 Finder フォルダ drop: DirectoryEntry を再帰読み取りして dropFolderEntriesImport（relPath / kind / 内容）', async ({ page }) => {
    await setup(page);
    await page.evaluate('(() => {' + FAKE_TREE_JS + '})()');
    // (a) 読み取り関数の payload
    const payload = await page.evaluate(() => (window as any).__outlinerReadDirectoryEntry((window as any).__fakeDir));
    expect(payload.name).toBe('proj');
    const byRel = Object.fromEntries(payload.files.map((f: any) => [f.relPath, f]));
    expect(Object.keys(byRel).sort()).toEqual(['index.md', 'sub/doc.pdf', 'sub/pic.png']);
    expect(byRel['index.md']).toMatchObject({ kind: 'md', content: '# Index' });
    expect(byRel['sub/pic.png'].kind).toBe('image');
    expect(byRel['sub/pic.png'].dataUrl).toMatch(/^data:.*;base64,/);
    expect(byRel['sub/doc.pdf'].kind).toBe('file');
    expect(byRel['sub/doc.pdf'].bytesBase64).toBe(Buffer.from([37, 80, 68, 70]).toString('base64'));
    // (b) drop handler 経路: items に DirectoryEntry を持つ合成 drop → dropFolderEntriesImport が drop 位置付きで飛ぶ
    const msgs = await page.evaluate(async () => {
        const w = window as any;
        w.__testApi.messages.length = 0;
        const dst = document.querySelector('.outliner-node[data-id="b"]') as HTMLElement;
        const r = dst.getBoundingClientRect();
        const dt: any = {
            types: ['Files'], files: [], getData: () => '',
            items: [{ kind: 'file', type: '', webkitGetAsEntry: () => w.__fakeDir, getAsFile: () => null }],
        };
        const ev = new DragEvent('drop', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.bottom - 2 });
        Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
        dst.dispatchEvent(ev);
        await new Promise((res) => setTimeout(res, 300));
        return JSON.parse(JSON.stringify(w.__testApi.messages));
    });
    const drop = msgs.filter((m: any) => m.type === 'dropFolderEntriesImport');
    expect(drop.length, `dropFolderEntriesImport が 1 回でない: ${msgs.map((m: any) => m.type).join(',')}`).toBe(1);
    expect(drop[0].payload.name).toBe('proj');
    expect(drop[0].payload.files.length).toBe(3);
    expect(drop[0].targetNodeId).toBe('b');
    expect(['after', 'before', 'child']).toContain(drop[0].position);
    expect(msgs.filter((m: any) => m.type === 'notifyDropFolderRejected').length, '旧 rejected 通知が出ている').toBe(0);
});

test('TC-DFI-04 Explorer フォルダ drop（uri-list）は従来どおり dropVscodeUrisImport に URI を渡す', async ({ page }) => {
    await setup(page);
    const msgs = await page.evaluate(async () => {
        const w = window as any;
        w.__testApi.messages.length = 0;
        const dst = document.querySelector('.outliner-node[data-id="c"]') as HTMLElement;
        const r = dst.getBoundingClientRect();
        const dt = new DataTransfer();
        dt.setData('application/vnd.code.uri-list', 'file:///tmp/some-folder\r\nfile:///tmp/a.pdf');
        const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + 2 });
        dst.dispatchEvent(ev);
        await new Promise((res) => setTimeout(res, 100));
        return JSON.parse(JSON.stringify(w.__testApi.messages));
    });
    const m = msgs.filter((x: any) => x.type === 'dropVscodeUrisImport');
    expect(m.length).toBe(1);
    expect(m[0].uris).toEqual(['file:///tmp/some-folder', 'file:///tmp/a.pdf']);
    expect(m[0].targetNodeId).toBe('c');
});
