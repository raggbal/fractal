/**
 * 手動テスト第 2 陣（sprint 20260804-145603 TASK-16..19）
 *
 * TC-B09-06  ツリー md → sidepanel md D&D → linkMdAsSubpage(filePath, mdFileId, sidePanelFilePath) 発火
 *            （TASK-17 の webview 配線。同一/別 note 判定は host = unit 側）
 * TC-B19-01  md editor の subpage アンカー dragstart で application/x-fractal-md-subpage が積まれる
 *            （href + sourceMdPath + title）
 * TC-B19-02  通常リンク（data-subpage なし）では積まれない（Link は不可）
 * TC-B19-03  ツリーへの drop で notesRegisterSubpageFromMd(payload, parentId, index) 発火
 */
import { test, expect } from '@playwright/test';

const SUBPAGE_MIME = 'application/x-fractal-md-subpage';

const fileList = [
    { filePath: '/test/other.md', title: 'Other', id: 'mdOther' },
    { filePath: '/test/plan.out', title: 'Plan', id: 'outPlan' },
];
const structure = {
    version: 1,
    rootIds: ['mdOther', 'outPlan'],
    items: {
        mdOther: { type: 'file', id: 'mdOther', title: 'Other', ext: 'md' },
        outPlan: { type: 'file', id: 'outPlan', title: 'Plan', ext: 'out' },
    },
};

async function bootNotes(page: import('@playwright/test').Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ fileList, structure }) => {
        (window as any).__testApi.initNotesPanel(fileList, '/test/plan.out', structure);
    }, { fileList, structure });
    await page.waitForTimeout(150);
    await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
}

test.describe('TASK-17: ツリー md → sidepanel md D&D (standalone-notes)', () => {
    test('TC-B09-06 sidepanel md に tree-md drop → linkMdAsSubpage 発火（sidePanelFilePath 付き）', async ({ page }) => {
        await bootNotes(page);
        // sidepanel md を開く
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'openSidePanel', markdown: '# SP\n\nbody\n',
                filePath: '/other-note/sp.md', fileName: 'sp.md', toc: [], documentBaseUri: '',
            });
        });
        await page.waitForTimeout(400);
        const msgs = await page.evaluate(() => {
            const src = document.querySelector('[data-item-id="mdOther"]') as HTMLElement;
            const spEditor = document.querySelector('.side-panel .editor, .side-panel-iframe-container .editor') as HTMLElement;
            if (!spEditor) return { error: 'no sidepanel editor' };
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const r = spEditor.getBoundingClientRect();
            const x = r.left + r.width / 2, y = r.top + 15;
            spEditor.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
            spEditor.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return JSON.parse(JSON.stringify((window as any).__testApi.notesMessages));
        });
        expect((msgs as any).error).toBeUndefined();
        const link = (msgs as any[]).filter((m: any) => m.type === 'linkMdAsSubpage');
        expect(link.length, 'sidepanel 宛 linkMdAsSubpage が 1 回').toBe(1);
        expect(link[0].filePath).toBe('/test/other.md');
        expect(link[0].mdFileId).toBe('mdOther');
        expect(link[0].sidePanelFilePath).toBe('/other-note/sp.md');
    });
});

test.describe('TASK-19: md editor 内 subpage → ツリー D&D (standalone-notes)', () => {
    async function bootWithMdPane(page: import('@playwright/test').Page) {
        await bootNotes(page);
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md',
                markdown: '# Cur\n\n[[Sub Page]](subpage-x.md)\n\n[normal link](https://example.com)\n',
                filePath: '/test/current.md', documentBaseUri: '',
            });
        });
        await page.waitForTimeout(300);
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
    }

    test('TC-B19-01 subpage アンカー dragstart で md-subpage MIME（href+sourceMdPath）が積まれる', async ({ page }) => {
        await bootWithMdPane(page);
        const payload = await page.evaluate((MIME) => {
            const a = document.querySelector('.markdown-container .editor a[data-subpage="true"]') as HTMLElement;
            if (!a) return { error: 'no subpage anchor' };
            const dt = new DataTransfer();
            a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const raw = dt.getData(MIME);
            a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return raw ? JSON.parse(raw) : null;
        }, SUBPAGE_MIME);
        expect((payload as any)?.error).toBeUndefined();
        expect(payload).not.toBeNull();
        expect((payload as any).href).toContain('subpage-x.md');
        expect((payload as any).sourceMdPath).toBe('/test/current.md');
    });

    test('TC-B19-02 通常リンク（非 subpage）では MIME を積まない', async ({ page }) => {
        await bootWithMdPane(page);
        const raw = await page.evaluate((MIME) => {
            const links = Array.from(document.querySelectorAll('.markdown-container .editor a'));
            const a = links.find(l => !(l as HTMLElement).dataset.subpage) as HTMLElement;
            if (!a) return 'no-normal-link';
            const dt = new DataTransfer();
            a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const v = dt.getData(MIME);
            a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return v;
        }, SUBPAGE_MIME);
        expect(raw).toBe('');
    });

    test('TC-B19-03 ツリー item への drop で notesRegisterSubpageFromMd 発火', async ({ page }) => {
        await bootWithMdPane(page);
        const msgs = await page.evaluate((MIME) => {
            const a = document.querySelector('.markdown-container .editor a[data-subpage="true"]') as HTMLElement;
            const target = document.querySelector('[data-item-id="outPlan"]') as HTMLElement;
            const dt = new DataTransfer();
            a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const r = target.getBoundingClientRect();
            const x = r.left + r.width / 2, y = r.top + r.height * 0.5;
            target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
            target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
            a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return JSON.parse(JSON.stringify((window as any).__testApi.notesMessages));
        }, SUBPAGE_MIME);
        const reg = (msgs as any[]).filter((m: any) => m.type === 'notesRegisterSubpageFromMd');
        expect(reg.length, 'notesRegisterSubpageFromMd が 1 回').toBe(1);
        expect(reg[0].payload.href).toContain('subpage-x.md');
        expect(reg[0].payload.sourceMdPath).toBe('/test/current.md');
    });
});
