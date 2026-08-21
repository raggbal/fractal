/**
 * Sprint 20260817-053313-notetree-local-folder-view — WV-VIEW（TASK-07/08）
 * フォルダビュー本体（notes-folder-view.js + folder-view-dispatcher.js）の UI 契約。
 *
 * ハーネス: about:blank + setContent(最小 DOM) + addScriptTag(現ソース 2 モジュール) +
 * **明示メソッド recorder bridge**（Proxy 禁止 — 実在しない bridge メソッド呼び出しを検出するため、
 * 台帳 #6-18 のメソッドだけを持つ）。host 応答は window.postMessage で注入（重量ハーネス回避 —
 * generator_failures 2026-08-15）。
 *
 * TC-FLV-34: lazy per-expand / TC-FLV-35: Search pruned tree + truncated /
 * TC-FLV-36: キーボード / TC-FLV-37: context menu 6 項目 + 契機リフレッシュ /
 * TC-FLV-44: 分離・i18n・モード境界 番人（node 側） / TC-FLV-45: 大規模 fixture 構造 assert
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as fsNode from 'fs';
import * as pathNode from 'path';
const ROOT2 = pathNode.resolve(__dirname, '../..');

const DISPATCHER_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/folder-view-dispatcher.js'), 'utf8');
const VIEW_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/notes-folder-view.js'), 'utf8');

/** host 応答（list/search）を window message で注入 */
async function postList(page: Page, relPath: string, entries: any[]): Promise<void> {
    await page.evaluate(({ relPath, entries }) => {
        window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath, entries }, '*');
    }, { relPath, entries });
    await page.waitForTimeout(50);
}

function calls(page: Page) {
    return page.evaluate(() => (window as any).__calls);
}

test.describe('TASK-07 — folder view UI（notes-folder-view.js / folder-view-dispatcher.js）', () => {

    test('TC-FLV-34: 初期 = ルート 1 階層のみ・展開で per-dir 取得・折りたたみ状態保持', async ({ page }) => {
        await loadViewInitKeepCalls(page);
        // 初期 list 要求はルート 1 回のみ
        let c = await calls(page);
        expect(c).toEqual([{ type: 'folderViewList', args: ['fl1', ''] }]);
        await postList(page, '', [
            { name: 'dirA', relPath: 'dirA', isDir: true },
            { name: 'fileB.txt', relPath: 'fileB.txt', isDir: false },
        ]);
        expect(await rowNames(page)).toEqual(['dirA', 'fileB.txt']);
        // 展開（dblclick）→ その dir の list 要求 + 応答で子描画
        await page.dblclick('.fv-row[data-rel="dirA"]');
        c = await calls(page);
        expect(c.some((x: any) => x.type === 'folderViewList' && x.args[1] === 'dirA')).toBe(true);
        await postList(page, 'dirA', [{ name: 'child.md', relPath: 'dirA/child.md', isDir: false }]);
        expect(await rowNames(page)).toEqual(['dirA', 'child.md', 'fileB.txt']);
        // 折りたたみ → 子が消える（キャッシュは保持 = 再展開で list 再要求なしに描画）
        await page.dblclick('.fv-row[data-rel="dirA"]');
        expect(await rowNames(page)).toEqual(['dirA', 'fileB.txt']);
        const before = (await calls(page)).filter((x: any) => x.type === 'folderViewList').length;
        await page.dblclick('.fv-row[data-rel="dirA"]');
        expect(await rowNames(page)).toEqual(['dirA', 'child.md', 'fileB.txt']);
        // キャッシュ再利用（契機リフレッシュ以外は list 再要求しない。stateSave は FR-FLV-26 で増えるため除外）
        expect((await calls(page)).filter((x: any) => x.type === 'folderViewList').length).toBe(before);
    });

    test('TC-FLV-35: Search — debounce 送出・マッチ + 祖先の pruned tree・truncated 警告・クリア復帰', async ({ page }) => {
        await loadViewInitKeepCalls(page);
        await postList(page, '', [{ name: 'top.txt', relPath: 'top.txt', isDir: false }]);
        await page.fill('.fv-search', 'hit');
        await page.waitForTimeout(350); // debounce 250ms
        let c = await calls(page);
        expect(c.some((x: any) => x.type === 'folderViewSearch' && x.args[1] === 'hit')).toBe(true);
        // 応答: 深い hit → 祖先 dir（dirA, dirA/sub）が自動導出・展開表示
        await page.evaluate(() => {
            window.postMessage({
                type: 'folderViewSearchResult', folderLinkId: 'fl1', query: 'hit',
                hits: [{ name: 'hit-1.txt', relPath: 'dirA/sub/hit-1.txt', isDir: false }],
                truncated: true,
            }, '*');
        });
        await page.waitForTimeout(50);
        expect(await rowNames(page)).toEqual(['dirA', 'sub', 'hit-1.txt']);
        expect(await page.locator('.fv-truncated').count()).toBe(1); // 警告行
        // クリア → 通常表示に復帰
        await page.fill('.fv-search', '');
        await page.waitForTimeout(350);
        expect(await rowNames(page)).toEqual(['top.txt']);
    });

    test('TC-FLV-36: キーボード — ↑↓ 選択・→ 展開・← 折りたたみ・cmd+enter = open', async ({ page }) => {
        await loadViewInitKeepCalls(page);
        await postList(page, '', [
            { name: 'dirA', relPath: 'dirA', isDir: true },
            { name: 'b.md', relPath: 'b.md', isDir: false },
        ]);
        await page.focus('.fv-tree');
        await page.keyboard.press('ArrowDown');
        expect(await selectedRel(page)).toBe('dirA');
        await page.keyboard.press('ArrowDown');
        expect(await selectedRel(page)).toBe('b.md');
        await page.keyboard.press('ArrowUp');
        expect(await selectedRel(page)).toBe('dirA');
        // → 展開（list 要求）
        await page.keyboard.press('ArrowRight');
        expect((await calls(page)).some((x: any) => x.type === 'folderViewList' && x.args[1] === 'dirA')).toBe(true);
        await postList(page, 'dirA', [{ name: 'c.txt', relPath: 'dirA/c.txt', isDir: false }]);
        expect(await rowNames(page)).toEqual(['dirA', 'c.txt', 'b.md']);
        // ← 折りたたみ
        await page.keyboard.press('ArrowLeft');
        expect(await rowNames(page)).toEqual(['dirA', 'b.md']);
        // cmd+enter でファイル open
        await page.keyboard.press('ArrowDown');
        expect(await selectedRel(page)).toBe('b.md');
        await page.keyboard.press('Meta+Enter');
        expect((await calls(page)).some((x: any) => x.type === 'folderViewOpen' && x.args[1] === 'b.md')).toBe(true);
    });

    test('TC-FLV-67: ファイル行アイコン click = folderViewOpen / アイコン外 = 選択のみ / dir 行アイコン無し + 👁 click = folderViewToggleHidden（FR-FLV-31/32 webview 端）', async ({ page }) => {
        await loadViewInitKeepCalls(page);
        await postList(page, '', [
            { name: 'dirA', relPath: 'dirA', isDir: true },
            { name: 'b.md', relPath: 'b.md', isDir: false },
        ]);
        const openCalls = async () => (await calls(page)).filter((x: any) => x.type === 'folderViewOpen');
        // アイコン外（行の名前部分）click → 選択のみ・open は飛ばない
        await page.click('.fv-row[data-rel="b.md"]');
        expect(await selectedRel(page)).toBe('b.md');
        expect((await openCalls()).length).toBe(0);
        // 📄 アイコン click → folderViewOpen(id, relPath) 1 回（FR-FLV-32）
        await page.click('.fv-row[data-rel="b.md"] .fv-file-icon');
        const oc = await openCalls();
        expect(oc.length).toBe(1);
        expect(oc[0].args).toEqual(['fl1', 'b.md']);
        // dir 行にはアイコンが無い（構造 pin — 展開トグルは chevron のみ）
        expect(await page.locator('.fv-row[data-rel="dirA"] .fv-file-icon').count()).toBe(0);
        // 👁 トグル click → folderViewToggleHidden(id) 送出（FR-FLV-31 webview 端）
        await page.click('.fv-hidden-toggle');
        const tc = (await calls(page)).filter((x: any) => x.type === 'folderViewToggleHidden');
        expect(tc.length).toBe(1);
        expect(tc[0].args).toEqual(['fl1']);
        // showHidden:true の listResult でボタンが active 化（表示状態復元）
        await page.evaluate(() => {
            window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries: [], showHidden: true }, '*');
        });
        await page.waitForTimeout(50);
        expect(await page.locator('.fv-hidden-toggle.active').count()).toBe(1);
    });

    test('TC-FLV-73: 👁 トグル click で全面 reload — 展開中 dir 再要求 + 閉じ dir キャッシュ破棄（ON/OFF 両方向）', async ({ page }) => {
        await loadViewInitKeepCalls(page);
        await postList(page, '', [
            { name: 'dirA', relPath: 'dirA', isDir: true },
            { name: 'dirB', relPath: 'dirB', isDir: true },
        ]);
        // dirA を展開（list 要求 + 応答でキャッシュ）→ dirB は展開して閉じる（キャッシュだけ残る）
        await page.dblclick('.fv-row[data-rel="dirA"]');
        await postList(page, 'dirA', [{ name: 'a.md', relPath: 'dirA/a.md', isDir: false }]);
        await page.dblclick('.fv-row[data-rel="dirB"]');
        await postList(page, 'dirB', [{ name: 'b.md', relPath: 'dirB/b.md', isDir: false }]);
        await page.dblclick('.fv-row[data-rel="dirB"]'); // 折りたたみ（キャッシュ保持）
        const listCallsFor = async (rel: string) =>
            (await calls(page)).filter((x: any) => x.type === 'folderViewList' && x.args[1] === rel).length;
        const beforeA = await listCallsFor('dirA');
        const beforeB = await listCallsFor('dirB');
        // トグル click → (a) toggle 送出 + 展開中 dirA の再要求（filter が変わるため stale 排除）
        await page.click('.fv-hidden-toggle');
        expect((await calls(page)).filter((x: any) => x.type === 'folderViewToggleHidden').length).toBe(1);
        expect(await listCallsFor('dirA')).toBe(beforeA + 1);
        // (b) 閉じている dirB はキャッシュ破棄 = トグル後の再展開でキャッシュ再利用せず再要求される
        await postList(page, '', [
            { name: 'dirA', relPath: 'dirA', isDir: true },
            { name: 'dirB', relPath: 'dirB', isDir: true },
        ]);
        await postList(page, 'dirA', [{ name: 'a.md', relPath: 'dirA/a.md', isDir: false }]);
        await page.dblclick('.fv-row[data-rel="dirB"]');
        // 展開は toggleDir + render の 2 箇所が要求しうる（既存挙動）— pin は「キャッシュ再利用なし = 再要求が発生する」
        //（counterfactual: キャッシュ破棄を外すと再要求 0 = beforeB のまま → RED）
        expect(await listCallsFor('dirB')).toBeGreaterThanOrEqual(beforeB + 1);
    });

    test('TC-FLV-70: hide/switch で folderViewClosed 送出（FR-FLV-33 webview 端 — watcher dispose 契機）', async ({ page }) => {
        await loadViewInitKeepCalls(page); // showFolderView('fl1')
        const closedCalls = async () =>
            (await calls(page)).filter((x: any) => x.type === 'folderViewClosed');
        expect((await closedCalls()).length).toBe(0);
        // 別 link への切替 → 旧 link の closed が 1 回飛ぶ
        await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl2', 'Docs2'); });
        let cc = await closedCalls();
        expect(cc.length).toBe(1);
        expect(cc[0].args).toEqual(['fl1']);
        // hide → 表示中 link の closed
        await page.evaluate(() => { (window as any).__folderViewDispatcher.hideFolderView(); });
        cc = await closedCalls();
        expect(cc.length).toBe(2);
        expect(cc[1].args).toEqual(['fl2']);
        // 二重 hide で重複送出しない
        await page.evaluate(() => { (window as any).__folderViewDispatcher.hideFolderView(); });
        expect((await closedCalls()).length).toBe(2);
    });

    test('TC-FLV-37: context menu（エントリ 6 項目のみ / 空白 2 項目）+ bridge 送出 + Refresh の状態保持', async ({ page }) => {
        await loadViewInitKeepCalls(page);
        await postList(page, '', [
            { name: 'dirA', relPath: 'dirA', isDir: true },
            { name: 'b.md', relPath: 'b.md', isDir: false },
        ]);
        // エントリ menu = 7 項目（FR-FLV-15 全列挙 + FR-ACC-04 Duplicate — sprint 20260820-063902 許可: test_update）
        await page.click('.fv-row[data-rel="b.md"]', { button: 'right' });
        let items = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.fv-menu .fv-menu-item')).map((el) => (el.textContent || '').trim()));
        expect(items).toEqual(['New Markdown', 'New Folder', 'Rename', 'Reveal in Finder', 'Copy Path', 'Duplicate', 'Delete']);
        // 各項目 → bridge（file 行: New 系の作成先は同階層 = ''）
        const clickItem = async (label: string, target = '.fv-row[data-rel="b.md"]') => {
            await page.click(target, { button: 'right' });
            await page.evaluate((lbl) => {
                const els = Array.from(document.querySelectorAll('.fv-menu .fv-menu-item'));
                (els.find((e) => (e.textContent || '').trim() === lbl) as HTMLElement).click();
            }, label);
        };
        await clickItem('New Markdown');
        await clickItem('New Folder', '.fv-row[data-rel="dirA"]'); // dir 行: 作成先 = その中
        // FR-FLV-28（再オープン①・test_update）: menu Rename はインライン input を開く（bridge 直呼びしない）
        await clickItem('Rename');
        expect(await page.locator('.fv-rename-input').count(), 'Rename はインライン化').toBe(1);
        await page.keyboard.press('Escape');
        await clickItem('Reveal in Finder');
        await clickItem('Copy Path');
        await clickItem('Delete');
        const c = await calls(page);
        const has = (type: string, ...args: any[]) =>
            c.some((x: any) => x.type === type && JSON.stringify(x.args) === JSON.stringify(args));
        expect(has('folderViewCreate', 'fl1', '', 'md')).toBe(true);
        expect(has('folderViewCreate', 'fl1', 'dirA', 'folder')).toBe(true);
        expect(c.filter((x: any) => x.type === 'folderViewRename').length, 'Rename 直呼びは廃止（確定時のみ = TC-FLV-55）').toBe(0);
        expect(has('folderViewRevealEntry', 'fl1', 'b.md')).toBe(true);
        expect(has('folderViewCopyEntryPath', 'fl1', 'b.md')).toBe(true);
        expect(has('folderViewDelete', 'fl1', 'b.md')).toBe(true);
        // 空白 menu = New 2 項目のみ
        await page.evaluate(() => {
            const tree = document.querySelector('.fv-tree') as HTMLElement;
            tree.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 200 }));
        });
        items = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.fv-menu .fv-menu-item')).map((el) => (el.textContent || '').trim()));
        expect(items).toEqual(['New Markdown', 'New Folder']);

        // 契機リフレッシュ: 操作後の list 再送（host 応答）で再描画 = 既に postList が検証。
        // Refresh ボタン → ルート + 展開済み dir の再要求・検索語 / 選択の保持
        await page.dblclick('.fv-row[data-rel="dirA"]');
        await postList(page, 'dirA', [{ name: 'c.txt', relPath: 'dirA/c.txt', isDir: false }]);
        await page.click('.fv-row[data-rel="b.md"]'); // 選択
        await page.fill('.fv-search', 'zz'); // 入力のみ（debounce 前に Refresh）
        await page.evaluate(() => { (window as any).__calls = []; });
        // fv-search の focus 幅アニメ（0.2s — outliner 同挙動）中は座標 click がズレるため DOM click で駆動
        await page.evaluate(() => { (document.querySelector('.fv-refresh') as HTMLElement).click(); });
        const rc = await calls(page);
        const listArgs = rc.filter((x: any) => x.type === 'folderViewList').map((x: any) => x.args[1]);
        expect(listArgs).toContain('');
        expect(listArgs).toContain('dirA');
        expect(await page.inputValue('.fv-search')).toBe('zz'); // 検索語保持
        await postList(page, '', [
            { name: 'dirA', relPath: 'dirA', isDir: true },
            { name: 'b.md', relPath: 'b.md', isDir: false },
        ]);
        expect(await selectedRel(page)).toBe('b.md'); // 選択保持（再描画後も selectedRel 基準で復元）
    });

    test('TC-ACC-31: Duplicate は file 行のみ表示・click で folderViewDuplicate(id, relPath) 送出（FR-ACC-04）', async ({ page }) => {
        await loadViewInitKeepCalls(page);
        await postList(page, '', [
            { name: 'dirA', relPath: 'dirA', isDir: true },
            { name: 'b.md', relPath: 'b.md', isDir: false },
        ]);
        // file 行 → Duplicate あり + click で bridge 送出
        await page.click('.fv-row[data-rel="b.md"]', { button: 'right' });
        await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('.fv-menu .fv-menu-item'));
            (els.find((e) => (e.textContent || '').trim() === 'Duplicate') as HTMLElement).click();
        });
        const c = await calls(page);
        expect(c.some((x: any) => x.type === 'folderViewDuplicate' && JSON.stringify(x.args) === JSON.stringify(['fl1', 'b.md']))).toBe(true);
        // dir 行 → Duplicate 非表示
        await page.click('.fv-row[data-rel="dirA"]', { button: 'right' });
        const dirItems = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.fv-menu .fv-menu-item')).map((el) => (el.textContent || '').trim()));
        expect(dirItems).not.toContain('Duplicate');
    });

    test('TC-FLV-45: 大規模 fixture — 初期表示の list 要求はルート 1 回のみ（再帰 walk 不在の構造 assert）', async ({ page }) => {
        await loadViewInitKeepCalls(page);
        const big: any[] = [];
        for (let i = 0; i < 2500; i++) { big.push({ name: `dir-${i}`, relPath: `dir-${i}`, isDir: true }); }
        for (let i = 0; i < 2500; i++) { big.push({ name: `f-${i}.txt`, relPath: `f-${i}.txt`, isDir: false }); }
        await postList(page, '', big);
        await page.waitForTimeout(200);
        const c = await calls(page);
        // 5,000 エントリ（うち dir 2,500）を描画しても list 要求はルート 1 回のみ（子 dir を先読みしない）
        expect(c.filter((x: any) => x.type === 'folderViewList')).toEqual([{ type: 'folderViewList', args: ['fl1', ''] }]);
        expect(await page.locator('.fv-row').count()).toBe(5000);
    });
});

// ── TC-FLV-44: 分離・i18n・モード境界 番人（node 側 — page 不使用） ──

test.describe('TC-FLV-44 — 分離・i18n・モード境界 番人', () => {
    const ROOT = path.join(__dirname, '../..');

    test('① outliner.js に folder-view 参照 0（NFR-FLV-07 — outliner.js 限定・editor.js は W4 分岐のみ許容）', () => {
        const outliner = fs.readFileSync(path.join(ROOT, 'src/webview/outliner.js'), 'utf8');
        expect(outliner.includes('folderView')).toBe(false);
        expect(outliner.includes('folder-view')).toBe(false);
        expect(outliner.includes('__folderView')).toBe(false);
    });

    test('② 新規 webview i18n キーが WebviewMessages + 7 locale 全てに登録済み', () => {
        const keys = [
            'folderLinkAdd', 'folderLinkRelink', 'folderLinkRemove', 'folderLinkBroken',
            'folderViewOpenFailed', 'folderViewSearchPlaceholder', 'folderViewRefresh',
            'folderViewTruncated', 'folderViewNoMatch', 'folderViewEmpty',
            'folderViewNewMarkdown', 'folderViewNewFolder',
            'folderViewNoFolderDrop', 'folderViewMoveInUnsupported', // TASK-09 D&D 不受理通知
        ];
        const iface = fs.readFileSync(path.join(ROOT, 'src/i18n/messages.ts'), 'utf8');
        const wvSection = iface.slice(iface.indexOf('export interface WebviewMessages'));
        for (const k of keys) {
            expect(wvSection.includes(`${k}: string;`), `WebviewMessages: ${k}`).toBe(true);
        }
        for (const loc of ['en', 'ja', 'es', 'fr', 'ko', 'zh-cn', 'zh-tw']) {
            const src = fs.readFileSync(path.join(ROOT, `src/i18n/locales/${loc}.ts`), 'utf8');
            const wv = src.slice(src.indexOf('export const webviewMessages'));
            for (const k of keys) {
                expect(new RegExp(`${k}: ['"]`).test(wv), `${loc}: ${k}`).toBe(true);
            }
        }
        // host 側キー（Messages + locales の messages）も逆引き（silent 債務防止）
        const hostKeys = [
            'folderLinkAddLabel', 'folderLinkRelinkLabel', 'folderLinkRenamePrompt',
            'folderLinkDuplicate', 'folderLinkSelfReference', 'folderLinkInvalid', 'folderLinkBroken',
            'folderViewOpenFailed', 'folderViewNewMarkdownPrompt', 'folderViewNewFolderPrompt',
            'folderViewInvalidName', 'folderViewNameConflict', 'folderViewOperationFailed',
            'folderViewMoveIntoSelf', 'folderViewMoveExdev', 'folderViewNoFolderDrop', 'folderViewMoveInUnsupported',
        ];
        const hostSection = iface.slice(iface.indexOf('export interface Messages'), iface.indexOf('export interface WebviewMessages'));
        for (const k of hostKeys) {
            expect(hostSection.includes(`${k}: string;`), `Messages: ${k}`).toBe(true);
        }
        for (const loc of ['en', 'ja', 'es', 'fr', 'ko', 'zh-cn', 'zh-tw']) {
            const src = fs.readFileSync(path.join(ROOT, `src/i18n/locales/${loc}.ts`), 'utf8');
            const hostPart = src.slice(0, src.indexOf('export const webviewMessages'));
            for (const k of hostKeys) {
                expect(new RegExp(`${k}: ['"]`).test(hostPart), `${loc}(host): ${k}`).toBe(true);
            }
        }
    });

    test('③ build-standalone-notes.js に新 2 モジュールの登録行が存在', () => {
        const build = fs.readFileSync(path.join(ROOT, 'test/build-standalone-notes.js'), 'utf8');
        expect(build.includes('folder-view-dispatcher.js')).toBe(true);
        expect(build.includes('notes-folder-view.js')).toBe(true);
        expect(build.includes('__FOLDER_VIEW_DISPATCHER_SCRIPT__')).toBe(true);
        expect(build.includes('__NOTES_FOLDER_VIEW_SCRIPT__')).toBe(true);
    });

    test('④ Single Outliner / standalone md ハーネスに +folder ボタン・#folderViewContainer が現れない（Notes モード限定）', () => {
        for (const artifact of ['test/html/standalone-outliner.html', 'test/html/standalone-editor.html']) {
            const p = path.join(ROOT, artifact);
            if (!fs.existsSync(p)) { continue; } // 未ビルド環境では skip（gate は必ずビルド後に走る）
            const html = fs.readFileSync(p, 'utf8');
            expect(html.includes('filePanelAddFolderLink'), `${artifact}: +folder ボタン不在`).toBe(false);
            expect(html.includes('folderViewContainer'), `${artifact}: folder view 不在`).toBe(false);
        }
        // build 生成器レベルでも確認（artifact の stale に依存しない）
        for (const gen of ['test/build-standalone-outliner.js', 'test/build-standalone.js']) {
            const src = fs.readFileSync(path.join(ROOT, gen), 'utf8');
            expect(src.includes('folder-view-dispatcher'), `${gen}`).toBe(false);
            expect(src.includes('notes-folder-view'), `${gen}`).toBe(false);
        }
    });
});

// ── TC-FLV-38: kind='folder' タブ（TASK-08 — standalone-notes ハーネス + 実 tab manager） ──

test.describe('TC-FLV-38 — kind=folder タブ配線（FR-FLV-25）', () => {

    /** notes ハーネス + 実 tab manager（__testApi.initTabManager = 本番と同じ __initNotesTabManager） */
    async function setupTabs(page: Page): Promise<void> {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__folderViewDispatcher && (window as any).__testApi);
        await page.evaluate(() => {
            const w = window as any;
            w.__testApi.initTabManager();
            w.__testApi.tabManager.initFirstTab('/x/a.out', 'out', 'A');
        });
    }

    function tabs(page: Page) {
        return page.evaluate(() => (window as any).__testApi.tabManager.getTabs());
    }
    function activeTab(page: Page) {
        return page.evaluate(() => {
            const tm = (window as any).__testApi.tabManager;
            return tm.getTabs().find((t: any) => t.id === tm.getActiveId());
        });
    }
    /** 指定 index 以降に notesOpenFile（= bridge.openFile）が飛んだか */
    function openFileCountSince(page: Page, since: number) {
        return page.evaluate((s) => (window as any).__testApi.messages
            .slice(s).filter((m: any) => m.type === 'notesOpenFile').length, since);
    }
    function msgCount(page: Page) {
        return page.evaluate(() => (window as any).__testApi.messages.length);
    }

    test('openInNewTab(folder) → showFolderView + bridge.openFile 不発 / captureActive 非破壊 / 再 activate で folder view', async ({ page }) => {
        await setupTabs(page);
        const base = await msgCount(page);
        await page.evaluate(() => {
            (window as any).__testApi.tabManager.openInNewTab('fl1', 'folder', 'My Docs');
        });
        // showFolderView が呼ばれる（分岐漏れ番人 — TC-FV-64 型）
        await page.waitForSelector('#folderViewContainer .fv-header', { timeout: 5000 });
        // bridge.openFile が飛ばない（folderLinkId を md エディタで開く事故の遮断）
        expect(await openFileCountSince(page, base), 'folder タブ load で openFile 不発').toBe(0);
        // タブは 2 本・アクティブ = folder タブ（filePath 欄 = folderLinkId 規約）
        const act = await activeTab(page);
        expect(act.kind).toBe('folder');
        expect(act.filePath).toBe('fl1');
        expect(act.title).toBe('My Docs');

        // captureActive 非破壊: A タブへ離れて戻る round-trip で folder タブ state が不変
        await page.evaluate(() => {
            const tm = (window as any).__testApi.tabManager;
            const aId = tm.getTabs()[0].id;
            tm.activateTab(aId);
        });
        const folderState = await page.evaluate(() =>
            (window as any).__testApi.tabManager.getTabs().find((t: any) => t.kind === 'folder'));
        expect(folderState.filePath).toBe('fl1');
        expect(folderState.title).toBe('My Docs');
        const base2 = await msgCount(page);
        await page.evaluate(() => {
            const tm = (window as any).__testApi.tabManager;
            const fId = tm.getTabs().find((t: any) => t.kind === 'folder').id;
            tm.activateTab(fId);
        });
        await page.waitForSelector('#folderViewContainer .fv-header', { timeout: 5000 });
        expect(await openFileCountSince(page, base2), '再 activate でも openFile 不発').toBe(0);
    });

    test('タブ右クリック: Open in Standalone / OS default 非表示・Duplicate したタブも folder view が開く（extra 非依存）・Close Other 動作', async ({ page }) => {
        await setupTabs(page);
        await page.evaluate(() => {
            (window as any).__testApi.tabManager.openInNewTab('fl1', 'folder', 'My Docs');
        });
        await page.waitForSelector('#folderViewContainer .fv-header', { timeout: 5000 });
        // folder タブの右クリックメニュー全列挙（assert 方向 = 表示 2 項目のみ）
        await page.click('.notes-tab[data-id="fl1"]', { button: 'right' });
        const items = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.file-panel-context-menu .file-panel-context-item'))
                .map((el) => (el.textContent || '').trim()));
        expect(items).toEqual(['Duplicate Tab', 'Close Other Tabs']);

        // Duplicate → 3 本目が folder タブとして開き folder view 表示 + openFile 不発 + title 継承
        const base = await msgCount(page);
        await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('.file-panel-context-menu .file-panel-context-item'));
            (els.find((e) => (e.textContent || '').trim() === 'Duplicate Tab') as HTMLElement).click();
        });
        await page.waitForSelector('#folderViewContainer .fv-header', { timeout: 5000 });
        expect((await tabs(page)).length).toBe(3);
        const act = await activeTab(page);
        expect(act.kind, 'Duplicate は extra 非依存（filePath=folderLinkId + kind で完結）').toBe('folder');
        expect(act.filePath).toBe('fl1');
        expect(act.title).toBe('My Docs');
        expect(await openFileCountSince(page, base)).toBe(0);

        // Close Other Tabs → 1 本
        await page.click('.notes-tab[data-active="true"]', { button: 'right' });
        await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('.file-panel-context-menu .file-panel-context-item'));
            (els.find((e) => (e.textContent || '').trim() === 'Close Other Tabs') as HTMLElement).click();
        });
        expect((await tabs(page)).length).toBe(1);
        expect((await tabs(page))[0].kind).toBe('folder');
    });

    test('通常 click（showFolderView 非 inTab）: タブを増やさずアクティブタブを folder に差し替え', async ({ page }) => {
        await setupTabs(page);
        await page.evaluate(() => {
            (window as any).__testApi.tabManager.openInNewTab('/x/b.md', 'md', 'B');
        });
        expect((await tabs(page)).length).toBe(2);
        // tree の folder item 通常 click 相当 = dispatcher.showFolderView（notes-file-panel.js openFolderView 経由）
        await page.evaluate(() => {
            (window as any).__folderViewDispatcher.showFolderView('fl2', 'Proj');
        });
        await page.waitForSelector('#folderViewContainer .fv-header', { timeout: 5000 });
        expect((await tabs(page)).length, 'タブは増えない').toBe(2);
        const act = await activeTab(page);
        expect(act.kind, 'アクティブタブが folder に差し替わる').toBe('folder');
        expect(act.filePath).toBe('fl2');
        expect(act.title).toBe('Proj');
    });

    test('kind 推定式 3 サイト（data-model §5 #16）: ①makeTabState 明示必須の事実 pin ②a openInActiveTab ②b syncActiveFile で folder タブ非上書き', async ({ page }) => {
        await setupTabs(page);
        // ① kind 未指定で folderLinkId を渡すと 'md' に化ける（= 呼び出し側の kind 明示が必須である事実の pin）
        const inferred = await page.evaluate(() => {
            const tm = (window as any).__testApi.tabManager;
            tm.initFirstTab('fl-implicit');
            return tm.getTabs()[0].kind;
        });
        expect(inferred, '推定式は out/md 2 値のみ — folder は明示必須').toBe('md');

        // folder タブを active に整え直す
        await page.evaluate(() => {
            const tm = (window as any).__testApi.tabManager;
            tm.initFirstTab('/x/a.out', 'out', 'A');
            tm.openInNewTab('fl1', 'folder', 'My Docs');
        });
        await page.waitForSelector('#folderViewContainer .fv-header', { timeout: 5000 });

        // ②b syncActiveFile（stray updateData(kind:out) 相当）— **folder view 表示中**は上書きされない
        //（2026-08-18 精緻化: 防御スコープ = folder view が実際に表示中の stray のみ）
        await page.evaluate(() => {
            (window as any).__testApi.tabManager.syncActiveFile('/x/c.out', 'out', 'C');
        });
        let act = await activeTab(page);
        expect(act.kind, '②b: folder view 表示中の stray は遮断（防御を外すと out に乗っ取られ RED）').toBe('folder');
        expect(act.filePath).toBe('fl1');
        expect(act.title, 'title も乗っ取られない').toBe('My Docs');

        // ②a openInActiveTab（Recent click 等 = 常にユーザー起点）は folder view を畳んで通常どおり差し替える
        //（2026-08-18 バグ修正: 旧仕様の早期 return では Recent が無反応だった — ユーザー裁定で変換に変更）
        const base = await msgCount(page);
        await page.evaluate(() => {
            (window as any).__testApi.tabManager.openInActiveTab('/x/c.out', 'out');
        });
        act = await activeTab(page);
        expect(act.kind, '②a: ユーザー起点は変換される').toBe('out');
        expect(act.filePath).toBe('/x/c.out');
        expect(await openFileCountSince(page, base), '②a: openFile が飛ぶ').toBe(1);
        expect(await page.evaluate(() => (window as any).__folderViewDispatcher.isFolderViewShown()), 'folder view は畳まれる').toBe(false);

        // ②b 続き: folder view が畳まれた後の syncActiveFile は通る（正規遷移の同期）
        await page.evaluate(() => {
            (window as any).__testApi.tabManager.syncActiveFile('/x/d.md', 'md', 'D');
        });
        act = await activeTab(page);
        expect(act.kind, 'folder view 非表示なら同期される').toBe('md');
    });
});

// ── helpers ──

async function loadViewInitKeepCalls(page: Page): Promise<void> {
    await page.goto('about:blank');
    await page.setContent(
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
        '<div class="notes-main-wrapper" style="position:relative;height:400px;">' +
        '<div id="outlinerContainer">outliner</div>' +
        '<div id="markdownContainer" style="display:none">md</div>' +
        '</div></body></html>');
    await page.evaluate(() => {
        const w = window as any;
        w.__outlinerMessages = {};
        w.__calls = [];
        const rec = (type: string) => (...args: any[]) => { w.__calls.push({ type, args }); };
        w.notesHostBridge = {
            folderViewList: rec('folderViewList'),
            folderViewSearch: rec('folderViewSearch'),
            folderViewOpen: rec('folderViewOpen'),
            folderViewToggleHidden: rec('folderViewToggleHidden'),
            folderViewClosed: rec('folderViewClosed'),
            folderViewCreate: rec('folderViewCreate'),
            folderViewRename: rec('folderViewRename'),
            folderViewDelete: rec('folderViewDelete'),
            folderViewMove: rec('folderViewMove'),
            folderViewRevealEntry: rec('folderViewRevealEntry'),
            folderViewCopyEntryPath: rec('folderViewCopyEntryPath'),
            folderViewDuplicate: rec('folderViewDuplicate'),
            folderViewMoveIn: rec('folderViewMoveIn'),
            folderViewMoveToTree: rec('folderViewMoveToTree'),
            folderViewMoveIntoMd: rec('folderViewMoveIntoMd'),
            folderViewMoveFromMd: rec('folderViewMoveFromMd'),
            folderViewStateSave: rec('folderViewStateSave'),
            folderViewRename: rec('folderViewRename'),
        };
    });
    await page.addScriptTag({ content: DISPATCHER_JS });
    await page.addScriptTag({ content: VIEW_JS });
    await page.evaluate(() => {
        (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs');
    });
}

async function rowNames(page: Page): Promise<string[]> {
    // 再オープン①: 行アイコン（svg 内 <text>M</text>）が textContent に混入するため svg を除いて読む
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('.fv-row .fv-name')).map((el) => {
            const clone = el.cloneNode(true) as HTMLElement;
            clone.querySelectorAll('svg, .fv-file-icon').forEach((v) => v.remove());
            return (clone.textContent || '').trim();
        }));
}

async function selectedRel(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        const el = document.querySelector('.fv-row.fv-selected') as HTMLElement | null;
        return el ? el.dataset.rel || null : null;
    });
}

// ── 再オープン①（TASK-19）: 状態復元・保存 / エラースコープ / インライン rename / デザイン統一 ──

test.describe('TC-FLV-53 — 状態復元・保存（FR-FLV-26 webview 端）', () => {

    test('savedExpanded 受信で lazy 展開・トグルで debounce 保存・全部畳むと空配列', async ({ page }) => {
        await loadViewInitKeepCalls(page);
        await page.evaluate(() => { (window as any).__calls = []; });
        // savedExpanded 付き root listResult → dirA が展開扱いになり子 list 要求が飛ぶ
        await page.evaluate(() => {
            window.postMessage({
                type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '',
                entries: [{ name: 'dirA', relPath: 'dirA', isDir: true }, { name: 'f.txt', relPath: 'f.txt', isDir: false }],
                savedExpanded: ['dirA'],
            }, '*');
        });
        await page.waitForTimeout(80);
        expect((await calls(page)).some((x: any) => x.type === 'folderViewList' && x.args[1] === 'dirA'), '復元 = lazy 展開の list 要求').toBe(true);
        await postList(page, 'dirA', [{ name: 'c.txt', relPath: 'dirA/c.txt', isDir: false }]);
        expect(await rowNames(page)).toEqual(['dirA', 'c.txt', 'f.txt']);

        // 開閉トグル → debounce 後 folderViewStateSave（畳む = 空配列）
        await page.evaluate(() => { (window as any).__calls = []; });
        await page.dblclick('.fv-row[data-rel="dirA"]');
        await page.waitForTimeout(450);
        const saves = (await calls(page)).filter((x: any) => x.type === 'folderViewStateSave');
        expect(saves.length, 'トグルで保存').toBeGreaterThan(0);
        expect(saves[saves.length - 1].args).toEqual(['fl1', []]);
        // 再展開 → ['dirA']
        await page.dblclick('.fv-row[data-rel="dirA"]');
        await page.waitForTimeout(450);
        const saves2 = (await calls(page)).filter((x: any) => x.type === 'folderViewStateSave');
        expect(saves2[saves2.length - 1].args).toEqual(['fl1', ['dirA']]);
    });
});

test.describe('TC-FLV-54 — list エラースコープ（FR-FLV-30）', () => {

    test('root エラー = 全体表示 / 子エラー = ツリー保持・局所掃除・stateSave から除去（counterfactual: スコープ分岐なしだと全体が消えて RED）', async ({ page }) => {
        await loadViewInitKeepCalls(page);
        await postList(page, '', [
            { name: 'dirA', relPath: 'dirA', isDir: true },
            { name: 'keep.txt', relPath: 'keep.txt', isDir: false },
        ]);
        await page.dblclick('.fv-row[data-rel="dirA"]');
        await postList(page, 'dirA', [{ name: 'c.txt', relPath: 'dirA/c.txt', isDir: false }]);
        expect(await rowNames(page)).toEqual(['dirA', 'c.txt', 'keep.txt']);

        // 子エラー（dirA 消滅）→ ツリーは保たれ dirA が畳まれ・親（root）再 list・stateSave に dirA を含まない
        await page.evaluate(() => { (window as any).__calls = []; });
        await page.evaluate(() => {
            window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: 'dirA', entries: [], error: 'read' }, '*');
        });
        await page.waitForTimeout(450);
        expect((await rowNames(page)).includes('keep.txt'), 'ツリー全体は破棄されない').toBe(true);
        expect((await rowNames(page)).includes('c.txt'), '該当ノードは畳まれる').toBe(false);
        const c = await calls(page);
        expect(c.some((x: any) => x.type === 'folderViewList' && x.args[1] === ''), '親階層の再 list').toBe(true);
        const saves = c.filter((x: any) => x.type === 'folderViewStateSave');
        if (saves.length > 0) {
            expect(saves[saves.length - 1].args[1].includes('dirA'), 'stateSave から除去').toBe(false);
        }

        // root エラー → 全体エラー表示（従来）
        await page.evaluate(() => {
            window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries: [], error: 'broken' }, '*');
        });
        await page.waitForTimeout(80);
        expect(await page.locator('.fv-note').count(), 'root エラーは全体表示').toBeGreaterThan(0);
        expect(await page.locator('.fv-row').count()).toBe(0);
    });
});

test.describe('TC-FLV-55 — インライン rename（FR-FLV-28 webview 端）', () => {

    async function setupRows(page: Page): Promise<void> {
        await loadViewInitKeepCalls(page);
        await postList(page, '', [
            { name: 'dirA', relPath: 'dirA', isDir: true },
            { name: 'a.txt', relPath: 'a.txt', isDir: false },
        ]);
        await page.click('.fv-row[data-rel="a.txt"]');
        await page.focus('.fv-tree');
    }

    test('Enter → input 化・確定で folderViewRename(newName)・Escape 復元・IME ガード・再描画 defer', async ({ page }) => {
        await setupRows(page);
        // ① Enter で input 化（全選択）
        await page.keyboard.press('Enter');
        expect(await page.locator('.fv-rename-input').count(), 'インライン input 出現').toBe(1);
        expect(await page.evaluate(() => (document.querySelector('.fv-rename-input') as HTMLInputElement).value)).toBe('a.txt');

        // ⑤ rename 中の listResult 受信で input が破棄されない（defer）
        await page.evaluate(() => {
            window.postMessage({
                type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '',
                entries: [{ name: 'dirA', relPath: 'dirA', isDir: true }, { name: 'a.txt', relPath: 'a.txt', isDir: false }],
            }, '*');
        });
        await page.waitForTimeout(80);
        expect(await page.locator('.fv-rename-input').count(), 'defer — input 生存').toBe(1);

        // ④ 確定 → bridge folderViewRename(id, rel, newName)・done フラグで 1 回のみ
        await page.evaluate(() => {
            const inp = document.querySelector('.fv-rename-input') as HTMLInputElement;
            inp.value = 'renamed.txt';
        });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(80);
        const renames = (await calls(page)).filter((x: any) => x.type === 'folderViewRename');
        expect(renames.length).toBe(1);
        expect(renames[0].args).toEqual(['fl1', 'a.txt', 'renamed.txt']);
        expect(await page.locator('.fv-rename-input').count(), '確定で input 終了').toBe(0);

        // ③ Escape = 原状復元・bridge 不発
        await page.evaluate(() => { (window as any).__calls = []; });
        await page.click('.fv-row[data-rel="dirA"]');
        await page.focus('.fv-tree');
        await page.keyboard.press('Enter');
        expect(await page.locator('.fv-rename-input').count()).toBe(1);
        await page.keyboard.press('Escape');
        expect(await page.locator('.fv-rename-input').count()).toBe(0);
        expect((await calls(page)).filter((x: any) => x.type === 'folderViewRename').length, 'Escape で不発').toBe(0);
        expect(await rowNames(page), 'DOM 原状復元').toContain('dirA');

        // ② IME 変換中の Enter では発火しない（isComposing counterfactual — rename-ime.spec 裁定済み例外）
        await page.evaluate(() => {
            const tree = document.querySelector('.fv-tree') as HTMLElement;
            const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'isComposing', { value: true });
            tree.dispatchEvent(ev);
        });
        expect(await page.locator('.fv-rename-input').count(), 'IME 中は rename 開始しない').toBe(0);

        // cmd+enter は open のまま（rename と衝突しない）
        await page.evaluate(() => { (window as any).__calls = []; });
        await page.click('.fv-row[data-rel="a.txt"]');
        await page.focus('.fv-tree');
        await page.keyboard.press('Meta+Enter');
        expect((await calls(page)).some((x: any) => x.type === 'folderViewOpen')).toBe(true);
        expect(await page.locator('.fv-rename-input').count()).toBe(0);
    });

    test('context menu の Rename も同方式（インライン input・ポップアップ廃止）', async ({ page }) => {
        await setupRows(page);
        await page.click('.fv-row[data-rel="a.txt"]', { button: 'right' });
        await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('.fv-menu .fv-menu-item'));
            (els.find((e) => (e.textContent || '').trim() === 'Rename') as HTMLElement).click();
        });
        expect(await page.locator('.fv-rename-input').count(), 'menu Rename もインライン').toBe(1);
        expect((await calls(page)).filter((x: any) => x.type === 'folderViewRename').length, '開いただけでは bridge 不発').toBe(0);
    });
});

// TC-FLV-57 はトークンが揃う standalone-notes ハーネスで検証（NFR-FLV-08）
test.describe('TC-FLV-57 — デザイン統一（NFR-FLV-08 / standalone-notes）', () => {

    test('背景・選択行・Search box・chevron・行アイコンが Outliner 統一先と同値 + 色直書き 0', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__folderViewDispatcher && (window as any).__testApi);
        await page.evaluate(() => {
            (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs');
            window.postMessage({
                type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '',
                entries: [
                    { name: 'dirA', relPath: 'dirA', isDir: true },
                    { name: 'b.md', relPath: 'b.md', isDir: false },
                    { name: 'c.txt', relPath: 'c.txt', isDir: false },
                ],
            }, '*');
        });
        await page.waitForSelector('.fv-row[data-rel="b.md"]', { timeout: 5000 });

        const styles = await page.evaluate(() => {
            const probe = (bg: string) => {
                const d = document.createElement('div');
                d.style.background = bg;
                document.body.appendChild(d);
                const v = getComputedStyle(d).backgroundColor;
                d.remove();
                return v;
            };
            const cont = document.getElementById('folderViewContainer')!;
            const search = document.querySelector('.fv-search') as HTMLElement;
            document.querySelector('.fv-row[data-rel="b.md"]')!.classList.add('fv-selected');
            const sel = document.querySelector('.fv-row.fv-selected') as HTMLElement;
            return {
                contBg: getComputedStyle(cont).backgroundColor,
                outlinerBg: probe('var(--outliner-bg)'),
                selBg: getComputedStyle(sel).backgroundColor,
                selectionToken: probe('var(--fr-color-selection-bg)'),
                searchBg: getComputedStyle(search).backgroundColor,
                searchToken: probe('var(--outliner-search-bg)'),
                searchFont: getComputedStyle(search).fontSize,
                searchRadius: getComputedStyle(search).borderRadius,
            };
        });
        // ① 背景 = outliner 面と同一トークン
        expect(styles.contBg, '背景がトークン解決値と同一（白直書きでない）').toBe(styles.outlinerBg);
        // ② 選択行 = outliner 選択色トークン
        expect(styles.selBg).toBe(styles.selectionToken);
        // ③ Search box = outliner 検索ボックスと同トークン・同メトリクス
        expect(styles.searchBg).toBe(styles.searchToken);
        expect(styles.searchFont).toBe('12px');
        expect(styles.searchRadius).toBe('5px');
        // ④ chevron: テキスト '▾▸' が存在しない + 折りたたみ dir は CSS 三角（border-left 5px）
        const chev = await page.evaluate(() => {
            const treeHtml = (document.querySelector('.fv-tree') as HTMLElement).innerHTML;
            const dirChev = document.querySelector('.fv-row[data-rel="dirA"] .fv-chevron .fv-tri') as HTMLElement;
            const cs = dirChev ? getComputedStyle(dirChev) : ({ borderLeftWidth: '(no .fv-tri)' } as any);
            return { hasTextChevron: treeHtml.includes('▾') || treeHtml.includes('▸'), borderLeft: cs.borderLeftWidth };
        });
        expect(chev.hasTextChevron, "テキスト '▾▸' 廃止").toBe(false);
        expect(chev.borderLeft, '折りたたみ = outliner bullet と同じ 5px CSS 三角').toBe('5px');
        // ⑥ md / file 行アイコン（ユーザー指定 2026-08-18: md=📄 / 他=📎）
        expect(await page.evaluate(() => document.querySelector('.fv-row[data-rel="b.md"] .fv-file-icon')?.textContent)).toBe('📄');
        expect(await page.evaluate(() => document.querySelector('.fv-row[data-rel="c.txt"] .fv-file-icon')?.textContent)).toBe('📎');
        // Search box 幅 = outliner wrapper と同じ 225px 固定（focus で拡張）
        expect(await page.evaluate(() => getComputedStyle(document.querySelector('.fv-search') as HTMLElement).width)).toBe('225px');
    });

    test('⑤ 色の直書き（hex / rgba fallback）が notes-folder-view.js に無い（grep 番人）', () => {
        const src = fsNode.readFileSync(pathNode.join(ROOT2, 'src/shared/notes-folder-view.js'), 'utf8');
        // HTML entity（&#10227; 等）は色でないため除外（lookbehind で & 直後の # を無視）
        const colorLiterals = src.match(/(?<!&)#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || [];
        expect(colorLiterals, `独自色直書き: ${JSON.stringify(colorLiterals.slice(0, 5))}`).toEqual([]);
    });
});

// ── TC-FLV-61 webview 面（TASK-22 / FR-FLV-29）: sidepanel 🔗 バッジ ──

test.describe('TC-FLV-61 — sidepanel md の 🔗 バッジ（webview 面 / standalone-notes）', () => {

    test('linkedFolderTitle 付き openSidePanel でバッジ表示・無しで非表示（stale 除去）', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        // linkedFolderTitle 付き → 🔗 + title のバッジが filename 近傍に出る
        await page.evaluate(() => {
            window.postMessage({
                type: 'openSidePanel', markdown: '# x', filePath: '/linked/doc.md', fileName: 'doc.md',
                toc: [], documentBaseUri: '', linkedFolderTitle: '資料',
            }, '*');
        });
        await page.waitForTimeout(100);
        const badge = page.locator('.side-panel-linkedfolder-badge');
        expect(await badge.count(), 'バッジ表示').toBe(1);
        expect((await badge.textContent()) || '').toContain('資料');
        // 絶対パスがバッジに漏れない（INV-4）
        expect((await badge.textContent()) || '').not.toContain('/linked');

        // linkedFolderTitle 無し（note md）→ バッジ除去（stale を残さない）
        await page.evaluate(() => {
            window.postMessage({
                type: 'openSidePanel', markdown: '# y', filePath: '/note/n.md', fileName: 'n.md',
                toc: [], documentBaseUri: '',
            }, '*');
        });
        await page.waitForTimeout(100);
        expect(await page.locator('.side-panel-linkedfolder-badge').count(), 'note md では非表示').toBe(0);
    });

    test('本番 inline + ハーネス build の 3 点登録（新規モジュールの配線番人 — generator_failures 2026-08-17）', () => {
        const wc = fsNode.readFileSync(pathNode.join(ROOT2, 'src/notesWebviewContent.ts'), 'utf8');
        expect(wc.includes('notes-folder-sidepanel-badge.js'), '本番 inline 登録').toBe(true);
        const build = fsNode.readFileSync(pathNode.join(ROOT2, 'test/build-standalone-notes.js'), 'utf8');
        expect(build.includes('notes-folder-sidepanel-badge.js'), 'ハーネス build 登録').toBe(true);
    });
});


// ── 2026-08-18 即時修正: md Outline sidebar の pdfjs css 衝突回帰の番人 ──
test.describe('md Outline sidebar × pdf_viewer.css 衝突（回帰 pin）', () => {

    test('#sidebar の背景が --sidebar-bg（md 背景系）で、pdfjs の白/角丸/影に乗っ取られない', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate(() => { (window as any).__testApi.mdDispatcher.loadMarkdown('# t', '/x/a.md', ''); });
        await page.waitForSelector('.markdown-container #sidebar', { state: 'attached', timeout: 5000 }); // 既定は .hidden（Outline 閉）— computed style は取得できる
        const info = await page.evaluate(() => {
            const sb = document.querySelector('.markdown-container #sidebar') as HTMLElement;
            const cs = getComputedStyle(sb);
            const probe = (v: string) => { const d = document.createElement('div'); d.style.background = v; document.body.appendChild(d); const r = getComputedStyle(d).backgroundColor; d.remove(); return r; };
            return { bg: cs.backgroundColor, want: probe('var(--sidebar-bg)'), radius: cs.borderRadius, shadow: cs.boxShadow };
        });
        expect(info.bg, 'pdfjs の #fff でなく --sidebar-bg（counterfactual: 打ち消し css を外すと白で RED）').toBe(info.want);
        expect(info.radius).toBe('0px');
        expect(info.shadow).toBe('none');
    });
});
