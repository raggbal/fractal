/**
 * TC-SPM-01..04 — sidepanel header overflow「…」メニュー
 * (sprint 20260808-000219 FR-SPM-01 / NFR-SPM-01)
 *
 * 方式: ボタン DOM 不動 + sp-overflowed クラスで CSS 非表示 + プロキシメニュー
 * （ADRL-sidepanel-overflow-menu）。判定は SidePanelOverflow.recalc()。
 *
 * counterfactual: recalc を呼ばない（旧方式のまま）と狭幅でボタンが横スクロールに
 * 隠れたまま「…」も出ない = TC-SPM-01 の overflowBtnVisible assert が RED。
 */
import { test, expect, Page } from '@playwright/test';

async function openSidePanelWithMd(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => {
        (window as any).__hostMessageHandler({
            type: 'openSidePanel',
            markdown: '# Doc\n\nbody\n',
            filePath: '/tmp/noteA/page1.md',
            fileName: 'page1.md',
            toc: [],
            documentBaseUri: '',
        });
    });
    await page.waitForTimeout(400);
}

async function sizePanel(page: Page, widthPx: number) {
    await page.evaluate((w) => {
        const sp = document.querySelector('.side-panel') as HTMLElement;
        if (sp) {
            sp.style.setProperty('width', w + 'px', 'important');
            sp.style.setProperty('min-width', w + 'px', 'important');
            sp.style.setProperty('max-width', w + 'px', 'important');
        }
        // sidepanel-header-narrow.spec.ts と同じく container も幅制限（header は container 内）
        const c = document.querySelector('.side-panel-editor-container') as HTMLElement;
        if (c) c.style.setProperty('width', w + 'px', 'important');
        (window as any).SidePanelOverflow.recalc();
    }, widthPx);
    await page.waitForTimeout(100);
}

function metrics(page: Page) {
    return page.evaluate(() => {
        const btn = document.getElementById('sidePanelOverflowBtn') as HTMLElement;
        const menu = document.getElementById('sidePanelOverflowMenu') as HTMLElement;
        const scroll = document.querySelector('.side-panel-header-scroll') as HTMLElement;
        const all = Array.from(scroll.querySelectorAll('.side-panel-header-actions > button, .side-panel-copy-path, .side-panel-copy-inapp-link')) as HTMLElement[];
        const overflowed = all.filter(b => b.classList.contains('sp-overflowed'));
        return {
            overflowBtnVisible: btn ? btn.style.display !== 'none' : false,
            menuVisible: menu ? menu.style.display !== 'none' : false,
            total: all.length,
            overflowedCount: overflowed.length,
            overflowedActions: overflowed.map(b => b.getAttribute('data-action') || b.className),
            scrollFits: scroll.scrollWidth <= scroll.clientWidth + 1,
        };
    });
}

test('TC-SPM-01 狭幅で溢れる分だけ順次格納 + 「…」可視 / 広幅で格納ゼロ + 「…」非表示', async ({ page }) => {
    await openSidePanelWithMd(page);

    // 広幅: 格納ゼロ
    await sizePanel(page, 800);
    let m = await metrics(page);
    expect(m.overflowedCount).toBe(0);
    expect(m.overflowBtnVisible).toBe(false);

    // 狭幅: 一部格納 + 「…」可視 + 表示分は収まっている
    await sizePanel(page, 380);
    m = await metrics(page);
    expect(m.overflowedCount).toBeGreaterThan(0);
    expect(m.overflowBtnVisible).toBe(true);
    expect(m.scrollFits, '格納後は残りが収まる（横スクロール不要）').toBe(true);

    // 中間幅: 格納数が狭幅より減る（順次性 = 2 値切替でない）
    const narrowCount = m.overflowedCount;
    await sizePanel(page, 500);
    m = await metrics(page);
    expect(m.overflowedCount).toBeLessThan(narrowCount);

    // 広幅に戻すと全部直接表示に戻る
    await sizePanel(page, 800);
    m = await metrics(page);
    expect(m.overflowedCount).toBe(0);
    expect(m.overflowBtnVisible).toBe(false);
});

test('TC-SPM-02 メニュー item click が元ボタンの action を発火（プロキシ委譲）', async ({ page }) => {
    await openSidePanelWithMd(page);
    await sizePanel(page, 340); // 強めに狭くして exportPdf まで格納させる

    const r = await page.evaluate(() => {
        const api = (window as any).__testApi;
        api.messages = [];
        // メニューを開く
        (document.getElementById('sidePanelOverflowBtn') as HTMLElement).click();
        const menu = document.getElementById('sidePanelOverflowMenu') as HTMLElement;
        const items = Array.from(menu.querySelectorAll('.side-panel-overflow-item')) as HTMLButtonElement[];
        // exportPdf の item を探して click
        const pdfItem = items.find(it => (it.textContent || '').includes('PDF') || (it.textContent || '').toLowerCase().includes('pdf'));
        if (pdfItem) pdfItem.click();
        return {
            menuWasVisible: menu.style.display !== 'none' || items.length > 0,
            itemCount: items.length,
            pdfItemFound: !!pdfItem,
            pdfMsgs: api.messages.filter((m: any) => m.type === 'exportPdf'),
            menuClosedAfterClick: menu.style.display === 'none',
        };
    });
    expect(r.itemCount).toBeGreaterThan(0);
    expect(r.pdfItemFound).toBe(true);
    expect(r.pdfMsgs.length, 'メニュー item click で元ボタンの exportPdf 配線が発火').toBe(1);
    expect(r.menuClosedAfterClick).toBe(true);
});

test('TC-SPM-02b 元々非表示のボタン（copy-inapp-link 非 Notes）はメニュー候補外', async ({ page }) => {
    await openSidePanelWithMd(page);
    await sizePanel(page, 340);
    const r = await page.evaluate(() => {
        const inapp = document.querySelector('.side-panel-copy-inapp-link') as HTMLElement;
        (document.getElementById('sidePanelOverflowBtn') as HTMLElement).click();
        const menu = document.getElementById('sidePanelOverflowMenu') as HTMLElement;
        const labels = Array.from(menu.querySelectorAll('.side-panel-overflow-item span')).map(s => s.textContent);
        return {
            inappNativeDisplay: inapp ? inapp.style.display : 'MISSING',
            labels,
        };
    });
    // standalone-notes harness は notes-layout 次第だが、display:none 初期のままなら候補外
    if (r.inappNativeDisplay === 'none') {
        expect(r.labels.some(l => (l || '').includes('In-App'))).toBe(false);
    }
});

test('TC-SPM-03 翻訳ビュー差し替え → 復元で recalc が効く（stale sp-overflowed が残らない）', async ({ page }) => {
    await openSidePanelWithMd(page);
    await sizePanel(page, 380);
    const before = await metrics(page);
    expect(before.overflowedCount).toBeGreaterThan(0);

    // 翻訳ビュー相当: 格納状態のまま actions.innerHTML を保存（本番の
    // sidePanelPreTranslationState.actionsHtml と同じく sp-overflowed class が焼き込まれる）
    // → Back ボタンへ差し替え → recalc（本番は差し替え直後に明示コール）
    await page.evaluate(() => {
        const actions = document.querySelector('.side-panel-header-actions') as HTMLElement;
        (window as any).__spmSavedActions = actions.innerHTML;
        actions.innerHTML = '<button class="side-panel-header-btn" data-action="translateBack" title="Back">← Back</button>';
        (window as any).SidePanelOverflow.recalc();
    });

    // 復元（sp-overflowed 焼き込み HTML が戻る）→ 広幅化 + recalc
    // → counterfactual: recalc が stale class を掃除しなければ格納が残り RED
    await page.evaluate(() => {
        const actions = document.querySelector('.side-panel-header-actions') as HTMLElement;
        actions.innerHTML = (window as any).__spmSavedActions;
    });
    await sizePanel(page, 800);
    const after = await metrics(page);
    expect(after.overflowedCount, '広幅なら焼き込まれた stale sp-overflowed が全解除される').toBe(0);
    expect(after.overflowBtnVisible).toBe(false);

    // 狭幅に戻せば再格納される（recalc が実際に再計算している）
    await sizePanel(page, 380);
    const narrowAgain = await metrics(page);
    expect(narrowAgain.overflowedCount).toBeGreaterThan(0);
    expect(narrowAgain.overflowBtnVisible).toBe(true);
});

test('TC-SPM-04 広幅の従来ボタン動作は無傷（回帰 pin: exportPdf 直接 click）', async ({ page }) => {
    await openSidePanelWithMd(page);
    await sizePanel(page, 800);
    const r = await page.evaluate(() => {
        const api = (window as any).__testApi;
        api.messages = [];
        const btn = document.querySelector('.side-panel-header-actions [data-action="exportPdf"]') as HTMLElement;
        btn.click();
        return { pdfMsgs: api.messages.filter((m: any) => m.type === 'exportPdf') };
    });
    expect(r.pdfMsgs.length).toBe(1);
});
