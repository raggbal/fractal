/**
 * FR-MM-FD: mindmap node への外部ファイル D&D → ノード追加（sprint 20260721-180905）。
 * treeEl の dragover/drop リスナーが対象 node を elementFromPoint で解決し、position(before/after/child) を
 * 出して outliner の handleFilesDrop（ctx フック）→ host.dropFilesImport を呼ぶ。
 * DataTransfer(Files) を合成して実 drop イベントを発火する。
 */
import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}
function n(id: string, text: string, extra: any = {}) {
    return Object.assign({ id, parentId: null, children: [], text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] }, extra);
}
async function toMindmap(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(150);
}
const TREE = () => ({ version: 1, viewMode: 'mindmap', rootIds: ['r'],
    nodes: { r: n('r', 'Root', { children: ['a'] }), a: n('a', 'AAA', { parentId: 'r' }) } });

// 対象 node box の指定 fracY 位置へ image ファイルの drop イベントを合成発火し、dropFilesImport の position を返す。
async function dropFileAt(page: import('@playwright/test').Page, targetId: string, fracY: number, fileName = 'pic.png', mime = 'image/png') {
    const box = await page.locator(`.mindmap-node[data-node-id="${targetId}"] .mindmap-node-box`).boundingBox();
    if (!box) throw new Error('box not found');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height * fracY;
    await page.evaluate(({ cx, cy, fileName, mime }) => {
        const tree = document.querySelector('.outliner-tree[data-view-mode="mindmap"]') as HTMLElement;
        const dt = new DataTransfer();
        // Files 型を持たせる（isFilesDragEvent が types に 'Files' を要求）
        const file = new File([new Uint8Array([1, 2, 3])], fileName, { type: mime });
        dt.items.add(file);
        function fire(type: string) {
            const ev = new DragEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy });
            // DragEvent の dataTransfer は read-only なので defineProperty で差し込む
            Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
            const target = document.elementFromPoint(cx, cy) || tree;
            target.dispatchEvent(ev);
        }
        fire('dragover');
        fire('drop');
    }, { cx, cy, fileName, mime });
    // ★ handleFilesDrop は async（FileReader で読んでから host.dropFilesImport を呼ぶ）→ 少し待つ
    await page.waitForTimeout(300);
    return page.evaluate(() => {
        const msgs = ((window as any).__testApi.messages || []) as any[];
        const last = msgs.filter(m => m.type === 'dropFilesImport').pop();
        return last ? { position: last.position, targetNodeId: last.targetNodeId, importsLen: (last.imports || []).length } : null;
    });
}

// TC-FD-01: node 中央へ file drop → child position で dropFilesImport
test('TC-FD-01 中央 drop → child position で dropFilesImport', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    const r = await dropFileAt(page, 'a', 0.5);
    expect(r).not.toBeNull();
    expect(r!.targetNodeId).toBe('a');
    expect(r!.position).toBe('child');
});

// TC-FD-02: 上端 1/4 → before
test('TC-FD-02 上端 drop → before position', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    const r = await dropFileAt(page, 'a', 0.1);
    expect(r).not.toBeNull();
    expect(r!.position).toBe('before');
});

// TC-FD-03: 下端 1/4 → after
test('TC-FD-03 下端 drop → after position', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    const r = await dropFileAt(page, 'a', 0.9);
    expect(r).not.toBeNull();
    expect(r!.position).toBe('after');
});

// TC-FD-04: dragover 中に位置マークが出て drop で消える
test('TC-FD-04 dragover で位置マーク表示 → drop で消える', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    const box = await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').boundingBox();
    if (!box) throw new Error('box not found');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height * 0.5; // 中央 = child マーク
    const duringMark = await page.evaluate(({ cx, cy }) => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([1])], 'p.png', { type: 'image/png' }));
        const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: cx, clientY: cy });
        Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
        (document.elementFromPoint(cx, cy) || document.body).dispatchEvent(ev);
        const box = document.querySelector('.mindmap-node[data-node-id="a"] .mindmap-node-box');
        return box ? Array.from(box.classList).filter(c => c.indexOf('mm-drop') === 0) : [];
    }, { cx, cy });
    expect(duringMark).toContain('mm-drop-child');
    // drop でマークが消える
    const afterMarks = await page.evaluate(({ cx, cy }) => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([1])], 'p.png', { type: 'image/png' }));
        const ev = new DragEvent('drop', { bubbles: true, cancelable: true, clientX: cx, clientY: cy });
        Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
        (document.elementFromPoint(cx, cy) || document.body).dispatchEvent(ev);
        return document.querySelectorAll('.mm-drop-before, .mm-drop-after, .mm-drop-child, .mm-drop-above, .mm-drop-below').length;
    }, { cx, cy });
    expect(afterMarks).toBe(0);
});
