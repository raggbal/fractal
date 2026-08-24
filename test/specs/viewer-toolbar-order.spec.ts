/**
 * viewer-toolbar-order.spec.ts — toolbar の kind 別ボタン集合と全順序（TC-VEX-16 / FR-FV-19）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-06。
 * buildToolbar は kind 側の open より先に走るため、モジュール未実装 kind でも toolbar 構造は検証できる。
 * html の全順序は既存 TC-FV-62（file-viewer.spec.ts）が pin — 本 spec は新 kind の集合と隣接順序。
 */
import { test, expect } from '@playwright/test';

const openKind = (kind: string) => `
    (window).__fileViewer.open('${kind}', './viewer-fixtures/dummy.txt',
        document.getElementById('viewer-root'), '/tmp/f.${kind}');
`;

async function toolbarClasses(page: any, kind: string): Promise<string[]> {
    await page.evaluate(openKind(kind));
    await page.waitForSelector('.viewer-toolbar');
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('.viewer-toolbar button')).map((b: any) => b.className));
}

test('TC-VEX-16: kind 別ボタン集合（FR-FV-19 の表が正）', async ({ page }) => {
    await page.goto('/standalone-viewer.html');
    const expectSet = (classes: string[], present: string[], absent: string[], label: string) => {
        for (const c of present) { expect(classes, `${label}: ${c} があるべき`).toContain(c); }
        for (const c of absent) { expect(classes, `${label}: ${c} は不在のはず`).not.toContain(c); }
    };
    // image: [−][+][fit][1:1]・🔍 なし・スクリプト許可なし
    const img = await toolbarClasses(page, 'image');
    expectSet(img, ['viewer-zoom-out', 'viewer-zoom-in', 'viewer-fit', 'viewer-actual-size'],
        ['viewer-find-toggle', 'viewer-script-toggle'], 'image');
    // 隣接順序: zoom-out < zoom-in < fit < actual-size < open-external
    const order = ['viewer-zoom-out', 'viewer-zoom-in', 'viewer-fit', 'viewer-actual-size', 'viewer-open-external'];
    for (let i = 0; i < order.length - 1; i++) {
        expect(img.indexOf(order[i]), `image: ${order[i]} < ${order[i + 1]}`).toBeLessThan(img.indexOf(order[i + 1]));
    }
    // pptx: [−][+] あり・fit/1:1 なし・🔍 あり
    const pptx = await toolbarClasses(page, 'pptx');
    expectSet(pptx, ['viewer-zoom-out', 'viewer-zoom-in', 'viewer-find-toggle'],
        ['viewer-fit', 'viewer-actual-size', 'viewer-script-toggle'], 'pptx');
    // docx: [−][+] なし（SYS-1 裁定）・🔍 あり
    const docx = await toolbarClasses(page, 'docx');
    expectSet(docx, ['viewer-find-toggle'],
        ['viewer-zoom-out', 'viewer-zoom-in', 'viewer-fit', 'viewer-actual-size'], 'docx');
    // xlsx / text: [−][+] なし・🔍 あり
    for (const kind of ['xlsx', 'text']) {
        const cs = await toolbarClasses(page, kind);
        expectSet(cs, ['viewer-find-toggle'], ['viewer-zoom-out', 'viewer-zoom-in'], kind);
    }
    // pdf: 従来どおり [−][+] + 🔍（INV-6）
    const pdf = await toolbarClasses(page, 'pdf');
    expectSet(pdf, ['viewer-zoom-out', 'viewer-zoom-in', 'viewer-find-toggle'],
        ['viewer-fit', 'viewer-actual-size', 'viewer-script-toggle'], 'pdf');
});
