/**
 * Sprint 20260901-075849 / TASK-83 (裁定 R36 / FR-MMD-01):
 * mindmap の node box を掴んで note ツリー（filetree / md / .out / linkedfd）へ運ぶ D&D。
 *
 * 実機報告（2026-09-05）: 「単一はできるが**複数選択の D&D に対応していない**」。
 * 原因は送り手（mindmap-render.js）が
 *   ① 添付を持つ node だけ draggable にしていた（複数選択しても選択集合が drag 起動しない）
 *   ② subtree payload（application/x-fractal-out-node-subtree）を積んでいなかった
 *   ③ payload を mindmap 内で手組みしていて outliner の複数選択対応（nodeIds / items）が入らない
 * の 3 点。修正は outliner.js の `window.__outlinerBuildNodeDragPayloads` に payload 生成を
 * 一元化し、mindmap はそれを呼ぶだけにする（送り手 2 実装の面差を構造的に消す）。
 *
 * ★draggable の範囲（裁定 R36 の要）: 「notes モードなら常時 draggable」は**採れない**。
 *   native HTML5 drag が起動すると mouse ベースの mindmap 内付け替え D&D が食われて reparent が
 *   起きなくなる（TC-MMD-04 が実測で捕まえた）。よって draggable は
 *     (a) 添付を持つ node（従来の挙動を維持）  (b) 複数選択の一部（= 外へ運ぶ意図が明確）
 *   に限る。素の単一 node を掴んだ場合は従来どおり mindmap 内の付け替えになる。
 *
 * payload 検証は TC-MDD-05 と同じ「合成 dragstart + 自前 DataTransfer」で行う
 * （real mouse の dragstart 中は getData が保護されて読めない）。
 */
import { test, expect } from '@playwright/test';

const SUBTREE_MIME = 'application/x-fractal-out-node-subtree';
const ASSETS_MIME = 'application/x-fractal-out-node-assets';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

function n(id: string, parentId: string | null, children: string[], text: string, extra: any = {}) {
    return {
        id, parentId, children, text, collapsed: false, subtext: '', images: [],
        isPage: false, pageId: null, checked: null, filePath: null, tags: [], ...extra,
    };
}

/** title 付き（放射レイアウト）+ 素の text node 3 つ + 添付付き node 2 つ */
function tree() {
    return {
        version: 1, viewMode: 'mindmap', title: 'T', rootIds: ['r'],
        nodes: {
            r: n('r', null, ['a', 'b', 'c', 'p1', 'f1'], 'Root'),
            a: n('a', 'r', [], 'AAA'),
            b: n('b', 'r', [], 'BBB'),
            c: n('c', 'r', [], 'CCC'),
            p1: n('p1', 'r', [], 'PageNode', { isPage: true, pageId: 'pg-1' }),
            f1: n('f1', 'r', [], 'FileNode', { filePath: 'files/doc.pdf' }),
        },
    };
}

async function init(page, data, notesMode = true) {
    if (notesMode) {
        // isNotesMode() は .notes-layout の存在で判定（mindmap-dnd-routes.spec.ts と同手法）
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

/** node box を click（mod=true で複数選択トグル） */
async function clickNode(page, id: string, mod = false) {
    const box = page.locator(`.mindmap-node[data-node-id="${id}"] .mindmap-node-box`);
    await box.click(mod ? { modifiers: ['Meta'] } : {});
    await page.waitForTimeout(80);
}

/** 合成 dragstart を box に投げ、積まれた payload を読む */
async function dragPayloads(page, id: string) {
    return await page.evaluate((nid) => {
        const box = document.querySelector(`.mindmap-node[data-node-id="${nid}"] .mindmap-node-box`) as HTMLElement;
        if (!box) { return { missing: true } as any; }
        const draggable = box.getAttribute('draggable');
        const dt = new DataTransfer();
        const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
        box.dispatchEvent(ev);
        const read = (m: string) => { const s = dt.getData(m); return s ? JSON.parse(s) : null; };
        return {
            draggable,
            subtree: read('application/x-fractal-out-node-subtree'),
            assets: read('application/x-fractal-out-node-assets'),
        } as any;
    }, id);
}

// ★load-bearing: 複数選択した node を掴んだら subtree payload に選択集合の root が載る
test('TC-MMD-01 multi-selected mindmap nodes carry nodeIds in the subtree payload', async ({ page }) => {
    await setup(page);
    await init(page, tree());

    // counterfactual: 単一選択では nodeIds を載せない（受け手は nodeId 1 件として扱う）
    await clickNode(page, 'a');
    const single = await dragPayloads(page, 'a');
    expect(single.subtree).toBeTruthy();
    expect(single.subtree.nodeId).toBe('a');
    expect(single.subtree.nodeIds).toBeUndefined();

    // 複数選択（a + b + c）→ nodeIds に 3 件（表示順）
    await clickNode(page, 'b', true);
    await clickNode(page, 'c', true);
    const multi = await dragPayloads(page, 'a');
    expect(multi.subtree).toBeTruthy();
    expect(multi.subtree.nodeIds).toEqual(['a', 'b', 'c']);
});

// 素の text node は「単一のままなら draggable でない（= 内部付け替えが生きる）」が、
// 複数選択に入った瞬間だけ draggable になり subtree payload を積む。
test('TC-MMD-02 plain mindmap node becomes draggable only as part of a multi-selection', async ({ page }) => {
    await setup(page);
    await init(page, tree());

    // 単一選択: draggable でない（mindmap 内の付け替え D&D を優先。TC-MMD-04 の裏返し）
    await clickNode(page, 'a');
    const single = await dragPayloads(page, 'a');
    expect(single.draggable).toBeNull();

    // 複数選択に入れる → draggable + subtree payload（添付が無いので assets は積まない）
    await clickNode(page, 'b', true);
    const multi = await dragPayloads(page, 'a');
    expect(multi.draggable).toBe('true');
    expect(multi.subtree).toBeTruthy();
    expect(multi.subtree.nodeIds).toEqual(['a', 'b']);
    expect(multi.assets).toBeNull();

    // 単一選択へ戻すと draggable が外れる（選択トグルに追随している = 焼き付きでない）
    await clickNode(page, 'a');
    const back = await dragPayloads(page, 'a');
    expect(back.draggable).toBeNull();
});

// 添付を持つ node は単一選択でも従来どおり運べる（回帰番人: R36 で狭めても (a) が残る）
test('TC-MMD-02b attachment node stays draggable when selected alone', async ({ page }) => {
    await setup(page);
    await init(page, tree());
    await clickNode(page, 'f1');
    const p = await dragPayloads(page, 'f1');
    expect(p.draggable).toBe('true');
    expect(p.subtree).toBeTruthy();
    expect(p.subtree.nodeId).toBe('f1');
    expect(p.assets).toBeTruthy();
});

// 複数選択に添付付き node が含まれるとき、添付 payload の items に全件載る
test('TC-MMD-03 multi-selection carries every attachment in assets.items', async ({ page }) => {
    await setup(page);
    await init(page, tree());
    await clickNode(page, 'p1');
    await clickNode(page, 'f1', true);
    const p = await dragPayloads(page, 'p1');
    expect(p.assets).toBeTruthy();
    const ids = (p.assets.items || []).map((it: any) => it.nodeId).sort();
    expect(ids).toEqual(['f1', 'p1']);
    expect(p.subtree.nodeIds).toEqual(['p1', 'f1']);
});

// 回帰番人: notes モードでも mindmap **内**の付け替え D&D（mouse 実装）が壊れない。
// これが red になる = box を draggable にし過ぎた合図（実測で常時 draggable を却下した根拠）。
test('TC-MMD-04 in-map reparent drag still works while boxes are draggable', async ({ page }) => {
    await setup(page);
    await init(page, tree());
    const rects = await page.evaluate(() => {
        const r = (id: string) => {
            const b = document.querySelector(`.mindmap-node[data-node-id="${id}"] .mindmap-node-box`)!.getBoundingClientRect();
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        };
        return { a: r('a'), b: r('b') };
    });
    await page.mouse.move(rects.a.x, rects.a.y);
    await page.mouse.down();
    await page.mouse.move(rects.b.x, rects.b.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const parentOfA = await page.evaluate(() => (window as any).__testApi.getModel().nodes.a.parentId);
    expect(parentOfA).toBe('b');   // b の中央へ drop = b の子になる
});
