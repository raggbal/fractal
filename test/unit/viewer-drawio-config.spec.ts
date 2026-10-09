/**
 * drawio viewer の 3 面 config 配線・ビルド成果物・ハーネス（sprint 20261009-130815-file-viewer-drawio / TASK-04）
 *
 * TC-DIO-05（3 面 __viewerConfig + CSP 不変）/ TC-DIO-06（build-viewer-modules + ハーネス）
 * TASK-07 で TC-DIO-10（i18n）を追記する。
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const SRC_PREFIX = path.join(ROOT, 'src') + path.sep;

function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) { delete require.cache[key]; }
    }
}
function requireWithVscodeStub(modulePath: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Mod = require('module');
    const origLoad = Mod._load;
    purgeSrcCache();
    const stub = {
        workspace: { getConfiguration: () => ({ get: () => undefined }) },
        Uri: {
            file: (p: string) => ({ fsPath: p, toString: () => 'file://' + p }),
            joinPath: (base: any, ...parts: string[]) => {
                const fsPath = path.join((base && base.fsPath) || '', ...parts);
                return { fsPath, toString: () => 'file://' + fsPath };
            },
        },
        window: {}, env: {}, EventEmitter: class { },
    };
    Mod._load = function (request: string) {
        if (request === 'vscode') { return stub; }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try { return require(modulePath); } finally { Mod._load = origLoad; purgeSrcCache(); }
}
const webviewStub = {
    asWebviewUri: (u: any) => 'vscode-resource://' + ((u && u.fsPath) || String(u)),
    cspSource: 'vscode-webview:',
};
function buildStandaloneHtml(): string {
    const { getFileViewerHtml } = requireWithVscodeStub('../../src/fileViewerContent');
    return getFileViewerHtml(webviewStub, { fsPath: ROOT }, { fsPath: '/tmp/a.drawio' }, 'drawio');
}
function buildNotesHtml(): string {
    const { getNotesWebviewContent } = requireWithVscodeStub('../../src/notesWebviewContent');
    const config = {
        webviewMessages: {}, fontSize: 14, theme: 'light', toolbarMode: 'full',
        showTranslateButtons: false, showOpenInTextEditor: false, enableDebugLogging: false,
        documentBaseUri: '', folderName: 'note',
    };
    const initData = {
        jsonContent: JSON.stringify({ version: 1, rootIds: [], nodes: {} }),
        currentFilePath: '/x/a.out', currentFileTitle: 'a', fileChangeId: 0, fileList: [],
        structure: { version: 1, rootIds: [], items: {} }, history: [], historyPanelCollapsed: true,
        historyPanelHeight: 120, initialMd: null, noteFolderName: 'note',
        noteSidePanelWidth: null, noteSidePanelOutlineWidth: null,
    };
    return getNotesWebviewContent(webviewStub, { fsPath: ROOT }, config as any, initData as any);
}
function buildOutlinerHtml(): string {
    const { getOutlinerWebviewContent } = requireWithVscodeStub('../../src/outlinerWebviewContent');
    return getOutlinerWebviewContent(webviewStub, { fsPath: ROOT },
        JSON.stringify({ version: 1, rootIds: [], nodes: {} }), { webviewMessages: {} } as any, 'k1');
}
/** 生成 HTML の（本体 webview の）CSP。nonce は可変なので N に正規化 */
function mainCsp(html: string): string {
    const all = [...html.matchAll(/http-equiv="Content-Security-Policy" content="([^"]+)"/g)].map((m) => m[1]);
    const main = all.find((c) => c.includes('script-src'));
    expect(main).toBeTruthy();
    return main!.replace(/'nonce-[^']+'/g, "'nonce-N'");
}

// 3 面の CSP（本 sprint で変えない — 変更前の値を pin）
const CSP_STANDALONE = "default-src 'none'; img-src vscode-webview: data: blob:; style-src vscode-webview: 'unsafe-inline'; script-src 'nonce-N' vscode-webview:; frame-src vscode-webview: blob:; worker-src vscode-webview: blob:; connect-src vscode-webview:; font-src vscode-webview: blob: data:; form-action 'none'";
const CSP_NOTES_OUTLINER = "default-src 'none'; style-src vscode-webview: 'unsafe-inline' https://fonts.googleapis.com; script-src 'nonce-N' vscode-webview:; img-src vscode-webview: https: http: data: file: blob:; font-src vscode-webview: https: https://fonts.gstatic.com data: blob:; frame-src vscode-webview: blob:; worker-src vscode-webview: blob:; connect-src vscode-webview:; form-action 'none';";

test.describe('drawio viewer の配線', () => {
    test('TC-DIO-05: 3 面の __viewerConfig に drawio モジュールとライブラリ 2 本、CSP は不変', () => {
        for (const [name, html, csp] of [
            ['standalone', buildStandaloneHtml(), CSP_STANDALONE],
            ['notes', buildNotesHtml(), CSP_NOTES_OUTLINER],
            ['outliner', buildOutlinerHtml(), CSP_NOTES_OUTLINER],
        ] as const) {
            const cfgStart = html.indexOf('__viewerConfig');
            expect(cfgStart, `${name}: __viewerConfig`).toBeGreaterThan(-1);
            const cfg = html.slice(cfgStart, cfgStart + 6000);
            expect(cfg, `${name}: viewer-drawio.mjs`).toContain(path.join('out', 'webview', 'viewer-drawio.mjs'));
            expect(cfg, `${name}: drawioAssetUris`).toContain('drawioAssetUris');
            expect(cfg, `${name}: viewer-static`).toContain(path.join('media', 'drawio-viewer', 'viewer-static.min.js'));
            expect(cfg, `${name}: stencils`).toContain(path.join('media', 'drawio-viewer', 'stencils.min.js'));
            expect(mainCsp(html), `${name}: CSP 不変`).toBe(csp);
        }
    });

    test('TC-DIO-06: ビルド成果物（モジュール・ハーネス 2 種・vendor コピー）', () => {
        execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-viewer-modules.js')], { stdio: 'pipe' });
        execFileSync(process.execPath, [path.join(ROOT, 'test', 'build-standalone-viewer.js')], { stdio: 'pipe' });
        const outDir = path.join(ROOT, 'out', 'webview');
        // (a) drawio モジュール: frame-boot を文字列で含み、ライブラリ本体は含まない
        const mod = fs.readFileSync(path.join(outDir, 'viewer-drawio.mjs'), 'utf8');
        expect(mod).toContain('drawioInit');
        expect(mod).not.toContain('mxStencilRegistry=');
        expect(mod.length).toBeLessThan(200 * 1024);
        // (b) 他 kind のバンドルに drawio が混ざらない
        for (const kind of ['text', 'image', 'docx', 'xlsx', 'pptx']) {
            const p = path.join(outDir, `viewer-${kind}.mjs`);
            if (fs.existsSync(p)) { expect(fs.readFileSync(p, 'utf8'), kind).not.toContain('drawio'); }
        }
        // (c) 標準ハーネスの config
        const harness = fs.readFileSync(path.join(ROOT, 'test', 'html', 'standalone-viewer.html'), 'utf8');
        expect(harness).toContain('./viewer-modules/viewer-drawio.mjs');
        expect(harness).toContain('./drawio-viewer/viewer-static.min.js');
        // (d) notes 面 CSP 相当のハーネス: 本番 notesWebviewContent.ts の img/font/style-src と一致
        const notesHarness = fs.readFileSync(path.join(ROOT, 'test', 'html', 'standalone-viewer-notescsp.html'), 'utf8');
        const hCsp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(notesHarness)![1];
        const prodCsp = mainCsp(buildNotesHtml());
        const directive = (c: string, d: string) => (c.split(';').map((s) => s.trim()).find((s) => s.startsWith(d + ' ')) || '')
            .replace(/vscode-webview:|'self'/g, 'SRC');
        for (const d of ['img-src', 'font-src', 'style-src']) {
            expect(directive(hCsp, d), d).toBe(directive(prodCsp, d));
        }
        expect(notesHarness).toContain('./viewer-modules/viewer-drawio.mjs');
        // (e) vendor コピー
        for (const f of ['viewer-static.min.js', 'stencils.min.js']) {
            expect(fs.existsSync(path.join(ROOT, 'test', 'html', 'drawio-viewer', f)), f).toBe(true);
        }
    });

    test('TC-DIO-10: drawio の i18n キーは WebviewMessages に属し、7 locale の webviewMessages に非空で存在', () => {
        const KEYS = ['viewerDrawioPage', 'viewerDrawioLayers', 'viewerDrawioLoading', 'viewerDrawioRenderFailed', 'drawioOpenInViewer'];
        const ifaceSrc = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'messages.ts'), 'utf8');
        const wmStart = ifaceSrc.indexOf('export interface WebviewMessages');
        expect(wmStart).toBeGreaterThan(-1);
        const wmBody = ifaceSrc.slice(wmStart, ifaceSrc.indexOf('\n}', wmStart));
        for (const k of KEYS) { expect(wmBody, `WebviewMessages.${k}`).toContain(`${k}:`); }
        for (const loc of ['en', 'es', 'fr', 'ja', 'ko', 'zh-cn', 'zh-tw']) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require(`../../src/i18n/locales/${loc}`);
            for (const k of KEYS) {
                const v = mod.webviewMessages && mod.webviewMessages[k];
                expect(typeof v === 'string' && v.length > 0, `${loc}.${k}`).toBe(true);
            }
        }
    });
});
