/**
 * 左ファイルツリー右クリック「Open in new tab」（sprint 20260725-120000-sidepanel-width-note-restore / TASK-04）。
 *
 * md / .out（outliner）の両方で、右クリックメニューに「Open in new tab」が出て、
 * 押すと bridge.openFileInTab(file.filePath) が呼ばれる（standalone スタブは notesMessages に記録）。
 * webview 内タブで開く経路（VS Code タブではない）。
 *
 * ★ TC-OT-03（sprint 20260906-024639 / FR-TF-10/11 rev）: **file item（ext:'file'）にも
 *   「Open in new tab」を表示する**（旧仕様「file はタブ化不可」を撤回）。実処理は id ベースの
 *   新 bridge `openTreeFileInTab`（FR-FTB）。`Copy In-App Link` は**非表示のまま**（アプリ内リンクは
 *   .md/.out の stem 前提で、この前提は失効していない）。
 */
import { test, expect } from '@playwright/test';

const fileList = [
    { filePath: '/test/note-a.md', title: 'NoteA', id: 'note-a' },
    { filePath: '/test/outline-b.out', title: 'OutlineB', id: 'outline-b' },
    // TC-OT-03 / TC-FTB-07: 添付 file item（kind='file'）
    { filePath: '', title: 'spec.pdf', id: 'file-c', kind: 'file' },
];

const structure = {
    version: 1,
    rootIds: ['note-a', 'outline-b', 'file-c'],
    items: {
        'note-a': { type: 'file', id: 'note-a', title: 'NoteA', ext: 'md' },
        'outline-b': { type: 'file', id: 'outline-b', title: 'OutlineB', ext: 'out' },
        'file-c': { type: 'file', id: 'file-c', title: 'spec.pdf', ext: 'file', filename: 'spec.pdf' },
    },
};

test.describe('左ツリー右クリック Open in new tab', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate((s) => {
            (window as any).__testApi.initNotesPanel(s.fileList, '/test/note-a.md', s.structure);
            (window as any).__testApi.notesMessages.length = 0;
        }, { fileList, structure });
    });

    // TC-OT-01: md ファイル右クリック → Open in new tab → bridge.openFileInTab(md path)
    test('TC-OT-01 md 右クリックで Open in new tab → openFileInTab(md)', async ({ page }) => {
        const mdItem = page.locator('.file-panel-item').first();
        await mdItem.click({ button: 'right' });
        await page.waitForTimeout(150);

        const menu = page.locator('.file-panel-context-menu');
        await expect(menu).toBeVisible();
        const openTab = menu.locator('.file-panel-context-item', { hasText: 'Open in new tab' });
        await expect(openTab, 'メニューに Open in new tab が出る').toHaveCount(1);

        await openTab.click();
        await page.waitForTimeout(100);

        const messages = await page.evaluate(() => (window as any).__testApi.notesMessages);
        const hit = messages.find((m: any) => m.type === 'openFileInTab');
        expect(hit, 'openFileInTab が呼ばれた').toBeTruthy();
        expect(hit.filePath).toBe('/test/note-a.md');
    });

    // TC-OT-02: .out（outliner）ファイル右クリックでも同メニュー・同 bridge 呼び出し
    test('TC-OT-02 .out 右クリックで Open in new tab → openFileInTab(.out)', async ({ page }) => {
        const outItem = page.locator('.file-panel-item').nth(1);
        await outItem.click({ button: 'right' });
        await page.waitForTimeout(150);

        const menu = page.locator('.file-panel-context-menu');
        await expect(menu).toBeVisible();
        const openTab = menu.locator('.file-panel-context-item', { hasText: 'Open in new tab' });
        await expect(openTab, '.out でもメニューに Open in new tab が出る').toHaveCount(1);

        await openTab.click();
        await page.waitForTimeout(100);

        const messages = await page.evaluate(() => (window as any).__testApi.notesMessages);
        const hit = messages.find((m: any) => m.type === 'openFileInTab');
        expect(hit, '.out でも openFileInTab が呼ばれた').toBeTruthy();
        expect(hit.filePath).toBe('/test/outline-b.out');
    });
});

test.describe('file item の Open in new tab（FR-TF-10/11 rev / TASK-09）', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate((s) => {
            (window as any).__testApi.initNotesPanel(s.fileList, '/test/note-a.md', s.structure);
            (window as any).__testApi.notesMessages.length = 0;
        }, { fileList, structure });
    });

    async function fileItemMenuLabels(page: import('@playwright/test').Page): Promise<string[]> {
        await page.locator('.file-panel-item[data-file-id="file-c"]').click({ button: 'right' });
        await page.waitForSelector('.file-panel-context-menu', { timeout: 3000 });
        return page.evaluate(() =>
            Array.from(document.querySelectorAll('.file-panel-context-menu .file-panel-context-item'))
                .map((el) => (el.textContent || '').trim()));
    }

    // TC-OT-03: file item メニューの全列挙（表示 = Open in new tab を含む / 非表示 = Copy In-App Link）
    test('TC-OT-03 file item のメニューに Open in new tab があり、Copy In-App Link は無い', async ({ page }) => {
        const items = await fileItemMenuLabels(page);
        for (const label of ['Open', 'Open in new tab', 'Reveal in Finder', 'Rename', 'Copy Path']) {
            expect(items.some((t) => t === label || t.startsWith(label)), `表示: ${label}`).toBe(true);
        }
        // ★ 対で assert（片側だけだと「全部足した」実装も通る）
        expect(items.some((t) => t.includes('Copy In-App Link')), '非表示: Copy In-App Link').toBe(false);
    });

    // TC-FTB-07: 押すと id のみの新 bridge が飛ぶ（絶対パスを載せない）
    test('TC-FTB-07 Open in new tab → openTreeFileInTab(id)（payload は id のみ）', async ({ page }) => {
        await fileItemMenuLabels(page);
        await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('.file-panel-context-menu .file-panel-context-item'));
            const el = els.find((e) => (e.textContent || '').trim() === 'Open in new tab');
            (el as HTMLElement).click();
        });
        await page.waitForTimeout(80);
        const messages = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.notesMessages)));
        const hit = messages.filter((m: any) => m.type === 'openTreeFileInTab');
        expect(hit.length, 'id ベースの新 bridge が 1 回').toBe(1);
        expect(hit[0].id).toBe('file-c');
        expect(Object.keys(hit[0]).sort(), 'payload は type + id のみ').toEqual(['id', 'type']);
        // md/.out 用の filePath bridge に流していない
        expect(messages.filter((m: any) => m.type === 'openFileInTab').length).toBe(0);
    });

    // md / .out のメニュー項目集合が不変（TASK-09 は file item だけを変える）
    test('regression: md item のメニューは従来どおり（Open in new tab あり / Copy In-App Link あり）', async ({ page }) => {
        await page.locator('.file-panel-item[data-file-id="note-a"]').click({ button: 'right' });
        await page.waitForSelector('.file-panel-context-menu', { timeout: 3000 });
        const items = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.file-panel-context-menu .file-panel-context-item'))
                .map((el) => (el.textContent || '').trim()));
        expect(items.some((t) => t.startsWith('Open in new tab'))).toBe(true);
        expect(items.some((t) => t.includes('Copy In-App Link')), 'md は従来どおり表示').toBe(true);
    });
});
