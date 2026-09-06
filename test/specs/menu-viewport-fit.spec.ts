/**
 * TASK-06/07/08/09 — 右クリックメニューの viewport 収め（7 サイト × 2 条件 = 14 セル）
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-MFIT-01/02 / ADRL-0109）
 *
 * TC-MFIT-01..14。testcases.md のメニュー配置マトリクスの全セルを埋める。
 *
 * 番人の形（design/tdd.md）: source 文字列の pin ではなく、実際に小 viewport で開いて
 * rect 4 辺と overflow 状態を実測する。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    MENU_SITES, MENU_SELECTOR, SMALL_VIEWPORT, BOTTOM_RIGHT,
    gotoSmall, measureMenu, assertWithinViewport, inflateMenu, type MenuSite,
} from '../utils/small-viewport';


/** notes 面（tree-file / tree-folder / linkedfd-row）はパネル初期化が必要（既存 spec 準拠の __testApi）。 */
const NOTES_STRUCTURE = {
    version: 1,
    rootIds: ['o1', 'm1', 'f1', 'lk1', 'dir1'],
    items: {
        o1: { type: 'file', id: 'o1', title: 'out item' },
        m1: { type: 'file', id: 'm1', title: 'md item', ext: 'md' },
        f1: { type: 'file', id: 'f1', title: 'file item', ext: 'file', filename: 'a.pdf' },
        lk1: { type: 'file', id: 'lk1', title: 'link folder', ext: 'folder' },
        dir1: { type: 'folder', id: 'dir1', title: 'real folder', childIds: [] },
    },
};
const NOTES_FILES = [
    { filePath: '/n/o1.out', title: 'out item', id: 'o1', kind: 'out' },
    { filePath: '/n/m1.md', title: 'md item', id: 'm1', kind: 'md' },
    { filePath: '', title: 'file item', id: 'f1', kind: 'file' },
    { filePath: '', title: 'link folder', id: 'lk1', kind: 'folder' },
];

async function initNotesPanel(page: import('@playwright/test').Page): Promise<void> {
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate(({ files, structure }) => {
        (window as any).__testApi.initNotesPanel(files, '/n/o1.out', structure);
    }, { files: NOTES_FILES, structure: NOTES_STRUCTURE });
    await page.waitForSelector('.file-panel-item', { timeout: 5000 });
}


/**
 * linkedfd（folder view）は host bridge 応答が必要なため、notes ハーネスでは開けない。
 * 既存 test/specs/folder-view.spec.ts の loadViewInitKeepCalls と同じ方式で
 * setContent + モジュール注入 + bridge スタブで単体マウントする。
 * menu-placement.js も明示注入する（この面は素の about:blank なので本番 inline が効かない）。
 */
const FV_DISPATCHER_JS = fs.readFileSync(
    path.join(__dirname, '../../src/shared/folder-view-dispatcher.js'), 'utf8');
const FV_VIEW_JS = fs.readFileSync(
    path.join(__dirname, '../../src/shared/notes-folder-view.js'), 'utf8');
const MENU_PLACEMENT_JS = fs.readFileSync(
    path.join(__dirname, '../../src/shared/menu-placement.js'), 'utf8');

async function mountFolderView(page: import('@playwright/test').Page): Promise<void> {
    await page.setViewportSize(SMALL_VIEWPORT);
    await page.goto('about:blank');
    await page.setContent(
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'
        + '<div class="notes-main-wrapper" style="position:relative;height:300px;">'
        + '<div id="outlinerContainer">outliner</div>'
        + '<div id="markdownContainer" style="display:none">md</div>'
        + '</div></body></html>');
    await page.evaluate(() => {
        const w = window as any;
        w.__outlinerMessages = {};
        const noop = () => { /* bridge スタブ */ };
        w.notesHostBridge = new Proxy({}, { get: () => noop });
    });
    await page.addScriptTag({ content: MENU_PLACEMENT_JS });
    await page.addScriptTag({ content: FV_DISPATCHER_JS });
    await page.addScriptTag({ content: FV_VIEW_JS });
    await page.evaluate(() => {
        (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs');
    });
    // host の list 応答を注入して行を描画させる
    await page.evaluate(() => {
        window.postMessage({
            type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '',
            entries: [
                { name: 'dirA', relPath: 'dirA', isDir: true },
                { name: 'fileB.txt', relPath: 'fileB.txt', isDir: false },
            ],
        }, '*');
    });
    await page.waitForSelector('.fv-row', { timeout: 5000 });
}

/** 各サイトのメニューを開く（面ごとに右クリック対象と前準備が違う）。 */
async function openMenu(page: import('@playwright/test').Page, site: MenuSite, at = BOTTOM_RIGHT): Promise<void> {
    switch (site) {
        case 'outliner-node': {
            // node の bullet / text 上で contextmenu
            await page.waitForSelector('.outliner-node', { timeout: 5000 });
            await page.evaluate(({ x, y }) => {
                const el = document.querySelector('.outliner-node .node-text, .outliner-node') as HTMLElement;
                el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }));
            }, at);
            break;
        }
        case 'outliner-column': {
            // Table View に切り替えて列ヘッダで contextmenu
            await page.evaluate(() => {
                const w = window as any;
                if (w.Outliner?.setViewMode) { w.Outliner.setViewMode('table'); }
            });
            const header = await page.$('.outliner-col-header, [data-col-id], .outliner-table th');
            if (!header) { test.skip(true, 'Table View の列ヘッダがこのハーネスに無い'); }
            await page.evaluate(({ x, y }) => {
                const el = document.querySelector('.outliner-col-header, [data-col-id], .outliner-table th') as HTMLElement;
                el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }));
            }, at);
            break;
        }
        case 'md-editor': {
            await page.waitForSelector('#editor, .editor-body, [contenteditable]', { timeout: 5000 });
            await page.evaluate(({ x, y }) => {
                const el = document.querySelector('#editor, .editor-body, [contenteditable]') as HTMLElement;
                el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }));
            }, at);
            break;
        }
        case 'tree-file': {
            await initNotesPanel(page);
            await page.evaluate(({ x, y }) => {
                const el = document.querySelector('.file-panel-item') as HTMLElement;
                el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }));
            }, at);
            break;
        }
        case 'tree-folder': {
            await initNotesPanel(page);
            // contextmenu ハンドラは header に直接付いており bubbles しない
            // （wrapper .file-panel-folder へ dispatch しても届かない）→ header を直接狙う
            await page.waitForSelector('.file-panel-folder-header', { timeout: 5000 });
            await page.evaluate(({ x, y }) => {
                const el = document.querySelector('.file-panel-folder-header') as HTMLElement;
                el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }));
            }, at);
            break;
        }
        case 'linkedfd-row': {
            // mountFolderView が gotoSmall の代わりに面を用意する（呼び出し側で分岐済み）
            await page.evaluate(({ x, y }) => {
                const el = document.querySelector('.fv-row') as HTMLElement;
                el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }));
            }, at);
            break;
        }
        case 'mindmap': {
            await page.evaluate(() => {
                const w = window as any;
                if (w.Outliner?.setViewMode) { w.Outliner.setViewMode('mindmap'); }
            });
            await page.waitForSelector('.mindmap-node', { timeout: 5000 });
            await page.evaluate(({ x, y }) => {
                const el = document.querySelector('.mindmap-node') as HTMLElement;
                el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }));
            }, at);
            break;
        }
    }
}

/** TC-MFIT-01..07: 7 サイト × 右下隅 */
const RIGHT_BOTTOM_TC: Record<MenuSite, string> = {
    'outliner-node': 'TC-MFIT-01',
    'outliner-column': 'TC-MFIT-02',
    'md-editor': 'TC-MFIT-03',
    'tree-file': 'TC-MFIT-04',
    'tree-folder': 'TC-MFIT-05',
    'linkedfd-row': 'TC-MFIT-06',
    'mindmap': 'TC-MFIT-07',
};

/** TC-MFIT-08..14: 7 サイト × tall menu */
const TALL_TC: Record<MenuSite, string> = {
    'outliner-node': 'TC-MFIT-08',
    'outliner-column': 'TC-MFIT-09',
    'md-editor': 'TC-MFIT-10',
    'tree-file': 'TC-MFIT-11',
    'tree-folder': 'TC-MFIT-12',
    'linkedfd-row': 'TC-MFIT-13',
    'mindmap': 'TC-MFIT-14',
};

for (const site of MENU_SITES) {
    test(`${RIGHT_BOTTOM_TC[site]} ${site}: 右下隅で開いても 4 辺が viewport 内`, async ({ page }) => {
        if (site === 'linkedfd-row') { await mountFolderView(page); } else { await gotoSmall(page, site); }
        await openMenu(page, site);
        const r = await measureMenu(page, site);
        // 前提: メニューが実体を持っている（0 サイズだと 4 辺 assert が自明真になる）
        expect(r.width, `${site}: メニュー幅 0 — 開いていない疑い`).toBeGreaterThan(0);
        expect(r.height, `${site}: メニュー高 0 — 開いていない疑い`).toBeGreaterThan(0);
        assertWithinViewport(r, `${RIGHT_BOTTOM_TC[site]} ${site}`);
        expect(r.vw).toBe(SMALL_VIEWPORT.width);
        expect(r.vh).toBe(SMALL_VIEWPORT.height);
    });
}

for (const site of MENU_SITES) {
    test(`${TALL_TC[site]} ${site}: tall menu で top が負値にならず scroll で到達できる`, async ({ page }) => {
        if (site === 'linkedfd-row') { await mountFolderView(page); } else { await gotoSmall(page, site); }
        await openMenu(page, site);
        // 項目を注入して viewport 高（300）を大きく超えさせる
        const count = await inflateMenu(page, site, 800);
        expect(count, `${site}: メニュー項目を伸ばせなかった`).toBeGreaterThan(1);

        // 伸ばした後に再配置（実装は開いた時点で place 済みなので、tall 化後の再 place を明示的に呼ぶ）
        await page.evaluate((sel) => {
            const el = document.querySelector(sel) as HTMLElement;
            const at = { x: window.innerWidth - 5, y: window.innerHeight - 5 };
            (window as any).__menuPlacement.place(el, at);
        }, MENU_SELECTOR[site]);

        const r = await measureMenu(page, site);
        // 主因の負値ガード（clamp のある 2 面でも起きていた欠陥）
        expect(r.top, `${site}: top が負値 — Math.max(gap, …) のガードが効いていない`).toBeGreaterThanOrEqual(0);
        assertWithinViewport(r, `${TALL_TC[site]} ${site}`);
        // 入らない高さは scroll で全項目に到達できる
        expect(r.overflowY, `${site}: overflow-y が auto でない`).toBe('auto');
        expect(r.maxHeight, `${site}: max-height が未設定`).not.toBe('');
        expect(r.scrollable, `${site}: scroll できない（下部項目に到達不能）`).toBe(true);
    });
}
