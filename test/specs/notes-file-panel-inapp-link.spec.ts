/**
 * FR-B04 / FR-B06 — 「アプリ内リンクをコピー」（Copy in-App Link）E2E
 *
 * FR-B04: Note ファイルツリーの右クリックメニューに、.out / .md ファイル行のみ
 *   「Copy in-App Link」を追加。フォルダ行には出さない。
 *   clipboard = [title](link)（title の [] 除去）。
 *   out → InAppLinkUtils.buildOutLink(folder, id)  = fractal://note/{folder}/{id}
 *   md  → InAppLinkUtils.buildMdLink(folder, id)    = fractal://note/{folder}/md/{id}
 *
 * FR-B06: md エディタ toolbar（Copy Path の右）に data-action="copyInAppLink" ボタン。
 *   Notes モード（.notes-layout あり）かつ main md filePath が note md のときだけ表示。
 *   standalone editor（.notes-layout 無し）では非表示のまま。
 *   click → clipboard [title](buildMdLink(folder, mdFileId))。
 *
 * リンク文字列は src/shared/inapp-link-utils.js（TASK-02b）が唯一の生成元。
 * この spec は「file-panel / toolbar が InAppLinkUtils を正しい引数で呼び clipboard に載せる」
 * ことを検証する（リンク文法そのものの網羅は inapp-link-utils の unit が担う）。
 */
import { test, expect, Page } from '@playwright/test';

// ---- FR-B04: file-tree 右クリック（standalone-notes.html）----

const FOLDER = 'noteA';

const FILE_LIST = [
    { filePath: '/Users/test/notes/noteA/foo.out', title: 'Foo Out', id: 'foo' },
    { filePath: '/Users/test/notes/noteA/bar.md', title: 'Bar [MD]', id: 'bar' },
];
const STRUCTURE = {
    version: 1,
    rootIds: ['dir1', 'foo', 'bar'],
    items: {
        dir1: { type: 'folder', id: 'dir1', title: 'Sub Folder', childIds: [] },
        foo: { type: 'file', id: 'foo', title: 'Foo Out', ext: 'out' },
        bar: { type: 'file', id: 'bar', title: 'Bar [MD]', ext: 'md' },
    },
};

async function initPanel(page: Page, folderName: string = FOLDER) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ fileList, structure, currentFile, folderName }) => {
        (window as any).__testApi.initNotesPanel(fileList, currentFile, structure, null, folderName);
    }, { fileList: FILE_LIST, structure: STRUCTURE, currentFile: '/Users/test/notes/noteA/foo.out', folderName });
    await page.waitForTimeout(150);
}

// copyInAppLink 項目のラベル（全 locale 網羅）
const COPY_INAPP_RE = /Copy in-App Link|Copy In-App Link|アプリ内リンクをコピー|앱 내 링크 복사|复制应用内链接|複製應用內連結|Copier le lien interne|Copiar enlace interno/i;

test.describe('FR-B04: file-tree Copy in-App Link (standalone-notes)', () => {
    test.beforeEach(async ({ context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    });

    test('TC-B04-01: .out ファイル右クリック → buildOutLink 形式の [title](link) を clipboard へ', async ({ page }) => {
        await initPanel(page);

        const outItem = page.locator('.file-panel-item[data-item-id="foo"]');
        await expect(outItem).toBeVisible();
        await outItem.click({ button: 'right' });
        await page.waitForTimeout(150);

        const menu = page.locator('.file-panel-context-menu');
        await expect(menu).toBeVisible();
        const copyItem = menu.locator('.file-panel-context-item').filter({ hasText: COPY_INAPP_RE });
        await expect(copyItem, 'Copy in-App Link 項目が .out 行に存在').toHaveCount(1);
        await copyItem.click();
        await page.waitForTimeout(150);

        // 期待リンクは InAppLinkUtils.buildOutLink を実際に呼んで導出（ハードコードしない）
        const expected = await page.evaluate(({ folder }) =>
            '[Foo Out](' + (window as any).InAppLinkUtils.buildOutLink(folder, 'foo') + ')', { folder: FOLDER });
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        expect(clip).toBe(expected);
        // out link は fractal://note/{folder}/{id}（md セグメント無し）
        expect(clip).toContain('fractal://note/noteA/foo');
        expect(clip).not.toContain('/md/');
    });

    test('TC-B04-02: .md ファイル右クリック → buildMdLink 形式（/md/）+ title の [] 除去', async ({ page }) => {
        await initPanel(page);

        const mdItem = page.locator('.file-panel-item[data-item-id="bar"]');
        await expect(mdItem).toBeVisible();
        await mdItem.click({ button: 'right' });
        await page.waitForTimeout(150);

        const menu = page.locator('.file-panel-context-menu');
        const copyItem = menu.locator('.file-panel-context-item').filter({ hasText: COPY_INAPP_RE });
        await expect(copyItem, 'Copy in-App Link 項目が .md 行に存在').toHaveCount(1);
        await copyItem.click();
        await page.waitForTimeout(150);

        const expectedLink = await page.evaluate(({ folder }) =>
            (window as any).InAppLinkUtils.buildMdLink(folder, 'bar'), { folder: FOLDER });
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        // md link は /md/ セグメント付き
        expect(expectedLink).toContain('fractal://note/noteA/md/bar');
        // title 'Bar [MD]' の [] は除去され 'Bar MD' になる
        expect(clip).toBe('[Bar MD](' + expectedLink + ')');
        expect(clip).not.toMatch(/[\[\]]MD/); // 角括弧が title 側に残っていない
    });

    test('TC-B04-03: フォルダ行の右クリックには Copy in-App Link が出ない（counterfactual）', async ({ page }) => {
        await initPanel(page);

        const folderHeader = page.locator('.file-panel-folder[data-folder-id="dir1"] .file-panel-folder-header');
        await expect(folderHeader).toBeVisible();
        await folderHeader.click({ button: 'right' });
        await page.waitForTimeout(150);

        const menu = page.locator('.file-panel-context-menu');
        await expect(menu).toBeVisible();
        // フォルダメニューには他項目（New Outline 等）はあるが Copy in-App Link は無い
        const allItems = await menu.locator('.file-panel-context-item').allTextContents();
        expect(allItems.length, 'フォルダメニューに項目はある').toBeGreaterThan(0);
        const copyItemCount = await menu.locator('.file-panel-context-item').filter({ hasText: COPY_INAPP_RE }).count();
        expect(copyItemCount, 'フォルダ行に Copy in-App Link は出ない').toBe(0);
    });
});

// ---- FR-B06: md エディタ toolbar ボタン ----

const MD_FILE = '/Users/test/notes/noteA/mypage.md';

async function openMdPane(page: Page, markdown: string, filePath: string = MD_FILE) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    // dispatcher 経由で main md ペインを開く（EditorInstance が options.filePath 付きで生成される）
    await page.evaluate(({ fp, md }) => {
        (window as any).__hostMessageHandler({
            type: 'updateData', kind: 'md', markdown: md, filePath: fp, documentBaseUri: '',
        });
    }, { fp: filePath, md: markdown });
    await page.waitForTimeout(300);
}

test.describe('FR-B06: md editor toolbar Copy in-App Link button', () => {
    test.beforeEach(async ({ context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    });

    test('TC-B06-01: Notes モードで note md を開くと toolbar に copyInAppLink ボタンが表示される', async ({ page }) => {
        await openMdPane(page, '# My Page\n\nbody\n');
        // .notes-layout に folder 名を注入（本番 notesWebviewContent 相当）
        await page.evaluate(({ folder }) => {
            const el = document.querySelector('.notes-layout') as HTMLElement | null;
            if (el) el.dataset.noteFolderName = folder;
        }, { folder: FOLDER });

        const btn = page.locator('.markdown-container [data-action="copyInAppLink"]');
        await expect(btn, 'Notes md ペインで copyInAppLink ボタンが可視').toBeVisible();
    });

    test('TC-B06-02: click → [H1 title](buildMdLink(folder, mdFileId)) を clipboard へ', async ({ page }) => {
        await openMdPane(page, '# My Page\n\nbody\n');
        await page.evaluate(({ folder }) => {
            const el = document.querySelector('.notes-layout') as HTMLElement | null;
            if (el) el.dataset.noteFolderName = folder;
        }, { folder: FOLDER });

        const btn = page.locator('.markdown-container [data-action="copyInAppLink"]');
        await expect(btn).toBeVisible();
        await btn.click();
        await page.waitForTimeout(150);

        const expectedLink = await page.evaluate(({ folder }) =>
            (window as any).InAppLinkUtils.buildMdLink(folder, 'mypage'), { folder: FOLDER });
        expect(expectedLink).toContain('fractal://note/noteA/md/mypage');
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        // 表示テキストは先頭 H1（'My Page'）、mdFileId は filePath basename から '.md' を除いた 'mypage'
        expect(clip).toBe('[My Page](' + expectedLink + ')');
    });

    test('TC-B06-03: H1 が無い md は mdFileId を表示テキストにフォールバック', async ({ page }) => {
        await openMdPane(page, 'just body, no heading\n');
        await page.evaluate(({ folder }) => {
            const el = document.querySelector('.notes-layout') as HTMLElement | null;
            if (el) el.dataset.noteFolderName = folder;
        }, { folder: FOLDER });

        const btn = page.locator('.markdown-container [data-action="copyInAppLink"]');
        await expect(btn).toBeVisible();
        await btn.click();
        await page.waitForTimeout(150);

        const expectedLink = await page.evaluate(({ folder }) =>
            (window as any).InAppLinkUtils.buildMdLink(folder, 'mypage'), { folder: FOLDER });
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        expect(clip).toBe('[mypage](' + expectedLink + ')');
    });

    test('TC-B06-04: standalone editor（.notes-layout 無し）では copyInAppLink ボタンが見えない（counterfactual）', async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);

        // standalone-editor.html には real .notes-layout 要素が無い（= Notes 外環境）
        const notesLayoutCount = await page.locator('.notes-layout').count();
        expect(notesLayoutCount, 'standalone editor に .notes-layout は無い').toBe(0);

        // Notes 外では copyInAppLink ボタンはユーザーに見えない
        // （editor.js 自前 toolbar には元々無く、reveal も .notes-layout 不在で発火しない。
        //  toBeHidden は「DOM 非存在 or display:none」の両方を pass）。
        const btn = page.locator('[data-action="copyInAppLink"]');
        await expect(btn, 'Notes 外では copyInAppLink ボタンが可視でない').toBeHidden();
    });

    test('TC-B06-05: note md ペインでも filePath が .md でなければボタンは非表示のまま（reveal gate が load-bearing）', async ({ page }) => {
        // 同じ標準 md ペイン template（copyInAppLink ボタンは DOM に存在・display:none）だが、
        // reveal 条件（.notes-layout あり かつ options.filePath が .md）の .md 側を満たさない filePath で開く。
        // → reveal が発火せず button は display:none のまま = filePath .md ゲートが load-bearing。
        await openMdPane(page, '# Not Md File\n', '/Users/test/notes/noteA/mypage.txt');
        await page.evaluate(({ folder }) => {
            const el = document.querySelector('.notes-layout') as HTMLElement | null;
            if (el) el.dataset.noteFolderName = folder;
        }, { folder: FOLDER });

        const btn = page.locator('.markdown-container [data-action="copyInAppLink"]');
        // ボタン要素は md ペイン template 共有なので DOM には存在する
        await expect(btn, 'md ペイン template のボタン要素は DOM に存在').toHaveCount(1);
        // だが filePath が .md でないので reveal されず非表示
        await expect(btn, 'filePath が .md でないので非表示のまま').toBeHidden();
    });
});
