/**
 * FR-TH-01/02 (note md tree title ↔ H1) の webview→host メッセージ配線 E2E。
 * host 側の実効果（renameTitle が md H1 を書換 / syncTitleFromH1 が items.title 更新）は
 * unit（notes-file-manager-title-h1.spec.ts）で担保。ここは「rename が host に届く」ことを確認。
 */
import { test, expect, Page } from '@playwright/test';

const fileList = [{ filePath: '/test/n1.md', title: 'Note One', id: 'n1' }];
const structure = {
    version: 1,
    rootIds: ['n1'],
    items: { n1: { type: 'file', id: 'n1', title: 'Note One', ext: 'md' } },
};

async function initPanel(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ fileList, structure }) => {
        (window as any).__testApi.initNotesPanel(fileList, '/test/n1.md', structure);
    }, { fileList, structure });
    await page.waitForTimeout(150);
}

test.describe('FR-TH-01/02 note md rename → host (standalone-notes)', () => {
    // TC-TH-20: ファイルツリーで note md を rename → renameTitle メッセージが新 title で飛ぶ
    test('TC-TH-20 note md rename で renameTitle が新 title 付きで送出', async ({ page }) => {
        await initPanel(page);
        const r = await page.evaluate(() => {
            (window as any).__testApi.notesMessages = [];
            const item = document.querySelector('.file-panel-item[data-item-id="n1"]') as HTMLElement;
            item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            const input = item.querySelector('.file-panel-rename-input') as HTMLInputElement;
            if (!input) return { err: 'no input' };
            input.value = 'Renamed Note';
            // 確定 Enter（IME 非変換）
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            const msgs = ((window as any).__testApi.notesMessages || []).filter((m: any) => m.type === 'renameTitle');
            return { err: null, count: msgs.length, title: msgs[0]?.newTitle };
        });
        expect(r.err).toBeNull();
        expect(r.count, 'renameTitle が 1 回送出').toBe(1);
        expect(r.title).toBe('Renamed Note');
    });

    // TC-TH-21: メインペインで note md を開き先頭 H1 を実キー編集 → notesSaveCurrentMd の content に編集後 H1 が乗る
    // （host 側の title 反映は unit TC-TH-04 でカバー。E2E は webview→host 配線まで＝送出 content に H1 が乗ることを確認）
    const MD_FILE = '/Users/test/notes/noteA/n1.md';
    test('TC-TH-21 メインペイン H1 編集で notesSaveCurrentMd の content に H1 が乗る', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        // dispatcher 経由でメインペインに md を開く（editor が notesMarkdownHostBridge に配線される）
        await page.evaluate(({ fp }) => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md', markdown: '# Old H1\n\nbody\n', filePath: fp, documentBaseUri: '',
            });
        }, { fp: MD_FILE });
        await page.waitForTimeout(300);

        // 実クリックで H1 行末にキャレット → 実キーで H1 を編集
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        const editor = page.locator('.markdown-container .editor');
        // H1 行（見出し要素）をクリックして編集モードに入り、行末で追記
        await editor.locator('h1').first().click();
        await page.keyboard.press('End');
        await page.keyboard.type(' EDIT'); // "# Old H1" → "# Old H1 EDIT"
        // 編集確定（blur）— syncContent は編集確定/idle で flush される（FR: 編集確定時）
        await page.locator('body').click({ position: { x: 3, y: 3 } });
        await page.waitForTimeout(500);

        const msgs = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'notesSaveCurrentMd'));
        expect(msgs.length, 'notesSaveCurrentMd が送出される').toBeGreaterThanOrEqual(1);
        const last = msgs[msgs.length - 1];
        // 送出 content の先頭 H1 に編集が反映されている
        expect(last.content, 'content 先頭 H1 に編集後テキストが乗る').toContain('Old H1 EDIT');
        expect(last.content.split('\n')[0], '先頭行が編集後 H1').toContain('# Old H1 EDIT');
    });
});
