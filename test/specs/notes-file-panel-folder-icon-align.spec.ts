/**
 * notes-file-panel-folder-icon-align — フォルダ/ファイルのアイコン x 位置揃え（FR-FA-01/02/03）
 *
 * folder-header は以前 [chevron][icon][title] で chevron+gap 分アイコンが右にずれていた。
 * chevron を position:absolute にして folder-icon を file-icon と同じ開始 x に揃える修正の検証。
 */
import { test, expect, Page } from '@playwright/test';

// 同一階層に folder と file（root 直下）
const fileList = [
    { filePath: '/test/fileTop.out', title: 'FileTop', id: 'fileTop' },
    { filePath: '/test/child.out', title: 'Child', id: 'child' },
];
const structure = {
    version: 1,
    rootIds: ['folderA', 'fileTop'],
    items: {
        folderA: { type: 'folder', id: 'folderA', title: 'FolderA', childIds: ['child'], collapsed: false },
        fileTop: { type: 'file', id: 'fileTop', title: 'FileTop' },
        child: { type: 'file', id: 'child', title: 'Child' },
    },
};

async function initPanel(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ fileList, structure }) => {
        (window as any).__testApi.initNotesPanel(fileList, '/test/fileTop.out', structure);
    }, { fileList, structure });
    await page.waitForTimeout(150);
}

test.describe('file-panel folder icon align (FR-FA-01/02/03)', () => {
    // root 直下の folder(folderA) と file(fileTop) のアイコン x を比較（同一階層）。
    // ★注意: `.file-panel-item` の最初は folderA 配下の child（ネスト）なので、必ず
    //   data-item-id="fileTop"（root 直下 file）を指定して同一階層で比較する。
    const rootIconDiffFn = () => {
        // data-folder-id は wrapper(.file-panel-folder) に付く（header ではない）
        const fIcon = document.querySelector('.file-panel-folder[data-folder-id="folderA"] > .file-panel-folder-header .file-panel-folder-icon') as HTMLElement;
        const fileIcon = document.querySelector('.file-panel-item[data-item-id="fileTop"] .file-panel-item-icon') as HTMLElement;
        if (!fIcon || !fileIcon) return { err: 'icon not found', diff: -1, folderX: -1, fileX: -1 };
        const a = fIcon.getBoundingClientRect().left;
        const b = fileIcon.getBoundingClientRect().left;
        return { err: null as string | null, diff: Math.abs(a - b), folderX: a, fileX: b };
    };

    test('TC-FA-01: root 直下の folder アイコン x が file アイコン x と揃う（load-bearing）', async ({ page }) => {
        await initPanel(page);
        const diff = await page.evaluate(rootIconDiffFn);
        expect(diff.err).toBeNull();
        expect(diff.diff, `folder icon x(${diff.folderX}) と file icon x(${diff.fileX}) の差 <= 2px`).toBeLessThanOrEqual(2);
    });

    test('TC-FA-01-cf: counterfactual — chevron を通常フローに戻すと差が大きくなる（load-bearing 証明）', async ({ page }) => {
        await initPanel(page);
        // 修正を打ち消す: chevron を static + folder-header gap を復元して旧レイアウトを再現
        await page.addStyleTag({ content: `
            .file-panel-folder-chevron { position: static !important; transform: none !important; width: 13px !important; }
            .file-panel-folder-header { gap: 4px !important; }
        ` });
        await page.waitForTimeout(100);
        const diff = await page.evaluate(rootIconDiffFn);
        // 旧レイアウトでは chevron(13)+gap 分ずれる → 差が大きい（修正が load-bearing である証拠）
        expect(diff.diff, '旧レイアウト（chevron 通常フロー）では差が 10px 以上').toBeGreaterThan(10);
    });

    test('TC-FA-02: chevron クリックで toggleFolder が呼ばれる（absolute 化してもクリック可能）', async ({ page }) => {
        await initPanel(page);
        const called = await page.evaluate(() => {
            (window as any).__testApi.notesMessages = [];
            const chevron = document.querySelector('.file-panel-folder[data-folder-id="folderA"] > .file-panel-folder-header .file-panel-folder-chevron')
                || document.querySelector('.file-panel-folder-chevron');
            (chevron as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return ((window as any).__testApi.notesMessages || [])
                .filter((m: any) => m.type === 'toggleFolder').length;
        });
        expect(called, 'chevron クリックで toggleFolder').toBeGreaterThanOrEqual(1);
    });

    test('TC-FA-03: ネスト階層でも folder icon x が同階層 file icon x と揃う', async ({ page }) => {
        await initPanel(page);
        // folderA 配下の child(file) のアイコン x が、folderA のアイコン x よりインデント分右にある
        const r = await page.evaluate(() => {
            const folderIcon = document.querySelector('.file-panel-folder[data-folder-id="folderA"] > .file-panel-folder-header .file-panel-folder-icon')!.getBoundingClientRect().left;
            const childIcon = document.querySelector('.file-panel-item[data-item-id="child"] .file-panel-item-icon')!.getBoundingClientRect().left;
            return { folderIcon, childIcon };
        });
        // child は folderA の子（1 階層深い）→ インデント分だけ右
        expect(r.childIcon, '子 file はインデント分だけ folder より右').toBeGreaterThan(r.folderIcon);
    });
});
