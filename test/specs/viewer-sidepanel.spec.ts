/**
 * viewer-sidepanel.spec.ts — sidepanel 面の受信側（表示・排他）— TC-FV-20/21
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-04。
 * ハーネス: standalone-outliner.html（viewer-side-panel.js 組込済み。実行前 test:build:all）。
 */
import { test, expect } from '@playwright/test';

test.describe('viewer sidepanel 面（FR-FV-05 / TASK-04）', () => {

    test('TC-FV-20: openViewerPanel message で表示・closeViewerPanel で消える（受信側）', async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__viewerSidePanel);
        // 受信側: host message と同型の message を window に流す
        await page.evaluate(() => {
            window.postMessage({ type: 'openViewerPanel', kind: 'html', fileUri: './viewer-fixtures/sample.html', filePath: '/x/sample.html' }, '*');
        });
        await page.waitForSelector('.viewer-side-panel.open', { timeout: 5000 });
        expect(await page.locator('.viewer-side-panel.open').count()).toBe(1);
        // viewer がマウントされている（iframe が生成される）
        await page.waitForSelector('.viewer-side-panel .viewer-html-frame', { timeout: 5000 });

        await page.evaluate(() => { window.postMessage({ type: 'closeViewerPanel' }, '*'); });
        await page.waitForTimeout(300);
        expect(await page.locator('.viewer-side-panel.open').count()).toBe(0);
        // 閉じたら viewer DOM は破棄される
        expect(await page.locator('.viewer-side-panel .viewer-html-frame').count()).toBe(0);
    });

    test('TC-FV-21: 排他番人 — 両方向（viewer open で md close / md open で viewer close）', async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__viewerSidePanel && (window as any).__testApi);

        // 方向 1: md sidepanel 表示中に viewer を開く → md 側が閉じる
        await page.evaluate(() => {
            // md sidepanel を開く（outliner.js の openSidePanel 相当を message で）
            (window as any).__hostMessageHandler({ type: 'openSidePanel', markdown: '# md panel', filePath: '/x/a.md', fileName: 'a.md', toc: [], documentBaseUri: '' });
        });
        await page.waitForSelector('.side-panel.open', { timeout: 5000 });
        await page.evaluate(() => {
            window.postMessage({ type: 'openViewerPanel', kind: 'html', fileUri: './viewer-fixtures/sample.html', filePath: '/x/s.html' }, '*');
        });
        await page.waitForSelector('.viewer-side-panel.open', { timeout: 5000 });
        await page.waitForTimeout(500);   // md close のアニメーション（200ms）余裕
        expect(await page.locator('.side-panel.open').count(), 'md sidepanel が閉じる').toBe(0);

        // 方向 2: viewer 表示中に md sidepanel を開く → viewer が閉じる（counterfactual: hook を外すと残留で RED）
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({ type: 'openSidePanel', markdown: '# md again', filePath: '/x/b.md', fileName: 'b.md', toc: [], documentBaseUri: '' });
        });
        await page.waitForSelector('.side-panel.open', { timeout: 5000 });
        await page.waitForTimeout(300);
        expect(await page.locator('.viewer-side-panel.open').count(), 'viewer が閉じる').toBe(0);
    });
});

test.describe('sidepanel 面 fallback 中継（reviewer iter1 TASK-09 / TC-FV-38）', () => {

    test('TC-FV-38: OS で開く中継（SEC-2 番人 — bridge 経由で filePath 付き message が届く）', async ({ page }) => {
        // PDF 実レンダの検証は TC-FV-04（軽量 standalone ハーネス・1 実装 3 マウントの共通コード）に集約。
        // 本 TC の検証面 = sidepanel 面の fallback 配線（ボタンは kind 非依存でツールバー常設 — html で駆動）
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__viewerSidePanel && (window as any).__fileViewer);
        await page.evaluate(() => {
            window.postMessage({ type: 'openViewerPanel', kind: 'html', fileUri: './viewer-fixtures/sample.html', filePath: '/x/sample.html' }, '*');
        });
        await page.waitForSelector('.viewer-side-panel.open', { timeout: 10000 });
        await page.click('.viewer-side-panel .viewer-open-external');
        await expect.poll(async () =>
            page.evaluate(() => ((window as any).__testApi.messages as any[])
                .find((m) => m.type === 'openExternalFallback')?.filePath ?? null),
        { timeout: 10000 }).toBe('/x/sample.html');
    });

    test('TC-FV-38b: pdf_viewer.css が outliner webview に配線される（QUAL-1 契約番人）', async ({ page }) => {
        // 実レンダの代わりに css 配線を DOM で契約検証（PDFViewer レイアウトの前提 — .pdfViewer ルールの実在）
        await page.goto('/standalone-outliner.html');
        const hasPdfCss = await page.evaluate(() => {
            for (const sheet of Array.from(document.styleSheets)) {
                try {
                    for (const rule of Array.from((sheet as CSSStyleSheet).cssRules)) {
                        if ((rule as CSSStyleRule).selectorText?.includes('.pdfViewer')) { return true; }
                    }
                } catch { /* cross-origin sheet は skip */ }
            }
            return false;
        });
        expect(hasPdfCss, '.pdfViewer ルールがハーネス（= 本番 outlinerWebviewContent と同経路）に存在').toBe(true);
    });
});

// ── 再オープン③（FR-FV-14 — sidepanel viewer の md パリティ） ──────
test.describe('viewer sidepanel: md パリティ（FR-FV-14）', () => {

    /** panel を開いて要素を返す共通 setup（html kind = iframe を持つ面） */
    async function openPanel(page: any, kind = 'html') {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__viewerSidePanel && (window as any).__fileViewer);
        await page.evaluate((k: string) => {
            (window as any).__viewerSidePanel.open(k, './viewer-fixtures/plain-text.html', 'plain-text.html', '/tmp/plain-text.html');
        }, kind);
        await page.waitForSelector('.viewer-side-panel.open', { timeout: 10000 });
        if (kind === 'html') {
            await page.waitForSelector('.viewer-side-panel .viewer-html-frame', { timeout: 10000 });
        }
    }

    test('TC-FV-67: ジオメトリ — md .side-panel と同値（top=タブバー変数・width 50%・max 70%・absolute）', async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__viewerSidePanel);
        // notes 面のタブバー高さ変数を再現（md .side-panel は var(--notes-tab-bar-height, 0px) を top に使う）
        await page.evaluate(() => {
            document.documentElement.style.setProperty('--notes-tab-bar-height', '35px');
            (window as any).__viewerSidePanel.open('html', './viewer-fixtures/plain-text.html', 'p.html', '/tmp/p.html');
        });
        await page.waitForSelector('.viewer-side-panel.open', { timeout: 10000 });
        const geo = await page.evaluate(() => {
            const el = document.querySelector('.viewer-side-panel') as HTMLElement;
            const cs = getComputedStyle(el);
            const parentW = (el.parentElement || document.body).getBoundingClientRect().width;
            return { position: cs.position, top: cs.top, rect: el.getBoundingClientRect(), parentW };
        });
        // counterfactual: 現行 position:fixed;top:0 では RED（タブ被り = 第6R④(1)）
        expect(geo.position, 'md と同じ absolute（fixed 廃止）').toBe('absolute');
        expect(geo.rect.top, '上端 = タブバー下端（35px）').toBeGreaterThanOrEqual(34);
        expect(geo.rect.top).toBeLessThanOrEqual(36);
        // width 50% / max-width 70%（md styles.css:1658-1672 と同値）
        expect(Math.abs(geo.rect.width - geo.parentW * 0.5), '既定幅 = 50%').toBeLessThanOrEqual(geo.parentW * 0.02);
    });

    test('TC-FV-68: ⤢ expand toggle — 幅 95% ⇄ 復帰（md .expanded と同値）', async ({ page }) => {
        await openPanel(page);
        const parentW = await page.evaluate(() => (document.querySelector('.viewer-side-panel')!.parentElement || document.body).getBoundingClientRect().width);
        await page.click('.viewer-side-panel .viewer-expand');
        expect(await page.locator('.viewer-side-panel.expanded').count(), '.expanded 付与').toBe(1);
        const wExpanded = await page.evaluate(() => document.querySelector('.viewer-side-panel')!.getBoundingClientRect().width);
        expect(wExpanded, '幅 95%').toBeGreaterThan(parentW * 0.9);
        await page.click('.viewer-side-panel .viewer-expand');
        expect(await page.locator('.viewer-side-panel.expanded').count(), '.expanded 解除').toBe(0);
        const wBack = await page.evaluate(() => document.querySelector('.viewer-side-panel')!.getBoundingClientRect().width);
        expect(wBack, '元の幅に復帰').toBeLessThan(parentW * 0.75);
    });

    test('TC-FV-69: 幅 D&D リサイズ — 実マウス drag で追従 + clamp（320px〜95%）', async ({ page }) => {
        await openPanel(page);
        const handle = page.locator('.viewer-side-panel-resize-handle');
        const hb = (await handle.boundingBox())!;
        const w0 = await page.evaluate(() => document.querySelector('.viewer-side-panel')!.getBoundingClientRect().width);
        // 左へ 150px drag → 幅 +150
        await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
        await page.mouse.down();
        await page.mouse.move(hb.x - 150, hb.y + hb.height / 2, { steps: 8 });
        await page.mouse.up();
        const w1 = await page.evaluate(() => document.querySelector('.viewer-side-panel')!.getBoundingClientRect().width);
        expect(Math.abs(w1 - (w0 + 150)), '幅がドラッグに追従').toBeLessThanOrEqual(20);
        // 右端方向へ大きく drag → 下限 320px でクランプ
        const hb2 = (await handle.boundingBox())!;
        await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + 50);
        await page.mouse.down();
        await page.mouse.move(hb2.x + 2000, hb2.y + 50, { steps: 8 });
        await page.mouse.up();
        const w2 = await page.evaluate(() => document.querySelector('.viewer-side-panel')!.getBoundingClientRect().width);
        expect(w2, '下限 320px クランプ').toBeGreaterThanOrEqual(318);
        expect(w2).toBeLessThanOrEqual(340);
    });

    test('TC-FV-69b: iframe 面での drag 貫通 + mouseup 後の listener 掃除（必須テク①③）', async ({ page }) => {
        await openPanel(page, 'html');   // html = iframe を持つ面
        const handle = page.locator('.viewer-side-panel-resize-handle');
        const hb = (await handle.boundingBox())!;
        const w0 = await page.evaluate(() => document.querySelector('.viewer-side-panel')!.getBoundingClientRect().width);
        // drag 軌道を iframe 領域の内側（パネル中央）まで通す — pointerEvents:none が無いと
        // iframe が mousemove を食って途中で追従が止まる（counterfactual: ① を外すと RED）
        const frameBox = (await page.locator('.viewer-side-panel .viewer-html-frame').boundingBox())!;
        await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
        await page.mouse.down();
        await page.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2, { steps: 12 });
        const wMid = await page.evaluate(() => document.querySelector('.viewer-side-panel')!.getBoundingClientRect().width);
        await page.mouse.up();
        expect(wMid, 'iframe 上を通過しても幅が追従（drag 中 iframe pointerEvents=none）')
            .toBeLessThan(w0 - 40);
        // mouseup 後に動かしても幅が変わらない（listener 4 点対掃除 — 必須テク③）
        const wAfterUp = await page.evaluate(() => document.querySelector('.viewer-side-panel')!.getBoundingClientRect().width);
        await page.mouse.move(frameBox.x + 100, frameBox.y + 100, { steps: 4 });
        const wAfterMove = await page.evaluate(() => document.querySelector('.viewer-side-panel')!.getBoundingClientRect().width);
        expect(wAfterMove, 'mouseup 後の mousemove で幅が変わらない').toBe(wAfterUp);
        // iframe の pointerEvents が復元されている
        const pe = await page.evaluate(() => (document.querySelector('.viewer-side-panel .viewer-html-frame') as HTMLElement).style.pointerEvents);
        expect(pe === '' || pe === 'auto', 'iframe pointerEvents 復元').toBe(true);
    });

    test('TC-FV-69c: expand 相互作用 + 再クランプ（必須テク②④⑤）', async ({ page }) => {
        await openPanel(page);
        // ② expand 状態で resize 開始 → .expanded 解除
        await page.click('.viewer-side-panel .viewer-expand');
        expect(await page.locator('.viewer-side-panel.expanded').count()).toBe(1);
        const hb = (await page.locator('.viewer-side-panel-resize-handle').boundingBox())!;
        await page.mouse.move(hb.x + 2, hb.y + hb.height / 2);
        await page.mouse.down();
        await page.mouse.move(hb.x + 60, hb.y + hb.height / 2, { steps: 4 });
        await page.mouse.up();
        expect(await page.locator('.viewer-side-panel.expanded').count(), 'resize 開始で expand 解除').toBe(0);
        // ④ expand したまま close → 再 open で .expanded リセット
        await page.click('.viewer-side-panel .viewer-expand');
        expect(await page.locator('.viewer-side-panel.expanded').count()).toBe(1);
        await page.evaluate(() => (window as any).__viewerSidePanel.close());
        await page.evaluate(() => {
            (window as any).__viewerSidePanel.open('html', './viewer-fixtures/plain-text.html', 'p.html', '/tmp/p.html');
        });
        await page.waitForSelector('.viewer-side-panel.open', { timeout: 10000 });
        expect(await page.locator('.viewer-side-panel.expanded').count(), 'close で expanded リセット').toBe(0);
        // ⑤ window resize（viewport 縮小）で表示中パネルを再クランプ
        await page.evaluate(() => {
            const el = document.querySelector('.viewer-side-panel') as HTMLElement;
            el.style.width = '900px';
            el.style.maxWidth = '900px';
        });
        await page.setViewportSize({ width: 700, height: 600 });
        await page.waitForTimeout(200);
        const w = await page.evaluate(() => document.querySelector('.viewer-side-panel')!.getBoundingClientRect().width);
        expect(w, '親 95% 内へ再クランプ').toBeLessThanOrEqual(700 * 0.95 + 2);
    });
});

// ── 第 8 ラウンド③（Esc で閉じる — md sidepanel パリティ） ──────
test.describe('viewer sidepanel: Esc close（FR-FV-14 追補）', () => {

    test('TC-FV-77: Esc で viewer sidepanel が閉じて資源が破棄される（md と同挙動）', async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__viewerSidePanel && (window as any).__fileViewer);
        await page.evaluate(() => {
            (window as any).__viewerSidePanel.open('html', './viewer-fixtures/plain-text.html', 'p.html', '/tmp/p.html');
        });
        await page.waitForSelector('.viewer-side-panel.open', { timeout: 10000 });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        expect(await page.locator('.viewer-side-panel.open').count(), 'Esc で閉じる').toBe(0);
        expect(await page.locator('.viewer-side-panel .viewer-html-frame').count(), 'viewer DOM も破棄').toBe(0);
        // 閉じている時の Esc は no-op（誤爆しない）
        await page.keyboard.press('Escape');
        expect(await page.locator('.viewer-side-panel.open').count()).toBe(0);
    });
});

// ── 第 8 ラウンド④（Esc close 後の focus 復帰） ──────
test.describe('viewer sidepanel: close 後の focus 復帰（FR-FV-14 追補）', () => {

    test('TC-FV-78: viewer が focus を奪っても Esc close で元の要素とカーソル位置に戻る', async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__viewerSidePanel && (window as any).__fileViewer);
        // 復帰先のプローブ（outliner node の text cell 相当 = contenteditable。caret を途中位置に置く）
        await page.evaluate(() => {
            const probe = document.createElement('div');
            probe.id = 'focus-probe';
            probe.contentEditable = 'true';
            probe.textContent = 'カーソル位置の保持テスト';
            document.body.appendChild(probe);
            probe.focus();
            const sel = window.getSelection()!;
            const r = document.createRange();
            r.setStart(probe.firstChild!, 5);   // 「位置」の後
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
        });
        // viewer を開く → viewer 内をクリック（pdf 面の focus 奪取と同型の状況を作る）
        await page.evaluate(() => {
            (window as any).__viewerSidePanel.open('html', './viewer-fixtures/plain-text.html', 'p.html', '/tmp/p.html');
        });
        await page.waitForSelector('.viewer-side-panel.open', { timeout: 10000 });
        // outliner の blur/再レンダを模してテキストノードを**作り直す**（第 8 R⑤ の実態 —
        // counterfactual: DOM 参照ベース（cloneRange）の復元はここで stale になり「先頭に戻る」RED）
        await page.evaluate(() => {
            const probe = document.getElementById('focus-probe')!;
            probe.textContent = probe.textContent;   // 同じ文字列の新しいテキストノードに置換
        });
        const panelBox = (await page.locator('.viewer-side-panel').boundingBox())!;
        await page.mouse.click(panelBox.x + panelBox.width / 2, panelBox.y + 20);   // focus がプローブから離れる
        // Esc close → focus + caret がプローブへ復帰
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        const res = await page.evaluate(() => {
            const probe = document.getElementById('focus-probe')!;
            const sel = window.getSelection()!;
            return {
                focused: document.activeElement === probe,
                caretOffset: sel.rangeCount ? sel.getRangeAt(0).startOffset : -1,
                caretInProbe: sel.rangeCount ? probe.contains(sel.getRangeAt(0).startContainer) : false,
            };
        });
        // counterfactual: 復帰処理なしでは focus は body に落ちて RED（pdf 面で実測された第 8 ラウンド④）
        expect(res.focused, '元の要素へ focus 復帰').toBe(true);
        expect(res.caretInProbe, 'caret も元の要素内').toBe(true);
        expect(res.caretOffset, 'caret offset 保持').toBe(5);
    });
});
