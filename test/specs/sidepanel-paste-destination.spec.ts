/**
 * TC-PDB-01/02/03/04b/06 — sidepanel paste 二重貼付の destination routing
 * （sprint 20260818-183407 FR-PDB-01/02）
 *
 * notes standalone ハーネスで main md + sidepanel md の 2 instance を実構築し、
 * host echo（__hostMessageHandler）を流す load-bearing 形式（合成イベント/Proxy fake 禁止 —
 * generator_failures 2026-08-09/2026-08-12）。
 *
 * counterfactual:
 *  - TC-PDB-03 が「destination 無し旧形式 = main md にも入る」を明示 pin する
 *    （= destination 札が防御の実体。発行元が札を積まないと旧形式に落ちて二重貼付）。
 *  - TC-PDB-06 は extract 系の同型（修正前は destination 判定が無く main md に混入 = RED）。
 */
import { test, expect, Page } from '@playwright/test';

const MAIN_MD_FILE = '/Users/test/notes/noteA/main-doc.md';
const SP_MD_FILE = '/Users/test/notes/noteA/side-page.md';

const MAIN_SEL = '.markdown-container .editor[contenteditable]';
const SP_SEL = '.side-panel-editor-root .editor[contenteditable]';

async function openMainAndSidePanel(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ mainFp, spFp }) => {
        (window as any).__hostMessageHandler({
            type: 'updateData', kind: 'md', markdown: '# Main\n\nmain body\n',
            filePath: mainFp, documentBaseUri: '',
        });
        (window as any).__hostMessageHandler({
            type: 'openSidePanel', markdown: '# Side\n\nside body\n',
            filePath: spFp, fileName: 'side-page.md', toc: [], documentBaseUri: '',
        });
    }, { mainFp: MAIN_MD_FILE, spFp: SP_MD_FILE });
    await page.waitForTimeout(400);
    // 2 instance が実在すること（load-bearing の前提）
    expect(await page.locator(MAIN_SEL).count()).toBeGreaterThan(0);
    expect(await page.locator(SP_SEL).count()).toBeGreaterThan(0);
}

function texts(page: Page) {
    return page.evaluate(({ m, s }) => ({
        main: (document.querySelector(m) as HTMLElement)?.textContent || '',
        sp: (document.querySelector(s) as HTMLElement)?.textContent || '',
    }), { m: MAIN_SEL, s: SP_SEL });
}

test('TC-PDB-01 destination=sidepanel: sidepanel のみに挿入・main md は不変', async ({ page }) => {
    await openMainAndSidePanel(page);
    const before = await texts(page);
    await page.evaluate(() => {
        (window as any).__hostMessageHandler({
            type: 'pasteWithAssetCopyResult', markdown: 'PASTED-SP-PDB01', destination: 'sidepanel',
        });
    });
    await page.waitForTimeout(300);
    const after = await texts(page);
    expect(after.sp).toContain('PASTED-SP-PDB01');
    expect(after.main).not.toContain('PASTED-SP-PDB01');
    expect(after.main).toBe(before.main); // byte 不変
});

test('TC-PDB-02 destination=main-md: main のみに挿入・sidepanel は不変', async ({ page }) => {
    await openMainAndSidePanel(page);
    const before = await texts(page);
    await page.evaluate(() => {
        (window as any).__hostMessageHandler({
            type: 'pasteWithAssetCopyResult', markdown: 'PASTED-MAIN-PDB02', destination: 'main-md',
        });
    });
    await page.waitForTimeout(300);
    const after = await texts(page);
    expect(after.main).toContain('PASTED-MAIN-PDB02');
    expect(after.sp).not.toContain('PASTED-MAIN-PDB02');
    expect(after.sp).toBe(before.sp);
});

test('TC-PDB-03 destination 無し（旧形式）: main md にも入る = 二重貼付の機序 pin（後方互換）', async ({ page }) => {
    await openMainAndSidePanel(page);
    await page.evaluate(() => {
        (window as any).__hostMessageHandler({
            type: 'pasteWithAssetCopyResult', markdown: 'PASTED-LEGACY-PDB03',
        });
    });
    await page.waitForTimeout(300);
    const after = await texts(page);
    // 旧形式は md pane 無条件処理 + outliner→sidepanel 転送の両方（これが二重貼付バグの機序）。
    // destination 札はこの旧形式に「落とさない」ことで直す（発行元 TC-PDB-04 が札を保証）。
    expect(after.main).toContain('PASTED-LEGACY-PDB03');
    expect(after.sp).toContain('PASTED-LEGACY-PDB03');
});

test('TC-PDB-04b notes main md 発行元: notesMarkdownHostBridge が destination=main-md を積む', async ({ page }) => {
    await openMainAndSidePanel(page);
    const sent = await page.evaluate(() => {
        (window as any).__testApi.messages = [];
        (window as any).notesMarkdownHostBridge.pasteOutlinerNodesWithAssets('- a\n', [{ text: 'a', level: 0 }]);
        return (window as any).__testApi.messages.filter((m: any) => m.type === 'pasteOutlinerNodesWithAssets');
    });
    expect(sent.length).toBe(1);
    expect(sent[0].sidePanelFilePath).toBe(MAIN_MD_FILE); // 既存: 自 filePath を畳む
    // counterfactual: destination 付与を外すと undefined = RED
    expect(sent[0].destination).toBe('main-md');
});

test('TC-PDB-06 extract 系 destination=sidepanel: main md に混入しない', async ({ page }) => {
    await openMainAndSidePanel(page);
    const before = await texts(page);
    await page.evaluate(() => {
        (window as any).__hostMessageHandler({
            type: 'extractDataUrlsInPastedMdResult', markdown: 'EXTRACTED-SP-PDB06', savedCount: 1,
            destination: 'sidepanel',
        });
    });
    await page.waitForTimeout(300);
    const after = await texts(page);
    expect(after.sp).toContain('EXTRACTED-SP-PDB06');
    // 修正前: editor.js:18448 に destination 判定が無く main md にも挿入される = RED
    expect(after.main).not.toContain('EXTRACTED-SP-PDB06');
    expect(after.main).toBe(before.main);
});

test('TC-PDB-06b extract 系 destination=main-md: sidepanel に混入しない', async ({ page }) => {
    await openMainAndSidePanel(page);
    await page.evaluate(() => {
        (window as any).__hostMessageHandler({
            type: 'extractDataUrlsInPastedMdResult', markdown: 'EXTRACTED-MAIN-PDB06B', savedCount: 1,
            destination: 'main-md',
        });
    });
    await page.waitForTimeout(300);
    const after = await texts(page);
    expect(after.main).toContain('EXTRACTED-MAIN-PDB06B');
    expect(after.sp).not.toContain('EXTRACTED-MAIN-PDB06B');
});
