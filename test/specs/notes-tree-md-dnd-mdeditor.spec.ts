/**
 * FR-B09 (sprint 20260804-145603 TASK-08) — ファイルツリーの md item → Note md editor D&D
 *
 * FR-B08 と同じ drag payload（application/x-fractal-tree-md）を Notes md editor が受け、
 * (7) FR-B07 適用後の挙動 = subpage リンク挿入。ただしファイルは note 内に既存のため
 * **コピーせず** host が既存 md への相対パス + title を解決して insertSubpageLink を返す。
 *
 * TC-B09-01  md pane に tree-md payload を drop → notesMdLinkMdAsSubpage(filePath) 送出
 *            （saveMdAsSubpage/添付は送らない = コピーしない）
 * TC-B09-02  insertSubpageLink 受信 → md pane に subpage リンクが挿入され serialize が [[title]](file.md)
 * TC-B09-03  (unit) linkMdAsSubpage の title 解決 = resolveSubpageTitle（H1 → stem・[] 除去）
 */
import { test, expect } from '@playwright/test';

const fileList = [
    { filePath: '/test/other.md', title: 'Other', id: 'mdOther' },
    { filePath: '/test/current.md', title: 'Current', id: 'mdCur' },
];
const structure = {
    version: 1,
    rootIds: ['mdOther', 'mdCur'],
    items: {
        mdOther: { type: 'file', id: 'mdOther', title: 'Other', ext: 'md' },
        mdCur: { type: 'file', id: 'mdCur', title: 'Current', ext: 'md' },
    },
};

async function bootMdPane(page: import('@playwright/test').Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ fileList, structure }) => {
        (window as any).__testApi.initNotesPanel(fileList, '/test/current.md', structure);
        // main md ペインを開く（FR-B06 spec と同じ dispatcher 経由）
        (window as any).__hostMessageHandler({
            type: 'updateData', kind: 'md', markdown: '# Current\n\nbody\n',
            filePath: '/test/current.md', documentBaseUri: '',
        });
    }, { fileList, structure });
    await page.waitForTimeout(300);
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
}

test.describe('FR-B09: ファイルツリー md → Note md editor D&D (standalone-notes)', () => {
    test.beforeEach(async ({ page }) => { await bootMdPane(page); });

    test('TC-B09-01 md pane への tree-md drop → linkMdAsSubpage（コピー系は送らない）', async ({ page }) => {
        const msgs = await page.evaluate(() => {
            const src = document.querySelector('[data-item-id="mdOther"]') as HTMLElement;
            const editor = document.querySelector('.markdown-container .editor') as HTMLElement;
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const r = editor.getBoundingClientRect();
            const x = r.left + r.width / 2, y = r.top + 20;
            editor.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
            editor.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return JSON.parse(JSON.stringify((window as any).__testApi.messages));
        });
        const link = msgs.filter((m: any) => m.type === 'notesMdLinkMdAsSubpage');
        expect(link.length, 'linkMdAsSubpage が 1 回').toBe(1);
        expect(link[0].filePath).toBe('/test/other.md');
        // コピー・添付系は送らない（既存ファイル 1:1 所有を保つ）
        expect(msgs.filter((m: any) => /saveMdAsSubpage|notesMdSaveFile|saveFileAndInsert/.test(m.type)).length).toBe(0);
    });

    test('TC-B09-02 insertSubpageLink 受信 → subpage リンク挿入・serialize [[title]](file.md)', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'insertSubpageLink',
                markdownPath: 'other.md',
                title: 'Other Doc',
            });
        });
        await page.waitForTimeout(150);
        const link = page.locator('.markdown-container .editor a[data-subpage="true"]');
        await expect(link).toHaveCount(1);
        await expect(link).toHaveText('Other Doc');
        const md = await page.evaluate(() =>
            (window as any).__testApi.mdDispatcher.getMdInstance()?.getMarkdown?.() ?? null);
        if (md !== null) {
            expect(md).toContain('[[Other Doc]](other.md)');
        }
    });
});

test.describe('FR-B09 unit: title 解決（resolveSubpageTitle）', () => {
    const utils = require('../../out/shared/md-subpage-utils');

    test('TC-B09-03 H1 優先・無ければ stem・[] 除去', () => {
        expect(utils.resolveSubpageTitle('# My Doc\nbody', 'other.md')).toBe('My Doc');
        expect(utils.resolveSubpageTitle('no h1', 'other.md')).toBe('other');
        expect(utils.resolveSubpageTitle('# Bad ]Ti[tle\n', 'x.md')).toBe('Bad Title');
    });
});
