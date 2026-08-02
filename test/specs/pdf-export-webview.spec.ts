/**
 * TC-PDF-40〜43 — md → PDF エクスポートの webview 側清書（window.PdfExport）の E2E。
 *
 * sprint 20260802-075012-md-pdf-export / TASK-05。
 * standalone-editor.html を page.goto でロードし、window.PdfExport.buildPdfExportHtml /
 * resolvePdfTarget / cleanPdfImageSrc を page.evaluate で直接駆動する（message 往復不要）。
 *
 * 対象 FR/NFR: FR-PDF-02（清書 = contenteditable/spellcheck 除去・checked 生存・svg 保持）,
 *              FR-PDF-06（img src 逆変換・data: 無傷）,
 *              NFR-PDF-04（清書は元 DOM を一切変更しない = read-only）,
 *              NFR-PDF-06（対象なしで例外死しない）。
 *
 * ★tautology 禁止: 清書結果は「要素が在る」でなく「内容・属性・元 DOM 不変」まで assert。
 *   - checkbox は property→attribute 焼き付けを外すと消える property 由来 checked で検証（counterfactual）。
 *   - contenteditable/spellcheck は既存子要素に付与してから除去されることを検証（strip を外すと残留 = RED）。
 */
import { test, expect, Page } from '@playwright/test';

async function boot(page: Page) {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready && (window as any).PdfExport);
}

test.describe('PDF エクスポート webview 清書 (window.PdfExport)', () => {

    // TC-PDF-40: 清書の中身まで assert（属性除去 + 内容一致 + checked 生存 + 元 DOM 不変）
    test('TC-PDF-40 buildPdfExportHtml — contenteditable/spellcheck 除去・内容一致・checked 生存・元 DOM read-only', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            const api = (window as any).__testApi;
            // 見出し + 段落 + リスト + checkbox（checked 1 + unchecked 1）+ 色 span
            api.setMarkdown('# Heading\n\nparagraph text\n\n- item one\n\n- [x] done task\n- [ ] todo task\n\nfoo <span style="color:#ef4444">red</span> bar');
            const ed = document.querySelector('.editor') as HTMLElement;

            // (a) を load-bearing にするため既存子要素に contenteditable/spellcheck を付与（strip を外すと残留 = RED）
            const p0 = ed.querySelector('p') as HTMLElement;
            if (p0) { p0.setAttribute('contenteditable', 'true'); p0.setAttribute('spellcheck', 'true'); }

            // (c) を load-bearing にするため checkbox を property でトグル（属性は付けない）。
            // markdown 由来の checked 属性ではなく property 由来の checked を焼き付ける経路を踏ませる:
            // 焼き付けを外すと naive clone は checked を落とす（= RED）。
            const cbs = ed.querySelectorAll('input[type=checkbox]');
            const secondCb = cbs[1] as HTMLInputElement | undefined;
            if (secondCb) { secondCb.checked = true; }   // property true / attribute 不在

            // 元 DOM の内容 / 色 span style（実行前スナップショット）
            const origSpan = ed.querySelector('span[style*="color"]') as HTMLElement;
            const origStyle = origSpan ? origSpan.getAttribute('style') : null;
            const origText = ed.textContent || '';
            const innerBefore = ed.innerHTML;   // (d) NFR-PDF-04 用

            // 清書実行
            const built = (window as any).PdfExport.buildPdfExportHtml(ed);
            const html = built.html as string;

            // (d) 実行後の元 DOM が実行前と一致（clone 忘れ / live mutate 番人）
            const innerAfter = ed.innerHTML;

            // 返却 html を parse して内容 / 色 span style を回収
            const tmp = document.createElement('div');
            tmp.innerHTML = html;
            const builtSpan = tmp.querySelector('span[style*="color"]') as HTMLElement;

            return {
                html,
                // (a) 属性除去
                hasContentEditable: /contenteditable/i.test(html),
                hasSpellcheck: /spellcheck/i.test(html),
                // (b) 内容一致 + 色 span style 一致
                builtText: tmp.textContent || '',
                origText,
                builtSpanStyle: builtSpan ? builtSpan.getAttribute('style') : null,
                origStyle,
                // (c) checked 生存（property 由来 checkbox）
                builtHasChecked: /checked/.test(html),
                // (d) 元 DOM 不変
                innerBefore,
                innerAfter,
            };
        });

        // (a) contenteditable / spellcheck 属性が返却 html に無い（既存子要素に付けたものが strip される）
        expect(r.hasContentEditable).toBe(false);
        expect(r.hasSpellcheck).toBe(false);
        // (b) 全テキスト内容が元 DOM と一致
        expect(r.builtText).toBe(r.origText);
        // (b) 色 span の style 値が元 DOM と一致
        expect(r.builtSpanStyle).toBe('color:#ef4444');
        expect(r.builtSpanStyle).toBe(r.origStyle);
        // (c) property 由来 checkbox の checked 属性が焼き付けで生存（外すと消える = RED）
        expect(r.builtHasChecked).toBe(true);
        // (d) NFR-PDF-04: 元 .editor の innerHTML が実行前後で完全一致（read-only）
        expect(r.innerAfter).toBe(r.innerBefore);
    });

    // TC-PDF-41: img src 逆変換（file+ / file%2B 両変種 + query/fragment 除去 + %20 デコード）・data: 無傷
    test('TC-PDF-41 img src 逆変換 — webview-resource 両変種を絶対 fs パス化・data: 保持', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            const api = (window as any).__testApi;
            api.setMarkdown('images\n');
            const ed = document.querySelector('.editor') as HTMLElement;

            // 3 つの img を DOM に直接挿入（webview-resource 両変種 + data:）
            const p = document.createElement('p');
            const img1 = document.createElement('img');   // file+ 変種 + ?query
            img1.setAttribute('src', 'https://file+.vscode-resource.vscode-cdn.net/Users/x/images/a.png?ver=1');
            const img2 = document.createElement('img');   // file%2B 変種 + %20 + #fragment
            img2.setAttribute('src', 'https://file%2B.vscode-resource.vscode-cdn.net/Users/x/images/b%20c.png#f');
            const img3 = document.createElement('img');   // data: URI（無傷であるべき）
            const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
            img3.setAttribute('src', dataUri);
            p.appendChild(img1); p.appendChild(img2); p.appendChild(img3);
            ed.appendChild(p);

            const built = (window as any).PdfExport.buildPdfExportHtml(ed);
            const tmp = document.createElement('div');
            tmp.innerHTML = built.html;
            const imgs = tmp.querySelectorAll('img');
            const srcs = Array.from(imgs).map((im) => (im as HTMLImageElement).getAttribute('src'));
            // cleanPdfImageSrc を単体でも駆動（純関数の直接検証）
            const direct1 = (window as any).PdfExport.cleanPdfImageSrc('https://file+.vscode-resource.vscode-cdn.net/Users/x/images/a.png?ver=1');
            const directData = (window as any).PdfExport.cleanPdfImageSrc(dataUri);
            return { srcs, dataUri, direct1, directData };
        });

        // 3 img 全て存在
        expect(r.srcs.length).toBe(3);
        // file+ 変種: プレフィクス + ?query 除去 → 絶対 fs パス
        expect(r.srcs[0]).toBe('/Users/x/images/a.png');
        // file%2B 変種: プレフィクス + #fragment 除去 + %20 デコード
        expect(r.srcs[1]).toBe('/Users/x/images/b c.png');
        // プレフィクス残留ゼロ
        expect(r.srcs[0]).not.toContain('vscode-resource');
        expect(r.srcs[1]).not.toContain('vscode-resource');
        expect(r.srcs[1]).not.toContain('%2B');
        // data: src は無傷（cleanImageSrc 流用だと '' に落ちる = counterfactual）
        expect(r.srcs[2]).toBe(r.dataUri);
        // 純関数直接検証
        expect(r.direct1).toBe('/Users/x/images/a.png');
        expect(r.directData).toBe(r.dataUri);
    });

    // TC-PDF-42: inline svg（mermaid 描画結果相当）が清書後 html にそのまま残る
    test('TC-PDF-42 inline svg が清書後 html に保持される', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            const api = (window as any).__testApi;
            api.setMarkdown('diagram\n');
            const ed = document.querySelector('.editor') as HTMLElement;
            // mermaid 描画結果相当の inline svg fixture を挿入
            const wrap = document.createElement('div');
            wrap.className = 'mermaid-rendered';
            wrap.innerHTML = '<svg id="mmd-1" width="120" height="60"><rect x="1" y="1" width="118" height="58" fill="#eef"></rect><text x="10" y="30">node</text></svg>';
            ed.appendChild(wrap);

            const built = (window as any).PdfExport.buildPdfExportHtml(ed);
            const html = built.html as string;
            const tmp = document.createElement('div');
            tmp.innerHTML = html;
            const svg = tmp.querySelector('svg');
            return {
                hasSvgTag: /<svg/i.test(html),
                svgHasRect: !!(svg && svg.querySelector('rect')),
                svgText: svg ? (svg.textContent || '') : null,
            };
        });
        expect(r.hasSvgTag).toBe(true);
        expect(r.svgHasRect).toBe(true);
        expect(r.svgText).toBe('node');
    });

    // TC-PDF-43: 対象なし（空 .editor / null）で resolvePdfTarget が null（例外で死なない = NFR-PDF-06）
    test('TC-PDF-43 対象なしで resolvePdfTarget が null を返す（例外死しない）', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            const ed = document.querySelector('.editor') as HTMLElement;
            ed.innerHTML = '';   // 空にする（対象なし）
            let target;
            let threw = false;
            try {
                target = (window as any).PdfExport.resolvePdfTarget();
            } catch (_e) {
                threw = true;
            }
            // editorEl=null でも buildPdfExportHtml が例外死せず {html:''} を返す
            let nullBuild;
            let buildThrew = false;
            try {
                nullBuild = (window as any).PdfExport.buildPdfExportHtml(null);
            } catch (_e) {
                buildThrew = true;
            }
            return { target, threw, nullBuild, buildThrew };
        });
        // resolvePdfTarget は null（例外を投げない）
        expect(r.threw).toBe(false);
        expect(r.target).toBeNull();
        // buildPdfExportHtml(null) は例外死せず {html:''}
        expect(r.buildThrew).toBe(false);
        expect(r.nullBuild).toEqual({ html: '' });
    });

    // TC-PDF-44: 隠し stale md（.out タブ表示中 + sidepanel 閉）を resolvePdfTarget が対象にしない
    //  = FR-PDF-01 受け入れ 4 行目「対象なし・副作用ゼロ」の DOM フォールバック番人（review iteration 1 追加）。
    //
    //  機序: Notes dispatcher の md→.out タブ切替（notes-md-dispatcher.js:112-118 の else）は
    //   showOutliner() で markdownContainer.style.display='none' にするだけで innerHTML を消さないため、
    //   直前に見ていた md の .editor DOM が display:none 配下に stale 残留する。権威 getter
    //   __pdfExportSources.mainMd（dispatcher:132-137）は display==='none' を見て null を返すが、
    //   resolvePdfTarget の DOM フォールバックには可視性ガードが無かった → 隠れた stale md を採用していた。
    //
    //  ★load-bearing・counterfactual（2 系統で担保）:
    //   (1) 同一 .editor を可視化すると採用され非 null（visibility 軸だけが採否を分ける = ガードが load-bearing）。
    //   (2) 【fix 無効時の実測 = RED 確認済み】可視性ガード未導入コード（build-standalone.js で fix 前の
    //       pdf-export-webview.js を inline した状態）で同 setup を走らせると、resolvePdfTarget が
    //       隠れた stale md を採用し target={editorEl:<div.editor>, filePath:null}（非 null）を返した。
    //       → 本コミットの可視性ガード導入後は null を返す（RED → GREEN 遷移を実測）。
    test('TC-PDF-44 隠し stale md（.out タブ + sidepanel 閉）を resolvePdfTarget が対象にしない', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            // 権威 getter（__pdfExportSources）を除去し DOM フォールバック経路を確実に踏む
            try { delete (window as any).__pdfExportSources; } catch (_e) { (window as any).__pdfExportSources = undefined; }

            // .out タブ表示中を模す: outliner-tree を実在させる
            const tree = document.createElement('div');
            tree.className = 'outliner-tree';
            tree.textContent = 'outline node';
            document.body.appendChild(tree);

            // 直前に見ていた md の .editor が display:none コンテナ配下に stale 残留（showOutliner 相当）
            const ed = document.querySelector('.editor') as HTMLElement;
            ed.innerHTML = '<p>stale markdown content</p>';   // stale 内容（_hasContent=true）
            const hidden = document.createElement('div');
            hidden.className = 'markdown-container';
            hidden.style.display = 'none';
            ed.parentNode!.insertBefore(hidden, ed);
            hidden.appendChild(ed);   // .editor を display:none 祖先配下へ移動（自身は display 指定なし）

            // sidepanel は開いていない（.side-panel .editor は存在しない）

            // (A) 隠れている間: resolvePdfTarget は null（隠れた stale md を対象にしない）
            const hiddenTarget = (window as any).PdfExport.resolvePdfTarget();

            // (B) counterfactual: 同一 .editor を可視化すると採用され非 null になる
            //     （visibility 以外の理由では弾かれていない = ガードが visibility 軸で load-bearing である証明）
            hidden.style.display = '';
            const visibleTarget = (window as any).PdfExport.resolvePdfTarget();

            return {
                hiddenIsNull: hiddenTarget === null,
                visibleAdopted: !!(visibleTarget && visibleTarget.editorEl === ed),
            };
        });
        // (A) display:none 配下の stale md は対象にしない（ガードを外すと非 null = RED）
        expect(r.hiddenIsNull).toBe(true);
        // (B) 可視化すると同 .editor が採用される（隠す以外の理由で弾いていない load-bearing 証明）
        expect(r.visibleAdopted).toBe(true);
    });

    // TC-PDF-61: main toolbar の [data-action="exportPdf"] クリック → host.exportPdf が 1 回呼ばれる。
    //  FR-PDF-08 / design §8.2。standalone toolbar は空 stub のため、ボタンを注入して既存の
    //  data-action dispatcher（editor.js:12901 の toolbar delegated click）を駆動する。
    //  host bridge は mock（window.hostBridge.exportPdf を spy に差し替え = TC 定義「host bridge は mock」）。
    //  ★load-bearing・counterfactual: dispatcher に case 'exportPdf' が無いとクリックしても spy が
    //   呼ばれず count===0（RED）。case 追加後に count===1（GREEN）。
    //  回帰: exportBundle ボタンの動作は不変（クリックで export dialog が開く・exportPdf は呼ばれない）。
    test('TC-PDF-61 main toolbar exportPdf クリックで host.exportPdf が 1 回呼ばれる（exportBundle 不変）', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            var toolbar = document.querySelector('.toolbar') as HTMLElement;
            // 空 stub の toolbar に exportPdf / exportBundle ボタンを注入（本番 DOM 相当・順序も Export bundle の左）
            toolbar.innerHTML =
                '<div class="toolbar-group" data-group="utility">' +
                '<button data-action="exportPdf" title="Export to PDF"></button>' +
                '<button data-action="exportBundle" title="Export bundle"></button>' +
                '</div>';
            toolbar.style.display = '';

            // host bridge の exportPdf を spy に差し替え（mock）。host === window.hostBridge（同一参照）。
            var calls = 0;
            (window as any).hostBridge.exportPdf = function () { calls++; };

            // exportPdf をクリック → dispatcher case 'exportPdf' → host.exportPdf()
            var pdfBtn = toolbar.querySelector('[data-action="exportPdf"]') as HTMLElement;
            pdfBtn.click();
            var afterPdfClick = calls;

            // 回帰: exportBundle をクリック → export dialog が開く（openExportDialog）・exportPdf は呼ばれない
            var bundleBtn = toolbar.querySelector('[data-action="exportBundle"]') as HTMLElement;
            bundleBtn.click();
            var dialogOpened = !!document.querySelector('.md-export-dialog-overlay');
            var afterBundleClick = calls;

            return { afterPdfClick, dialogOpened, afterBundleClick };
        });
        // dispatcher の case 'exportPdf' が host.exportPdf を 1 回呼ぶ（case 無しなら 0 = RED）
        expect(r.afterPdfClick).toBe(1);
        // 回帰: exportBundle は従来どおり export dialog を開く
        expect(r.dialogOpened).toBe(true);
        // exportBundle クリックで exportPdf は増えない（別経路）
        expect(r.afterBundleClick).toBe(1);
    });

    // TC-PDF-63: resolvePdfTarget(targetHint) が surface 別に解決する（design §8.3）。
    //  main .editor と .side-panel .editor の両方に内容がある状態で:
    //   - 'sidepanel-md' → sidepanel の editorEl を返す（'auto' だと解決順で main が勝つ状態を明示上書き）
    //   - 'main-md'      → main の editorEl を返す
    //  ★counterfactual: hint 無視実装（従来 'auto' 相当）だと 'sidepanel-md' でも main を返す = RED。
    //   本 TC は「'auto' なら main が勝つ」を先に実測し、hint がその既定を覆すことで load-bearing を示す。
    test('TC-PDF-63 resolvePdfTarget(targetHint) が sidepanel-md / main-md を surface 別に解決する', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            // 権威 getter を除去し DOM フォールバック経路（surface 別ガード）を確実に踏む
            try { delete (window as any).__pdfExportSources; } catch (_e) { (window as any).__pdfExportSources = undefined; }

            // main .editor に内容を入れる（可視・非空）
            var mainEd = document.querySelector('.editor') as HTMLElement;
            mainEd.innerHTML = '<p>main markdown</p>';

            // .side-panel .editor を可視・非空で構築。
            // 本番の styles.css は `.side-panel { display:none }` / `.side-panel.open { display:flex }`
            // なので、sidepanel exportPdf ボタンを押せる = パネルが開いている状態を再現するため
            // 'open' を付ける（付けないと display:none で _isVisible=false になり解決対象外 = TC-PDF-44 のガード）。
            var sp = document.createElement('div');
            sp.className = 'side-panel open';
            var spEd = document.createElement('div');
            spEd.className = 'editor';
            spEd.innerHTML = '<p>sidepanel markdown</p>';
            sp.appendChild(spEd);
            document.body.appendChild(sp);

            var PdfExport = (window as any).PdfExport;
            var autoT = PdfExport.resolvePdfTarget();            // 既定（'auto' 相当）
            var spT = PdfExport.resolvePdfTarget('sidepanel-md'); // sidepanel 明示
            var mainT = PdfExport.resolvePdfTarget('main-md');    // main 明示

            return {
                autoIsMain: !!(autoT && autoT.editorEl === mainEd),   // 既定では main が勝つ
                sidepanelResolved: !!(spT && spT.editorEl === spEd),  // hint で sidepanel を明示解決
                mainResolved: !!(mainT && mainT.editorEl === mainEd), // hint で main を明示解決
            };
        });
        // 既定（auto）では解決順で main が勝つ（この前提が counterfactual の土台）
        expect(r.autoIsMain).toBe(true);
        // 'sidepanel-md' は main が勝つ状態でも sidepanel を返す（hint 無視だと main = RED）
        expect(r.sidepanelResolved).toBe(true);
        // 'main-md' は main を返す
        expect(r.mainResolved).toBe(true);
    });
});
