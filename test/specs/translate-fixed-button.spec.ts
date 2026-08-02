/**
 * translate-fixed-button.spec.ts — FR-TR-01/02 の E2E
 *
 * Sprint: 20260803-013547-translate-button-and-scope / TASK-01
 *
 * FR-TR-01: showTranslateButtons ON のとき、note md / standalone md の **full/simple 両モード**で
 *   翻訳ボタンを exportPdf の左（toolbar-fixed--right 内）に出す。二重表示回避のため
 *   toolbar-inner の既存 translate group は常時非表示に統一。
 * FR-TR-02: sidepanel md からの翻訳応答（translateResult{sidePanelFilePath}）は
 *   sidepanel instance に届き、main md の翻訳ビューを開かない。
 *
 * ★ Notes アーキテクチャの実測（実装冒頭に確定・design §2-3 の要請）:
 *   Notes の md ペイン EditorInstance は includeSidePanel:false で生成されるため、その closure の
 *   sidePanelInstance は null（editor.js:16241 openSidePanel が早期 return）。Notes の sidepanel md は
 *   **outliner.js が所有**し、outliner.js の message handler（outliner.js:8889 case 'translateResult'）が
 *   showTranslationInSidePanel で sidepanel を翻訳ビュー化する（signal = [data-action="translateBack"]
 *   + filename "Translation (…)"、.fractal-translation-header ではない）。
 *   → FR-TR-02 の forward（sidepanel 要求で main を汚さない）は editor.js md ペインの
 *     「sidePanelFilePath ありなら return」だけで達成され、sidepanel は outliner.js の既存経路で開く。
 *   → editor.js の sidePanelHostBridge._sendMessage 再送は standalone-editor（main + 同一 closure sidepanel）
 *     モデル専用の到達手段（Notes では sidePanelInstance=null で発火せず no-op）。
 *
 * 戦略（standalone build 非対称性を踏まえる）:
 *   - TC-TR-01: generateEditorBodyHtml() 出力の source-string 検証（fixed ボタンが exportPdf より前）
 *     + toolbar-inner の translate group が CSS（実 styles.css）で非表示（computed display）。
 *     standalone-editor.html の #toolbar は空 stub なので本番生成器の出力文字列 + fixture CSS で検証
 *     （toolbar-translate-toggle.spec.ts / inline-color.spec.ts と同じ理由）。
 *   - TC-TR-02: fixture + 実 styles.css で computed display（OFF 非表示 / ON+simple 可視）。
 *     counterfactual = OFF 用の CSS rule を外すと OFF でも見える。
 *   - TC-TR-03: standalone-notes.html の live md ペイン（generateEditorBodyHtml 由来）で
 *     fixed 翻訳ボタン click → 既存 translate 経路（translateContent host message）が 1 回。
 *   - TC-TR-04: standalone-notes.html で main md + sidepanel 両方に内容を入れ、
 *     translateResult{sidePanelFilePath} を受信 → main の editor DOM が翻訳ビュー化しない
 *     （.fractal-translation-header が main に付かない）。counterfactual = 振り分けを外すと main が汚染。
 */
import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

const editorBodyHtmlPath = path.resolve(__dirname, '../../src/shared/editor-body-html.js');
const stylesCssPath = path.resolve(__dirname, '../../src/webview/styles.css');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateEditorBodyHtml } = require(editorBodyHtmlPath);

test.describe('FR-TR-01: fixed 翻訳ボタン（exportPdf の左・inner group 一本化）', () => {
    test('TC-TR-01: generateEditorBodyHtml で fixed translate ボタンが exportPdf より前 + inner translate group は CSS 非表示', async ({ page }) => {
        const html = generateEditorBodyHtml({}, 'darwin');

        // (1) toolbar-fixed--right 内に fixed 翻訳ボタン（.toolbar-translate-fixed）が存在。
        expect(html).toContain('toolbar-translate-fixed');

        // toolbar-fixed--right ブロックを抽出。
        const fixedMatch = html.match(/<div class="toolbar-fixed toolbar-fixed--right">([\s\S]*?)<\/div>\s*<\/div>\s*<div class="editor-wrapper"/);
        expect(fixedMatch).not.toBeNull();
        const fixedBlock = fixedMatch![1];

        // (2) fixed 翻訳ボタンは同ブロック内で exportPdf より前（文字列位置）。
        const fixedTranslateIdx = fixedBlock.indexOf('toolbar-translate-fixed');
        const exportPdfIdx = fixedBlock.indexOf('data-action="exportPdf"');
        expect(fixedTranslateIdx).toBeGreaterThan(-1);
        expect(exportPdfIdx).toBeGreaterThan(-1);
        expect(fixedTranslateIdx).toBeLessThan(exportPdfIdx);

        // (3) fixed ボタンは data-action="translate"（既存 dispatcher の case 'translate' に落ちる）。
        expect(fixedBlock).toContain('data-action="translate"');

        // (4) inner translate group は実 styles.css で常時非表示（一本化・二重表示回避）。
        //     ON（data-show-translate-buttons="true"）でも inner は隠れる。
        await page.setContent(`
            <!DOCTYPE html>
            <html data-show-translate-buttons="true" data-toolbar-mode="full">
            <head><title>fx</title></head>
            <body>
                <div class="toolbar">
                    <div class="toolbar-inner">
                        <div class="toolbar-group" data-group="translate">
                            <button data-action="translate">x</button>
                        </div>
                        <div class="toolbar-group" data-group="inline">
                            <button data-action="bold">b</button>
                        </div>
                    </div>
                    <div class="toolbar-fixed toolbar-fixed--right">
                        <div class="toolbar-group" data-group="utility">
                            <button data-action="translate" class="toolbar-translate-fixed">t</button>
                            <button data-action="exportPdf">p</button>
                        </div>
                    </div>
                </div>
            </body></html>`);
        await page.addStyleTag({ path: stylesCssPath });
        const disp = await page.evaluate(() => {
            const inner = document.querySelector('.toolbar-inner [data-group="translate"]') as HTMLElement;
            const fixed = document.querySelector('.toolbar-translate-fixed') as HTMLElement;
            const inline = document.querySelector('.toolbar-inner [data-group="inline"]') as HTMLElement;
            return {
                inner: inner ? getComputedStyle(inner).display : null,
                fixed: fixed ? getComputedStyle(fixed).display : null,
                inline: inline ? getComputedStyle(inline).display : null,
            };
        });
        // inner translate group は一本化で非表示（ON でも）
        expect(disp.inner).toBe('none');
        // fixed 翻訳ボタンは ON で可視
        expect(disp.fixed).not.toBe('none');
        // 他の inner group は影響を受けない（regression）
        expect(disp.inline).not.toBe('none');
    });

    // buildFixture: 最小 toolbar（fixed 翻訳ボタン + exportPdf）。
    const buildFixture = (showFlag: 'true' | 'false', toolbarMode: 'full' | 'simple') => `
        <!DOCTYPE html>
        <html data-show-translate-buttons="${showFlag}" data-toolbar-mode="${toolbarMode}">
        <head><title>fixture</title></head>
        <body>
            <div class="toolbar">
                <div class="toolbar-inner">
                    <div class="toolbar-group" data-group="translate">
                        <button data-action="translate">x</button>
                    </div>
                    <div class="toolbar-group" data-group="inline">
                        <button data-action="bold">b</button>
                    </div>
                </div>
                <div class="toolbar-fixed toolbar-fixed--right">
                    <div class="toolbar-group" data-group="utility">
                        <button data-action="translate" class="toolbar-translate-fixed">t</button>
                        <button data-action="exportPdf">p</button>
                    </div>
                </div>
            </div>
        </body></html>`;

    test('TC-TR-02: OFF で fixed ボタン非表示 / ON+simple で可視（counterfactual: OFF rule 依存）', async ({ page }) => {
        // (a) OFF → fixed ボタン非表示。
        await page.setContent(buildFixture('false', 'full'));
        await page.addStyleTag({ path: stylesCssPath });
        let fixedDisp = await page.evaluate(() => {
            const el = document.querySelector('.toolbar-translate-fixed') as HTMLElement;
            return el ? getComputedStyle(el).display : null;
        });
        expect(fixedDisp).toBe('none');

        // (b) ON + simple モード → fixed ボタンは可視（toolbar-fixed--right は simple でも表示される）。
        await page.setContent(buildFixture('true', 'simple'));
        await page.addStyleTag({ path: stylesCssPath });
        const simpleState = await page.evaluate(() => {
            const fixed = document.querySelector('.toolbar-translate-fixed') as HTMLElement;
            const fixedRight = document.querySelector('.toolbar-fixed--right') as HTMLElement;
            const inner = document.querySelector('.toolbar-inner') as HTMLElement;
            return {
                fixed: fixed ? getComputedStyle(fixed).display : null,
                fixedRight: fixedRight ? getComputedStyle(fixedRight).display : null,
                innerContainer: inner ? getComputedStyle(inner).display : null,
            };
        });
        // simple モードでも fixed 翻訳ボタンは見える（従来 simple で「出ない」問題の解消）
        expect(simpleState.fixed).not.toBe('none');
        expect(simpleState.fixedRight).not.toBe('none');
        // simple モードでは toolbar-inner 自体が非表示（既存挙動）→ inner の翻訳導線は元々出ない
        expect(simpleState.innerContainer).toBe('none');

        // (c) counterfactual 相当: OFF フラグ + fixed ボタンが「非表示になる」ことが
        //     OFF 用 CSS rule に依存していることを確認する。属性を true にすると可視に戻る。
        await page.setContent(buildFixture('false', 'full'));
        await page.addStyleTag({ path: stylesCssPath });
        await page.evaluate(() => document.documentElement.setAttribute('data-show-translate-buttons', 'true'));
        fixedDisp = await page.evaluate(() => {
            const el = document.querySelector('.toolbar-translate-fixed') as HTMLElement;
            return el ? getComputedStyle(el).display : null;
        });
        expect(fixedDisp).not.toBe('none');
    });
});

test.describe('FR-TR-01/02: 実 md ペインでの click・応答ルーティング（standalone-notes）', () => {
    const DOC = 'http://localhost:3000/note1/';

    test('TC-TR-03: fixed 翻訳ボタン click → 既存 translate 経路（translateContent）が呼ばれる', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);

        // main md ペインを開く（dispatcher の updateData kind:md）。
        await page.evaluate(({ md, doc }) => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md', markdown: md, filePath: '/notes/main.md', documentBaseUri: doc,
            });
        }, { md: '# Main\n\nhello world\n', doc: DOC });
        await page.waitForTimeout(300);

        // 既存 translate message を捨てて計測を明確化。
        await page.evaluate(() => {
            const api = (window as any).__testApi;
            api.messages = (api.messages || []).filter((m: any) => m.type !== 'translateContent');
        });

        // fixed 翻訳ボタンが md ペインの toolbar に存在することを確認 → click。
        const hasFixed = await page.evaluate(() => {
            const mc = document.querySelector('.markdown-container');
            return !!mc?.querySelector('.toolbar .toolbar-fixed--right .toolbar-translate-fixed[data-action="translate"]');
        });
        expect(hasFixed).toBe(true);

        await page.evaluate(() => {
            const mc = document.querySelector('.markdown-container');
            const btn = mc?.querySelector('.toolbar-translate-fixed[data-action="translate"]') as HTMLElement;
            btn.click();
        });
        await page.waitForTimeout(150);

        // 翻訳 popup が開く → Execute で translateContent が飛ぶ。
        await page.evaluate(() => {
            const exec = document.querySelector('.fractal-translate-popup .ftp-execute') as HTMLElement;
            if (exec) exec.click();
        });
        await page.waitForTimeout(150);

        const translateMsgs = await page.evaluate(() =>
            ((window as any).__testApi.messages || []).filter((m: any) => m.type === 'translateContent')
        );
        // fixed ボタン → 既存 translate 経路（translateContent）が 1 回発火。
        expect(translateMsgs.length).toBe(1);
    });

    test('TC-TR-04: translateResult{sidePanelFilePath} 受信で main md の翻訳ビュー化が起きない（counterfactual）', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);

        const SP_FP = '/notes/side.md';

        // main md ペインを開く。
        await page.evaluate(({ md, doc }) => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md', markdown: md, filePath: '/notes/main.md', documentBaseUri: doc,
            });
        }, { md: '# Main\n\nmain body text\n', doc: DOC });
        await page.waitForTimeout(300);

        // sidepanel を content 付きで開く。
        await page.evaluate(({ md, fp, doc }) => {
            (window as any).__hostMessageHandler({
                type: 'openSidePanel', markdown: md, filePath: fp, fileName: 'side.md', toc: [], documentBaseUri: doc,
            });
        }, { md: '# Side\n\nside body text\n', fp: SP_FP, doc: DOC });
        await page.waitForTimeout(400);

        // 事前状態: main / sidepanel いずれも翻訳ビューでない。
        const before = await page.evaluate(() => {
            const mc = document.querySelector('.markdown-container');
            const sp = document.querySelector('.side-panel');
            return {
                mainHeader: !!mc?.querySelector('.fractal-translation-header'),
                spHeader: !!sp?.querySelector('.fractal-translation-header'),
                hasSpEditor: !!sp?.querySelector('.editor[contenteditable]'),
            };
        });
        expect(before.mainHeader).toBe(false);
        expect(before.hasSpEditor).toBe(true);

        // (A) sidepanel 要求の応答: translateResult{sidePanelFilePath}
        //     → main は翻訳ビュー化してはならない（sidepanel 側に届く）。
        await page.evaluate(({ fp }) => {
            (window as any).__hostMessageHandler({
                type: 'translateResult',
                translatedMarkdown: '# T\n\ntranslated text\n',
                sourceLang: 'en', targetLang: 'ja',
                sidePanelFilePath: fp,
            });
        }, { fp: SP_FP });
        await page.waitForTimeout(300);

        const afterSp = await page.evaluate(() => {
            const mc = document.querySelector('.markdown-container');
            const mainEd: any = mc?.querySelector('.editor[contenteditable]');
            const sp = document.querySelector('.side-panel');
            const spEd: any = sp?.querySelector('.editor');
            return {
                mainHeader: !!mc?.querySelector('.fractal-translation-header'),
                mainEditable: mainEd?.contentEditable,
                mainText: mainEd?.textContent || '',
                // Notes の sidepanel 翻訳ビュー signal（outliner.js:8889 showTranslationInSidePanel）
                // = [data-action="translateBack"] + filename "Translation (…)" + 翻訳文の描画。
                spTranslateBack: !!sp?.querySelector('[data-action="translateBack"]'),
                spFilename: (sp?.querySelector('#sidePanelFilename') as HTMLElement | null)?.textContent || '',
                spText: spEd?.textContent || '',
            };
        });
        // ★ load-bearing（forward-case guard）: main の editor DOM は不変（翻訳ビュー化しない・翻訳文が
        //   main に出ない）。counterfactual = editor.js:16134 の `if (message.sidePanelFilePath){…return;}`
        //   を外すと main が openTranslationPanel で翻訳ビュー化し mainHeader=true / mainText に翻訳文 = RED。
        expect(afterSp.mainHeader).toBe(false);
        expect(afterSp.mainText).toContain('main body text');
        expect(afterSp.mainText).not.toContain('translated text');
        // sidepanel 側に翻訳ビューが開く（Notes では outliner.js が所有・その既存 translateResult 経路で開く。
        //   editor.js md ペインの sidePanelInstance は null なので _sendMessage 再送は Notes では no-op）。
        expect(afterSp.spTranslateBack).toBe(true);
        expect(afterSp.spFilename).toContain('Translation');
        expect(afterSp.spText).toContain('translated text');

        // (B) main 要求の応答: sidePanelFilePath 無し → 従来どおり main が翻訳ビュー化する。
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'translateResult',
                translatedMarkdown: '# M\n\nmain translated\n',
                sourceLang: 'en', targetLang: 'ja',
            });
        });
        await page.waitForTimeout(300);

        const afterMain = await page.evaluate(() => {
            const mc = document.querySelector('.markdown-container');
            return { mainHeader: !!mc?.querySelector('.fractal-translation-header') };
        });
        // main 要求（sidePanelFilePath 無し）は従来どおり main を翻訳ビュー化する。
        expect(afterMain.mainHeader).toBe(true);
    });
});
