/**
 * outliner node の右クリック「新規タブで開く」（page / file）
 * sprint 20260906-024639-tree-keynav-opennew-modifier / FR-ONT-01..04 / NFR-ONT-01 / NFR-MFIT-03
 *
 * TC-ONT-01..09 / TC-MFIT-18。
 *
 * 設計（design/system.md §3）:
 *   - `showContextMenu` の `node.isPage` ブロックに「page を新規タブで開く」、
 *     `node.filePath` ブロックに「file を新規タブで開く」を追加する
 *   - **page と file は排他ではない**ため両方持つ node ではメニューに 2 項目が並ぶ（併存セル）。
 *     ラベルは i18n の別キー 2 本で分ける（同名 2 項目にしない = FR-ONT-03 / 裁定 R7 rev）
 *   - page 項目 → 既存 `openPageInTab(nodeId, pageId)` / file 項目 → 新規 `openNodeFileInTab(nodeId)`
 *
 * ★ design-review TDD-3: 「page と file を両方持つ node」の fixture は既存テストに **1 件も無い**
 *   （`grep -rn "isPage: true" test/specs test/unit` の全ヒットで `filePath` が非 null のものが 0 件）。
 *   本 spec がその fixture の初出。
 *
 * TASK-02: fixture ヘルパ + スモーク。TASK-10: TC-ONT-01..09 / TC-MFIT-18。
 */
import { test, expect, Page } from '@playwright/test';
import { SMALL_VIEWPORT, BOTTOM_RIGHT, measureMenu, assertWithinViewport } from '../utils/small-viewport';

/**
 * fixture（design/tdd.md E2E 後方追跡表 B-1）:
 *   nBoth … **isPage:true + pageId + 非 null filePath を同時に持つ**（併存セル。TC-ONT-03 の核心）
 *   nPage … page のみ / nFile … file のみ / nPlain … どちらも無し（TC-ONT-04 = 項目が出ない側）
 */
export const OUT_DOC = {
    version: 1,
    rootIds: ['nBoth', 'nPage', 'nFile', 'nPlain'],
    nodes: {
        nBoth: {
            id: 'nBoth', parentId: null, children: [], text: 'both page and file',
            tags: [], subtext: '', images: [], collapsed: false, checked: null,
            isPage: true, pageId: 'pg-both', filePath: 'files/both.pdf',
        },
        nPage: {
            id: 'nPage', parentId: null, children: [], text: 'page only',
            tags: [], subtext: '', images: [], collapsed: false, checked: null,
            isPage: true, pageId: 'pg-1', filePath: null,
        },
        nFile: {
            id: 'nFile', parentId: null, children: [], text: 'file only',
            tags: [], subtext: '', images: [], collapsed: false, checked: null,
            isPage: false, pageId: null, filePath: 'files/spec.pdf',
        },
        nPlain: {
            id: 'nPlain', parentId: null, children: [], text: 'plain',
            tags: [], subtext: '', images: [], collapsed: false, checked: null,
            isPage: false, pageId: null, filePath: null,
        },
    },
};

/** ハーネス: `/standalone-notes.html` + `__testApi.initOutliner(...)`（bridge は factory 経由 = `__testApi.messages`）。 */
export async function setupOutliner(page: Page, doc: any = OUT_DOC): Promise<void> {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.initOutliner !== undefined, undefined, { timeout: 8000 });
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, doc);
    await page.waitForSelector('.outliner-node[data-id="nBoth"]', { timeout: 5000 });
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
}

/** node を右クリックしてコンテキストメニューを開き、項目ラベルの配列を返す。 */
export async function openNodeMenu(page: Page, nodeId: string): Promise<string[]> {
    await page.evaluate((id) => {
        const el = document.querySelector(`.outliner-node[data-id="${id}"] .outliner-text`)
            || document.querySelector(`.outliner-node[data-id="${id}"]`);
        if (!el) { throw new Error('node が無い: ' + id); }
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    }, nodeId);
    await page.waitForSelector('.outliner-context-menu', { timeout: 5000 });
    return menuLabels(page);
}

export function menuLabels(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('.outliner-context-menu .outliner-context-menu-item .context-menu-label'))
            .map((el) => (el.textContent || '').trim()));
}

/** メニュー項目をラベルで click する。 */
export async function clickMenuItem(page: Page, label: string): Promise<void> {
    await page.evaluate((l) => {
        const items = Array.from(document.querySelectorAll('.outliner-context-menu .outliner-context-menu-item'));
        const hit = items.find((it) => ((it.querySelector('.context-menu-label') as HTMLElement)?.textContent || '').trim() === l);
        if (!hit) { throw new Error('メニュー項目が無い: ' + l + ' / 実際: ' + items.map((i) => (i.textContent || '').trim()).join(' | ')); }
        (hit as HTMLElement).click();
    }, label);
}

export function messages(page: Page): Promise<any[]> {
    return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
}

test.describe('outliner Open in new tab — fixture（TASK-02）', () => {
    test('fixture スモーク: page と file を併持する node が描画され、メニューが開く', async ({ page }) => {
        await setupOutliner(page);

        // 併持 node が model 上で両方の属性を持つ（fixture が要件どおり）
        const both = await page.evaluate(() => {
            const n = (window as any).__testApi.getModel
                ? (window as any).__testApi.getModel().getNode('nBoth')
                : null;
            const el = document.querySelector('.outliner-node[data-id="nBoth"]') as HTMLElement;
            return {
                hasPageIcon: !!el.querySelector('.outliner-page-icon'),
                hasFileIcon: !!el.querySelector('.outliner-file-icon'),
                modelIsPage: n ? !!n.isPage : null,
                modelFilePath: n ? n.filePath : null,
            };
        });
        expect(both.hasPageIcon, '📄 page アイコンが出ている').toBe(true);
        expect(both.hasFileIcon, '📎 file アイコンが出ている').toBe(true);

        // 4 種の node がすべて描画されている
        const ids = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.outliner-node')).map((el) => (el as HTMLElement).dataset.id));
        expect(ids, '併持 / page のみ / file のみ / plain の 4 node').toEqual(['nBoth', 'nPage', 'nFile', 'nPlain']);

        // 右クリックメニューが開き、ラベルが取れる（TASK-10 の TC がこのヘルパを使う）
        const labels = await openNodeMenu(page, 'nBoth');
        expect(labels.length, 'メニュー項目が 1 件以上').toBeGreaterThan(0);
    });
});

const PAGE_LABEL = 'Open page in new tab';
const FILE_LABEL = 'Open file in new tab';

test.describe('outliner Open in new tab — メニュー（TASK-10 / FR-ONT-01..04）', () => {
    test('TC-ONT-01 page 添付 node のメニューに page 用項目があり openPageInTab が飛ぶ', async ({ page }) => {
        await setupOutliner(page);
        const labels = await openNodeMenu(page, 'nPage');
        expect(labels, 'page 用の項目がある').toContain(PAGE_LABEL);
        expect(labels, 'file 用の項目は出ない').not.toContain(FILE_LABEL);
        await clickMenuItem(page, PAGE_LABEL);
        const m = await messages(page);
        const hit = m.filter((x) => x.type === 'openPageInTab');
        expect(hit.length).toBe(1);
        expect(hit[0]).toMatchObject({ nodeId: 'nPage', pageId: 'pg-1' });
        expect(m.filter((x) => x.type === 'openPageInSidePanel').length, '通常 open は起きない').toBe(0);
    });

    test('TC-ONT-02 file 添付 node のメニューに file 用項目があり openNodeFileInTab（nodeId のみ）が飛ぶ', async ({ page }) => {
        await setupOutliner(page);
        const labels = await openNodeMenu(page, 'nFile');
        expect(labels).toContain(FILE_LABEL);
        expect(labels, 'page 用の項目は出ない').not.toContain(PAGE_LABEL);
        await clickMenuItem(page, FILE_LABEL);
        const m = await messages(page);
        const hit = m.filter((x) => x.type === 'openNodeFileInTab');
        expect(hit.length).toBe(1);
        expect(hit[0].nodeId).toBe('nFile');
        expect(Object.keys(hit[0]).sort(), 'payload は type + nodeId のみ（絶対パスなし）').toEqual(['nodeId', 'type']);
        expect(m.filter((x) => x.type === 'openAttachedFile').length, '通常 open は起きない').toBe(0);
    });

    test('TC-ONT-03 併持 node は 2 項目が並び、ラベルが異なり、取り違えない', async ({ page }) => {
        await setupOutliner(page);
        const labels = await openNodeMenu(page, 'nBoth');
        expect(labels.filter((l) => l === PAGE_LABEL).length, 'page 用 1 件').toBe(1);
        expect(labels.filter((l) => l === FILE_LABEL).length, 'file 用 1 件').toBe(1);
        expect(PAGE_LABEL === FILE_LABEL, '★ 同名 2 項目になっていない').toBe(false);
        // page 項目 → page 経路
        await clickMenuItem(page, PAGE_LABEL);
        let m = await messages(page);
        expect(m.filter((x) => x.type === 'openPageInTab').length).toBe(1);
        expect(m.filter((x) => x.type === 'openNodeFileInTab').length, 'file 経路に流れない').toBe(0);
        // file 項目 → file 経路
        await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
        await openNodeMenu(page, 'nBoth');
        await clickMenuItem(page, FILE_LABEL);
        m = await messages(page);
        expect(m.filter((x) => x.type === 'openNodeFileInTab').length).toBe(1);
        expect(m.filter((x) => x.type === 'openPageInTab').length, 'page 経路に流れない').toBe(0);
    });

    test('TC-ONT-04 page も file も無い node ではどちらの項目も出ない', async ({ page }) => {
        await setupOutliner(page);
        const labels = await openNodeMenu(page, 'nPlain');
        expect(labels).not.toContain(PAGE_LABEL);
        expect(labels).not.toContain(FILE_LABEL);
    });

    test('TC-ONT-06 メニュー項目は disabled にしない（FR-FTB-03: 常に表示・縮退は host 側）', async ({ page }) => {
        await setupOutliner(page);
        await openNodeMenu(page, 'nBoth');
        const disabled = await page.evaluate((labels) => {
            const items = Array.from(document.querySelectorAll('.outliner-context-menu .outliner-context-menu-item'));
            return items
                .filter((it) => labels.indexOf(((it.querySelector('.context-menu-label') as HTMLElement)?.textContent || '').trim()) >= 0)
                .map((it) => it.classList.contains('disabled'));
        }, [PAGE_LABEL, FILE_LABEL]);
        expect(disabled, '2 項目とも有効').toEqual([false, false]);
    });

    test('TC-ONT-07/08 shortcut ラベルで新しい修飾（Cmd/Ctrl+Shift+Click）を露出している', async ({ page }) => {
        await setupOutliner(page);
        await openNodeMenu(page, 'nBoth');
        const shortcuts = await page.evaluate((labels) => {
            const items = Array.from(document.querySelectorAll('.outliner-context-menu .outliner-context-menu-item'));
            const out: Record<string, string> = {};
            items.forEach((it) => {
                const l = ((it.querySelector('.context-menu-label') as HTMLElement)?.textContent || '').trim();
                if (labels.indexOf(l) >= 0) {
                    out[l] = ((it.querySelector('.context-menu-shortcut') as HTMLElement)?.textContent || '').trim();
                }
            });
            return out;
        }, [PAGE_LABEL, FILE_LABEL]);
        expect(shortcuts[PAGE_LABEL]).toMatch(/\+Shift\+Click$/);
        expect(shortcuts[FILE_LABEL]).toMatch(/\+Shift\+Click$/);
    });

    test('TC-ONT-09 i18n: 新規 2 キーが WebviewMessages + 7 locale の 8 箇所にある（host Messages に無い）', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs2 = require('fs');
        const pathM = require('path');
        const root = pathM.join(__dirname, '..', '..');
        const files = ['src/i18n/messages.ts',
            'src/i18n/locales/en.ts', 'src/i18n/locales/ja.ts', 'src/i18n/locales/ko.ts',
            'src/i18n/locales/es.ts', 'src/i18n/locales/fr.ts', 'src/i18n/locales/zh-cn.ts',
            'src/i18n/locales/zh-tw.ts'];
        for (const key of ['outlinerOpenPageInNewTab', 'outlinerOpenFileInNewTab']) {
            const hits = files.filter((f) => fs2.readFileSync(pathM.join(root, f), 'utf8').includes(key));
            expect(hits.length, `${key} が 8 ファイルに無い: ${hits.join(',')}`).toBe(8);
        }
        // WebviewMessages 側に定義されている（Messages interface ではない）ことの確認:
        const msgSrc: string = fs2.readFileSync(pathM.join(root, 'src/i18n/messages.ts'), 'utf8');
        const wvIdx = msgSrc.indexOf('WebviewMessages');
        expect(wvIdx, 'WebviewMessages interface がある').toBeGreaterThan(-1);
        expect(msgSrc.indexOf('outlinerOpenPageInNewTab'), 'WebviewMessages より後ろに定義されている').toBeGreaterThan(wvIdx);
    });
});

/**
 * TC-MFIT-18 — 項目が 2 本増えた併持 node のメニューでも小 viewport に収まる（NFR-MFIT-03）。
 * 既存 TC-MFIT-01..17 と同じ「実測 rect の 4 辺」型。`menu-placement.js` の登録は変更していないので、
 * ここは「項目追加で収まりが壊れていない」ことの番人。
 */
test.describe('outliner Open in new tab — メニュー配置（TASK-10 / NFR-MFIT-03）', () => {
    test('TC-MFIT-18 400×300 の右下隅で併持 node のメニュー 4 辺が viewport 内', async ({ page }) => {
        await page.setViewportSize(SMALL_VIEWPORT);
        await setupOutliner(page);
        await page.evaluate((pt) => {
            const el = document.querySelector('.outliner-node[data-id="nBoth"] .outliner-text')
                || document.querySelector('.outliner-node[data-id="nBoth"]');
            (el as HTMLElement).dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y,
            }));
        }, BOTTOM_RIGHT);
        const rect = await measureMenu(page, 'outliner-node');
        assertWithinViewport(rect, 'TC-MFIT-18 併持 node メニュー');
        // 併持で 2 項目増えていること（この TC が本当に「増えた後」を見ている保証）
        const labels = await menuLabels(page);
        expect(labels).toContain(PAGE_LABEL);
        expect(labels).toContain(FILE_LABEL);
    });
});
