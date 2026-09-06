/**
 * TASK-13/14 — node 添付 payload と 2 つの送り手（outliner バレット / mindmap node box）
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-NDA-01/03/04 / NFR-NDA-02 / ADRL-0107）
 *
 * TC-NDA-12（payload スキーマ + effectAllowed）/ TC-NDA-11（mindmap も送り手）。
 * 受け手側の分岐（TC-NDA-01..10）は TASK-15 が担う。
 */
import { test, expect, Page } from '@playwright/test';

const MIME = 'application/x-fractal-out-node-assets';

function n(id: string, text: string, extra: any = {}) {
    return Object.assign({
        id, parentId: null, children: [], text, collapsed: false, subtext: '',
        images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [],
    }, extra);
}

/** 併持 8 セル（design/system.md §2-2 の分岐表）を node として持つ木。 */
const CELLS = [
    { cell: 1, page: false, file: false, images: 0 },
    { cell: 2, page: false, file: false, images: 2 },
    { cell: 3, page: false, file: true, images: 0 },
    { cell: 4, page: false, file: true, images: 2 },
    { cell: 5, page: true, file: false, images: 0 },
    { cell: 6, page: true, file: false, images: 2 },
    { cell: 7, page: true, file: true, images: 0 },
    { cell: 8, page: true, file: true, images: 2 },
];

function buildTree() {
    const nodes: any = {};
    const rootIds: string[] = [];
    for (const c of CELLS) {
        const id = `n${c.cell}`;
        rootIds.push(id);
        const extra: any = {};
        if (c.page) { extra.isPage = true; extra.pageId = `page-${c.cell}`; }
        if (c.file) { extra.filePath = `files/spec-${c.cell}.pdf`; }
        if (c.images > 0) {
            extra.images = [];
            for (let i = 1; i <= c.images; i++) { extra.images.push(`images/pic-${c.cell}-${i}.png`); }
        }
        nodes[id] = n(id, `cell-${c.cell}`, extra);
    }
    return { version: 1, rootIds, nodes };
}

/**
 * 添付 payload は notes モード限定（outliner.js の isNotesMode() = `.notes-layout` の存在で判定）。
 * standalone outliner ハーネスには `.notes-layout` が無いので、テスト側で付与して
 * 本番の notes 面と同じ条件を作る（既存の subtree payload も同じ gate 配下）。
 */
async function enableNotesMode(page: Page): Promise<void> {
    await page.evaluate(() => {
        if (!document.querySelector('.notes-layout')) {
            const d = document.createElement('div');
            d.className = 'notes-layout';
            document.body.appendChild(d);
        }
    });
}

async function setup(page: Page): Promise<void> {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await enableNotesMode(page);
    await page.evaluate((t) => { (window as any).__testApi.initOutliner(t); }, buildTree());
    await page.waitForSelector('.outliner-node', { timeout: 5000 });
}

/**
 * dragstart を発火して dataTransfer の内容を採る。
 * DataTransfer を自前で作って渡す（合成 DragEvent に本物の dataTransfer は付かないため）。
 *
 * ⚠️ `effectAllowed` は**合成 DataTransfer では読み戻せない**（仕様上 'uninitialized' のまま）。
 * NFR-NDA-02（effectAllowed='copyMove' 必須）の番人は、実 drag で `dropEffect` が 'copy' に
 * 解決されるかを見る受け手側の TC（TC-DCP-11 / TASK-18）が担う。
 */
async function fireDragstart(page: Page, selector: string): Promise<{ types: string[]; assets: any; effectAllowed: string } | null> {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement;
        if (!el) { return null; }
        const dt = new DataTransfer();
        const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt });
        el.dispatchEvent(ev);
        const raw = dt.getData('application/x-fractal-out-node-assets');
        return {
            types: Array.from(dt.types),
            assets: raw ? JSON.parse(raw) : null,
            effectAllowed: dt.effectAllowed,
        };
    }, selector);
}

test.describe('TASK-13 outliner バレットが添付 payload を積む（FR-NDA-01/03）', () => {
    test('TC-NDA-12 payload スキーマ（v/outFileKey/nodeId/assets）と effectAllowed=copyMove', async ({ page }) => {
        await setup(page);
        // cell 8（page + file + 画像 2）
        const r = await fireDragstart(page, '.outliner-node[data-id="n8"] .outliner-bullet, .outliner-node[data-id="n8"] .bullet');
        expect(r, 'バレット要素が見つからない').toBeTruthy();
        expect(r!.types, `${MIME} が積まれていない: ${r!.types.join(',')}`).toContain(MIME);
        const p = r!.assets;
        expect(p.v, 'スキーマ版 v が 1 でない').toBe(1);
        expect(p.nodeId).toBe('n8');
        // outFileKey は host が与える値。standalone ハーネスでは null なので存在だけ見る
        // （本番では currentOutFileKey が入る）。
        expect('outFileKey' in p, 'payload に outFileKey フィールドが無い').toBe(true);
        expect(Array.isArray(p.assets)).toBe(true);
        // 併持 page + file が入る。**直付き画像は転送対象外**（2026-09-04 R22 — 旧: 4 件）
        expect(p.assets.length, `併持が落ちている: ${JSON.stringify(p.assets)}`).toBe(2);
        expect(p.assets.filter((a: any) => a.kind === 'page').length).toBe(1);
        expect(p.assets.filter((a: any) => a.kind === 'file').length).toBe(1);
        expect(p.assets.filter((a: any) => a.kind === 'image').length, '画像が payload に載っている（R22 で対象外）').toBe(0);
        // パスは note 相対（絶対パスを webview から渡さない）
        for (const a of p.assets) {
            const v = a.filePath || a.src || '';
            if (v) { expect(v.startsWith('/'), `絶対パスが載っている: ${v}`).toBe(false); }
        }
        // subtree payload も同時に積まれている（drop 先で意味論が決まる）
        expect(r!.types, 'subtree payload が消えている（outliner 内 D&D が壊れる）')
            .toContain('application/x-fractal-out-node-subtree');
    });

    test('TC-NDA-12b 併持 8 セルの assets 件数が分岐表どおり（他属性の不在を条件に混ぜていない）', async ({ page }) => {
        await setup(page);
        for (const c of CELLS) {
            const expected = (c.page ? 1 : 0) + (c.file ? 1 : 0);   // 画像は対象外（R22）
            const r = await fireDragstart(page,
                `.outliner-node[data-id="n${c.cell}"] .outliner-bullet, .outliner-node[data-id="n${c.cell}"] .bullet`);
            expect(r, `cell ${c.cell}: バレットが無い`).toBeTruthy();
            if (expected === 0) {
                // 添付ゼロの node では当該 type を積まない（受け手が「添付 drag」と誤認しないため）
                expect(r!.types, `cell ${c.cell}: 添付ゼロなのに ${MIME} が積まれている`).not.toContain(MIME);
                continue;
            }
            expect(r!.types, `cell ${c.cell}: ${MIME} が無い`).toContain(MIME);
            expect(r!.assets.assets.length,
                `cell ${c.cell}: 期待 ${expected} 件 / 実際 ${JSON.stringify(r!.assets.assets)}`)
                .toBe(expected);
        }
    });

    test('TC-NDA-12c 子孫の添付は payload に含まれない', async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
        await enableNotesMode(page);
        await page.evaluate(() => {
            const mk = (id: string, text: string, extra: any = {}) => Object.assign({
                id, parentId: null, children: [], text, collapsed: false, subtext: '',
                images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] }, extra);
            (window as any).__testApi.initOutliner({
                version: 1, rootIds: ['p'],
                nodes: {
                    p: mk('p', 'parent', { children: ['k'], filePath: 'files/parent.pdf' }),
                    k: mk('k', 'kid', { parentId: 'p', filePath: 'files/child.pdf' }),
                },
            });
        });
        await page.waitForSelector('.outliner-node', { timeout: 5000 });

        const r = await fireDragstart(page, '.outliner-node[data-id="p"] .outliner-bullet, .outliner-node[data-id="p"] .bullet');
        expect(r!.assets.assets.length, '子の添付が混ざっている（子孫は含めない = ユーザー裁定）').toBe(1);
        expect(r!.assets.assets[0].filePath).toBe('files/parent.pdf');
    });
});

test.describe('TASK-14 mindmap node box も送り手（FR-NDA-04）', () => {
    test('TC-NDA-11 mindmap の node box が同じ payload を積む', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => { (window as any).Outliner.setViewMode('mindmap'); });
        await page.waitForSelector('.mindmap-node', { timeout: 5000 });

        // cell 8 の node box（添付あり → draggable 化されている）
        const draggable = await page.evaluate(() => {
            const box = document.querySelector('.mindmap-node[data-node-id="n8"] .mindmap-node-box') as HTMLElement;
            return box ? box.getAttribute('draggable') : null;
        });
        expect(draggable,
            'mindmap の node box が draggable でない — 受け手改訂だけでは効かず送り手側の配線が必要')
            .toBe('true');

        const r = await fireDragstart(page, '.mindmap-node[data-node-id="n8"] .mindmap-node-box');
        expect(r!.types, `mindmap で ${MIME} が積まれていない`).toContain(MIME);
        expect(r!.assets.assets.length, 'outliner バレットと同じ 2 件（page + file。画像は対象外 = R22）でない').toBe(2);
        expect(r!.assets.nodeId).toBe('n8');
    });

    test('TC-NDA-11b 添付ゼロの mindmap node box は draggable にならない', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => { (window as any).Outliner.setViewMode('mindmap'); });
        await page.waitForSelector('.mindmap-node', { timeout: 5000 });
        const draggable = await page.evaluate(() => {
            const box = document.querySelector('.mindmap-node[data-node-id="n1"] .mindmap-node-box') as HTMLElement;
            return box ? box.getAttribute('draggable') : 'no-box';
        });
        expect(draggable, '添付ゼロの node box が draggable になっている（内部 D&D と競合する）').not.toBe('true');
    });
});

test.describe('TC-NDA-14 複数選択の drag は選択集合全体の添付を items に載せる（2026-09-04）', () => {
    async function cmdClick(page: Page, id: string): Promise<void> {
        await page.evaluate((i) => {
            const el = document.querySelector(`.outliner-node[data-id="${i}"] .outliner-text`) as HTMLElement;
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, metaKey: true }));
        }, id);
    }
    test('n3 + n5 + n8 を cmd+click して n5 のバレットを drag → items = 表示順 [n3, n5, n8]・nodeId は drag 元', async ({ page }) => {
        await setup(page);
        await cmdClick(page, 'n8');
        await cmdClick(page, 'n3');
        await cmdClick(page, 'n5');
        const r = await fireDragstart(page, '.outliner-node[data-id="n5"] .outliner-bullet');
        expect(r!.types).toContain(MIME);
        const p = r!.assets;
        expect(p.nodeId, 'drag 元 node（後方互換フィールド）').toBe('n5');
        expect(Array.isArray(p.items), '複数選択なのに items が無い（旧: drag した 1 node の添付だけ）').toBe(true);
        expect(p.items.map((it: any) => it.nodeId), '表示順でない').toEqual(['n3', 'n5', 'n8']);
        expect(p.items[0].assets).toEqual([{ kind: 'file', filePath: 'files/spec-3.pdf' }]);
        expect(p.items[1].assets).toEqual([{ kind: 'page', pageId: 'page-5' }]);
        expect(p.items[2].assets.length, 'cell 8 = page + file（画像は対象外 = R22）').toBe(2);
    });

    test('選択集合に添付なし node（cell 1）が混ざっても、添付を持つ node だけが items に入る', async ({ page }) => {
        await setup(page);
        await cmdClick(page, 'n1');
        await cmdClick(page, 'n3');
        const r = await fireDragstart(page, '.outliner-node[data-id="n1"] .outliner-bullet');
        expect(r!.types, 'drag 元に添付が無くても選択集合に添付があれば MIME を積む').toContain(MIME);
        expect(r!.assets.assets).toEqual([]);
        expect(r!.assets.items.map((it: any) => it.nodeId)).toEqual(['n3']);
    });

    test('regression: 単一 drag（選択なし / 選択外）は items を付けない', async ({ page }) => {
        await setup(page);
        const r = await fireDragstart(page, '.outliner-node[data-id="n8"] .outliner-bullet');
        expect(r!.assets.items).toBeUndefined();
        expect(r!.assets.nodeId).toBe('n8');
    });
});

test.describe('TC-NDA-17 icon drag（page / file アイコン）も複数選択中は選択集合の添付を運ぶ（2026-09-04 rc.6）', () => {
    async function cmdClick(page: Page, id: string): Promise<void> {
        await page.evaluate((i) => {
            const el = document.querySelector(`.outliner-node[data-id="${i}"] .outliner-text`) as HTMLElement;
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, metaKey: true }));
        }, id);
    }
    test('n3 + n5 を選択して n5 の page アイコンを drag → 添付 MIME に items [n3, n5]（page MIME も従来どおり載る）', async ({ page }) => {
        await setup(page);
        await cmdClick(page, 'n3');
        await cmdClick(page, 'n5');
        const r = await fireDragstart(page, '.outliner-node[data-id="n5"] .outliner-page-icon');
        expect(r, 'page アイコンが無い').toBeTruthy();
        expect(r!.types).toContain('application/x-fractal-out-node-page');
        expect(r!.types, '複数選択の icon drag が添付 MIME を積まない（旧: 1 件しか移らない）').toContain(MIME);
        expect(r!.assets.items.map((it: any) => it.nodeId)).toEqual(['n3', 'n5']);
    });
    test('n3 + n4 を選択して n3 の file アイコンを drag → items [n3, n4]', async ({ page }) => {
        await setup(page);
        await cmdClick(page, 'n3');
        await cmdClick(page, 'n4');
        const r = await fireDragstart(page, '.outliner-node[data-id="n3"] .outliner-file-icon');
        expect(r!.types).toContain('application/x-fractal-out-node-file');
        expect(r!.types).toContain(MIME);
        expect(r!.assets.items.map((it: any) => it.nodeId)).toEqual(['n3', 'n4']);
    });
    test('regression: 単一の icon drag は従来どおり page/file MIME のみ（添付 MIME を積まない）', async ({ page }) => {
        await setup(page);
        const r = await fireDragstart(page, '.outliner-node[data-id="n5"] .outliner-page-icon');
        expect(r!.types).toContain('application/x-fractal-out-node-page');
        expect(r!.types).not.toContain(MIME);
    });
});

test.describe('TC-NDA-18 複数選択の drag は subtree payload に nodeIds（選択集合の root・表示順）を載せる（2026-09-04）', () => {
    async function cmdClick(page: Page, id: string): Promise<void> {
        await page.evaluate((i) => {
            (document.querySelector(`.outliner-node[data-id="${i}"] .outliner-text`) as HTMLElement)
                .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, metaKey: true }));
        }, id);
    }
    test('n2 + n5 + n7 を選択して n5 のバレットを drag → subtree.nodeIds = [n2, n5, n7] / 単一は nodeIds なし', async ({ page }) => {
        await setup(page);
        await cmdClick(page, 'n7'); await cmdClick(page, 'n2'); await cmdClick(page, 'n5');
        const r = await page.evaluate(() => {
            const el = document.querySelector('.outliner-node[data-id="n5"] .outliner-bullet') as HTMLElement;
            const dt = new DataTransfer();
            el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            return JSON.parse(dt.getData('application/x-fractal-out-node-subtree') || 'null');
        });
        expect(r.nodeId).toBe('n5');
        expect(r.nodeIds, '複数選択なのに nodeIds が無い').toEqual(['n2', 'n5', 'n7']);
        const single = await page.evaluate(() => {
            (document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement)
                .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));   // 選択クリア
            const el = document.querySelector('.outliner-node[data-id="n8"] .outliner-bullet') as HTMLElement;
            const dt = new DataTransfer();
            el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            return JSON.parse(dt.getData('application/x-fractal-out-node-subtree') || 'null');
        });
        expect(single.nodeIds).toBeUndefined();
    });
});
