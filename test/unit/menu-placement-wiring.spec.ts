/**
 * TASK-01 / FR-MFIT-02 / FR-MFIT-03 / NFR-MFIT-02
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / ADRL-0109）
 *
 * メニュー配置の共有ヘルパ（src/shared/menu-placement.js）の単体検証と、
 * 本番 webview への inline 登録（4 点登録のうち本番 2 本）の契約検証。
 *
 * - TC-MFIT-15: 収まる長さのメニューにスクロールバーを出さない
 * - TC-MFIT-16: 本番 HTML 生成関数が window.__menuPlacement を inline している（両 provider）
 * - TC-MFIT-17: 衝突補正後に clientX/clientY を書き戻さない（2 回呼んで同じ位置）
 *
 * 番人の形（design/tdd.md）: source 文字列の toContain による pin は使わず、
 * 実際に place() を走らせて rect と style を実測する。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const MODULE_PATH = path.join(ROOT, 'src', 'shared', 'menu-placement.js');

/** menu-placement.js を素の DOM に載せた最小ハーネスを作る。 */
async function loadHarness(page: import('@playwright/test').Page, opts: {
    viewport: { width: number; height: number };
    itemCount: number;
}) {
    await page.setViewportSize(opts.viewport);
    const src = fs.readFileSync(MODULE_PATH, 'utf8');
    await page.setContent(`<!DOCTYPE html><html><head><style>
      #menu { position: fixed; min-width: 126px; background: #fff; border: 1px solid #ccc; }
      #menu .item { height: 20px; line-height: 20px; padding: 0 8px; white-space: nowrap; }
    </style></head><body>
      <div id="menu">${'<div class="item">Item</div>'.repeat(opts.itemCount)}</div>
    </body></html>`);
    await page.addScriptTag({ content: src });
    await page.waitForFunction(() => !!(window as any).__menuPlacement);
}

test.describe('menu-placement — place() の挙動', () => {
    test('TC-MFIT-15 収まる長さのメニューにスクロールバーが出ない', async ({ page }) => {
        // viewport 400x300 に対し 5 項目（約 100px）= 収まる
        await loadHarness(page, { viewport: { width: 400, height: 300 }, itemCount: 5 });

        const result = await page.evaluate(() => {
            const menu = document.getElementById('menu')!;
            // place() 前の素の高さ（切り詰められていないことの基準）
            const naturalHeight = menu.getBoundingClientRect().height;
            (window as any).__menuPlacement.place(menu, { x: 10, y: 10 });
            const r = menu.getBoundingClientRect();
            return {
                maxHeight: menu.style.maxHeight,
                overflowY: menu.style.overflowY,
                naturalHeight,
                placedHeight: r.height,
                bottom: r.bottom,
                vh: window.innerHeight,
                visibility: menu.style.visibility,
            };
        });

        // max-height は上限としてのみ働く = 収まる場合は設定されない
        expect(result.maxHeight).toBe('');
        expect(result.overflowY).toBe('');
        // 挙動の帰結: 収まるメニューは切り詰められず全高が viewport 内に収まる
        // （`scrollHeight <= clientHeight` では測れない — overflow が visible なら
        //   scrollHeight が超えていてもスクロールバーは出ないため）
        expect(result.placedHeight).toBeCloseTo(result.naturalHeight, 1);
        expect(result.bottom).toBeLessThanOrEqual(result.vh);
        // 測定用の visibility:hidden が残っていない（メニューが見えなくなる事故の防止）
        expect(result.visibility).not.toBe('hidden');
    });

    test('TC-MFIT-17 衝突補正後に clientX/clientY を書き戻さない（2 回呼んで同位置）', async ({ page }) => {
        // 右下隅で開き flip + clamp を確実に発火させる
        await loadHarness(page, { viewport: { width: 400, height: 300 }, itemCount: 6 });

        const result = await page.evaluate(() => {
            const menu = document.getElementById('menu')!;
            // 同一の at オブジェクトを 2 回渡す（実装が at を書き換えると 2 回目がずれる）
            const at = { x: 395, y: 295 };
            (window as any).__menuPlacement.place(menu, at);
            const first = { left: menu.style.left, top: menu.style.top };
            const atAfterFirst = { x: at.x, y: at.y };
            (window as any).__menuPlacement.place(menu, at);
            const second = { left: menu.style.left, top: menu.style.top };
            return { first, second, atAfterFirst, atOriginal: { x: 395, y: 295 } };
        });

        expect(result.second).toEqual(result.first);
        // at 自体が書き換わっていない
        expect(result.atAfterFirst).toEqual(result.atOriginal);
    });

    test('TC-MFIT-08 相当（helper 単体）: tall menu で top が負値にならず scroll 可能', async ({ page }) => {
        // viewport 300px に対し 40 項目（約 800px）= 入らない
        await loadHarness(page, { viewport: { width: 400, height: 300 }, itemCount: 40 });

        const result = await page.evaluate(() => {
            const menu = document.getElementById('menu')!;
            (window as any).__menuPlacement.place(menu, { x: 395, y: 295 });
            const r = menu.getBoundingClientRect();
            return {
                top: r.top, left: r.left, right: r.right, bottom: r.bottom,
                vw: window.innerWidth, vh: window.innerHeight,
                overflowY: menu.style.overflowY,
                maxHeight: menu.style.maxHeight,
                canScroll: menu.scrollHeight > menu.clientHeight,
            };
        });

        // 4 辺すべて viewport 内（counterfactual: clamp を外すと top が負値で RED）
        expect(result.top).toBeGreaterThanOrEqual(0);
        expect(result.left).toBeGreaterThanOrEqual(0);
        expect(result.right).toBeLessThanOrEqual(result.vw);
        expect(result.bottom).toBeLessThanOrEqual(result.vh);
        // 入らない高さは scroll で全項目に到達できる
        expect(result.overflowY).toBe('auto');
        expect(result.maxHeight).not.toBe('');
        expect(result.canScroll).toBe(true);
    });

    test('TC-MFIT-01 相当（helper 単体）: viewport より広いメニューでも left が負値にならない', async ({ page }) => {
        // 縦方向の負値は max-height に吸収されるためガードを判別できない。
        // 横方向は max-width の上限が無いので、ここで clamp の Math.max(gap, …) が実際に効く。
        // （i18n で項目幅が伸びた長いラベルの実ケース。counterfactual = ガードを外すと left < 0 で RED）
        await page.setViewportSize({ width: 400, height: 300 });
        await page.setContent(`<!DOCTYPE html><html><head><style>
          #menu { position: fixed; background: #fff; }
          #menu .item { height: 20px; white-space: nowrap; }
        </style></head><body>
          <div id="menu"><div class="item">${'とても長いメニュー項目のラベル'.repeat(6)}</div></div>
        </body></html>`);
        await page.addScriptTag({ content: fs.readFileSync(MODULE_PATH, 'utf8') });
        await page.waitForFunction(() => !!(window as any).__menuPlacement);

        const result = await page.evaluate(() => {
            const menu = document.getElementById('menu')!;
            const natural = menu.getBoundingClientRect();
            (window as any).__menuPlacement.place(menu, { x: 395, y: 150 });
            const r = menu.getBoundingClientRect();
            return { left: r.left, naturalWidth: natural.width, vw: window.innerWidth };
        });

        // 前提: メニュー幅が viewport 幅を超えている（超えていないとこの TC は何も検証しない）
        expect(result.naturalWidth).toBeGreaterThan(result.vw);
        // ガードが効いていれば left は gap 以上に留まる
        expect(result.left).toBeGreaterThanOrEqual(0);
    });
});

test.describe('menu-placement — 本番 webview への inline 登録（NFR-MFIT-02）', () => {
    test('TC-MFIT-16 notesWebviewContent / outlinerWebviewContent の生成 HTML に定義マーカーが含まれる', () => {
        // 本番 HTML 生成関数を require して生成物を検査する。
        // Module._load stub + require の spec なので require 前 purge / finally purge を対で行う
        // （generator_failures 2026-08-17: 先行 spec の残置 cache を掴むと自分の stub が効かない）。
        const Module = require('module');
        const SRC_PREFIX = path.join(ROOT, 'src') + path.sep;
        const origLoad = (Module as any)._load;

        const purge = () => {
            for (const k of Object.keys(require.cache)) {
                if (k.startsWith(SRC_PREFIX)) { delete require.cache[k]; }
            }
        };

        const vscodeStub: any = {
            Uri: {
                file: (p: string) => ({ fsPath: p, scheme: 'file', path: p, toString: () => 'file://' + p }),
                joinPath: (base: any, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }),
            },
            env: { openExternal: () => Promise.resolve(true), language: 'en' },
            workspace: { getConfiguration: () => ({ get: () => undefined }) },
            window: {},
            ExtensionMode: { Production: 1, Development: 2, Test: 3 },
        };

        purge();
        (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
            if (request === 'vscode') { return vscodeStub; }
            return origLoad.apply(this, [request, parent, isMain]);
        };

        try {
            const notes = require(path.join(ROOT, 'src', 'notesWebviewContent'));
            const outliner = require(path.join(ROOT, 'src', 'outlinerWebviewContent'));
            // standalone md editor 面（webviewContent.ts）も本番 inline の対象。
            // TASK-06..09 の実装中に登録漏れが実測で判明した（TC-MFIT-03 が hasHelper=undefined で RED）
            // → 4 点登録ではなく **6 点登録**（本番 3 + ハーネス 3）が正。
            const editor = require(path.join(ROOT, 'src', 'webviewContent'));

            // 実シグネチャで名指し呼び出しする（推測ベースの候補試行はしない）:
            //   getNotesWebviewContent(webview, extensionUri, config, initData)
            //   getOutlinerWebviewContent(webview, extensionUri, jsonContent, config, outFileKey?)
            const webviewStub = {
                cspSource: 'vscode-webview://test',
                asWebviewUri: (u: any) => ({ toString: () => 'vscode-webview://res' + (u?.fsPath || '') }),
            } as any;
            const extUri = { fsPath: ROOT, scheme: 'file', path: ROOT, toString: () => 'file://' + ROOT } as any;
            const config = { theme: 'light', fontSize: 14, webviewMessages: {} };

            const notesHtml: string = notes.getNotesWebviewContent(webviewStub, extUri, config, {
                jsonContent: '{"rootIds":[],"nodes":{}}',
                fileList: [],
                currentFilePath: null,
                panelCollapsed: false,
            });
            const outlinerHtml: string = outliner.getOutlinerWebviewContent(
                webviewStub, extUri, '{"rootIds":[],"nodes":{}}', config
            );

            expect(typeof notesHtml).toBe('string');
            expect(notesHtml.length).toBeGreaterThan(0);
            expect(typeof outlinerHtml).toBe('string');
            expect(outlinerHtml.length).toBeGreaterThan(0);

            // 定義マーカー: モジュールが公開する window.__menuPlacement の代入
            // （counterfactual: どちらかの inline 登録を外すと RED）
            expect(notesHtml, 'notesWebviewContent に menu-placement が inline されていない')
                .toContain('window.__menuPlacement');
            expect(outlinerHtml, 'outlinerWebviewContent に menu-placement が inline されていない')
                .toContain('window.__menuPlacement');

            const editorHtml: string = editor.getWebviewContent(webviewStub, extUri, '# md\n', config);
            expect(typeof editorHtml).toBe('string');
            expect(editorHtml, 'webviewContent（standalone md editor）に menu-placement が inline されていない')
                .toContain('window.__menuPlacement');
        } finally {
            (Module as any)._load = origLoad;
            purge();
        }
    });
});

