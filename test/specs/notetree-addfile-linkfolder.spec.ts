/**
 * TC-FTM-01/02（webview 側）— +file ボタン + New link folder（sprint 20260818-183407 FR-FTM-01/02）
 *
 * New link folder は「共通項目（New Outline here 等）が出る全メニュー」= item 種別 3 分岐
 * （md・out / file / folder link）+ 実フォルダ分岐、に共通 4 項目目として表示
 * （master FR-TF-10/11・FR-FLV-06/07 の「item 種別メニューにも共通項目表示」と整合 —
 *  requirement FR-FTM-02 の全列挙が唯一の正。counterfactual: 一部分岐だけの配線 = 残分岐 RED）。
 */
import { test, expect, Page } from '@playwright/test';

const STRUCTURE = {
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
const FILES = [
    { filePath: '/Users/test/notes/o1.out', title: 'out item', id: 'o1', kind: 'out' },
    { filePath: '/Users/test/notes/m1.md', title: 'md item', id: 'm1', kind: 'md' },
    { filePath: '', title: 'file item', id: 'f1', kind: 'file' },
    { filePath: '', title: 'link folder', id: 'lk1', kind: 'folder' },
];

async function setupPanel(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ files, structure }) => {
        (window as any).__testApi.initNotesPanel(files, '/Users/test/notes/o1.out', structure);
    }, { files: FILES, structure: STRUCTURE });
    await page.waitForTimeout(200);
}

async function menuLabelsFor(page: Page, title: string) {
    await page.evaluate(() => {
        const m = document.querySelector('.file-panel-context-menu');
        if (m) m.remove();
    });
    const item = page.locator(`.file-panel-item:has-text("${title}"), .file-panel-folder-header:has-text("${title}")`).first();
    await item.click({ button: 'right' });
    await page.waitForTimeout(150);
    return page.locator('.file-panel-context-menu .file-panel-context-item').allTextContents();
}

test('TC-FTM-02w New link folder が全 4 分岐（md/out・file・folder link・実フォルダ）に表示される', async ({ page }) => {
    await setupPanel(page);
    for (const title of ['out item', 'file item', 'link folder', 'real folder']) {
        const labels = await menuLabelsFor(page, title);
        expect(labels.join('|'), `${title} 分岐に New link folder 不在`).toContain('New link folder');
    }
});

test('TC-FTM-02c New link folder click → addFolderLink がその場所（parentId）付きで送出', async ({ page }) => {
    await setupPanel(page);
    await menuLabelsFor(page, 'real folder');
    const sent = await page.evaluate(() => {
        (window as any).__testApi.notesMessages.length = 0;
        const items = Array.from(document.querySelectorAll('.file-panel-context-menu .file-panel-context-item'));
        const target = items.find((it) => ((it as HTMLElement).textContent || '').includes('New link folder')) as HTMLElement;
        if (target) target.click();
        return JSON.parse(JSON.stringify((window as any).__testApi.notesMessages));
    });
    const hit = sent.filter((m: any) => m.type === 'addFolderLink');
    expect(hit.length).toBe(1);
    expect(hit[0].parentId).toBe('dir1'); // 実フォルダ分岐はそのフォルダ内へ登録
});

test('TC-FTM-01w +file ボタン click → addTreeFilesViaDialog 送出（ヘッダに +file ボタン実在）', async ({ page }) => {
    await setupPanel(page);
    const btn = page.locator('#filePanelAddFileEntity');
    await expect(btn).toBeVisible();
    const sent = await page.evaluate(() => {
        (window as any).__testApi.notesMessages.length = 0;
        (document.getElementById('filePanelAddFileEntity') as HTMLElement).click();
        return JSON.parse(JSON.stringify((window as any).__testApi.notesMessages));
    });
    // harness は初期化 + initNotesPanel の 2 回 wiring 関数が走る（+out/+md/+linkfd と同じ既存構造）
    // — 本番は 1 回。ここでは「click で送出される」配線の実在を pin する
    expect(sent.filter((m: any) => m.type === 'addTreeFilesViaDialog').length).toBeGreaterThanOrEqual(1);
});

// ─── TC-FTM-07: Duplicate のメニュー表示裁定（FR-FTM-03・TASK-15） ───

test('TC-FTM-07 Duplicate は out/md/file 分岐に表示・folder link / 実フォルダには非表示 + click 送出', async ({ page }) => {
    await setupPanel(page);
    for (const title of ['out item', 'md item', 'file item']) {
        const labels = await menuLabelsFor(page, title);
        expect(labels.join('|'), `${title} 分岐に Duplicate 不在`).toContain('Duplicate');
    }
    // requirement の非表示裁定（folder link は参照のみ・実フォルダは OS 側操作）
    for (const title of ['link folder', 'real folder']) {
        const labels = await menuLabelsFor(page, title);
        expect(labels.some((l) => l.trim() === 'Duplicate'), `${title} 分岐に Duplicate が誤表示`).toBe(false);
    }
    // click → duplicateTreeItem(id) 送出
    await menuLabelsFor(page, 'md item');
    const sent = await page.evaluate(() => {
        (window as any).__testApi.notesMessages.length = 0;
        const items = Array.from(document.querySelectorAll('.file-panel-context-menu .file-panel-context-item'));
        const target = items.find((it) => ((it as HTMLElement).textContent || '').trim() === 'Duplicate') as HTMLElement;
        if (target) target.click();
        return JSON.parse(JSON.stringify((window as any).__testApi.notesMessages));
    });
    const hit = sent.filter((m: any) => m.type === 'duplicateTreeItem');
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit[0].id).toBe('m1');
});
