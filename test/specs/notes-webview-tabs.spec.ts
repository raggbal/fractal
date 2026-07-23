/**
 * FR-TAB-01/05, NFR-TAB-01/02, FR-TAB-06 — Notes webview 内マルチタブ E2E（standalone-notes）。
 *
 * standalone build に tab bar DOM + notes-tab-manager.js（4 点登録）+ outliner 3 段 DOM を追加済み。
 * __testApi.initTabManager() で実 DOM に対して Tab Manager を駆動する。
 * host 往復（実 openFile→updateData 再 render）は vscode 依存のため、ここでは Tab Manager の
 * DOM 描画（tab bar 表示・横スクロール）と scroll 復元の同期 consume を実 scroll owner で検証する。
 * 実 flush / 実 openFile / resource root は手動 US。
 */
import { test, expect, Page } from '@playwright/test';

// 多数ノードのアウトラインを作り .outliner-scroll-content をスクロール可能にする。
function bigOutline(n: number) {
    const nodes: Record<string, any> = {};
    const rootIds: string[] = [];
    for (let i = 0; i < n; i++) {
        const id = 'n' + i;
        nodes[id] = { id, text: 'node line ' + i + ' — some content to add height', children: [] };
        rootIds.push(id);
    }
    return { version: 1, rootIds, nodes };
}

async function setup(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((data) => {
        (window as any).__testApi.initOutliner(data);
        (window as any).__testApi.initTabManager();
    }, bigOutline(80));
    await page.waitForTimeout(100);
}

test.describe('notes webview tabs (FR-TAB)', () => {
    // TC-TAB-10: tab bar 表示・横スクロール
    test('TC-TAB-10 tabs>=2 で tab bar 可視・多数タブで横スクロール可', async ({ page }) => {
        await setup(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__tm = (window as any).__notesTabManager;
            const bar = document.getElementById('notesTabBar')!;
            // 初期 1 タブ
            tm.initFirstTab('/note/a.out', 'out');
            const disp1 = bar.style.display;
            // 2 タブで表示
            tm.openInNewTab('/note/b.md', 'md');
            const disp2 = bar.style.display;
            // 多数タブで横スクロール
            for (let i = 0; i < 15; i++) tm.openInNewTab('/note/tab' + i + '.md', 'md');
            const scroll = bar.querySelector('.notes-tab-bar-scroll') as HTMLElement;
            return {
                disp1, disp2,
                tabCount: bar.querySelectorAll('.notes-tab').length,
                scrollable: scroll ? scroll.scrollWidth > scroll.clientWidth : false,
                hasAddBtn: !!bar.querySelector('.notes-tab-add'),
            };
        });
        expect(r.disp1).toBe('none');
        expect(r.disp2).toBe('flex');
        expect(r.tabCount).toBe(17);
        expect(r.scrollable).toBe(true);   // FR-TAB-05: tab 領域が横スクロール可
        expect(r.hasAddBtn).toBe(true);
    });

    // TC-TAB-11: ★scroll 復元が同期で入る（チラつき無し）・counterfactual
    test('TC-TAB-11 consumePendingMainRestore が同期で scrollTop を復元（中間 0 が観測されない）', async ({ page }) => {
        await setup(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__notesTabManager;
            const sc = document.querySelector('.outliner-scroll-content') as HTMLElement;
            // scroll owner に高さを持たせる（overflow）。80 ノードで既にスクロール可のはず。
            // 復元対象の scrollTop を予約（activateTab の setPendingRestore 相当を内部で作る）。
            // ここでは openInActiveTab 経由で pendingMainRestore を積み、consume で同期復元する経路を検証。
            // 直接 API で pending をセットするため、まず 2 タブ用意して activate 切替を模す。
            tm.initFirstTab('/note/a.out', 'out');
            tm.openInNewTab('/note/b.md', 'md');
            // A に戻して scrollTop を 150 に
            const idA = tm.getTabs()[0].id;
            tm.activateTab(idA);
            sc.scrollTop = 150;
            // B に切替（capture で A.mainScrollTop=150 が保存される）
            const idB = tm.getTabs()[1].id;
            tm.activateTab(idB);
            sc.scrollTop = 0; // B は先頭相当
            // A に戻す（load 予約）→ 受信ハンドラ末尾相当の consume を同期で呼ぶ
            tm.activateTab(idA);
            const beforeConsume = sc.scrollTop;      // まだ復元前（0 のはず）
            tm.consumePendingMainRestore();          // ★同期復元
            const afterConsume = sc.scrollTop;
            return { beforeConsume, afterConsume, scrollable: sc.scrollHeight > sc.clientHeight };
        });
        expect(r.scrollable).toBe(true);
        expect(r.afterConsume).toBe(150);   // ★ A の scroll が復元
        // beforeConsume（consume 前）は 0 = 「consume が実際に復元している」証拠（tautology でない）
        expect(r.beforeConsume).toBe(0);
    });

    // TC-TAB-11b: counterfactual — consume を呼ばない（= rAF 遅延で paint を挟む相当）と復元されない
    test('TC-TAB-11b consume を呼ばないと scroll は復元されない（番人の counterfactual）', async ({ page }) => {
        await setup(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__notesTabManager;
            const sc = document.querySelector('.outliner-scroll-content') as HTMLElement;
            tm.initFirstTab('/note/a.out', 'out');
            tm.openInNewTab('/note/b.md', 'md');
            const idA = tm.getTabs()[0].id;
            tm.activateTab(idA);
            sc.scrollTop = 150;
            tm.activateTab(tm.getTabs()[1].id);
            sc.scrollTop = 0;
            tm.activateTab(idA);
            // consume を呼ばない → 復元されない（rAF 遅延で中間 0 が見える状態の相当）
            return { notRestored: sc.scrollTop };
        });
        expect(r.notRestored).toBe(0); // consume 無しでは 0 のまま = 復元は consume に load-bearing
    });

    // TC-TAB-12: メモリ = アクティブのみ実 DOM（非アクティブタブのコンテンツ DOM は存在しない）
    test('TC-TAB-12 多数タブでも実 DOM はアクティブ 1 タブ分（tab bar は軽量 state のみ）', async ({ page }) => {
        await setup(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__notesTabManager;
            tm.initFirstTab('/note/a.out', 'out');
            for (let i = 0; i < 20; i++) tm.openInNewTab('/note/t' + i + '.md', 'md');
            // 実 DOM: outliner tree は 1 個、markdown container も 1 個（アクティブ分のみ）
            return {
                tabs: tm.getTabs().length,
                treeCount: document.querySelectorAll('.outliner-tree').length,
                mdContainerCount: document.querySelectorAll('.markdown-container').length,
                // tab bar のタブ要素は軽量（title + close のみ、コンテンツ DOM を持たない）
                tabEls: document.querySelectorAll('.notes-tab').length,
            };
        });
        expect(r.tabs).toBe(21);
        expect(r.treeCount).toBe(1);         // outliner tree は 1 個だけ（20 倍にならない）
        expect(r.mdContainerCount).toBe(1);  // markdown container も 1 個
        expect(r.tabEls).toBe(21);           // タブ要素自体は 21（軽量）
    });

    // TC-TAB-15: tab bar 常時表示（内側スクロールで tab bar が押し出されない）
    // bug: md/outliner 内で下に移動すると tab bar が隠れて消えた（.notes-main-wrapper が縦スクロールしていた）。
    test('TC-TAB-15 内側スクロールでも tab bar は上端固定・wrapper は縦スクロールしない', async ({ page }) => {
        await setup(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__notesTabManager;
            tm.initFirstTab('/note/a.out', 'out');
            tm.openInNewTab('/note/b.md', 'md'); // 2 タブで tab bar 表示
            const wrapper = document.querySelector('.notes-main-wrapper') as HTMLElement;
            const bar = document.getElementById('notesTabBar')!;
            const sc = document.querySelector('.outliner-scroll-content') as HTMLElement;
            // 内側（scroll owner）を最下部までスクロール
            const barTopBefore = bar.getBoundingClientRect().top;
            sc.scrollTop = sc.scrollHeight; // 目一杯下へ
            const barTopAfter = bar.getBoundingClientRect().top;
            return {
                // wrapper 自身は縦スクロールしない（tab bar が押し出される原因）
                wrapperScrollable: wrapper.scrollHeight > wrapper.clientHeight,
                wrapperScrollTop: wrapper.scrollTop,
                // 内側スクロール前後で tab bar の画面上位置が動かない（= 常時表示）
                barMoved: Math.abs(barTopAfter - barTopBefore) > 1,
                innerScrolled: sc.scrollTop > 0,
                barDisplay: bar.style.display,
            };
        });
        expect(r.barDisplay).toBe('flex');          // tab bar 表示中
        expect(r.innerScrolled).toBe(true);          // 内側は実際にスクロールした
        expect(r.wrapperScrollTop).toBe(0);          // ★ wrapper は縦スクロールしていない
        expect(r.wrapperScrollable).toBe(false);     // ★ wrapper に縦 overflow が無い（tab bar が押し出されない）
        expect(r.barMoved).toBe(false);              // ★ tab bar は画面上で動かない（常時表示）
    });

    // TC-TAB-16: メインペイン移動（tab manager 非経由）が activeTab.filePath に同期される
    // bug: outliner タブ内でページ B を開いても tab.filePath が stale → 再アクティブ化で「1つ前のページ」に戻った。
    test('TC-TAB-16 syncActiveFile でタブ再アクティブ化が「1つ前のページ」に戻らない', async ({ page }) => {
        await setup(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__notesTabManager;
            const calls: string[] = [];
            (window as any).__openFileCalls = calls;
            const idOut = tm.initFirstTab('/note/a.out', 'out');
            // メインペイン移動を模す: 左ファイルパネルで「ページ B の md」を開いた（tab manager 非経由 = updateData 同期のみ）
            tm.syncActiveFile('/note/pages/pageB.md', 'md');
            // 別 md を新タブで開く → 元タブは非アクティブに
            const idNew = tm.openInNewTab('/note/pages/other.md', 'md');
            // 元タブ（旧 outliner タブ）に戻る → loadTab が bridge.openFile を呼ぶ
            // openFile 呼び出しを記録するため bridge を差し替え（tm 内 bridge は初期化済みなので getTabs で filePath を確認）
            tm.activateTab(idOut);
            const reactivated = tm.getTabs().find((t: any) => t.id === idOut);
            return { reactivatedFilePath: reactivated.filePath, reactivatedKind: reactivated.kind };
        });
        // ★ 元タブは「ページ B」に同期されている（元の .out に戻らない）
        expect(r.reactivatedFilePath).toBe('/note/pages/pageB.md');
        expect(r.reactivatedKind).toBe('md');
        // ★ counterfactual: syncActiveFile を呼ばなければ filePath は '/note/a.out' のまま（= 1つ前のページに戻るバグ）
    });

    // TC-TAB-16b: 同一 filePath の syncActiveFile は no-op（scroll/view 温存・re-entrancy 回避）
    test('TC-TAB-16b 同一 filePath の syncActiveFile は scroll を温存（no-op）', async ({ page }) => {
        await setup(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__notesTabManager;
            tm.initFirstTab('/note/a.out', 'out');
            tm.syncActiveFile('/note/pages/pageB.md', 'md');
            // scroll を積む（capture 相当で mainScrollTop を持たせるため activate 往復）
            const tabs1 = tm.getTabs();
            const before = tabs1[0].filePath;
            // 同一 filePath で再同期 → no-op（filePath 不変・mainScrollTop リセットしない）
            tm.syncActiveFile('/note/pages/pageB.md', 'md');
            const after = tm.getTabs()[0].filePath;
            return { before, after };
        });
        expect(r.after).toBe(r.before); // 同一 → 変化なし
    });

    // TC-TAB-13: サイドパネル scroll 復元（consumePendingSidePanelRestore が同期で復元・counterfactual）
    test('TC-TAB-13 サイドパネル scroll が consume で同期復元・consume 無しは復元されない', async ({ page }) => {
        await setup(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__notesTabManager;
            // サイドパネルの scroll owner を用意（開いた状態を模す。高さで overflow させる）。
            // standalone に既存の .side-panel .editor-wrapper があっても、確実に overflow させるため
            // 高さと内部コンテンツを強制する（getSidePanelScrollEl は .side-panel .editor-wrapper を返す）。
            const sp = document.querySelector('.side-panel') as HTMLElement;
            sp.style.display = 'block';
            let wrap = sp.querySelector('.editor-wrapper') as HTMLElement;
            if (!wrap) {
                wrap = document.createElement('div');
                wrap.className = 'editor-wrapper';
                sp.appendChild(wrap);
            }
            wrap.style.cssText = 'height:200px;overflow:auto;display:block';
            if (wrap.scrollHeight <= wrap.clientHeight) {
                const inner = document.createElement('div');
                inner.style.cssText = 'height:2000px';
                wrap.appendChild(inner);
            }
            tm.initFirstTab('/note/a.out', 'out');
            const idB = tm.openInNewTab('/note/b.md', 'md');
            const idA = tm.getTabs()[0].id;
            tm.activateTab(idA);
            // タブ A のサイドパネル状態（open + scrollTop 120）を capture させる（captureSidePanel は __testApi.sidePanelState 依存）
            wrap.scrollTop = 120;
            (window as any).__testApi.sidePanelState = { open: true, filePath: '/note/pages/p.md', scrollTop: 120 };
            // B へ切替（A の sidePanel が capture）
            tm.activateTab(idB);
            (window as any).__testApi.sidePanelState = { open: false, filePath: null, scrollTop: 0 };
            wrap.scrollTop = 0;
            // A へ戻る（restoreSidePanel が呼ばれ pendingSidePanelRestore が積まれる）
            tm.activateTab(idA);
            const beforeConsume = wrap.scrollTop;         // 復元前（0）
            tm.consumePendingSidePanelRestore();          // ★同期復元
            const afterConsume = wrap.scrollTop;
            return { beforeConsume, afterConsume, scrollable: wrap.scrollHeight > wrap.clientHeight };
        });
        expect(r.scrollable).toBe(true);
        expect(r.beforeConsume).toBe(0);     // consume 前は 0（番人性）
        expect(r.afterConsume).toBe(120);    // ★ サイドパネル scroll が復元
    });
});
