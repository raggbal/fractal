/**
 * FR-TAB-01/02/03/04/05/06/07, NFR-TAB-01/03/06 — Notes webview 内マルチタブ Tab Manager 純ロジック。
 *
 * notes-tab-manager.js は純 DOM + bridge。ここでは about:blank に module を inject し、
 * 最小 DOM（tab bar + mock scroll owner）+ mock bridge（呼出記録）で state 遷移を検証する。
 * 実 openFile/updateData 経路・実 scroll 描画は standalone E2E（notes-webview-tabs.spec.ts）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const TAB_MANAGER_JS = fs.readFileSync(
    path.join(__dirname, '../../src/shared/notes-tab-manager.js'), 'utf8');

// about:blank に module を inject し、mock 環境で __initNotesTabManager を初期化するヘルパ。
async function setupTabManager(page: import('@playwright/test').Page) {
    await page.goto('about:blank');
    await page.addScriptTag({ content: TAB_MANAGER_JS });
    await page.evaluate(() => {
        // 最小 DOM
        const bar = document.createElement('div');
        bar.id = 'notesTabBar';
        document.body.appendChild(bar);
        // mock scroll owner（アクティブ main）: scrollTop を持つだけ
        const scrollEl: any = { scrollTop: 0 };
        (window as any).__mockScrollEl = scrollEl;
        (window as any).__mockSidePanelScrollEl = { scrollTop: 0 };
        // mock bridge（呼出記録）
        const calls: any[] = [];
        (window as any).__calls = calls;
        // webview flush の順序検証用フラグ
        (window as any).__unsentBuffer = false; // 「未送信編集あり」を模す
        const bridge = {
            openFile: (fp: string) => calls.push({ m: 'openFile', fp }),
            flushActive: () => calls.push({ m: 'flushActive' }),
            restoreSidePanel: (fp: string) => calls.push({ m: 'restoreSidePanel', fp }),
            closeSidePanel: () => calls.push({ m: 'closeSidePanel' }),
            openInVscodeTab: (fp: string) => calls.push({ m: 'openInVscodeTab', fp }),
        };
        (window as any).__tm = (window as any).__initNotesTabManager({
            tabBarEl: bar,
            getActiveMainScrollEl: () => (window as any).__mockScrollEl,
            bridge,
            flushActiveWebview: () => {
                calls.push({ m: 'flushActiveWebview' });
                (window as any).__unsentBuffer = false; // webview flush で未送信が空になる
            },
            captureOutlinerView: () => ({ focusedNodeId: 'n1', currentScope: { type: 'document' } }),
            applyOutlinerView: (v: any) => calls.push({ m: 'applyOutlinerView', v }),
            captureSidePanel: () => (window as any).__sidePanelState || { open: false, filePath: null, scrollTop: 0 },
            getSidePanelScrollEl: () => (window as any).__mockSidePanelScrollEl,
            closeSidePanelInWebview: () => calls.push({ m: 'closeSidePanelInWebview' }),
        });
    });
}

test.describe('FR-TAB — Notes Tab Manager 純ロジック', () => {
    // TC-TAB-01: 表示条件
    test('TC-TAB-01 tabs=1 で非表示 / 2 で表示 / 閉じて 1 で再び非表示', async ({ page }) => {
        await setupTabManager(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__tm;
            const bar = document.getElementById('notesTabBar')!;
            tm.initFirstTab('/note/a.out', 'out');
            const disp1 = bar.style.display;
            tm.openInNewTab('/note/b.md', 'md');
            const disp2 = bar.style.display;
            const secondId = tm.getActiveId();
            tm.closeTab(secondId);
            const disp3 = bar.style.display;
            return { disp1, disp2, disp3, tabs: tm.getTabs().length };
        });
        expect(r.disp1).toBe('none');       // 1 タブ
        expect(r.disp2).toBe('flex');       // 2 タブ
        expect(r.disp3).toBe('none');       // 1 タブに戻る
        expect(r.tabs).toBe(1);
    });

    // TC-TAB-02: 新タブ追加
    test('TC-TAB-02 openInNewTab で tabs+1・新タブ active・bridge.openFile 呼び', async ({ page }) => {
        await setupTabManager(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__tm;
            tm.initFirstTab('/note/a.out', 'out');
            (window as any).__calls.length = 0;
            const id = tm.openInNewTab('/note/b.md', 'md');
            return {
                tabs: tm.getTabs().length,
                activeIsNew: tm.getActiveId() === id,
                openFileCalled: (window as any).__calls.filter((c: any) => c.m === 'openFile' && c.fp === '/note/b.md').length,
            };
        });
        expect(r.tabs).toBe(2);
        expect(r.activeIsNew).toBe(true);
        expect(r.openFileCalled).toBe(1);
    });

    // TC-TAB-03: 切替 capture/restore（★load-bearing）
    test('TC-TAB-03 切替で A の scroll を capture・B load 後に A へ戻ると復元される', async ({ page }) => {
        await setupTabManager(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__tm;
            const idA = tm.initFirstTab('/note/a.out', 'out');
            const idB = tm.openInNewTab('/note/b.md', 'md');
            // A に戻して A をアクティブにし、scroll を 120 に
            tm.activateTab(idA);
            (window as any).__mockScrollEl.scrollTop = 120;
            // B へ切替（capture が走る）→ A へ戻す
            tm.activateTab(idB);
            (window as any).__mockScrollEl.scrollTop = 0; // B は先頭
            tm.activateTab(idA);
            // 受信ハンドラ末尾相当: consume で同期復元
            tm.consumePendingMainRestore();
            return { restored: (window as any).__mockScrollEl.scrollTop };
        });
        expect(r.restored).toBe(120); // A の scroll が復元
    });

    // TC-TAB-03b: ★flush 二段（データ損失防止・load-bearing）
    test('TC-TAB-03b 切替で webview flush が host flush より先・未送信が空に', async ({ page }) => {
        await setupTabManager(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__tm;
            const idA = tm.initFirstTab('/note/a.out', 'out');
            const idB = tm.openInNewTab('/note/b.md', 'md');
            tm.activateTab(idA);
            (window as any).__calls.length = 0;
            (window as any).__unsentBuffer = true; // debounce 窓内編集を模す
            tm.activateTab(idB);
            const calls = (window as any).__calls.map((c: any) => c.m);
            const wIdx = calls.indexOf('flushActiveWebview');
            const hIdx = calls.indexOf('flushActive');
            return { wIdx, hIdx, unsent: (window as any).__unsentBuffer };
        });
        expect(r.wIdx).toBeGreaterThanOrEqual(0);       // webview flush が呼ばれた
        expect(r.hIdx).toBeGreaterThanOrEqual(0);       // host flush が呼ばれた
        expect(r.wIdx).toBeLessThan(r.hIdx);            // ★ webview flush → host flush の順
        expect(r.unsent).toBe(false);                    // ★ 未送信バッファが空（編集消失しない）
    });

    // TC-TAB-04: 閉じる・最後の 1 タブは閉じない
    test('TC-TAB-04 closeTab で隣が active・最後の 1 タブは閉じない', async ({ page }) => {
        await setupTabManager(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__tm;
            const idA = tm.initFirstTab('/note/a.out', 'out');
            const idB = tm.openInNewTab('/note/b.md', 'md');
            const idC = tm.openInNewTab('/note/c.md', 'md');
            // idC が active。閉じると隣（右優先だが末尾なので左 = idB）が active
            tm.activateTab(idC);
            tm.closeTab(idC);
            const afterCloseC = tm.getActiveId();
            // さらに閉じて 1 タブに
            tm.closeTab(tm.getActiveId());
            const oneLeft = tm.getTabs().length;
            const lastId = tm.getActiveId();
            // 最後の 1 タブは閉じない
            tm.closeTab(lastId);
            return { afterCloseC, idB, oneLeft, finalTabs: tm.getTabs().length };
        });
        expect(r.afterCloseC).toBe(r.idB); // idC を閉じたら idB が active
        expect(r.oneLeft).toBe(1);
        expect(r.finalTabs).toBe(1);       // 最後の 1 タブは閉じられない
    });

    // TC-TAB-05: Recent 現タブ（★load-bearing）
    test('TC-TAB-05 openInActiveTab は tabs を増やさず現 active の filePath を差替', async ({ page }) => {
        await setupTabManager(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__tm;
            tm.initFirstTab('/note/a.out', 'out');
            tm.openInNewTab('/note/b.md', 'md');
            const before = tm.getTabs().length;
            (window as any).__calls.length = 0;
            tm.openInActiveTab('/other/recent.md', 'md');
            const active = tm.getTabs().find((t: any) => t.id === tm.getActiveId());
            return {
                before,
                after: tm.getTabs().length,
                activeFp: active.filePath,
                openFileCalled: (window as any).__calls.filter((c: any) => c.m === 'openFile' && c.fp === '/other/recent.md').length,
            };
        });
        expect(r.after).toBe(r.before);           // tabs 増えない
        expect(r.activeFp).toBe('/other/recent.md');
        expect(r.openFileCalled).toBe(1);
    });

    // TC-TAB-06: 重複ポリシー
    test('TC-TAB-06 ＋=複製 tabs+1 / Recent=不変 / リンク=tabs+1', async ({ page }) => {
        await setupTabManager(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__tm;
            tm.initFirstTab('/note/a.out', 'out');
            const n0 = tm.getTabs().length;
            // ＋ 複製（現 active を複製）
            const active = tm.getTabs().find((t: any) => t.id === tm.getActiveId());
            tm.openInNewTab(active.filePath, active.kind);
            const nPlus = tm.getTabs().length;
            // Recent（現タブ）
            tm.openInActiveTab('/x/r.md', 'md');
            const nRecent = tm.getTabs().length;
            // リンク cmd+click（新タブ）
            tm.openInNewTab('/x/link.md', 'md');
            const nLink = tm.getTabs().length;
            return { n0, nPlus, nRecent, nLink };
        });
        expect(r.nPlus).toBe(r.n0 + 1);       // ＋ で +1
        expect(r.nRecent).toBe(r.nPlus);       // Recent で不変
        expect(r.nLink).toBe(r.nRecent + 1);   // リンクで +1
    });

    // TC-TAB-07: サイドパネル state per-tab
    test('TC-TAB-07 タブ毎に sidePanel 状態を保持・復元/クローズを呼び分け', async ({ page }) => {
        await setupTabManager(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__tm;
            const idA = tm.initFirstTab('/note/a.out', 'out');
            const idB = tm.openInNewTab('/note/b.md', 'md');
            // A をアクティブにし、A のサイドパネルを open 状態に（capture は「タブを離れる瞬間の live 状態」を読む）
            tm.activateTab(idA);
            (window as any).__sidePanelState = { open: true, filePath: '/note/pages/p.md', scrollTop: 80 };
            (window as any).__calls.length = 0;
            // B へ切替: captureActive(A) が live=open を読んで A.sidePanel に退避 → loadTab(B) は closeSidePanel
            tm.activateTab(idB);
            // B load 後はサイドパネルが閉じた状態（次に B を離れる時に B.sidePanel=閉 が capture される）
            (window as any).__sidePanelState = { open: false, filePath: null, scrollTop: 0 };
            const bCalls = (window as any).__calls.map((c: any) => c.m);
            // A へ戻る（A の sidePanel が open だったので restoreSidePanel が呼ばれる）
            (window as any).__calls.length = 0;
            tm.activateTab(idA);
            const aCalls = (window as any).__calls.filter((c: any) => c.m === 'restoreSidePanel');
            return {
                bClosed: bCalls.indexOf('closeSidePanel') >= 0,
                aRestored: aCalls.length,
                aRestoreFp: aCalls[0] ? aCalls[0].fp : null,
            };
        });
        expect(r.bClosed).toBe(true);                       // B（閉）へは closeSidePanel
        expect(r.aRestored).toBe(1);                        // A（開）へ戻ると restoreSidePanel
        expect(r.aRestoreFp).toBe('/note/pages/p.md');
    });

    // ===== sprint 20260724-042927: サイドパネル×タブ共存 =====

    // TC-SPC-07: updateActiveSidePanel でアクティブタブの sidePanel 状態が追随
    test('TC-SPC-07 updateActiveSidePanel が activeTab.sidePanel を更新する', async ({ page }) => {
        await setupTabManager(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__tm;
            tm.initFirstTab('/note/a.out', 'out');
            tm.updateActiveSidePanel({ open: true, filePath: '/note/pages/p.md', scrollTop: 40 });
            const active = tm.getTabs().find((t: any) => t.id === tm.getActiveId());
            return { open: active.sidePanel.open, fp: active.sidePanel.filePath, st: active.sidePanel.scrollTop };
        });
        expect(r.open).toBe(true);
        expect(r.fp).toBe('/note/pages/p.md');
        expect(r.st).toBe(40);
    });

    // TC-SPC-09（★load-bearing・#3d・counterfactual）: サイドパネル無しタブへ切替で webview 内 close が呼ばれる
    test('TC-SPC-09 サイドパネル無しタブへ切替 → closeSidePanelInWebview が呼ばれる（host 往復だけでない）', async ({ page }) => {
        await setupTabManager(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__tm;
            const idA = tm.initFirstTab('/note/a.out', 'out');
            const idB = tm.openInNewTab('/note/b.md', 'md');
            // A をアクティブにし、A のサイドパネルを open に（capture で退避される）
            tm.activateTab(idA);
            (window as any).__sidePanelState = { open: true, filePath: '/note/pages/p.md', scrollTop: 0 };
            (window as any).__calls.length = 0;
            // B（サイドパネル無し）へ切替 → loadTab の close 分岐が closeSidePanelInWebview を呼ぶ
            tm.activateTab(idB);
            const calls = (window as any).__calls.map((c: any) => c.m);
            return {
                closeInWebview: calls.filter((m: string) => m === 'closeSidePanelInWebview').length,
                closeBridge: calls.filter((m: string) => m === 'closeSidePanel').length,
            };
        });
        expect(r.closeInWebview).toBe(1);   // ★ webview 内で直接閉じる（.side-panel.open を外す）
        expect(r.closeBridge).toBe(1);       // host 往復（watcher dispose）も呼ぶ
        // counterfactual: closeSidePanelInWebview が無い（host bridge のみ）と .side-panel.open が残り前タブのパネルが見えたまま
    });

    // ===== sprint 20260724-063158: タブ/サイドパネル追加改修 =====

    // TC-TP-04a（tab 名 title 優先・early-return 是正・FR-TP-04）★load-bearing
    test('TC-TP-04a syncActiveFile が title を優先・filePath 同一でも title 更新', async ({ page }) => {
        await setupTabManager(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__tm;
            tm.initFirstTab('/note/pages/p.md', 'md');
            // title 提供 → basename でなく title
            tm.syncActiveFile('/note/pages/p.md', 'md', 'My Title');
            const t1 = tm.getTabs()[0].title;
            // ★ filePath 同一でも title 更新（early-return が title をバイパスしない）
            tm.syncActiveFile('/note/pages/p.md', 'md', 'Renamed Title');
            const t2 = tm.getTabs()[0].title;
            // title 未提供の別ファイル → basename フォールバック
            tm.syncActiveFile('/note/pages/q.md', 'md');
            const t3 = tm.getTabs()[0].title;
            return { t1, t2, t3 };
        });
        expect(r.t1).toBe('My Title');
        expect(r.t2).toBe('Renamed Title');   // ★ 同一 filePath でも title 更新
        expect(r.t3).toBe('q');                // title 無し → basename
    });

    // TC-TP-04b（updateActiveTabTitle 即時反映・FR-TP-04）
    test('TC-TP-04b updateActiveTabTitle が active タブ title を更新', async ({ page }) => {
        await setupTabManager(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__tm;
            tm.initFirstTab('/note/a.out', 'out', 'Old Title');
            tm.updateActiveTabTitle('New Title');
            return tm.getTabs()[0].title;
        });
        expect(r).toBe('New Title');
    });

    // TC-TP-06（右クリック→openInVscodeTab・md のみ・FR-TP-06）★load-bearing・counterfactual
    test('TC-TP-06 md タブ右クリックで Open in VS Code Tab → openInVscodeTab / out タブはメニュー無し', async ({ page }) => {
        await setupTabManager(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__tm;
            const idOut = tm.initFirstTab('/note/a.out', 'out');
            const idMd = tm.openInNewTab('/note/b.md', 'md');   // 2 タブで tab bar 表示
            const bar = document.getElementById('notesTabBar')!;
            function tabEl(id: string) {
                var els = bar.querySelectorAll('.notes-tab');
                for (var i = 0; i < els.length; i++) { if ((els[i] as HTMLElement).dataset.tabId === id) return els[i] as HTMLElement; }
                return null;
            }
            // out タブに contextmenu → メニュー出ない
            (window as any).__calls.length = 0;
            tabEl(idOut)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
            const outMenu = document.querySelector('.file-panel-context-menu');
            // md タブに contextmenu → メニュー出る → 項目 click → openInVscodeTab
            tabEl(idMd)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
            const mdMenu = document.querySelector('.file-panel-context-menu');
            const item = mdMenu ? mdMenu.querySelector('.file-panel-context-item') as HTMLElement : null;
            if (item) item.click();
            const calls = (window as any).__calls.map((c: any) => c.m + ':' + (c.fp || ''));
            return {
                outMenuShown: !!outMenu,
                mdMenuShown: !!mdMenu,
                itemLabel: item ? item.textContent : null,
                openInVscodeTabCalled: calls.filter((s: string) => s === 'openInVscodeTab:/note/b.md').length,
            };
        });
        expect(r.outMenuShown).toBe(false);   // ★ out タブはメニュー出ない
        expect(r.mdMenuShown).toBe(true);      // md タブはメニュー出る
        expect(r.itemLabel).toBe('Open in VS Code Tab');
        expect(r.openInVscodeTabCalled).toBe(1);  // ★ 項目 click で openInVscodeTab(filePath)
    });
});
