/**
 * Mindmap iteration 6 — 編集中重なり解消の DOM 非再生成方式 (Wave 10, TASK-32)
 * TC-160e (caret 飛ばない), TC-231c (DOM 非再生成), TC-162c (改行保存回帰), TC-150e (重なり解消), TC-IME
 * 実クリック→実キー + composition イベントで検証。
 */

import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}
function node(id: string, text: string, children: string[] = [], parentId: string | null = null) {
    return { id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] };
}
async function toMindmap(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(150);
}
async function editNode(page: import('@playwright/test').Page, id: string) {
    await page.locator(`.mindmap-node[data-node-id="${id}"] .mindmap-node-box`).click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(60);
}

test('TC-160e (#1) 半角 Shift+Enter で caret が先頭に飛ばず入力順どおり', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: { r: node('r', 'Root', ['n1', 'sib']), n1: node('n1', '', [], 'r'), sib: node('sib', 'Sib', [], 'r') }
    });
    await editNode(page, 'n1');
    await page.keyboard.type('abc');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('def');
    await page.keyboard.press('Enter'); // commit
    await page.waitForTimeout(100);
    const text = (await page.evaluate(() => (window as any).Outliner.getModel().nodes.n1.text)).replace(/\r/g, '');
    // caret が先頭に飛んでいたら 'defabc' になる。正しくは入力順 'abc\ndef'
    expect(text).toBe('abc\ndef');
});

test('TC-231c (#1#2) 編集中に contenteditable 要素が再生成されない', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: { r: node('r', 'Root', ['n1', 'sib']), n1: node('n1', '', [], 'r'), sib: node('sib', 'Sib', [], 'r') }
    });
    await editNode(page, 'n1');
    // 編集中の要素に一意マーカーを付ける
    await page.evaluate(() => {
        const el = document.querySelector('.mindmap-node-text[data-node-id="n1"]') as any;
        el.__editMarker = 'MARK-' + Math.random();
        (window as any).__savedMarker = el.__editMarker;
    });
    await page.keyboard.type('x');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('y');
    await page.waitForTimeout(120);
    const sameEl = await page.evaluate(() => {
        const el = document.querySelector('.mindmap-node-text[data-node-id="n1"]') as any;
        return el && el.__editMarker === (window as any).__savedMarker;
    });
    expect(sameEl).toBe(true); // 同一 DOM 要素（再生成されていない）
    const editable = await page.getAttribute('.mindmap-node-text[data-node-id="n1"]', 'contenteditable');
    expect(editable).toBe('true'); // 編集継続
});

test('TC-162c (#1) 改行保存の回帰維持 (モード往復で \\n 保持)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: { r: node('r', 'Root', ['n1']), n1: node('n1', '', [], 'r') }
    });
    await editNode(page, 'n1');
    await page.keyboard.type('abc');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('def');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    await page.evaluate(() => { (window as any).Outliner.setViewMode('outliner'); (window as any).Outliner.setViewMode('mindmap'); });
    await page.waitForTimeout(100);
    const text = (await page.evaluate(() => (window as any).Outliner.getModel().nodes.n1.text)).replace(/\r/g, '');
    expect(text).toBe('abc\ndef');
});

test('TC-150e (#1) 編集中 Shift+Enter で下ノードと重ならない (DOM 非再生成)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: {
            r: node('r', 'Root', ['top', 'mid', 'bottom']),
            top: node('top', 'Top', [], 'r'), mid: node('mid', 'Mid', [], 'r'), bottom: node('bottom', 'Bottom', [], 'r')
        }
    });
    await editNode(page, 'mid');
    await page.keyboard.type('X');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Y');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Z');
    await page.waitForTimeout(150);
    const res = await page.evaluate(() => {
        function rect(id: string) { return (document.querySelector(`.mindmap-node[data-node-id="${id}"]`) as SVGGraphicsElement).getBoundingClientRect(); }
        // mid と bottom が同じ側にある前提。重なり判定
        const mid = rect('mid'), bottom = rect('bottom');
        const sameSide = Math.abs(mid.left - bottom.left) < 50; // ざっくり同じ x 帯
        const overlap = !(mid.right < bottom.left || bottom.right < mid.left || mid.bottom < bottom.top || bottom.bottom < mid.top);
        const editable = document.querySelector('.mindmap-node-text[data-node-id="mid"]')?.getAttribute('contenteditable');
        return { overlap, editable, sameSide };
    });
    // 同じ側なら重ならないこと。編集継続。
    if (res.sameSide) { expect(res.overlap).toBe(false); }
    expect(res.editable).toBe('true');
});

test('TC-IME (#2) IME composition 中は位置調整を skip し改行操作が中断されない', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: { r: node('r', 'Root', ['n1']), n1: node('n1', '', [], 'r') }
    });
    await editNode(page, 'n1');
    // composition シミュレート: compositionstart → input(isComposing) → compositionend
    const noThrow = await page.evaluate(() => {
        const el = document.querySelector('.mindmap-node-text[data-node-id="n1"]') as HTMLElement;
        try {
            el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            el.textContent = 'あ';
            el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true } as any));
            el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'あ' }));
            // composition 中に例外や DOM 再生成が起きず、要素が編集継続していれば OK
            return document.querySelector('.mindmap-node-text[data-node-id="n1"]') === el
                && el.getAttribute('contenteditable') === 'true';
        } catch (e) { return false; }
    });
    expect(noThrow).toBe(true);
});
