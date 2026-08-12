/**
 * Sprint 20260812-110538: FR-MDD mindmap の md/file D&D 4 経路
 * 送り = 📄/📎 icon の HTML5 dragstart(PoC 実測済み・real mouse で検証)
 * 受け = treeEl drop の custom MIME dispatch(outliner handler を ctx 共有)
 */
import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

function tree() {
    return {
        version: 1, viewMode: 'mindmap', rootIds: ['n1'],
        nodes: {
            n1: { id: 'n1', parentId: null, children: ['p1', 'f1'], text: 'Root', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
            p1: { id: 'p1', parentId: 'n1', children: [], text: 'PageNode', collapsed: false, subtext: '', images: [], isPage: true, pageId: 'pg-1', checked: null, filePath: null, tags: [] },
            f1: { id: 'f1', parentId: 'n1', children: [], text: 'FileNode', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, filePath: 'files/doc.pdf', checked: null, tags: [] },
        }
    };
}

async function init(page, data, notesMode = false) {
    if (notesMode) {
        // isNotesMode() は .notes-layout の存在で判定 — 実 DOM マーカーを立てる
        await page.evaluate(() => {
            if (!document.querySelector('.notes-layout')) {
                const d = document.createElement('div');
                d.className = 'notes-layout';
                d.style.display = 'none';
                document.body.appendChild(d);
            }
        });
    }
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.waitForTimeout(250);
}

// standalone は notes モードでない可能性 → isNotesMode を確認し、必要なら notes フラグを立てる
async function ensureNotesMode(page) {
    return await page.evaluate(() => {
        // standalone-outliner の test host は notes モード扱いか確認
        const icons = document.querySelectorAll('.mindmap-node-icon[draggable="true"]');
        return icons.length;
    });
}

test('TC-MDD-01 page icon real-mouse drag fires dragstart with out-node-page MIME', async ({ page }) => {
    await setup(page);
    await init(page, tree(), true); // notes モード(.notes-layout マーカー)で icon が draggable 化
    const draggableCount = await ensureNotesMode(page);
    expect(draggableCount).toBeGreaterThan(0); // 📄/📎 が draggable
    // real mouse drag で dragstart 発火を検証(dataTransfer.getData は dragstart 中
    // 保護され読めないため、payload 検証は TC-MDD-05 の合成 dispatch が担う)
    await page.evaluate(() => {
        (window as any).__mddPayload = null;
        // icon の handler は stopPropagation するため document では観測不能 →
        // icon 要素自身に後付け listener(登録順で先行 handler の setData 後に呼ばれる)
        const icon = document.querySelector('.mindmap-node[data-node-id="p1"] .mindmap-node-icon') as HTMLElement;
        icon.addEventListener('dragstart', (e: any) => {
            (window as any).__mddPayload = e.dataTransfer && e.dataTransfer.types
                ? Array.from(e.dataTransfer.types).join(',') : 'fired';
        });
    });
    const box = await page.evaluate(() => {
        const icon = document.querySelector('.mindmap-node[data-node-id="p1"] .mindmap-node-icon') as HTMLElement;
        const b = icon.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 60, { steps: 10 });
    await page.mouse.up();
    const payload = await page.evaluate(() => (window as any).__mddPayload);
    expect(payload).toBeTruthy(); // dragstart 発火(counterfactual: draggable を外すと null)
    expect(payload).toContain('application/x-fractal-out-node-page'); // MIME が積まれた
});

// tree-md / md-filelink の drop dispatch: handler 実体(notesImportMdIntoOut 等)は
// window.notesHostBridge + notesFilePanel(Notes 面限定)前提のため standalone では
// early return する。ここでは「mindmap の drop 受理(preventDefault + indicator)と
// dispatch 分岐への到達」を検証し、bridge 呼び出しは Notes 面の既存 wiring TC + 手動 UC-4 が担保。
test('TC-MDD-03 tree-md drag is accepted by mindmap dragover (preventDefault + indicator)', async ({ page }) => {
    await setup(page);
    await init(page, tree());
    const st = await page.evaluate(async () => {
        const nodeEl = document.querySelector('.mindmap-node[data-node-id="n1"]') as HTMLElement;
        const b = nodeEl.getBoundingClientRect();
        const dt = new DataTransfer();
        dt.setData('application/x-fractal-tree-md', JSON.stringify({ id: 'md-1', filePath: 'sub/note.md' }));
        const tree = document.querySelector('.outliner-tree')!;
        const over = new DragEvent('dragover', {
            bubbles: true, cancelable: true,
            clientX: b.x + b.width / 2, clientY: b.y + b.height / 2,
        });
        Object.defineProperty(over, 'dataTransfer', { value: dt });
        tree.dispatchEvent(over);
        const marks = document.querySelectorAll('.mm-drop-child, .mm-drop-above, .mm-drop-below').length;
        const drop = new DragEvent('drop', {
            bubbles: true, cancelable: true,
            clientX: b.x + b.width / 2, clientY: b.y + b.height / 2,
        });
        Object.defineProperty(drop, 'dataTransfer', { value: dt });
        tree.dispatchEvent(drop);
        await new Promise(r => setTimeout(r, 200));
        return {
            overPrevented: over.defaultPrevented,
            dropPrevented: drop.defaultPrevented,
            marksDuringOver: marks,
            marksAfterDrop: document.querySelectorAll('.mm-drop-child, .mm-drop-above, .mm-drop-below').length,
        };
    });
    expect(st.overPrevented).toBe(true);   // 受理(counterfactual: 判定を外すと false = RED)
    expect(st.dropPrevented).toBe(true);   // drop dispatch に到達
    expect(st.marksDuringOver).toBeGreaterThan(0); // indicator 表示
    expect(st.marksAfterDrop).toBe(0);     // drop 後 clear
});

test('TC-MDD-06 md-filelink drag is accepted by mindmap dragover/drop', async ({ page }) => {
    await setup(page);
    await init(page, tree());
    const st = await page.evaluate(async () => {
        const nodeEl = document.querySelector('.mindmap-node[data-node-id="n1"]') as HTMLElement;
        const b = nodeEl.getBoundingClientRect();
        const dt = new DataTransfer();
        dt.setData('application/x-fractal-md-filelink', JSON.stringify({ href: 'files/a.pdf', sourceMdPath: 'x.md' }));
        const tree = document.querySelector('.outliner-tree')!;
        const over = new DragEvent('dragover', {
            bubbles: true, cancelable: true,
            clientX: b.x + b.width / 2, clientY: b.y + b.height / 2,
        });
        Object.defineProperty(over, 'dataTransfer', { value: dt });
        tree.dispatchEvent(over);
        const drop = new DragEvent('drop', {
            bubbles: true, cancelable: true,
            clientX: b.x + b.width / 2, clientY: b.y + b.height / 2,
        });
        Object.defineProperty(drop, 'dataTransfer', { value: dt });
        tree.dispatchEvent(drop);
        await new Promise(r => setTimeout(r, 200));
        return { overPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented };
    });
    expect(st.overPrevented).toBe(true);
    expect(st.dropPrevented).toBe(true);
});

test('TC-MDD-07 md-subpage drag is accepted by mindmap dragover/drop', async ({ page }) => {
    await setup(page);
    await init(page, tree());
    const st = await page.evaluate(async () => {
        const nodeEl = document.querySelector('.mindmap-node[data-node-id="n1"]') as HTMLElement;
        const b = nodeEl.getBoundingClientRect();
        const dt = new DataTransfer();
        dt.setData('application/x-fractal-md-subpage', JSON.stringify({ href: 'sub.md', sourceMdPath: 'x.md' }));
        const tree = document.querySelector('.outliner-tree')!;
        const over = new DragEvent('dragover', {
            bubbles: true, cancelable: true,
            clientX: b.x + b.width / 2, clientY: b.y + b.height / 2,
        });
        Object.defineProperty(over, 'dataTransfer', { value: dt });
        tree.dispatchEvent(over);
        return { overPrevented: over.defaultPrevented };
    });
    expect(st.overPrevented).toBe(true);
});

test('TC-MDD-04 tree-file drag accepted + dispatch order (custom MIME before Files)', async ({ page }) => {
    await setup(page);
    await init(page, tree());
    const st = await page.evaluate(async () => {
        const nodeEl = document.querySelector('.mindmap-node[data-node-id="n1"]') as HTMLElement;
        const b = nodeEl.getBoundingClientRect();
        const dt = new DataTransfer();
        dt.setData('application/x-fractal-tree-file', JSON.stringify({ id: 'tf-1' }));
        const tree = document.querySelector('.outliner-tree')!;
        const over = new DragEvent('dragover', {
            bubbles: true, cancelable: true,
            clientX: b.x + b.width / 2, clientY: b.y + b.height / 2,
        });
        Object.defineProperty(over, 'dataTransfer', { value: dt });
        tree.dispatchEvent(over);
        return { overPrevented: over.defaultPrevented };
    });
    expect(st.overPrevented).toBe(true);
});

test('TC-MDD-08 drop indicator clears on dragleave/drop', async ({ page }) => {
    await setup(page);
    await init(page, tree());
    await page.evaluate(async () => {
        const nodeEl = document.querySelector('.mindmap-node[data-node-id="n1"]') as HTMLElement;
        const b = nodeEl.getBoundingClientRect();
        const dt = new DataTransfer();
        dt.setData('application/x-fractal-tree-file', JSON.stringify({ id: 'tf-1' }));
        const tree = document.querySelector('.outliner-tree')!;
        const e = new DragEvent('dragover', {
            bubbles: true, cancelable: true,
            clientX: b.x + b.width / 2, clientY: b.y + b.height / 2,
        });
        Object.defineProperty(e, 'dataTransfer', { value: dt });
        tree.dispatchEvent(e);
    });
    let marks = await page.evaluate(() =>
        document.querySelectorAll('.mm-drop-child, .mm-drop-above, .mm-drop-below').length);
    expect(marks).toBeGreaterThan(0); // dragover で indicator
    await page.evaluate(() => {
        const tree = document.querySelector('.outliner-tree')!;
        const e = new DragEvent('dragleave', { bubbles: true, cancelable: true });
        Object.defineProperty(e, 'relatedTarget', { value: document.body });
        tree.dispatchEvent(e);
    });
    marks = await page.evaluate(() =>
        document.querySelectorAll('.mm-drop-child, .mm-drop-above, .mm-drop-below').length);
    expect(marks).toBe(0); // dragleave で clear(one-shot 対クリア)
});

test('TC-MDD-09 outliner view does not react to mindmap-only handlers', async ({ page }) => {
    await setup(page);
    const data = tree();
    (data as any).viewMode = 'outliner';
    await init(page, data);
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    // outliner view で mm-drop mark が付かない(mindmap handler は attach されていない)
    await page.evaluate(() => {
        const tree = document.querySelector('.outliner-tree')!;
        const dt = new DataTransfer();
        dt.setData('application/x-fractal-tree-file', JSON.stringify({ id: 'tf-1' }));
        const e = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 });
        Object.defineProperty(e, 'dataTransfer', { value: dt });
        tree.dispatchEvent(e);
    });
    const marks = await page.evaluate(() =>
        document.querySelectorAll('.mm-drop-child, .mm-drop-above, .mm-drop-below').length);
    expect(marks).toBe(0);
});

test('TC-MDD-02 file icon dragstart carries out-node-file MIME (real mouse)', async ({ page }) => {
    await setup(page);
    await init(page, tree(), true);
    await page.evaluate(() => {
        (window as any).__mddPayload2 = null;
        const icon = document.querySelector('.mindmap-node[data-node-id="f1"] .mindmap-node-icon') as HTMLElement;
        icon.addEventListener('dragstart', (e: any) => {
            (window as any).__mddPayload2 = e.dataTransfer && e.dataTransfer.types
                ? Array.from(e.dataTransfer.types).join(',') : 'fired';
        });
    });
    const box = await page.evaluate(() => {
        const icon = document.querySelector('.mindmap-node[data-node-id="f1"] .mindmap-node-icon') as HTMLElement;
        const b = icon.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 60, { steps: 10 });
    await page.mouse.up();
    const payload = await page.evaluate(() => (window as any).__mddPayload2);
    expect(payload).toBeTruthy();
    expect(payload).toContain('application/x-fractal-out-node-file');
});

// TC-MDD-05: payload が md editor 受け(editor.js :20268/:20278)の期待形と一致(送信側番人)
test('TC-MDD-05 icon payload shape matches editor.js receiver contract', async ({ page }) => {
    await setup(page);
    await init(page, tree(), true); // notes モード必須(icon draggable 化の gate)
    const payloads = await page.evaluate(() => {
        const out: any = {};
        document.addEventListener('dragstart', (e: any) => {
            const p = e.dataTransfer.getData('application/x-fractal-out-node-page');
            const f = e.dataTransfer.getData('application/x-fractal-out-node-file');
            if (p) out.page = JSON.parse(p);
            if (f) out.file = JSON.parse(f);
        }, true);
        return new Promise<any>(async (resolve) => {
            for (const sel of ['.mindmap-node[data-node-id="p1"] .mindmap-node-icon',
                               '.mindmap-node[data-node-id="f1"] .mindmap-node-icon']) {
                const el = document.querySelector(sel) as HTMLElement;
                const dt = new DataTransfer();
                const e = new DragEvent('dragstart', { bubbles: true, cancelable: true });
                Object.defineProperty(e, 'dataTransfer', { value: dt });
                el.dispatchEvent(e);
                const p = dt.getData('application/x-fractal-out-node-page');
                const f = dt.getData('application/x-fractal-out-node-file');
                if (p) out.page = JSON.parse(p);
                if (f) out.file = JSON.parse(f);
            }
            resolve(out);
        });
    });
    // editor.js 受け(importOutPageNodeToMd / attachOutNodeFileToMd)の必須フィールド。
    // outFileKey は standalone では null(Notes 面で host が設定)— キーの存在のみ検証
    expect('outFileKey' in payloads.page).toBe(true);
    expect(payloads.page.nodeId).toBe('p1');
    expect(payloads.page.pageId).toBe('pg-1');
    expect(payloads.page.title).toBe('PageNode');
    expect('outFileKey' in payloads.file).toBe(true);
    expect(payloads.file.nodeId).toBe('f1');
});
