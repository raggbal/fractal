/**
 * TASK-05 — 小 viewport（400×300）で 7 サイトの右クリックメニューを開くテストハーネス
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-MFIT-01 の検証前提）
 *
 * TC-MFIT-01..14 は「7 サイト × 右下隅 / tall menu」の 14 セルを踏む（testcases.md の
 * メニュー配置マトリクス）。各 spec で面ごとの開き方を書くと 14 箇所に重複するため 1 本化する。
 *
 * 面の識別子とメニュー要素の対応（実コードから採取）:
 *   outliner-node   → .outliner-context-menu     （src/webview/outliner.js:7353）
 *   outliner-column → .outliner-col-ctx-menu     （同 :3172）
 *   md-editor       → .editor-context-menu       （src/webview/editor.js:961）
 *   tree-file       → .file-panel-context-menu   （src/shared/notes-file-panel.js:558）
 *   tree-folder     → .file-panel-context-menu   （同 showFolderContextMenu）
 *   linkedfd-row    → .fv-menu                   （src/shared/notes-folder-view.js:772）
 *   mindmap         → .mindmap-context-menu      （src/webview/mindmap-interactions.js:1828）
 */
import type { Page } from '@playwright/test';

/** 対象の 7 サイト。 */
export type MenuSite =
    | 'outliner-node'
    | 'outliner-column'
    | 'md-editor'
    | 'tree-file'
    | 'tree-folder'
    | 'linkedfd-row'
    | 'mindmap';

export const MENU_SITES: MenuSite[] = [
    'outliner-node',
    'outliner-column',
    'md-editor',
    'tree-file',
    'tree-folder',
    'linkedfd-row',
    'mindmap',
];

/** 各サイトのメニュー要素セレクタ（実コードの className と 1:1）。 */
export const MENU_SELECTOR: Record<MenuSite, string> = {
    'outliner-node': '.outliner-context-menu',
    'outliner-column': '.outliner-col-ctx-menu',
    'md-editor': '.editor-context-menu',
    'tree-file': '.file-panel-context-menu',
    'tree-folder': '.file-panel-context-menu',
    'linkedfd-row': '.fv-menu',
    'mindmap': '.mindmap-context-menu',
};

/** そのサイトを載せているハーネス HTML。 */
export const MENU_HARNESS: Record<MenuSite, string> = {
    'outliner-node': '/standalone-outliner.html',
    'outliner-column': '/standalone-outliner.html',
    'md-editor': '/standalone-editor.html',
    'tree-file': '/standalone-notes.html',
    'tree-folder': '/standalone-notes.html',
    'linkedfd-row': '/standalone-notes.html',
    'mindmap': '/standalone-outliner.html',
};

export const SMALL_VIEWPORT = { width: 400, height: 300 };
/** 右下隅（viewport の端から 5px 内側）。flip + clamp を確実に発火させる。 */
export const BOTTOM_RIGHT = { x: SMALL_VIEWPORT.width - 5, y: SMALL_VIEWPORT.height - 5 };

/**
 * 小 viewport でハーネスを開き、outliner init の遅延タイマー着地を待つ。
 *
 * outliner.js の init は `setTimeout(100)` で `focusFirstVisibleNode()` を呼ぶため、
 * 着地前に操作するとフォーカスを奪われる（generator_failures 2026-08-29:
 * **sleep 延長では直らない** — 条件待ちが必要）。
 */
export async function gotoSmall(page: Page, site: MenuSite): Promise<void> {
    await page.setViewportSize(SMALL_VIEWPORT);
    await page.goto(MENU_HARNESS[site]);
    // 遅延自動フォーカスの着地を条件待ち（着地しない面ではタイムアウトせず素通りさせる）
    await page
        .waitForFunction(() => {
            const ae = document.activeElement as HTMLElement | null;
            return !!ae && ae !== document.body;
        }, undefined, { timeout: 3000 })
        .catch(() => { /* この面に自動フォーカスが無いだけ — 続行してよい */ });
}

/** 指定座標で contextmenu を発火する（既存 spec と同じ MouseEvent 経路）。 */
export async function fireContextMenu(
    page: Page, targetSelector: string, at: { x: number; y: number },
): Promise<void> {
    await page.evaluate(
        ({ sel, x, y }) => {
            const el = document.querySelector(sel);
            if (!el) { throw new Error('contextmenu の対象が見つからない: ' + sel); }
            el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }));
        },
        { sel: targetSelector, x: at.x, y: at.y },
    );
}

export interface MenuRect {
    left: number; top: number; right: number; bottom: number;
    width: number; height: number;
    vw: number; vh: number;
    maxHeight: string; overflowY: string;
    scrollable: boolean;
}

/** メニュー要素の rect と overflow 状態を採る。 */
export async function measureMenu(page: Page, site: MenuSite): Promise<MenuRect> {
    const sel = MENU_SELECTOR[site];
    await page.waitForSelector(sel, { state: 'attached', timeout: 5000 });
    return page.evaluate((s) => {
        const el = document.querySelector(s) as HTMLElement;
        const r = el.getBoundingClientRect();
        return {
            left: r.left, top: r.top, right: r.right, bottom: r.bottom,
            width: r.width, height: r.height,
            vw: window.innerWidth, vh: window.innerHeight,
            maxHeight: el.style.maxHeight, overflowY: el.style.overflowY,
            scrollable: el.scrollHeight > el.clientHeight,
        };
    }, sel);
}

/**
 * メニューの 4 辺が viewport 内にあることを assert する（NFR-MFIT-01）。
 * 数値の許容は 0（端まで許すが 1px でも出たら fail）。
 */
export function assertWithinViewport(r: MenuRect, label: string): void {
    const errors: string[] = [];
    if (r.left < 0) { errors.push(`left=${r.left} < 0`); }
    if (r.top < 0) { errors.push(`top=${r.top} < 0`); }
    if (r.right > r.vw) { errors.push(`right=${r.right} > vw=${r.vw}`); }
    if (r.bottom > r.vh) { errors.push(`bottom=${r.bottom} > vh=${r.vh}`); }
    if (errors.length > 0) {
        throw new Error(`${label}: メニューが viewport から出ている — ${errors.join(' / ')}`);
    }
}

/**
 * そのサイトのメニューを viewport 高を超える長さにする（tall menu 条件）。
 * 実装のメニュー項目数は面ごとに違うので、**開いたメニューに項目を注入して伸ばす**
 * （メニュー本体の項目構成をテストのために変えない）。
 *
 * @returns 伸ばした後の項目数
 */
export async function inflateMenu(page: Page, site: MenuSite, minHeightPx = 800): Promise<number> {
    const sel = MENU_SELECTOR[site];
    return page.evaluate(
        ({ s, minH }) => {
            const el = document.querySelector(s) as HTMLElement;
            if (!el) { throw new Error('メニューが開いていない: ' + s); }
            // 既存項目を複製して伸ばす（class 構成を保つため最後の子を clone する）
            const proto = el.lastElementChild;
            if (!proto) { throw new Error('メニュー項目が無い: ' + s); }
            let guard = 0;
            while (el.getBoundingClientRect().height < minH && guard < 200) {
                el.appendChild(proto.cloneNode(true));
                guard++;
            }
            return el.children.length;
        },
        { s: sel, minH: minHeightPx },
    );
}
