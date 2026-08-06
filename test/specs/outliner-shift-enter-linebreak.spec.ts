/**
 * outliner-shift-enter-linebreak — Shift+Enter = node text 内改行 / Shift+Cmd+Enter = subtext トグル
 * (sprint 20260806-133523, FR-SE-01/02)
 *
 * 方式: CSS pre-wrap + 生 \n（mindmap と同方式）。model.text に \n を挿入 → renderEditingText
 * 再描画 → カーソル復元。共有 render/cursor 関数と getPlainText は無変更。
 *
 * TC-SE-01 (load-bearing): Shift+Enter でカーソル位置に \n。counterfactual = 旧実装（openSubtext）
 *   では text 不変 + subtext が開く。
 * TC-SE-04b (load-bearing): tag 入り text の改行で spurious \n が混入しない（design-review HIGH の番人）。
 * TC-SE-07 (load-bearing): Shift+Cmd+Enter で subtext が開く。counterfactual = 前置分岐なしだと
 *   Cmd+Enter 分岐に吸収され page 化が走る。
 */
import { test, expect, Page } from '@playwright/test';

async function boot(page: Page, nodes?: any) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    if (nodes) {
        await page.evaluate((data) => {
            (window as any).__testApi.initOutliner(data);
        }, nodes);
        await page.waitForTimeout(100);
    }
}

function singleNodeData(text: string, extra: any = {}) {
    return {
        version: 1,
        rootIds: ['n1'],
        nodes: { n1: { id: 'n1', parentId: null, children: [], text, ...extra } },
    };
}

/** node text を編集モードにしてカーソルを offset に置く */
async function focusNodeTextAt(page: Page, nodeId: string, offset: number) {
    await page.evaluate(({ id, off }) => {
        const textEl = document.querySelector(`.outliner-node[data-id="${id}"] .outliner-text`) as HTMLElement;
        textEl.focus();
        const OC = (window as any).OutlinerCell;
        OC.setCursorAtOffset(textEl, off);
    }, { id: nodeId, off: offset });
    await page.waitForTimeout(50);
}

async function pressShiftEnter(page: Page, nodeId: string, meta = false) {
    await page.evaluate(({ id, withMeta }) => {
        const textEl = document.querySelector(`.outliner-node[data-id="${id}"] .outliner-text`) as HTMLElement;
        const ev = new KeyboardEvent('keydown', {
            key: 'Enter', keyCode: 13, shiftKey: true, metaKey: withMeta,
            bubbles: true, cancelable: true,
        });
        textEl.dispatchEvent(ev);
    }, { id: nodeId, withMeta: meta });
    await page.waitForTimeout(100);
}

test.describe('FR-SE-02: Shift+Enter = node text 内改行', () => {

    test('TC-SE-01: カーソル位置に \\n が入る（model + 表示）', async ({ page }) => {
        await boot(page, singleNodeData('hello world'));
        await focusNodeTextAt(page, 'n1', 5); // "hello|" の直後
        await pressShiftEnter(page, 'n1');

        const r = await page.evaluate(() => {
            const model = (window as any).__testApi.getModel();
            const textEl = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            const subtextOpen = !!document.querySelector('.outliner-node[data-id="n1"] .outliner-subtext.editing');
            return {
                text: model.getNode('n1').text,
                domText: textEl.textContent,
                cursorOffset: (window as any).OutlinerCell.getCursorOffset(textEl),
                subtextOpen,
            };
        });
        expect(r.text).toBe('hello\n world');
        expect(r.domText).toBe('hello\n world');
        expect(r.cursorOffset).toBe(6); // \n の直後
        expect(r.subtextOpen).toBe(false); // 旧挙動（subtext が開く）でない
    });

    test('TC-SE-02: 改行入り text の serialize 往復がロスレス', async ({ page }) => {
        await boot(page, singleNodeData('line1\nline2'));
        const r = await page.evaluate(() => {
            const model = (window as any).__testApi.getModel();
            const json = JSON.stringify(model.serialize());
            const parsed = JSON.parse(json);
            return parsed.nodes.n1.text;
        });
        expect(r).toBe('line1\nline2');
    });

    test('TC-SE-03: 非編集表示が pre-wrap（改行が視覚反映される）', async ({ page }) => {
        await boot(page, singleNodeData('line1\nline2'));
        const r = await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            return {
                whiteSpace: getComputedStyle(textEl).whiteSpace,
                textContent: textEl.textContent,
            };
        });
        expect(r.whiteSpace).toBe('pre-wrap');
        expect(r.textContent).toContain('\n');
    });

    test('TC-SE-04: 改行を跨いだ編集 — 2 行目への文字挿入が 1 行目を壊さない', async ({ page }) => {
        await boot(page, singleNodeData('first\nsecond'));
        await focusNodeTextAt(page, 'n1', 8); // "first\nse|cond"
        const r = await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            // カーソル位置に "X" を打ったのと同じ流れ（textNode 直接編集 + input 発火）
            const sel = window.getSelection()!;
            const range = sel.getRangeAt(0);
            const tn = range.startContainer as Text;
            tn.insertData(range.startOffset, 'X');
            textEl.dispatchEvent(new Event('input', { bubbles: true }));
            const model = (window as any).__testApi.getModel();
            return model.getNode('n1').text;
        });
        expect(r).toBe('first\nseXcond');
    });

    test('TC-SE-04b: tag 入り text の改行で spurious \\n が混入しない（番人）', async ({ page }) => {
        await boot(page, singleNodeData('hello #tag world'));
        await focusNodeTextAt(page, 'n1', 16); // 末尾
        await pressShiftEnter(page, 'n1');
        const r = await page.evaluate(() => {
            const model = (window as any).__testApi.getModel();
            return model.getNode('n1').text;
        });
        // 末尾に \n が 1 個だけ。#tag の前後に \n が湧かない
        expect(r).toBe('hello #tag world\n');
    });

    test('TC-SE-04c: 末尾スペースの NBSP 正規化が従来どおり（getPlainText 継続の証明）', async ({ page }) => {
        await boot(page, singleNodeData('word'));
        await focusNodeTextAt(page, 'n1', 4);
        const r = await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            const sel = window.getSelection()!;
            const range = sel.getRangeAt(0);
            const tn = range.startContainer as Text;
            tn.insertData(range.startOffset, ' ');
            textEl.dispatchEvent(new Event('input', { bubbles: true }));
            const model = (window as any).__testApi.getModel();
            // renderEditingText は末尾スペースを NBSP 表示するが、model には通常スペースで入る
            return { text: model.getNode('n1').text, nbspInModel: / /.test(model.getNode('n1').text) };
        });
        expect(r.text).toBe('word ');
        expect(r.nbspInModel).toBe(false);
    });

    test('TC-SE-05: table view の outline 列でも Shift+Enter 改行（handleNodeKeydown 共用）', async ({ page }) => {
        await boot(page, singleNodeData('cell text'));
        await page.evaluate(() => {
            const api = (window as any).__testApi;
            if (api.setViewMode) { api.setViewMode('table'); }
            else if ((window as any).Outliner.setViewMode) { (window as any).Outliner.setViewMode('table'); }
        });
        await page.waitForTimeout(150);
        const hasTableNode = await page.evaluate(() =>
            !!document.querySelector('.outliner-node[data-id="n1"] .outliner-text'));
        if (!hasTableNode) { test.skip(true, 'table view harness API not available'); return; }
        await focusNodeTextAt(page, 'n1', 4);
        await pressShiftEnter(page, 'n1');
        const r = await page.evaluate(() => (window as any).__testApi.getModel().getNode('n1').text);
        expect(r).toBe('cell\n text');
    });

    test('TC-SE-06: mindmap の Shift+Enter 改行は不変（回帰 pin）', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            // mindmap の改行実装が依存する共有関数の契約を pin:
            // renderInlineText は \n を <br> に変換しない（生 \n のまま = pre-wrap 表示前提）
            const OC = (window as any).OutlinerCell;
            const html = OC.renderInlineText('line1\nline2');
            const div = document.createElement('div'); div.innerHTML = html;
            return { hasBr: !!div.querySelector('br'), textContent: div.textContent };
        });
        expect(r.hasBr).toBe(false);
        expect(r.textContent).toBe('line1\nline2');
    });
});

test.describe('FR-SE-01: Shift+Cmd+Enter = subtext トグル', () => {

    test('TC-SE-07: Shift+Cmd+Enter で subtext が開く（page 化されない）', async ({ page }) => {
        await boot(page, singleNodeData('node with subtext'));
        await focusNodeTextAt(page, 'n1', 5);
        await pressShiftEnter(page, 'n1', true); // meta+shift

        const r = await page.evaluate(() => {
            const model = (window as any).__testApi.getModel();
            const node = model.getNode('n1');
            const subtextEl = document.querySelector('.outliner-node[data-id="n1"] .outliner-subtext') as HTMLElement;
            const editing = !!(subtextEl && (subtextEl.classList.contains('editing')
                || subtextEl.getAttribute('contenteditable') === 'true'
                || document.activeElement === subtextEl
                || (subtextEl.contains && subtextEl.contains(document.activeElement))));
            return {
                subtextVisible: !!subtextEl && subtextEl.style.display !== 'none',
                editing,
                isPage: !!node.isPage,       // Cmd+Enter 分岐に吸収されると page 化が走る
                text: node.text,             // 改行分岐に落ちると \n が入る
            };
        });
        expect(r.isPage).toBe(false);
        expect(r.text).toBe('node with subtext');
        expect(r.subtextVisible || r.editing).toBe(true);
    });

    test('TC-SE-08: subtext 内で Shift+Cmd+Enter → 閉じて確定', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const subtextEl = document.createElement('div');
            subtextEl.contentEditable = 'true';
            subtextEl.textContent = 'val';
            document.body.appendChild(subtextEl);
            try {
                let saved: string | null = null;
                let prevented = 0;
                const event = {
                    isComposing: false, keyCode: 13, key: 'Enter',
                    shiftKey: true, metaKey: true, ctrlKey: false,
                    preventDefault: () => { prevented++; },
                };
                const model = {
                    getNode: () => ({ id: 'n' }),
                    updateSubtext: (_id: string, v: string) => { saved = v; },
                };
                OC.handleSubtextKeydown({
                    event, nodeId: 'n', subtextEl, model,
                    host: { scheduleSyncToHost: () => {}, focusNode: () => {} },
                });
                return { saved, prevented };
            } finally { subtextEl.remove(); }
        });
        expect(r.saved).toBe('val');
        expect(r.prevented).toBe(1);
    });

    test('TC-SE-09: subtext 内の Shift+Enter は閉じない（改行 = デフォルト委譲）', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const subtextEl = document.createElement('div');
            subtextEl.contentEditable = 'true';
            subtextEl.textContent = 'val';
            document.body.appendChild(subtextEl);
            try {
                let saved: string | null = null;
                let prevented = 0;
                const event = {
                    isComposing: false, keyCode: 13, key: 'Enter',
                    shiftKey: true, metaKey: false, ctrlKey: false,
                    preventDefault: () => { prevented++; },
                };
                const model = {
                    getNode: () => ({ id: 'n' }),
                    updateSubtext: (_id: string, v: string) => { saved = v; },
                };
                OC.handleSubtextKeydown({
                    event, nodeId: 'n', subtextEl, model,
                    host: { scheduleSyncToHost: () => {}, focusNode: () => {} },
                });
                return { saved, prevented };
            } finally { subtextEl.remove(); }
        });
        expect(r.saved).toBe(null);    // 閉じ処理（保存）が走らない
        expect(r.prevented).toBe(0);   // preventDefault しない = ブラウザ改行に委譲
    });

    test('TC-SE-10: Enter=兄弟追加 / Cmd+Enter=page 化 は不変（回帰 pin）', async ({ page }) => {
        await boot(page, singleNodeData('base'));
        await focusNodeTextAt(page, 'n1', 4);
        // Enter → 兄弟追加
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            textEl.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', keyCode: 13, bubbles: true, cancelable: true,
            }));
        });
        await page.waitForTimeout(100);
        const r = await page.evaluate(() => {
            const model = (window as any).__testApi.getModel();
            return { rootCount: model.rootIds.length, n1Text: model.getNode('n1').text };
        });
        expect(r.rootCount).toBe(2);        // 兄弟が増えた
        expect(r.n1Text).not.toContain('\n'); // 改行分岐に落ちていない
    });

    test('TC-SE-11: HUD shortcut-list の表記が更新されている', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            const SL = (window as any).ShortcutList || (window as any).__shortcutList;
            // shortcut-list.js は SHORTCUTS_OUTLINER を export。ビルドにより window 直付けか
            // module か異なるため、ソース contract でなく HUD の実 render で確認できない場合は
            // outliner カテゴリの項目文字列を検査する
            let items: any[] = [];
            if (SL && SL.SHORTCUTS_OUTLINER) {
                items = SL.SHORTCUTS_OUTLINER.flatMap((c: any) => c.items);
            } else if ((window as any).SHORTCUTS_OUTLINER) {
                items = (window as any).SHORTCUTS_OUTLINER.flatMap((c: any) => c.items);
            }
            return items.map((i: any) => `${i.keys}|${i.desc}`);
        });
        if (r.length === 0) { test.skip(true, 'shortcut list not exposed in harness'); return; }
        expect(r).toContain('Shift+Enter|Line break within node text');
        expect(r).toContain('Cmd+Shift+Enter|Open / close subtext (note)');
    });
});
