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

test.describe('FR-SE-03/04: 下流保護 + H1 先頭行同期 (TASK-02)', () => {

    test('TC-SE-12: 複数選択 Cmd+C の plain text は改行を空白に潰す（1 node = 1 行）', async ({ page }) => {
        await boot(page, {
            version: 1,
            rootIds: ['n1', 'n2'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'multi\nline\ntext', tags: [] },
                n2: { id: 'n2', parentId: null, children: [], text: 'plain', tags: [] },
            },
        });
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        // Cmd+A で全 node 選択 → Cmd+C（実キー経路）
        await page.locator('.outliner-node[data-id="n2"] .outliner-text').click();
        await page.keyboard.press('Meta+a');
        await page.waitForTimeout(50);
        await page.keyboard.press('Meta+c');
        await page.waitForTimeout(200);

        const r = await page.evaluate(() => {
            const msgs = (window as any).__testApi.messages.filter((m: any) => m.type === 'saveOutlinerClipboard');
            return msgs.length ? msgs[msgs.length - 1] : null;
        });
        expect(r).toBeTruthy();
        const lines = (r.plainText as string).split('\n');
        expect(lines.length).toBe(2);              // ★ 1 node = 1 行（改行入りでも分裂しない）
        expect(lines[0]).toBe('multi line text');  // ★ \n → 空白
        expect(lines[1]).toBe('plain');
        // 内部 nodes（clipboardNodes）は改行保持
        const texts = r.nodes.map((n: any) => n.text);
        expect(texts).toContain('multi\nline\ntext');
    });

    test('TC-SE-13: 内部 copy 用 getSelectedNodesData は改行保持', async ({ page }) => {
        await boot(page, singleNodeData('multi\nline'));
        const r = await page.evaluate(() => {
            const model = (window as any).__testApi.getModel();
            // clipboardNodes の源泉 = model の text がそのまま入ることを確認
            return model.getNode('n1').text;
        });
        expect(r).toBe('multi\nline');
    });

    test('TC-SE-16: page node の H1 同期は先頭行のみ送出', async ({ page }) => {
        await boot(page, {
            version: 1,
            rootIds: ['n1'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'Title', tags: [], isPage: true, pageId: 'pg-se16' },
            },
        });
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        // 実キー編集: 末尾で Shift+Enter → 2 行目を入力 → blur
        const textEl = page.locator('.outliner-node[data-id="n1"] .outliner-text');
        await textEl.click();
        await page.keyboard.press('End');
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('detail');
        await page.locator('body').click({ position: { x: 5, y: 5 } });
        await page.waitForTimeout(150);

        const r = await page.evaluate(() => {
            const msgs = (window as any).__testApi.messages.filter((m: any) => m.type === 'syncNodeTextToPageH1');
            const model = (window as any).__testApi.getModel();
            return { msgs, text: model.getNode('n1').text };
        });
        expect(r.text).toBe('Title\ndetail');           // model には改行入りで保持
        expect(r.msgs.length).toBeGreaterThanOrEqual(1);
        const last = r.msgs[r.msgs.length - 1];
        expect(last.text).toBe('Title');                 // ★ H1 へは先頭行のみ（\n を含まない）
        expect(last.text).not.toContain('\n');
    });

    test('TC-SE-17: H1→node 反映は先頭行だけ置換（継続行保持）', async ({ page }) => {
        const DOC = 'http://localhost:3000/note1/';
        await boot(page, {
            version: 1,
            rootIds: ['n1'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'Old\ndetail', tags: [], isPage: true, pageId: 'pg-se17' },
            },
        });
        // sidepanel を本番経路（openSidePanel メッセージ）で開き、H1 を編集（syncContent 経路）
        await page.evaluate(({ md, fp, doc }) => {
            (window as any).__hostMessageHandler({
                type: 'openSidePanel', markdown: md, filePath: fp, fileName: fp.split('/').pop(), toc: [], documentBaseUri: doc,
            });
        }, { md: '# Old\n\nbody', fp: `${DOC}pg-se17.md`, doc: DOC });
        await page.waitForTimeout(200);
        await page.evaluate((m) => (window as any).__testApi.editSidePanelMarkdown(m), '# New\n\nbody');
        await page.waitForTimeout(200);
        const text = await page.evaluate(() => (window as any).__testApi.getModel().getNode('n1').text);
        expect(text).toBe('New\ndetail');   // ★ 先頭行だけ New、継続行 detail は保持
    });

    test('TC-SE-18: 改行なし page node の H1 同期は従来どおり（回帰 pin）', async ({ page }) => {
        await boot(page, {
            version: 1,
            rootIds: ['n1'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'Old', tags: [], isPage: true, pageId: 'pg-se18' },
            },
        });
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        const textEl = page.locator('.outliner-node[data-id="n1"] .outliner-text');
        await textEl.click();
        await page.keyboard.press('End');
        await page.keyboard.type('X');
        await page.locator('body').click({ position: { x: 5, y: 5 } });
        await page.waitForTimeout(150);
        const msgs = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'syncNodeTextToPageH1'));
        expect(msgs.length).toBeGreaterThanOrEqual(1);
        expect(msgs[msgs.length - 1].text).toBe('OldX');
    });

    test('TC-SE-19: mindmap 発の改行入り page node text も H1 送出は先頭行のみ', async ({ page }) => {
        // mindmap で改行が入った状態を model 直接投入で再現（mindmap 編集の結果と等価）
        await boot(page, {
            version: 1,
            rootIds: ['n1'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'MTitle\nmm-detail', tags: [], isPage: true, pageId: 'pg-se19' },
            },
        });
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        // outliner 側で同 node を実キー編集して確定（mindmap で改行済み text に触るシナリオ）
        const textEl = page.locator('.outliner-node[data-id="n1"] .outliner-text');
        await textEl.click();
        await page.keyboard.press('End');
        await page.keyboard.type('!');
        await page.locator('body').click({ position: { x: 5, y: 5 } });
        await page.waitForTimeout(150);
        const msgs = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'syncNodeTextToPageH1'));
        expect(msgs.length).toBeGreaterThanOrEqual(1);
        const last = msgs[msgs.length - 1];
        expect(last.text).toBe('MTitle');   // ★ 改行入り text でも先頭行のみ（H1 破壊しない）
        expect(last.text).not.toContain('\n');
    });
});

// ============================================================
// TASK-06 (review iteration 1): 宣言済み未実装 TC の regression pin
// sink は全て潰し済みで挙動は正 = 純粋な番人（将来の潰し除去を RED にする）
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as pathMod from 'path';

test.describe('FR-SE-03: 下流 sink の \\n 潰し regression pin (TASK-06)', () => {

    test('TC-SE-14: llms.txt 生成で改行入り node.text が 1 行化（cleanText の \\s+ 潰し）', async () => {
        const { buildLlmsTxt } = require('../../src/shared/llms-txt-builder');
        const tree = {
            id: 'r', text: 'Root\nsecond line', pageId: 'p1', filePath: null, children: [],
        };
        const out = buildLlmsTxt(tree, 'md', {
            resolveMdPath: (pid: string) => (pid === 'p1' ? '/abs/p1.md' : null),
            resolveFilePath: () => null,
        });
        // heading にもリンクラベルにも \n が残らない（1 行化）
        expect(out).toBe('# Root second line\n\n- [Root second line](/abs/p1.md)\n');
        expect(out.split('\n').filter(l => l.startsWith('#')).length).toBe(1);
    });

    test('TC-SE-15: paste-asset の node md 化で改行が空白化（既存 replace の番人）', async () => {
        const pah = require('../../src/shared/paste-asset-handler');
        const src = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'fr-se15-src-'));
        const dest = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'fr-se15-dest-'));
        fs.writeFileSync(pathMod.join(dest, 'target.md'), '# T\n');
        try {
            const r = pah.buildOutlinerNodesPasteMd({
                nodes: [{ text: 'multi\nline\nnode', level: 0 }],
                srcOutDir: src, srcPagesDir: src, srcFileDir: pathMod.join(src, 'files'),
                destMdPath: pathMod.join(dest, 'target.md'),
                destFilesDir: pathMod.join(dest, 'files'),
                destImagesDir: pathMod.join(dest, 'images'),
            });
            expect(r.markdown).toContain('- multi line node');  // \n → 空白で 1 bullet 行
            expect(r.markdown.trim().split('\n').length).toBe(1);
        } finally {
            fs.rmSync(src, { recursive: true, force: true });
            fs.rmSync(dest, { recursive: true, force: true });
        }
    });

    test('TC-SE-20: sanitizeSubpageLabel は改行をラベルに残さない（[\\r\\n]+ 潰しの番人）', async () => {
        const pah = require('../../src/shared/paste-asset-handler');
        const label = pah.sanitizeSubpageLabel('Title\r\nwith\nbreaks');
        expect(label).toBe('Title with breaks');
        expect(label).not.toMatch(/[\r\n]/);
    });
});

test.describe('FR-SE-03/04: review iteration 1 の code_fix 番人 (TASK-03/04/05)', () => {

    test('TC-SE-21: 単一 node Cmd+C の plain text は \\n を空白潰し（nodesData は raw 保持）', async ({ page }) => {
        await boot(page, singleNodeData('single\nnode\ntext', { tags: [] }));
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        // 単一 node にフォーカス（選択なし・collapsed）で Cmd+C
        await page.locator('.outliner-node[data-id="n1"] .outliner-text').click();
        await page.evaluate(() => {
            // クリック位置により selection が非 collapsed になるのを避ける
            const sel = window.getSelection()!;
            sel.collapseToStart();
        });
        await page.keyboard.press('Meta+c');
        await page.waitForTimeout(200);
        const r = await page.evaluate(() => {
            const msgs = (window as any).__testApi.messages.filter((m: any) => m.type === 'saveOutlinerClipboard');
            return msgs.length ? msgs[msgs.length - 1] : null;
        });
        expect(r).toBeTruthy();
        expect(r.plainText).toBe('single node text');       // ★ plain は潰し
        expect(r.plainText).not.toContain('\n');
        expect(r.nodes[0].text).toBe('single\nnode\ntext'); // ★ nodesData は raw（内部 paste 忠実度）
    });

    test('TC-SE-22: page node の行途中 Shift+Enter 直後（入力なし blur なし）に H1 同期が発火', async ({ page }) => {
        await boot(page, {
            version: 1,
            rootIds: ['n1'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'HeadTail', tags: [], isPage: true, pageId: 'pg-se22' },
            },
        });
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        await focusNodeTextAt(page, 'n1', 4); // "Head|Tail"
        await pressShiftEnter(page, 'n1');    // 先頭行が "Head" に変わる

        const r = await page.evaluate(() => {
            const msgs = (window as any).__testApi.messages.filter((m: any) => m.type === 'syncNodeTextToPageH1');
            const model = (window as any).__testApi.getModel();
            return { msgs, text: model.getNode('n1').text };
        });
        expect(r.text).toBe('Head\nTail');
        // ★ blur を待たず改行挿入時点で先頭行 "Head" が送出される（stale 解消）
        expect(r.msgs.length).toBeGreaterThanOrEqual(1);
        expect(r.msgs[r.msgs.length - 1].text).toBe('Head');
    });

    test('TC-SE-23: 複数行 node の page 化で H1 は先頭行のみ（継続行が md に漏れない）', async ({ page }) => {
        await boot(page, singleNodeData('PageTitle\ncontinuation', { tags: [] }));
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        // Cmd+Enter で page 化（makePage 経路）
        await focusNodeTextAt(page, 'n1', 3);
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            textEl.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', keyCode: 13, metaKey: true, bubbles: true, cancelable: true,
            }));
        });
        await page.waitForTimeout(200);
        const r = await page.evaluate(() => {
            const msgs = (window as any).__testApi.messages.filter((m: any) => m.type === 'makePage');
            const model = (window as any).__testApi.getModel();
            return { msgs, text: model.getNode('n1').text, isPage: model.getNode('n1').isPage };
        });
        expect(r.isPage).toBe(true);
        expect(r.msgs.length).toBe(1);
        expect(r.msgs[0].title).toBe('PageTitle');           // ★ 先頭行のみ
        expect(r.msgs[0].title).not.toContain('\n');
        expect(r.text).toBe('PageTitle\ncontinuation');      // node.text 自体は不変
    });
});
