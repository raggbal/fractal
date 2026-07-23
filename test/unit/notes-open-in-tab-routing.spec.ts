/**
 * FR-TAB-02 / NFR-TAB-04 — Notes サイドパネル「Open in tab」経路（TASK-08 の fix）の番人。
 *
 * outliner.js の side-panel-open-tab は host=outlinerHostBridge → shared openLinkInTab →
 * postMessage({type:'openLinkInTab'}) → notes-message-handler.ts の case 'openLinkInTab' に落ちる。
 * その分岐（.md → openFileInWebviewTab / それ以外 → openFileInEditor）を検証する。
 *
 * 注: notes-message-handler.ts は mindmap-export-host 経由で `vscode` を transitive import するため
 * Playwright unit 環境に直接 import できない（Cannot find module 'vscode'）。よって分岐述語を
 * ミラー（handler の実コードと 1:1 の文字列判定）して検証する（notes-link-history.spec の
 * dispatchOnFileOpened ミラーと同じ確立パターン）。実 handler 実行と VS Code タブ非オープンは手動 US。
 */
import { test, expect } from '@playwright/test';

// notes-message-handler.ts の case 'openLinkInTab' 分岐と 1:1 のミラー。
// 変更時は両方を同時に直すこと（src が真実）。
function routeOpenLinkInTab(
    href: string,
    hasWebviewTab: boolean,
): 'openFileInWebviewTab' | 'openFileInEditor' | 'none' {
    if (!href) return 'none';
    const lower = String(href).toLowerCase();
    if ((lower.endsWith('.md') || lower.endsWith('.markdown')) && hasWebviewTab) {
        return 'openFileInWebviewTab';
    }
    return 'openFileInEditor';
}

test.describe('FR-TAB-02 — Notes サイドパネル Open-in-tab routing (TASK-08)', () => {
    // TC-TAB-14（★load-bearing・counterfactual）: openLinkInTab(.md) は webview タブ・VS Code タブを開かない
    test('TC-TAB-14 openLinkInTab(.md) → openFileInWebviewTab（openFileInEditor でない）', () => {
        expect(routeOpenLinkInTab('/note/pages/p.md', true)).toBe('openFileInWebviewTab');
        expect(routeOpenLinkInTab('/note/pages/p.markdown', true)).toBe('openFileInWebviewTab');
        // ★ counterfactual: webview タブに落ちる = openFileInEditor（VS Code 別タブ）ではない
        expect(routeOpenLinkInTab('/note/pages/p.md', true)).not.toBe('openFileInEditor');
    });

    // TC-TAB-14b: .md 以外（画像等）は従来どおり openFileInEditor（非 md は webview タブ化しない）
    test('TC-TAB-14b openLinkInTab(非 md) → openFileInEditor（従来経路を温存）', () => {
        expect(routeOpenLinkInTab('/note/files/a.pdf', true)).toBe('openFileInEditor');
        expect(routeOpenLinkInTab('/note/files/a.png', true)).toBe('openFileInEditor');
    });

    // TC-TAB-14c（後方互換）: openFileInWebviewTab 未実装の platform では openFileInEditor フォールバック
    test('TC-TAB-14c openFileInWebviewTab 無しは openFileInEditor フォールバック', () => {
        expect(routeOpenLinkInTab('/note/pages/p.md', false)).toBe('openFileInEditor');
    });
});
