/**
 * TASK-27 — outliner →「linkedfd に送る」+ folder link サブメニュー
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-SND-03/04 / §6-2 §6-3）
 *
 * TC-SND-10（登録順の列挙）/ TC-SND-11（0 件・broken の disabled）/
 * TC-SND-12（親の overflow でクリップされない）/ TC-SND-13（既存 Export folder の併存）。
 *
 * 🔴 counterfactual: サブメニューを親 menu の**子孫 DOM** に置くと、FR-MFIT-03 の
 * `max-height` + `overflow-y:auto` でクリップされて TC-SND-12 が RED。
 */
import { test, expect, Page } from '@playwright/test';

function n(id: string, text: string, extra: any = {}) {
    return Object.assign({
        id, parentId: null, children: [], text, collapsed: false, subtext: '',
        images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [],
    }, extra);
}

const TREE = {
    version: 1,
    rootIds: ['a', 'b'],
    nodes: {
        a: n('a', 'alpha', { children: ['a1'], filePath: 'files/a.pdf' }),
        a1: n('a1', 'alpha-1', { parentId: 'a' }),
        b: n('b', 'bravo'),
    },
};

/** folder link 3 件（登録順 / 3 件目が broken）を持つ note ツリー。 */
const FILES = [
    { filePath: '/n/work.out', title: 'work', id: 'o1', kind: 'out' },
    { filePath: '', title: 'Docs', id: 'fl1', kind: 'folder', broken: false },
    { filePath: '', title: 'Projects', id: 'fl2', kind: 'folder', broken: false },
    { filePath: '', title: 'Archive', id: 'fl3', kind: 'folder', broken: true },
];
const STRUCTURE = {
    version: 1,
    rootIds: ['o1', 'fl1', 'fl2', 'fl3'],
    items: {
        o1: { type: 'file', id: 'o1', title: 'work', ext: 'out', filePath: '/n/work.out' },
        fl1: { type: 'file', id: 'fl1', title: 'Docs', ext: 'folder' },
        fl2: { type: 'file', id: 'fl2', title: 'Projects', ext: 'folder' },
        fl3: { type: 'file', id: 'fl3', title: 'Archive', ext: 'folder' },
    },
};

async function setup(page: Page, opts?: { files?: any[]; structure?: any }): Promise<void> {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate((a) => {
        (window as any).__testApi.initNotesPanel(a.files, '/n/work.out', a.structure);
        (window as any).__testApi.initOutliner(a.tree);
    }, { files: opts?.files ?? FILES, structure: opts?.structure ?? STRUCTURE, tree: TREE });
    await page.waitForSelector('.outliner-node', { timeout: 5000 });
}

/** node を右クリックして本体メニューを開く。 */
async function openNodeMenu(page: Page, id: string): Promise<void> {
    await page.evaluate((i) => {
        const el = document.querySelector(`.outliner-node[data-id="${i}"] .outliner-text`) as HTMLElement;
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5,
        }));
    }, id);
    await page.waitForSelector('.outliner-context-menu', { timeout: 5000 });
}

/** 「linkedfd に送る」項目の要素情報。 */
async function sendItemInfo(page: Page): Promise<{ found: boolean; disabled: boolean; text: string }> {
    return page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.outliner-context-menu:not(.outliner-context-submenu) .outliner-context-menu-item')) as HTMLElement[];
        const hit = items.find((el) => /Send to linkedfd|linkedfd に送る/.test(el.textContent || ''));
        return hit
            ? { found: true, disabled: hit.classList.contains('disabled'), text: (hit.textContent || '').trim() }
            : { found: false, disabled: false, text: items.map((x) => x.textContent).join(' | ') };
    });
}

/** 「linkedfd に送る」をクリックしてサブメニューを開く。 */
async function openSubmenu(page: Page): Promise<void> {
    await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.outliner-context-menu:not(.outliner-context-submenu) .outliner-context-menu-item')) as HTMLElement[];
        const hit = items.find((el) => /Send to linkedfd|linkedfd に送る/.test(el.textContent || ''));
        if (hit) { hit.click(); }
    });
    await page.waitForSelector('.outliner-context-submenu', { timeout: 5000 });
}

test.describe('TC-SND-10 folder link サブメニュー（FR-SND-04）', () => {
    test('登録済み folder link が登録順に列挙される', async ({ page }) => {
        await setup(page);
        await openNodeMenu(page, 'a');
        const item = await sendItemInfo(page);
        expect(item.found, `「linkedfd に送る」が無い。メニュー項目: ${item.text}`).toBe(true);
        expect(item.disabled, '1 件以上あるのに disabled').toBe(false);

        await openSubmenu(page);
        const names = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.outliner-context-submenu .outliner-context-menu-item'))
                .map((el) => (el.textContent || '').replace(/^\s*📁\s*/, '').trim()));
        expect(names, `登録順で列挙されていない: ${names.join(',')}`).toEqual(['Docs', 'Projects', 'Archive']);
    });

    test('folder link を選ぶと sendNodesToFolderLink が呼ばれる（ExportNode[] + folderLinkId）', async ({ page }) => {
        await setup(page);
        await openNodeMenu(page, 'a');
        await openSubmenu(page);
        const call = await page.evaluate(() => {
            const w = window as any;
            w.__testApi.notesMessages.length = 0;
            const items = Array.from(document.querySelectorAll('.outliner-context-submenu .outliner-context-menu-item')) as HTMLElement[];
            items[1].click();   // Projects
            return w.__testApi.notesMessages.find((m: any) => m.type === 'sendNodesToFolderLink') || null;
        });
        expect(call, 'bridge が呼ばれていない').toBeTruthy();
        expect(call.folderLinkId, '選んだ folder link が渡っていない').toBe('fl2');
        expect(Array.isArray(call.tree), 'ExportNode[] でない').toBe(true);
        expect(call.tree.length, '対象 node が 1 件でない').toBe(1);
        expect(call.tree[0].id).toBe('a');
        // 子孫は children として入る（Export folder と同じ形）
        expect(call.tree[0].children.map((c: any) => c.id)).toEqual(['a1']);
        expect(call.tree[0].filePath, 'file 添付が落ちた').toBe('files/a.pdf');
    });

    test('選択集合があるときは最上位のみが送られる（祖先包含の重複排除）', async ({ page }) => {
        await setup(page);
        // Cmd+A 2 段で全選択（a, a1, b）
        await page.locator('.outliner-node[data-id="b"] .outliner-text').click();
        await page.keyboard.press('Meta+a');
        await page.keyboard.press('Meta+a');
        await page.waitForFunction(() =>
            document.querySelectorAll('.outliner-node.is-selected').length >= 3, undefined, { timeout: 3000 });

        await openNodeMenu(page, 'a');
        await openSubmenu(page);
        const call = await page.evaluate(() => {
            const w = window as any;
            w.__testApi.notesMessages.length = 0;
            (document.querySelector('.outliner-context-submenu .outliner-context-menu-item') as HTMLElement).click();
            return w.__testApi.notesMessages.find((m: any) => m.type === 'sendNodesToFolderLink') || null;
        });
        expect(call, 'bridge が呼ばれていない').toBeTruthy();
        // a と b が root（a1 は a の subtree に含まれるので root にしない）
        expect(call.tree.map((t: any) => t.id), `最上位のみになっていない: ${JSON.stringify(call.tree.map((t: any) => t.id))}`)
            .toEqual(['a', 'b']);
    });
});

test.describe('TC-SND-11 0 件 / リンク切れ（FR-SND-04）', () => {
    test('folder link 0 件 → 親項目が disabled + click で通知（無反応にしない）', async ({ page }) => {
        await setup(page, {
            files: [{ filePath: '/n/work.out', title: 'work', id: 'o1', kind: 'out' }],
            structure: { version: 1, rootIds: ['o1'], items: {
                o1: { type: 'file', id: 'o1', title: 'work', ext: 'out', filePath: '/n/work.out' } } },
        });
        await openNodeMenu(page, 'a');
        const item = await sendItemInfo(page);
        expect(item.found, `項目が消えた（disabled で残すのが仕様）。実際: ${item.text}`).toBe(true);
        expect(item.disabled, '0 件なのに disabled でない').toBe(true);

        // click で通知（項目が反応しないだけだと「壊れている」と見える）
        const notices = await page.evaluate(() => {
            const w = window as any;
            w.__testApi.notesMessages.length = 0;
            const items = Array.from(document.querySelectorAll('.outliner-context-menu .outliner-context-menu-item')) as HTMLElement[];
            const hit = items.find((el) => /Send to linkedfd|linkedfd に送る/.test(el.textContent || ''));
            if (hit) { hit.click(); }
            return w.__testApi.notesMessages.filter((m: any) => m.type === 'notifyError');
        });
        expect(notices.length, '0 件クリックで通知が出ない').toBe(1);
    });

    test('リンク切れの folder link はサブメニュー項目が disabled', async ({ page }) => {
        await setup(page);
        await openNodeMenu(page, 'a');
        await openSubmenu(page);
        const states = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.outliner-context-submenu .outliner-context-menu-item'))
                .map((el) => ({
                    name: (el.textContent || '').replace(/^\s*📁\s*/, '').trim(),
                    disabled: el.classList.contains('disabled'),
                })));
        expect(states.find((s) => s.name === 'Archive')?.disabled, 'broken な link が disabled でない').toBe(true);
        expect(states.find((s) => s.name === 'Docs')?.disabled, '正常な link が disabled になっている').toBe(false);
    });

    test('リンク切れ項目のクリックは送らない', async ({ page }) => {
        await setup(page);
        await openNodeMenu(page, 'a');
        await openSubmenu(page);
        const call = await page.evaluate(() => {
            const w = window as any;
            w.__testApi.notesMessages.length = 0;
            const items = Array.from(document.querySelectorAll('.outliner-context-submenu .outliner-context-menu-item')) as HTMLElement[];
            items[2].click();   // Archive（broken）
            return w.__testApi.notesMessages.find((m: any) => m.type === 'sendNodesToFolderLink') || null;
        });
        expect(call, 'broken な link へ送られた').toBeNull();
    });
});

test.describe('TC-SND-12 サブメニューが親の overflow でクリップされない（FR-MFIT-02）', () => {
    test('サブメニューは body 直下・position:fixed で、親 menu の子孫ではない', async ({ page }) => {
        await setup(page);
        await openNodeMenu(page, 'a');
        await openSubmenu(page);
        const dom = await page.evaluate(() => {
            const parent = document.querySelector('.outliner-context-menu:not(.outliner-context-submenu)') as HTMLElement;
            const sub = document.querySelector('.outliner-context-submenu') as HTMLElement;
            return {
                isChildOfParent: !!(parent && sub && parent.contains(sub)),
                parentIsBody: !!(sub && sub.parentElement === document.body),
                position: sub ? getComputedStyle(sub).position : '',
            };
        });
        expect(dom.isChildOfParent,
            'サブメニューが親 menu の子孫にある（max-height + overflow-y:auto でクリップされる）').toBe(false);
        expect(dom.parentIsBody, 'body 直下に出ていない').toBe(true);
        expect(dom.position, 'position:fixed でない').toBe('fixed');
    });

    test('max-height が効く小 viewport でもサブメニュー全体が viewport 内に収まる', async ({ page }) => {
        await page.setViewportSize({ width: 400, height: 300 });
        await setup(page);
        await openNodeMenu(page, 'a');
        // 親 menu に max-height が効いている（FR-MFIT-03）ことを前提として確認
        const parentOverflow = await page.evaluate(() => {
            const p = document.querySelector('.outliner-context-menu:not(.outliner-context-submenu)') as HTMLElement;
            return { maxHeight: p.style.maxHeight, overflowY: p.style.overflowY };
        });
        expect(parentOverflow.maxHeight, '小 viewport で親 menu に max-height が付いていない（前提が崩れている）').toBeTruthy();
        expect(parentOverflow.overflowY).toBe('auto');

        await openSubmenu(page);
        const rect = await page.evaluate(() => {
            const sub = document.querySelector('.outliner-context-submenu') as HTMLElement;
            const r = sub.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
                vw: window.innerWidth, vh: window.innerHeight };
        });
        expect(rect.left, `左が viewport 外: ${rect.left}`).toBeGreaterThanOrEqual(0);
        expect(rect.top, `上が viewport 外: ${rect.top}`).toBeGreaterThanOrEqual(0);
        expect(rect.right, `右が viewport 外: ${rect.right} > ${rect.vw}`).toBeLessThanOrEqual(rect.vw);
        expect(rect.bottom, `下が viewport 外: ${rect.bottom} > ${rect.vh}`).toBeLessThanOrEqual(rect.vh);
    });

    test('本体メニューを閉じるとサブメニューも閉じる（片肺で残らない）', async ({ page }) => {
        await setup(page);
        await openNodeMenu(page, 'a');
        await openSubmenu(page);
        expect(await page.locator('.outliner-context-submenu').count()).toBe(1);
        // Escape / 外側クリックで本体を閉じる
        await page.evaluate(() => { document.body.click(); });
        await page.waitForTimeout(150);
        expect(await page.locator('.outliner-context-submenu').count(),
            'サブメニューが残留した（片肺 close）').toBe(0);
    });
});

test.describe('TC-SND-13 既存 Export folder が併存する（回帰）', () => {
    test('node 右クリックの Export folder... が従来どおり残り exportOutlinerFolder を呼ぶ', async ({ page }) => {
        await setup(page);
        await openNodeMenu(page, 'a');
        const has = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.outliner-context-menu .outliner-context-menu-item')) as HTMLElement[];
            return items.some((el) => /Export folder/.test(el.textContent || ''));
        });
        expect(has, 'Export folder... が消えた（「linkedfd に送る」で置き換えていない）').toBe(true);

        const call = await page.evaluate(() => {
            const w = window as any;
            // Export folder は outlinerHostBridge（sidepanel-bridge-methods）経由 = messages バケツ
            w.__testApi.messages.length = 0;
            const items = Array.from(document.querySelectorAll('.outliner-context-menu .outliner-context-menu-item')) as HTMLElement[];
            const hit = items.find((el) => /Export folder/.test(el.textContent || ''));
            if (hit) { hit.click(); }
            return w.__testApi.messages.find((m: any) => m.type === 'exportOutlinerFolder') || null;
        });
        expect(call, 'Export folder... が exportOutlinerFolder を呼ばない（回帰）').toBeTruthy();
    });

    test('Import 系 3 項目も従来どおり残る（メニューの既存項目を壊していない）', async ({ page }) => {
        await setup(page);
        await openNodeMenu(page, 'a');
        const labels = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.outliner-context-menu .outliner-context-menu-item'))
                .map((el) => (el.textContent || '').trim()));
        for (const want of ['Import .md files', 'Import any files', 'Import folder']) {
            expect(labels.some((l) => l.includes(want)), `${want} が消えた: ${labels.join(' | ')}`).toBe(true);
        }
    });
});
