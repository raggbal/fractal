/**
 * Fractal の Notes 画面（VS Code の webview・デスクトップアプリの note のビュー）の操作。
 * VS Code では webview の frame、デスクトップアプリでは note のビューの page を渡す。
 */
import type { Frame, Page } from '@playwright/test';
import { sleep } from './demo';

export type View = Page | Frame;

/** 左の note のツリーの項目を開く */
export async function openTreeItem(v: View, title: string): Promise<void> {
    await v.locator('.file-panel-item', { hasText: title }).first().click();
    await sleep(1500);
}

/** 左の note のツリーを畳む */
export async function collapseTree(v: View): Promise<void> {
    const b = v.locator('#filePanelCollapse');
    if (await b.isVisible()) {
        await b.click();
        await sleep(500);
    }
}

/** 本文が text のノードのアイコン（iconSel: '.outliner-page-icon'・'.outliner-file-icon'・'.mindmap-node-icon'）を押す */
export async function clickNodeIcon(v: View, iconSel: string, text: string): Promise<void> {
    const ok = await v.evaluate(({ iconSel, text }) => {
        for (const icon of Array.from(document.querySelectorAll(iconSel))) {
            let el: Element | null = icon;
            for (let i = 0; i < 6 && el; i++) {
                el = el.parentElement;
                if (el && (el.textContent || '').includes(text) && (el.textContent || '').length < text.length + 40) {
                    (icon as HTMLElement).click();
                    return true;
                }
            }
        }
        return false;
    }, { iconSel, text });
    if (!ok) {
        throw new Error(`no ${iconSel} for "${text}"`);
    }
}

/** アウトライナーのノードのページをサイドパネルに開く */
export async function openNodePage(v: View, text: string): Promise<void> {
    await clickNodeIcon(v, '.outliner-page-icon', text);
    await v.locator('.side-panel').first().waitFor({ state: 'visible' });
    await sleep(2000);
}

/** マークダウンの中のサブページのリンクを押す（サイドパネルに開く） */
export async function openSubpage(v: View, title: string): Promise<void> {
    await v.locator('.markdown-container a[data-subpage="true"], a.link-subpage', { hasText: title }).first().click();
    await sleep(2000);
}

/** サイドパネルの目次を閉じる */
export async function closeSideToc(v: View): Promise<void> {
    const b = v.locator('#sidePanelSidebarClose').first();
    if (await b.isVisible().catch(() => false)) {
        await b.click();
        await sleep(500);
    }
}

/** サイドパネルのページを本体の側で開く */
export async function openSideInTab(v: View): Promise<void> {
    await v.locator('.side-panel-open-tab').first().click();
    await sleep(1800);
}

/** モードのボタン（[Outliner Mode ⇄]）を押して mode（'database' | 'mindmap' | 'outliner'）にする */
export async function switchMode(v: View, mode: string): Promise<void> {
    const toggle = v.locator('.outliner-view-toggle-btn').first();
    for (let i = 0; i < 3; i++) {
        if ((await toggle.getAttribute('data-mode')) === mode) {
            await sleep(1500);
            return;
        }
        await toggle.click();
        await sleep(800);
    }
    throw new Error(`could not switch to ${mode}`);
}

/** scope の中の見出し（text で始まる）が上に来るまで、それを囲むスクロールの枠を動かす */
export async function scrollToHeading(v: View, scope: string, text: string, offset = 24): Promise<void> {
    await v.evaluate(({ scope, text, offset }) => {
        const root = document.querySelector(scope) || document;
        const h = Array.from(root.querySelectorAll('h1, h2, h3')).find((e) => (e.textContent || '').trim().startsWith(text));
        if (!h) {
            throw new Error(`no heading "${text}" in ${scope}`);
        }
        let sc = h.parentElement;
        while (sc && !(sc.scrollHeight > sc.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) {
            sc = sc.parentElement;
        }
        if (sc) {
            sc.scrollTop += h.getBoundingClientRect().top - sc.getBoundingClientRect().top - offset;
        }
    }, { scope, text, offset });
    await sleep(700);
}

/** マインドマップの全体を、サイドパネルに隠れない所に収める（Fit はサイドパネルを考えないので、縮めてから空いた所を掴んで動かす） */
export async function fitMindmapBesideSidePanel(page: Page): Promise<void> {
    const measure = () => page.evaluate(() => {
        const vp = document.querySelector('.mindmap-viewport') as HTMLElement;
        const tree = vp.parentElement as HTMLElement; // マインドマップを動かすときに掴む要素
        const nodes = Array.from(tree.querySelectorAll('.mindmap-node')).map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0);
        const side = document.querySelector('.side-panel.open, #sidePanel.open') as HTMLElement | null;
        const bar = tree.querySelector('.mindmap-toolbar') as HTMLElement | null;
        const hr = tree.getBoundingClientRect();
        const right = side ? Math.min(hr.right, side.getBoundingClientRect().left) : hr.right;
        const top = bar ? bar.getBoundingClientRect().bottom : hr.top;
        const c = { l: Math.min(...nodes.map((r) => r.left)), r: Math.max(...nodes.map((r) => r.right)), t: Math.min(...nodes.map((r) => r.top)), b: Math.max(...nodes.map((r) => r.bottom)) };
        const t = { l: hr.left + 24, r: right - 24, t: top + 16, b: hr.bottom - 24 };
        let blank = null as null | { x: number; y: number };
        for (let y = t.t + 4; y < t.b && !blank; y += 23) {
            for (let x = t.l; x < t.r && !blank; x += 37) {
                const el = document.elementFromPoint(x, y);
                if (el && tree.contains(el) && !el.closest('.mindmap-node, .mindmap-toolbar, .mindmap-minimap')) {
                    blank = { x, y };
                }
            }
        }
        return { c, t, blank };
    });
    let m = await measure();
    for (let i = 0; i < 8 && (m.c.r - m.c.l > (m.t.r - m.t.l) * 0.96 || m.c.b - m.c.t > (m.t.b - m.t.t) * 0.96); i++) {
        await page.locator('[data-mm-action="zoom-out"]').first().click({ timeout: 5000 });
        await sleep(500);
        m = await measure();
    }
    if (!m.blank) {
        throw new Error('no blank point to pan the mindmap from');
    }
    const dx = (m.t.l + m.t.r) / 2 - (m.c.l + m.c.r) / 2;
    const dy = (m.t.t + m.t.b) / 2 - (m.c.t + m.c.b) / 2;
    await page.mouse.move(m.blank.x, m.blank.y);
    await page.mouse.down();
    for (let k = 1; k <= 10; k++) {
        await page.mouse.move(m.blank.x + (dx * k) / 10, m.blank.y + (dy * k) / 10);
    }
    await page.mouse.up();
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await sleep(600);
}
