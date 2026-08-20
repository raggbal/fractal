/**
 * Sprint 20260817-053313-notetree-local-folder-view — WV-TREE（TASK-06）
 * Notes 左ツリー panel の folder link（kind:'folder'）配線。対象: src/shared/notes-file-panel.js。
 *
 * ハーネス: about:blank + setContent(notes-body-html の panel HTML) + addScriptTag(現ソース) +
 * spy bridge（notetree-file-panel.spec.ts の確立パターン）。
 * dispatcher / tab manager は**明示メソッド stub**（Proxy 禁止 — typeof ガードの欠落検出のため）。
 *
 * TC-FLV-30: folder item 描画（アイコン/class/broken 表示）・click=showFolderView・broken click=relink・
 *            pointerup 保険・explore filter の title マッチ + [folder] バッジ
 * TC-FLV-31: +folder ボタン → bridge.addFolderLink
 * TC-FLV-32: context menu 全列挙（表示 8 + 共通 3 / 非表示 5 系）+ 各項目の bridge 送出
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const PANEL_JS = fs.readFileSync(
    path.join(__dirname, '../../src/shared/notes-file-panel.js'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateNotesFilePanelHtml } = require('../../src/shared/notes-body-html.js');
const PANEL = generateNotesFilePanelHtml({ collapsed: false, messages: {} });

async function loadPanel(page: Page, opts: { fileList: any[]; structure: any }): Promise<void> {
    await page.goto('about:blank');
    await page.setContent(
        '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<style>' + PANEL.css + '</style>' +
        '<style>.file-panel-item{min-height:22px;}</style>' +
        '</head><body>' + PANEL.html + '</body></html>');
    await page.evaluate(() => {
        const w = window as any;
        w.__outlinerMessages = {};
        w.__calls = [];
        // 明示メソッド stub（folder view dispatcher / tab manager）
        w.__dispatcherCalls = [];
        w.__folderViewDispatcher = {
            showFolderView: (folderLinkId: string, title: string) => {
                w.__dispatcherCalls.push({ folderLinkId, title });
            },
        };
        w.__tabCalls = [];
        w.__notesTabManager = {
            openInNewTab: (fileKey: string, kind: string, title: string) => {
                w.__tabCalls.push({ fileKey, kind, title });
            },
        };
        w.__makeBridge = function () {
            const rec = (type: string) => function () {
                const args = Array.prototype.slice.call(arguments);
                w.__calls.push({ type, args });
                if (type === 'onSearchStart') w.__onSearchStart = args[0]; // panel 登録の検索 cb を捕捉
            };
            return new Proxy({}, {
                get(_t, prop) {
                    if (typeof prop !== 'string') return undefined;
                    return rec(prop);
                },
            });
        };
    });
    await page.addScriptTag({ content: PANEL_JS });
    await page.evaluate((o) => {
        const w = window as any;
        w.notesFilePanel.init(w.__makeBridge(), o.fileList, null, o.structure, null, 'MyNote');
        w.__calls = [];
    }, opts as any);
}

function folderFixture(broken = false) {
    return {
        fileList: [
            { id: 'fl1', filePath: '', title: 'Docs', kind: 'folder', broken },
            { id: 'o1', filePath: '/n/plan.out', title: 'Plan', kind: 'out' },
        ],
        structure: {
            version: 1, rootIds: ['fl1', 'o1'],
            items: {
                fl1: { type: 'file', id: 'fl1', title: 'Docs', ext: 'folder', broken },
                o1: { type: 'file', id: 'o1', title: 'Plan' },
            },
        },
    };
}

test.describe('TASK-06 — folder link tree panel（notes-file-panel.js）', () => {

    test('TC-FLV-30: folder item 描画・click=showFolderView・broken=リンク切れ表示+relink・pointerup 保険・explore [folder]', async ({ page }) => {
        await loadPanel(page, folderFixture(false));

        // 描画: kind='folder' → is-folder / フォルダアイコン / is-attach・is-md でない
        const r = await page.evaluate(() => {
            const el = document.querySelector('[data-item-id="fl1"]') as HTMLElement;
            return {
                exists: !!el,
                fileExt: el?.dataset.fileExt,
                isFolder: el?.classList.contains('is-folder-link'),
                isAttach: el?.classList.contains('is-attach'),
                isMd: el?.classList.contains('is-md'),
                isBroken: el?.classList.contains('is-broken'),
                hasFolderIcon: !!el?.querySelector('svg.file-panel-folderlink-icon'),
            };
        });
        expect(r.exists).toBe(true);
        expect(r.fileExt).toBe('folder');
        expect(r.isFolder).toBe(true);
        expect(r.isAttach).toBe(false);
        expect(r.isMd).toBe(false);
        expect(r.isBroken).toBe(false);
        expect(r.hasFolderIcon).toBe(true);

        // click → __folderViewDispatcher.showFolderView（bridge.openFile は不発）
        await page.click('[data-item-id="fl1"]');
        const afterClick = await page.evaluate(() => ({
            disp: (window as any).__dispatcherCalls,
            calls: (window as any).__calls.map((c: any) => c.type),
        }));
        expect(afterClick.disp.length).toBeGreaterThanOrEqual(1);
        expect(afterClick.disp[0]).toEqual({ folderLinkId: 'fl1', title: 'Docs' });
        expect(afterClick.calls).not.toContain('openFile');
        expect(afterClick.calls).not.toContain('openFileInTab');

        // pointerup 保険経路（D&D 直後の click 合成不発対策）: pointer イベントのみで発火
        await page.evaluate(() => {
            const w = window as any;
            w.__dispatcherCalls = [];
            const el = document.querySelector('[data-item-id="fl1"]') as HTMLElement;
            el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
            el.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
        });
        const afterPointer = await page.evaluate(() => (window as any).__dispatcherCalls);
        expect(afterPointer.length).toBeGreaterThanOrEqual(1);
        expect(afterPointer[0].folderLinkId).toBe('fl1');

        // explore filter: title マッチ + [folder] バッジ（filePath が空でも title で当たる）
        const explore = await page.evaluate(() => {
            const input = document.getElementById('notesSearchInput') as HTMLInputElement;
            input.value = 'Docs';
            (window as any).__onSearchStart(1); // panel が bridge.onSearchStart(cb) で登録した cb（既存 TC-WV-06 パターン）
            const matches = Array.from(document.querySelectorAll('#notesSearchResults .file-panel-search-match'));
            return matches.map((m) => (m.textContent || '').trim());
        });
        expect(explore.some((t) => t.includes('Docs') && t.includes('[folder]'))).toBe(true);

        // broken 表示 + broken click → relinkFolderLink（dispatcher 不発）
        await loadPanel(page, folderFixture(true));
        const rb = await page.evaluate(() => {
            const el = document.querySelector('[data-item-id="fl1"]') as HTMLElement;
            return { isBroken: el?.classList.contains('is-broken') };
        });
        expect(rb.isBroken).toBe(true);
        await page.click('[data-item-id="fl1"]');
        const afterBrokenClick = await page.evaluate(() => ({
            disp: (window as any).__dispatcherCalls,
            calls: (window as any).__calls,
        }));
        expect(afterBrokenClick.disp).toHaveLength(0);
        expect(afterBrokenClick.calls.some((c: any) => c.type === 'relinkFolderLink' && c.args[0] === 'fl1')).toBe(true);
    });

    test('TC-FLV-31: ヘッダ +folder ボタン → bridge.addFolderLink', async ({ page }) => {
        await loadPanel(page, folderFixture(false));
        const hasBtn = await page.evaluate(() => !!document.getElementById('filePanelAddFolderLink'));
        expect(hasBtn).toBe(true);
        await page.click('#filePanelAddFolderLink');
        const calls = await page.evaluate(() => (window as any).__calls);
        expect(calls.some((c: any) => c.type === 'addFolderLink')).toBe(true);
    });

    test('TC-FLV-32: context menu 全列挙（表示 8 + 共通 3 / 非表示 5 系）+ bridge 送出', async ({ page }) => {
        await loadPanel(page, folderFixture(false));
        const menuTexts = async () => page.evaluate(() => {
            return Array.from(document.querySelectorAll('.file-panel-context-menu .file-panel-context-item'))
                .map((el) => (el.textContent || '').trim());
        });
        const openMenu = async () => {
            await page.click('[data-item-id="fl1"]', { button: 'right' });
        };
        await openMenu();
        const items = await menuTexts();

        // 表示 8 項目（requirement FR-FLV-06 表が唯一の正）
        for (const label of ['Open', 'Open in new tab', 'Rename', 'Re-link', 'Reveal in Finder', 'Copy Path', 'Set Color', 'Remove Link']) {
            expect(items.some((t) => t === label || t.startsWith(label)), `表示: ${label}`).toBe(true);
        }
        // 共通 3 項目は従来どおり表示
        for (const label of ['New Outline here', 'New Markdown here', 'New Subfolder']) {
            expect(items.some((t) => t.includes(label)), `共通: ${label}`).toBe(true);
        }
        // 非表示 5 系（not.toContain — Delete は Remove Link と別物として不在）
        for (const label of ['Favorite', 'Move Other Note', 'Copy In-App Link', 'Open in Standalone']) {
            expect(items.some((t) => t.includes(label)), `非表示: ${label}`).toBe(false);
        }
        expect(items.some((t) => t === 'Delete'), '非表示: Delete').toBe(false);

        // 各項目 click → 対応 bridge / tab manager 送出
        const clickMenu = async (label: string) => {
            await openMenu();
            await page.evaluate((lbl) => {
                const els = Array.from(document.querySelectorAll('.file-panel-context-menu .file-panel-context-item'));
                const el = els.find((e) => (e.textContent || '').trim() === lbl || (e.textContent || '').trim().startsWith(lbl));
                (el as HTMLElement).click();
            }, label);
        };
        await clickMenu('Open in new tab');
        let state = await page.evaluate(() => ({ tabs: (window as any).__tabCalls, calls: (window as any).__calls }));
        expect(state.tabs.some((t: any) => t.fileKey === 'fl1' && t.kind === 'folder' && t.title === 'Docs')).toBe(true);

        await clickMenu('Re-link');
        await clickMenu('Reveal in Finder');
        await clickMenu('Copy Path');
        await clickMenu('Remove Link');
        await clickMenu('Rename');
        state = await page.evaluate(() => ({ tabs: (window as any).__tabCalls, calls: (window as any).__calls }));
        const has = (type: string) => state.calls.some((c: any) => c.type === type && c.args[0] === 'fl1');
        expect(has('relinkFolderLink')).toBe(true);
        expect(has('revealFolderLink')).toBe(true);
        expect(has('copyFolderLinkPath')).toBe(true);
        expect(has('removeFolderLink')).toBe(true);
        expect(has('renameFolderLink')).toBe(true);
        // Open（メニュー）→ dispatcher
        await clickMenu('Open');
        const disp = await page.evaluate(() => (window as any).__dispatcherCalls);
        expect(disp.some((d: any) => d.folderLinkId === 'fl1')).toBe(true);
    });
});

// ── TC-FLV-63（TASK-21 / 再オープン① FR-FLV-01/03 改訂）: +linkfd ラベル / 🔗 アイコン ──

test.describe('TC-FLV-63 — ラベル・アイコン変更', () => {

    test('追加ボタンが「+linkfd」・folder link アイコンが通常フォルダと非同一の 🔗 SVG', async ({ page }) => {
        await loadPanel(page, folderFixture());
        // ① ボタンラベル = +linkfd（'+folder' は DOM に無い）
        const btnText = await page.evaluate(() =>
            (document.getElementById('filePanelAddFolderLink') as HTMLElement)?.textContent?.trim());
        expect(btnText).toBe('+linkfd');
        expect(await page.evaluate(() => document.body.innerHTML.includes('+folder')), "'+folder' 表記が残っていない").toBe(false);
        // ② folder link 行のアイコン = 🔗 チェーンリンク（通常 tree フォルダの SVG path と非同一）
        const paths = await page.evaluate(() => {
            const linkIcon = document.querySelector('.file-panel-item.is-folder-link svg.file-panel-folderlink-icon path, .file-panel-item.is-folder-link svg.file-panel-folderlink-icon');
            const folderIconPathD = 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';
            const html = (document.querySelector('.file-panel-item.is-folder-link svg.file-panel-folderlink-icon') as HTMLElement)?.outerHTML || '';
            return { present: !!linkIcon, isFolderShape: html.includes(folderIconPathD), html: html.slice(0, 80) };
        });
        expect(paths.present, 'アイコンが存在').toBe(true);
        expect(paths.isFolderShape, 'フォルダ形 path を使っていない（🔗 に差し替え済み）').toBe(false);
    });
});
