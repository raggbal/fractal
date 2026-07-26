/**
 * notes-file-panel-rename-ime — rename 入力の IME 変換確定 Enter を無視する（FR-IME-01/02）
 *
 * IME 変換中（isComposing=true / keyCode=229）の Enter で rename/検索を確定しないことを検証。
 * 実 IME フローは synthetic event で完全再現できない（designer_failures 2026-04-21）ため、
 * KeyboardEvent の isComposing/keyCode を直接持たせて分岐（ガード）を検証する。実フローは手動 US。
 */
import { test, expect, Page } from '@playwright/test';

const fileList = [
    { filePath: '/test/fileA.out', title: 'FileA', id: 'fileA' },
];
const structure = {
    version: 1,
    rootIds: ['folderA', 'fileA'],
    items: {
        folderA: { type: 'folder', id: 'folderA', title: 'FolderA', childIds: [], collapsed: false },
        fileA: { type: 'file', id: 'fileA', title: 'FileA' },
    },
};

async function initPanel(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ fileList, structure }) => {
        (window as any).__testApi.initNotesPanel(fileList, '/test/fileA.out', structure);
    }, { fileList, structure });
    await page.waitForTimeout(150);
}

// rename 入力を開いて値を入れ、指定オプションの Enter keydown を dispatch → renameTitle が呼ばれた回数を返す
async function renameFileAndEnter(page: Page, keyOpts: Record<string, unknown>) {
    return page.evaluate(({ opts }) => {
        (window as any).__testApi.notesMessages = [];
        const item = document.querySelector('.file-panel-item[data-item-id="fileA"]') as HTMLElement;
        item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const input = item.querySelector('.file-panel-rename-input') as HTMLInputElement;
        if (!input) return { err: 'no rename input', calls: -1 };
        input.value = 'NewName';
        input.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: 'Enter', bubbles: true }, opts)));
        const calls = ((window as any).__testApi.notesMessages || []).filter((m: any) => m.type === 'renameTitle').length;
        return { err: null, calls, stillEditing: !!item.querySelector('.file-panel-rename-input') };
    }, { opts: keyOpts });
}

test.describe('file-panel rename IME guard (FR-IME-01/02)', () => {
    test('TC-IME-01: IME 変換中(isComposing) の Enter は rename 確定しない（load-bearing）', async ({ page }) => {
        await initPanel(page);
        // 同一 rename input で「変換中 Enter → まだ確定しない」→「確定 Enter → 確定する」を連続検証
        // （dblclick を 2 回すると blur 経由の finish が混入するため 1 フローに統一）
        const r = await page.evaluate(() => {
            (window as any).__testApi.notesMessages = [];
            const item = document.querySelector('.file-panel-item[data-item-id="fileA"]') as HTMLElement;
            item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            const input = item.querySelector('.file-panel-rename-input') as HTMLInputElement;
            if (!input) return { err: 'no rename input', composing: -1, stillEditing: false, plain: -1 };
            input.value = 'NewName';
            // (1) IME 変換中 Enter → 確定しない
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
            const composing = ((window as any).__testApi.notesMessages || []).filter((m: any) => m.type === 'renameTitle').length;
            const stillEditing = !!item.querySelector('.file-panel-rename-input');
            // (2) 確定 Enter → 確定する（counterfactual: ガードが load-bearing）
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: false, bubbles: true }));
            const plain = ((window as any).__testApi.notesMessages || []).filter((m: any) => m.type === 'renameTitle').length;
            return { err: null as string | null, composing, stillEditing, plain };
        });
        expect(r.err).toBeNull();
        expect(r.composing, 'isComposing:true の Enter では renameTitle が呼ばれない').toBe(0);
        expect(r.stillEditing, 'まだ編集中（確定していない）').toBe(true);
        expect(r.plain, 'counterfactual: isComposing:false の Enter で renameTitle が呼ばれる').toBe(1);
    });

    test('TC-IME-02: keyCode 229（isComposing 立たない IME 保険）の Enter も無視', async ({ page }) => {
        await initPanel(page);
        const r = await renameFileAndEnter(page, { keyCode: 229 });
        expect(r.calls, 'keyCode:229 の Enter では renameTitle が呼ばれない').toBe(0);
        expect(r.stillEditing).toBe(true);
    });

    test('TC-IME-03: フォルダ rename も IME ガードが効く', async ({ page }) => {
        await initPanel(page);
        const r = await page.evaluate(() => {
            (window as any).__testApi.notesMessages = [];
            const header = document.querySelector('.file-panel-folder[data-folder-id="folderA"] > .file-panel-folder-header') as HTMLElement;
            header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            const input = header.querySelector('.file-panel-rename-input') as HTMLInputElement;
            if (!input) return { err: 'no folder rename input', composing: -1, plain: -1 };
            input.value = 'NewFolder';
            // IME 変換中 Enter → 確定しない
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
            const composing = ((window as any).__testApi.notesMessages || []).filter((m: any) => m.type === 'renameFolder').length;
            // 確定 Enter → 確定する
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: false, bubbles: true }));
            const plain = ((window as any).__testApi.notesMessages || []).filter((m: any) => m.type === 'renameFolder').length;
            return { err: null, composing, plain };
        });
        expect(r.err).toBeNull();
        expect(r.composing, 'フォルダ: isComposing 中は renameFolder なし').toBe(0);
        expect(r.plain, 'フォルダ: 確定 Enter で renameFolder').toBe(1);
    });
});
