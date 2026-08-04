/**
 * bug-fix 2026-08-05 — D&D 直後の 1 回目 click が無視される
 *
 * 原因: D&D 応答の notesFileListChanged → renderTree() が item を全再構築し、
 * mousedown〜mouseup の間に要素が差し替わると click 合成イベントが発火しない。
 *
 * TC-CLK-01  mousedown 後に renderTree（notesFileListChanged）が走っても、mouseup で
 *            openFile が発火する（pointerup 保険。counterfactual: click 依存のみだと 0 発火 = RED）
 * TC-CLK-02  通常 click は従来どおり 1 回だけ発火（pointerup 保険との二重送信なし）
 * TC-CLK-03  drag セッション（dragstart 済み）では pointerup で openFile しない
 */
import { test, expect } from '@playwright/test';

const fileList = [
    { filePath: '/test/a.md', title: 'A', id: 'mdA' },
    { filePath: '/test/b.out', title: 'B', id: 'outB' },
];
const structure = {
    version: 1, rootIds: ['mdA', 'outB'],
    items: {
        mdA: { type: 'file', id: 'mdA', title: 'A', ext: 'md' },
        outB: { type: 'file', id: 'outB', title: 'B', ext: 'out' },
    },
};

async function boot(page: import('@playwright/test').Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ fileList, structure }) => {
        (window as any).__testApi.initNotesPanel(fileList, '/test/a.md', structure);
    }, { fileList, structure });
    await page.waitForTimeout(150);
    await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
}

test('TC-CLK-01 mousedown 中の renderTree 後も mouseup で openFile 発火', async ({ page }) => {
    await boot(page);
    const msgs = await page.evaluate(({ fileList, structure }) => {
        const item = document.querySelector('[data-item-id="outB"]') as HTMLElement;
        const r = item.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        // 1. pointerdown（ユーザーが押した）
        item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }));
        item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x, clientY: y }));
        // 2. 押している間に D&D 応答の notesFileListChanged → renderTree（item 全再構築）
        (window as any).__hostMessageHandler({
            type: 'notesFileListChanged', fileList, structure, currentFile: '/test/a.md',
        });
        // 3. mouseup は「新しい」要素上で起きる（旧要素は detach 済み → click 合成は発火しない）
        const newItem = document.querySelector('[data-item-id="outB"]') as HTMLElement;
        newItem.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: x, clientY: y }));
        newItem.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: x, clientY: y }));
        // click は意図的に dispatch しない（実ブラウザでは合成されないため）
        return JSON.parse(JSON.stringify((window as any).__testApi.notesMessages));
    }, { fileList, structure });
    const opens = msgs.filter((m: any) => m.type === 'openFile');
    expect(opens.length, 'renderTree を跨いでも 1 回目で openFile').toBe(1);
    expect(opens[0].filePath).toBe('/test/b.out');
});

test('TC-CLK-02 通常 click は 1 回だけ発火（pointerup 保険と二重にならない）', async ({ page }) => {
    await boot(page);
    const msgs = await page.evaluate(() => {
        const item = document.querySelector('[data-item-id="outB"]') as HTMLElement;
        const r = item.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }));
        item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: x, clientY: y }));
        item.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: x, clientY: y }));
        return JSON.parse(JSON.stringify((window as any).__testApi.notesMessages));
    });
    expect(msgs.filter((m: any) => m.type === 'openFile').length).toBe(1);
});

test('TC-CLK-03 drag セッション中の pointerup では openFile しない', async ({ page }) => {
    await boot(page);
    const msgs = await page.evaluate(() => {
        const item = document.querySelector('[data-item-id="outB"]') as HTMLElement;
        const dt = new DataTransfer();
        item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        item.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        return JSON.parse(JSON.stringify((window as any).__testApi.notesMessages));
    });
    expect(msgs.filter((m: any) => m.type === 'openFile').length).toBe(0);
});
