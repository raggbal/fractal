/**
 * viewer-note-pane.spec.ts — note 面（viewer-dispatcher）の受信側 — TC-FV-22/35
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-05。
 * ハーネス: standalone-notes.html（viewer-dispatcher.js 組込済み）。
 */
import { test, expect } from '@playwright/test';

test.describe('viewer note 面（FR-FV-06 / TASK-05）', () => {

    test('TC-FV-22: showViewer で他ペイン hidden・hideViewer で復帰 + viewer DOM 破棄（stale 番人）', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__viewerDispatcher);
        // showViewer（message 受信経路）
        await page.evaluate(() => {
            window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: './viewer-fixtures/sample.html', fileName: 'sample.html' }, '*');
        });
        await page.waitForSelector('#viewerContainer', { state: 'visible', timeout: 5000 });
        // 他ペインが隠れる
        const outlinerHidden = await page.evaluate(() => {
            const el = document.getElementById('outlinerContainer');
            return !el || el.style.display === 'none';
        });
        expect(outlinerHidden).toBe(true);
        // viewer がマウントされている
        await page.waitForSelector('#viewerContainer .viewer-html-frame', { timeout: 5000 });

        // hideViewer（message 受信経路）→ DOM 破棄（counterfactual: display:none だけだと残留で RED）
        await page.evaluate(() => { window.postMessage({ type: 'hideNoteViewer' }, '*'); });
        await page.waitForTimeout(300);
        expect(await page.locator('#viewerContainer .viewer-html-frame').count(), 'viewer DOM が破棄される').toBe(0);
        const containerHidden = await page.evaluate(() => document.getElementById('viewerContainer')!.style.display === 'none');
        expect(containerHidden).toBe(true);
    });

    test('TC-FV-35: 双方向 hide 番人 — 既存タブ切替（showOutliner/showMarkdown）で viewer が消える（counterfactual: hook 除去で RED）', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__viewerDispatcher);
        await page.evaluate(() => {
            window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: './viewer-fixtures/sample.html', fileName: 'sample.html' }, '*');
        });
        await page.waitForSelector('#viewerContainer', { state: 'visible', timeout: 5000 });

        // 既存 dispatcher の面切替を駆動する: loadMarkdown（内部で showMarkdown → hook 発火）は
        // __testApi.mdDispatcher が公開する正規のテスト API（build-standalone-notes.js:574 の返り値）
        await page.evaluate(() => {
            (window as any).__testApi.mdDispatcher.loadMarkdown('# md へ切替', '/x/a.md', '');
        });
        await page.waitForTimeout(500);
        const viewerGone = await page.evaluate(() => {
            const el = document.getElementById('viewerContainer');
            return !el || el.style.display === 'none';
        });
        expect(viewerGone, '既存の面切替で viewer が消える（SYS-1 の双方向 hook）').toBe(true);
        expect(await page.locator('#viewerContainer .viewer-html-frame').count(), 'DOM も破棄').toBe(0);
    });
});

test.describe('note 面 viewer × md sidepanel の排他（reviewer iter3 CONS-1 / TC-FV-59）', () => {

    // standalone で `.side-panel` を open 状態にする（実 openSidePanel は host 往復を伴うため
    // クラス操作で open を再現 — sidepanel-tab-coexist.spec.ts:20 の既存 precedent と同型）。
    async function openMdSidePanelDom(page: import('@playwright/test').Page) {
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel') as HTMLElement;
            sp.style.display = 'flex';
            sp.classList.add('open');
        });
    }

    test('TC-FV-59: note 面 viewer を開くと md sidepanel が閉じる（counterfactual: showViewer の排他 click を外すと open のまま残り RED）', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.waitForFunction(() => (window as any).__viewerDispatcher);
        await openMdSidePanelDom(page);
        expect(await page.locator('.side-panel.open').count(), '前提: md sidepanel が open').toBe(1);

        // note 面 viewer を表示（In-App file link / file panel クリック いずれも showViewer を通る）
        await page.evaluate(() => {
            window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: './viewer-fixtures/sample.html', fileName: 'sample.html' }, '*');
        });
        await page.waitForSelector('#viewerContainer', { state: 'visible', timeout: 5000 });
        // ② viewer が実際に mount される（排他だけして viewer が出ないのを防ぐ）
        await page.waitForSelector('#viewerContainer .viewer-html-frame', { timeout: 5000 });

        // ① md sidepanel が閉じる（`.open` の除去は close ボタン click で同期・display:none は 200ms 後）
        await page.waitForTimeout(250);
        expect(
            await page.locator('.side-panel.open').count(),
            'md sidepanel（z-index:100）が viewer（z-index:50）に被さらないよう閉じる'
        ).toBe(0);
        const spHidden = await page.evaluate(() => (document.querySelector('.side-panel') as HTMLElement).style.display === 'none');
        expect(spHidden, 'closeSidePanelImmediate まで到達（display:none）').toBe(true);
    });
});

test.describe('note 面 css 配線（reviewer iter1 TASK-09 / TC-FV-39）', () => {

    test('TC-FV-39: pdf_viewer.css が notes webview に配線される（QUAL-1 契約番人）', async ({ page }) => {
        // PDF 実レンダは TC-FV-04（軽量 standalone ハーネス）に集約 — 実 3 面の表示は手動検収 §1/§4。
        // 本 TC = css 配線の契約（.pdfViewer レイアウトルールの実在）+ pdf kind の message 受理
        await page.goto('/standalone-notes.html');
        const hasPdfCss = await page.evaluate(() => {
            for (const sheet of Array.from(document.styleSheets)) {
                try {
                    for (const rule of Array.from((sheet as CSSStyleSheet).cssRules)) {
                        if ((rule as CSSStyleRule).selectorText?.includes('.pdfViewer')) { return true; }
                    }
                } catch { /* skip */ }
            }
            return false;
        });
        expect(hasPdfCss, '.pdfViewer ルールが notes ハーネス（= 本番 notesWebviewContent と同経路）に存在').toBe(true);
        // pdf kind の showNoteViewer message で viewer コンテナが表示状態になる（レンダ完了は待たない）
        await page.evaluate(() => {
            window.postMessage({ type: 'showNoteViewer', kind: 'pdf', fileUri: './viewer-fixtures/ja-en.pdf', fileName: 'ja-en.pdf', filePath: '/x/ja-en.pdf' }, '*');
        });
        await page.waitForSelector('#viewerContainer', { state: 'visible', timeout: 10000 });
        expect(await page.locator('#viewerContainer .viewer-toolbar').count(), 'viewer がマウントされる').toBe(1);
    });
});

// ── 再オープン③（FR-FV-13 / ADRL-0069 — file タブ + Open in Standalone） ──────
test.describe('file タブ（FR-FV-13）', () => {

    /** notes ハーネス + 実 tab manager（__testApi.initTabManager = 本番と同じ __initNotesTabManager） */
    async function setupWithTabs(page: import('@playwright/test').Page) {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__viewerDispatcher && (window as any).__testApi);
        await page.evaluate(() => { (window as any).__testApi.initTabManager(); });
    }
    const FILE_PATH = '/x/doc.html';
    const FILE_URI = './viewer-fixtures/sample.html';

    /** overlay（非タブ）で note 面 viewer を表示 */
    async function showOverlayViewer(page: import('@playwright/test').Page) {
        await page.evaluate(({ uri, fp }) => {
            window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: uri, fileName: 'doc.html', filePath: fp }, '*');
        }, { uri: FILE_URI, fp: FILE_PATH });
        await page.waitForSelector('#viewerContainer .viewer-toolbar', { timeout: 5000 });
    }

    test('TC-FV-63: Open in new tab → file タブ生成 + note 面表示（vscode message 不発・webview 完結）', async ({ page }) => {
        await setupWithTabs(page);
        await showOverlayViewer(page);
        const posted0 = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'viewerOpenInNewTab').length);

        await page.click('#viewerContainer .viewer-open-in-new-tab');
        await page.waitForSelector('#viewerContainer .viewer-html-frame', { timeout: 5000 });

        const state = await page.evaluate(() => {
            const tabs = (window as any).__notesTabManager.getTabs();
            const activeId = (window as any).__notesTabManager.getActiveId();
            return { tabs, active: tabs.find((t: any) => t.id === activeId) };
        });
        expect(state.active.kind, 'kind=file タブが active（makeTabState の明示 kind — 拡張子導出を通らない）').toBe('file');
        expect(state.active.filePath).toBe(FILE_PATH);
        expect(state.active.title).toBe('doc.html');
        // vscode タブ経路（viewerOpenInNewTab message）は不発 = fractal タブ化の pin
        const posted1 = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'viewerOpenInNewTab').length);
        expect(posted1, 'viewerOpenInNewTab message は post されない（host 往復ゼロ）').toBe(posted0);
        // タブ内ツールバーに切替わる（Open in new tab 消滅 / Open in Standalone 表示 — §14-6）
        expect(await page.locator('#viewerContainer .viewer-open-in-new-tab').count(), 'inTab では Open in new tab 非表示').toBe(0);
        expect(await page.locator('#viewerContainer .viewer-open-in-standalone').count(), 'inTab では Open in Standalone 表示').toBe(1);
    });

    test('TC-FV-63b: kind 推定 3 サイト番人 — file パスが拡張子導出を通らない / md への変換は一貫', async ({ page }) => {
        await setupWithTabs(page);
        // (iii) makeTabState: kind 明示（.html でも 'md' に化けない）
        await page.evaluate(({ uri, fp }) => {
            (window as any).__notesTabManager.openInNewTab(fp, 'file', 'doc.html', { viewerKind: 'html', viewerFileUri: uri });
        }, { uri: FILE_URI, fp: FILE_PATH });
        let active = await page.evaluate(() => {
            const tm = (window as any).__notesTabManager;
            return tm.getTabs().find((t: any) => t.id === tm.getActiveId());
        });
        expect(active.kind).toBe('file');
        // loadTab の file 分岐: bridge.openFile('/x/doc.html') が**呼ばれない**
        //（counterfactual: 分岐が無いと .html が md エディタ経路 = notesOpenFile に流れて RED — ADRL-0069 決定 3）
        const openFileCalls = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'notesOpenFile').map((m: any) => m.filePath));
        expect(openFileCalls, 'file タブは bridge.openFile を通らない').not.toContain(FILE_PATH);

        // (i) syncActiveFile（:431）: file タブ active 中に md の updateData 相当 → md タブへ**一貫変換**
        //（メインペインが md に変わった時の意図された同期 — 中途半端な file/md 混在状態を残さない）
        await page.evaluate(() => { (window as any).__notesTabManager.syncActiveFile('/x/note.md', undefined, 'Note'); });
        active = await page.evaluate(() => {
            const tm = (window as any).__notesTabManager;
            return tm.getTabs().find((t: any) => t.id === tm.getActiveId());
        });
        expect(active.kind, 'md へ変換（derivation は md/out パスのみ受ける）').toBe('md');
        expect(active.filePath).toBe('/x/note.md');

        // (ii) openInActiveTab（:377）: md/out 専用経路 — md パスで従来どおり
        await page.evaluate(() => { (window as any).__notesTabManager.openInActiveTab('/y/b.md'); });
        active = await page.evaluate(() => {
            const tm = (window as any).__notesTabManager;
            return tm.getTabs().find((t: any) => t.id === tm.getActiveId());
        });
        expect(active.kind).toBe('md');
    });

    test('TC-FV-64: タブ切替の排他往復 — file ⇄ md で viewer 表示/破棄が正しく切り替わる', async ({ page }) => {
        await setupWithTabs(page);
        // md タブ（updateData 相当 = loadMarkdown で md 面を成立させる）
        const mdTabId = await page.evaluate(() => {
            const id = (window as any).__notesTabManager.openInNewTab('/x/a.md', 'md');
            (window as any).__testApi.mdDispatcher.loadMarkdown('# a', '/x/a.md', '');
            return id;
        });
        // file タブ
        const fileTabId = await page.evaluate(({ uri, fp }) =>
            (window as any).__notesTabManager.openInNewTab(fp, 'file', 'doc.html', { viewerKind: 'html', viewerFileUri: uri }),
            { uri: FILE_URI, fp: FILE_PATH });
        await page.waitForSelector('#viewerContainer .viewer-html-frame', { timeout: 5000 });
        expect(await page.evaluate(() => document.getElementById('viewerContainer')!.style.display !== 'none')).toBe(true);

        // file → md: loadTab(md) は bridge.openFile（recorder）→ 本番は updateData で showMarkdown が走る
        await page.evaluate((id) => { (window as any).__notesTabManager.activateTab(id); }, mdTabId);
        await page.evaluate(() => { (window as any).__testApi.mdDispatcher.loadMarkdown('# a', '/x/a.md', ''); });
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => {
            const el = document.getElementById('viewerContainer');
            return !el || el.style.display === 'none';
        }), 'md タブへ切替で viewer が隠れる').toBe(true);
        expect(await page.locator('#viewerContainer .viewer-html-frame').count(), 'viewer DOM は破棄（stale なし）').toBe(0);

        // md → file: 再活性化で viewer が再表示される
        await page.evaluate((id) => { (window as any).__notesTabManager.activateTab(id); }, fileTabId);
        await page.waitForSelector('#viewerContainer .viewer-html-frame', { timeout: 5000 });
        expect(await page.evaluate(() => document.getElementById('viewerContainer')!.style.display !== 'none'),
            'file タブ再活性化で viewer 再表示').toBe(true);
        // 全過程で file パスが bridge.openFile に流れていない（63b と同じ到達ガードの往復 pin）
        const openFileCalls = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'notesOpenFile').map((m: any) => m.filePath));
        expect(openFileCalls).not.toContain(FILE_PATH);
    });

    test('TC-FV-65: Open in Standalone → 既存 viewerOpenInNewTab case 流用の pin（新 message type を発明しない）', async ({ page }) => {
        await setupWithTabs(page);
        await page.evaluate(({ uri, fp }) => {
            (window as any).__notesTabManager.openInNewTab(fp, 'file', 'doc.html', { viewerKind: 'html', viewerFileUri: uri });
        }, { uri: FILE_URI, fp: FILE_PATH });
        await page.waitForSelector('#viewerContainer .viewer-open-in-standalone', { timeout: 5000 });
        await page.click('#viewerContainer .viewer-open-in-standalone');
        const posted = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'viewerOpenInNewTab'));
        expect(posted.length, '既存 case（openWith）へ 1 件').toBe(1);
        expect(posted[0].filePath).toBe(FILE_PATH);
        expect(posted[0].kind, 'host が viewType を選ぶための kind').toBe('html');
    });

    test('TC-FV-66: 面×ボタン マトリクス全セル（FR-FV-13 の表 — 部分セルで代表しない）', async ({ page }) => {
        const count = async (cls: string) => page.locator(`#viewerContainer .${cls}`).count();

        // セル A: タブ strip なし（outliner 単独面相当 = __notesTabManager 不在）
        //   → Open in new tab のみ表示（従来どおり vscode タブ = md sidepanel の openTab と同格）
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__viewerDispatcher);
        await page.evaluate(({ uri, fp }) => {
            window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: uri, fileName: 'doc.html', filePath: fp }, '*');
        }, { uri: FILE_URI, fp: FILE_PATH });
        await page.waitForSelector('#viewerContainer .viewer-toolbar', { timeout: 5000 });
        expect(await count('viewer-open-in-new-tab'), 'A: new tab 表示').toBe(1);
        expect(await count('viewer-open-in-standalone'), 'A: Standalone 非表示').toBe(0);

        // セル B: notes 面 overlay（タブ strip あり・非タブ）→ 両方表示
        //   （notes sidepanel 面も同一 buildToolbar 経路 = hasTabStrip && !inTab で同セル）
        await page.evaluate(() => { (window as any).__testApi.initTabManager(); });
        await page.evaluate(({ uri, fp }) => {
            window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: uri, fileName: 'doc.html', filePath: fp }, '*');
        }, { uri: FILE_URI, fp: FILE_PATH });
        await page.waitForTimeout(300);
        expect(await count('viewer-open-in-new-tab'), 'B: new tab 表示（→ fractal タブ）').toBe(1);
        expect(await count('viewer-open-in-standalone'), 'B: Standalone 表示').toBe(1);

        // セル C: file タブ内（inTab）→ Standalone のみ
        await page.click('#viewerContainer .viewer-open-in-new-tab');
        await page.waitForSelector('#viewerContainer .viewer-open-in-standalone', { timeout: 5000 });
        expect(await count('viewer-open-in-new-tab'), 'C: new tab 非表示（自身がタブ）').toBe(0);
        expect(await count('viewer-open-in-standalone'), 'C: Standalone 表示').toBe(1);

        // セル D: standalone 面（__viewerConfig.kind/fileUri あり）→ 両方非表示
        //   （実 standalone 面の実測は TC-FV-51 — ここは面判別ロジックの対称性 pin）
        await page.evaluate(({ uri }) => {
            (window as any).__viewerConfig = (window as any).__viewerConfig || {};
            (window as any).__viewerConfig.kind = 'html';
            (window as any).__viewerConfig.fileUri = uri;
            window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: uri, fileName: 'doc.html', filePath: '/x/doc.html' }, '*');
        }, { uri: FILE_URI });
        await page.waitForTimeout(300);
        expect(await count('viewer-open-in-new-tab'), 'D: new tab 非表示').toBe(0);
        expect(await count('viewer-open-in-standalone'), 'D: Standalone 非表示').toBe(0);
    });
});

// ── 再オープン④（手動テスト第 7 ラウンド①③ — 実色 / タブ strip 非被覆） ──────
test.describe('note 面 viewer の第 7 ラウンド番人（FR-FV-12/13）', () => {

    test('TC-FV-73: #viewerContainer がタブ strip を覆わない（top = --notes-tab-bar-height）', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__viewerDispatcher);
        await page.evaluate(() => {
            document.documentElement.style.setProperty('--notes-tab-bar-height', '35px');
            window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: './viewer-fixtures/sample.html', fileName: 's.html' }, '*');
        });
        await page.waitForSelector('#viewerContainer', { state: 'visible', timeout: 5000 });
        const top = await page.evaluate(() => getComputedStyle(document.getElementById('viewerContainer')!).top);
        // counterfactual: inset:0 のままでは top 0px = タブ strip 被覆（file タブが「開かない」ように見える）で RED
        expect(top, 'viewer はタブ strip の下に収まる').toBe('35px');
    });

    test('TC-FV-74: ツールバーボタンの実色 = md と同じ --fr-color-text-primary（#1A1B1F）', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__viewerDispatcher);
        await page.evaluate(() => {
            window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: './viewer-fixtures/sample.html', fileName: 's.html', filePath: '/x/s.html' }, '*');
        });
        // 先頭ボタンは notes 側が動的注入する ☰（notes-panel-toggle-btn — 色は notes 側 CSS 管理）に
        // なりうるため、viewer 自前のボタン（.viewer-open-external）を対象にする
        await page.waitForSelector('#viewerContainer .viewer-toolbar .viewer-open-external', { timeout: 5000 });
        const colors = await page.evaluate(() => {
            const btn = document.querySelector('#viewerContainer .viewer-toolbar .viewer-open-external')!;
            const expected = getComputedStyle(document.documentElement).getPropertyValue('--fr-color-text-primary').trim();
            return { btn: getComputedStyle(btn).color, expected };
        });
        // tokens.css の --fr-color-text-primary（= md の --text-color 実体・#1A1B1F）に解決されること。
        // counterfactual: 旧 --fr-color-text（存在しないトークン）参照では fallback へ落下して RED（第 7 ラウンド① = md より薄い）
        const hex = colors.expected;   // '#1A1B1F'
        const rgb = `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
        expect(colors.btn, `md と同じ実色（${hex}）`).toBe(rgb);
    });
});

// ── 第 8 ラウンド②（file タブの右クリックメニュー） ──────
test.describe('file タブの右クリックメニュー（FR-FV-13 追補）', () => {

    test('TC-FV-76: Open in Standalone / Open in OS default app が出て既存 host case へ post する', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__viewerDispatcher && (window as any).__testApi);
        await page.evaluate(() => { (window as any).__testApi.initTabManager(); });
        await page.evaluate(() => {
            // タブバーは 1 タブでは非表示（既存仕様）— md タブを先に作って 2 タブにする
            (window as any).__notesTabManager.openInNewTab('/x/a.md', 'md');
            (window as any).__notesTabManager.openInNewTab('/x/doc.html', 'file', 'doc.html',
                { viewerKind: 'html', viewerFileUri: './viewer-fixtures/sample.html' });
        });
        const fileTab = page.locator('.notes-tab', { hasText: 'doc.html' });
        await fileTab.waitFor({ timeout: 5000 });
        await fileTab.click({ button: 'right' });
        await page.waitForSelector('.file-panel-context-menu', { timeout: 5000 });
        const items = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.file-panel-context-menu .file-panel-context-item, .file-panel-context-menu > div'))
                .map((e) => (e.textContent || '').trim()));
        expect(items).toContain('Open in Standalone');
        expect(items).toContain('Open in OS default app');
        // Open in Standalone → 既存 viewerOpenInNewTab case（ツールバーと同一配線）
        await page.getByText('Open in Standalone', { exact: true }).click();
        let posted = await page.evaluate(() => (window as any).__testApi.messages.filter((m: any) => m.type === 'viewerOpenInNewTab'));
        expect(posted.length).toBe(1);
        expect(posted[0].filePath).toBe('/x/doc.html');
        expect(posted[0].kind).toBe('html');
        // Open in OS default app → 既存 openExternalFallback case
        await fileTab.click({ button: 'right' });
        await page.waitForSelector('.file-panel-context-menu', { timeout: 5000 });
        await page.getByText('Open in OS default app', { exact: true }).click();
        posted = await page.evaluate(() => (window as any).__testApi.messages.filter((m: any) => m.type === 'openExternalFallback'));
        expect(posted.length).toBe(1);
        expect(posted[0].filePath).toBe('/x/doc.html');
    });
});
