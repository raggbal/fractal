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
    rootIds: ['mdOther', 'outPlan', 'dirA', 'dirB'],
    items: {
        // W5: 仮想フォルダ（dirA = 閉じて子なし / dirB = 開いて空 = 子の隙間に落とせる）
        dirA: { type: 'folder', id: 'dirA', title: 'FolderA', childIds: [], collapsed: true },
        dirB: { type: 'folder', id: 'dirB', title: 'FolderB', childIds: [], collapsed: false },
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
            // 2026-09-04（TC-TGT-05）: .out item の**中央帯**は「その outliner へ page node として取込」に変わったため、
            // tree item 登録の契約は**上帯（ratio 0.1）**で見る
            const x = r.left + r.width / 2, y = r.top + r.height * 0.1;
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

/**
 * W5: md の subpage / 📎 リンクを仮想フォルダ行の中央帯（0.25-0.60）へ落とすとフォルダの**中**に入る
 *（以前は subpage = targetSp.dataset.parentId、📎 = computeSiblingInsert で常に兄弟）。
 * 本番の dragstart（editor.js）が積んだ DataTransfer をそのまま tree へ流す。
 */
test.describe('W5: md のリンク → ツリーのフォルダ行 / 子の隙間', () => {
    async function bootWithLinks(page: import('@playwright/test').Page) {
        await bootNotes(page);
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md',
                markdown: '# Cur\n\n[[Sub Page]](subpage-x.md)\n\n[📎 x.pdf](files/x.pdf)\n',
                filePath: '/test/current.md', documentBaseUri: '',
            });
        });
        await page.waitForSelector('.markdown-container .editor a[data-is-file-attachment="true"]', { timeout: 5000 });
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
    }
    /** anchorSel から本番 dragstart → dstSel の ratio 位置に dragover / drop。host への message を返す */
    async function dragLinkTo(page: import('@playwright/test').Page, anchorSel: string, dstSel: string, ratio: number) {
        return page.evaluate(({ anchorSel, dstSel, ratio }) => {
            (window as any).__testApi.notesMessages.length = 0;
            const a = document.querySelector(anchorSel) as HTMLElement;
            const dst = document.querySelector(dstSel) as HTMLElement;
            if (!a || !dst) { return [{ type: 'NO-ELEMENT' }]; }
            const dt = new DataTransfer();
            a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const r = dst.getBoundingClientRect();
            const x = r.left + Math.min(20, r.width / 2), y = r.top + r.height * ratio;
            const ov = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y });
            dst.dispatchEvent(ov);
            dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
            a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            const msgs = JSON.parse(JSON.stringify((window as any).__testApi.notesMessages));
            return msgs.concat([{ type: '__dragoverPrevented', value: ov.defaultPrevented }]);
        }, { anchorSel, dstSel, ratio });
    }
    const SUB_A = '.markdown-container .editor a[data-subpage="true"]';
    const FILE_A = '.markdown-container .editor a[data-is-file-attachment="true"]';
    const HEADER_A = '.file-panel-folder[data-item-id="dirA"] > .file-panel-folder-header';
    const GAP_B = '.file-panel-folder[data-item-id="dirB"] > .file-panel-folder-children';

    test('TC-W5-03 subpage → フォルダ行の中央帯 = フォルダの中 / 上帯 = 兄弟（従来）', async ({ page }) => {
        await bootWithLinks(page);
        const m = (await dragLinkTo(page, SUB_A, HEADER_A, 0.45)).filter((x: any) => x.type === 'notesRegisterSubpageFromMd');
        expect(m.length).toBe(1);
        expect(m[0].parentId, 'フォルダの兄弟に入った').toBe('dirA');
        expect(m[0].index).toBe(0);
        const up = (await dragLinkTo(page, SUB_A, HEADER_A, 0.1)).filter((x: any) => x.type === 'notesRegisterSubpageFromMd');
        expect(up[0].parentId).toBeNull();
        expect(up[0].index).toBe(structure.rootIds.indexOf('dirA'));
    });

    test('TC-W5-04 📎 → フォルダ行の中央帯 = フォルダの中', async ({ page }) => {
        await bootWithLinks(page);
        const m = (await dragLinkTo(page, FILE_A, HEADER_A, 0.45)).filter((x: any) => x.type === 'notesRegisterFileFromMdLink');
        expect(m.length).toBe(1);
        expect(m[0].parentId, 'フォルダの兄弟に入った').toBe('dirA');
        expect(m[0].payload.href).toContain('x.pdf');
    });

    test('TC-W5-05 subpage / 📎 → 開いた空フォルダの子の隙間 = フォルダの中', async ({ page }) => {
        await bootWithLinks(page);
        for (const [sel, type] of [[SUB_A, 'notesRegisterSubpageFromMd'], [FILE_A, 'notesRegisterFileFromMdLink']]) {
            const all = await dragLinkTo(page, sel, GAP_B, 0.5);
            expect(all.find((x: any) => x.type === '__dragoverPrevented').value, `${type}: 子の隙間が drag を受けない`).toBe(true);
            const m = all.filter((x: any) => x.type === type);
            expect(m.length, `${type} が飛ばない`).toBe(1);
            expect(m[0].parentId).toBe('dirB');
            expect(m[0].index).toBe(0);
        }
    });
});
