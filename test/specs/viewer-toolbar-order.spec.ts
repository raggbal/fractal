/**
 * viewer-toolbar-order.spec.ts — toolbar の kind 別ボタン集合と全順序（TC-VEX-16 改め TC-VZP-10 / FR-FV-08/12）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-06 →
 * 【許可: test_update】sprint 20260825-224210-viewer-zoom-pan TASK-08（TC-VZP-10・ADRL-0100）:
 * [−][+] の kind 制約（pdf/image/pptx のみ）を撤廃 — 全 kind に zoom ボタンあり。
 * 改訂後の全順序の一次ソース = sprint requirement.md「toolbar 全順序表の改訂」節:
 *   [filename] [スクリプト許可](html のみ) [−][+] [フィット][等倍](image のみ)
 *   [🔍 find](image 以外) [OSで開く] [Open in Standalone] [Export] [Copy Path]
 *   [Copy In-App Link] [Open in new tab] [×](sidepanel のみ)
 * 部分順序 pin は逆順実装を素通しする（designer_failures 2026-08-16）ため、
 * 描画されたボタン列全体を全順序射影との toEqual で pin する。
 * buildToolbar は kind 側の open より先に走るため、fixture は dummy.txt でよい。
 * html の全順序は既存 TC-FV-62（file-viewer.spec.ts）が pin — 本 spec は残り全 kind。
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

// 全順序（requirement「toolbar 全順序表の改訂」節から引用 — button 要素のみ。filename は非 button）
const FULL_ORDER = [
    'viewer-script-toggle',      // html のみ
    'viewer-zoom-out',           // 全 kind（ADRL-0100 — kind 制約撤廃）
    'viewer-zoom-in',
    'viewer-zoom-reset',         // image 以外（再オープン① v3 = FR-VZP-06。image は [フィット] が同機能）
    'viewer-fit',                // image のみ
    'viewer-actual-size',        // image のみ
    'viewer-find-toggle',        // image 以外
    'viewer-open-external',
    'viewer-open-in-standalone',
    'viewer-export-file',
    'viewer-copy-path',
    'viewer-copy-inapp-link',
    'viewer-open-in-new-tab',
];

test('TC-VZP-10: kind 別ボタン集合 + 隣接ペア全順序（全 kind に [−][+]）', async ({ page }) => {
    await page.goto('/standalone-viewer.html');
    const expectKind = (classes: string[], present: string[], absent: string[], label: string) => {
        for (const c of present) { expect(classes, `${label}: ${c} があるべき`).toContain(c); }
        for (const c of absent) { expect(classes, `${label}: ${c} は不在のはず`).not.toContain(c); }
        // 全順序 pin: 描画された列は FULL_ORDER をその集合へ射影した列と完全一致（隣接ペア全順序を含意）
        const projected = FULL_ORDER.filter((c) => classes.indexOf(c) !== -1);
        expect(classes, `${label}: DOM 順が全順序表と一致`).toEqual(projected);
    };
    // image: [−][+][fit][1:1]・⟲ なし・🔍 なし・スクリプト許可なし
    expectKind(await toolbarClasses(page, 'image'),
        ['viewer-zoom-out', 'viewer-zoom-in', 'viewer-fit', 'viewer-actual-size'],
        ['viewer-zoom-reset', 'viewer-find-toggle', 'viewer-script-toggle'], 'image');
    // pdf / pptx / docx / xlsx / text: [−][+][⟲] + 🔍・fit/1:1 なし・スクリプト許可なし
    for (const kind of ['pdf', 'pptx', 'docx', 'xlsx', 'text']) {
        expectKind(await toolbarClasses(page, kind),
            ['viewer-zoom-out', 'viewer-zoom-in', 'viewer-zoom-reset', 'viewer-find-toggle'],
            ['viewer-fit', 'viewer-actual-size', 'viewer-script-toggle'], kind);
    }
});
