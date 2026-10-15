/**
 * drawio の隔離 iframe 文書の組み立て（sprint 20261009-130815-file-viewer-drawio / TASK-05 / ADRL-0135）
 *
 * TC-DIO-09
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'src', 'webview', 'viewer-drawio');

// design/system/drawio-viewer.md §5 の内側 meta CSP（完全一致で pin）
const FRAME_CSP = "default-src 'none'; script-src 'nonce-N1'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; media-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

async function load(): Promise<any> {
    return import(pathToFileURL(path.join(DIR, 'frame-doc.mjs')).href);
}

test.describe('drawio iframe 文書', () => {
    test('TC-DIO-09: meta CSP が先頭・全 script に nonce・</script> の無害化・前置 script の順序', async () => {
        const { buildFrameDoc } = await load();
        const html: string = buildFrameDoc({
            nonce: 'N1',
            viewerStatic: 'var a="</script>";window.__VS=1;',
            stencils: 'window.__ST=1;',
            boot: 'window.__BOOT=1;',
        });
        // (a) 最初の <script より前に meta CSP があり、内容が完全一致
        const metaIdx = html.indexOf('<meta http-equiv="Content-Security-Policy"');
        expect(metaIdx).toBeGreaterThan(-1);
        expect(metaIdx).toBeLessThan(html.indexOf('<script'));
        const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
        expect(m![1]).toBe(FRAME_CSP);
        // (b) すべての <script に nonce="N1"
        const tags = html.match(/<script\b[^>]*>/g) || [];
        expect(tags.length).toBe(4);
        for (const t of tags) { expect(t).toContain('nonce="N1"'); }
        // (c) ライブラリ中の </script> は無害化され、終了タグはちょうど 4 個
        expect(html).toContain('var a="<\\/script>"');
        expect((html.match(/<\/script>/g) || []).length).toBe(4);
        // (d) 前置 script（既定 URL 潰し）がライブラリより前、boot が最後
        const pre = html.indexOf('STENCIL_PATH');
        expect(pre).toBeGreaterThan(-1);
        expect(pre).toBeLessThan(html.indexOf('window.__VS=1'));
        expect(html.indexOf('window.__VS=1')).toBeLessThan(html.indexOf('window.__ST=1'));
        expect(html.indexOf('window.__ST=1')).toBeLessThan(html.indexOf('window.__BOOT=1'));
        for (const k of ['DRAW_MATH_URL', 'PROXY_URL', 'mxLoadResources', 'mxLoadStylesheets', 'isLocalStorage']) {
            expect(html.slice(0, html.indexOf('window.__VS=1')), k).toContain(k);
        }
        // (e) viewer-drawio のソースに allow-same-origin が無い（sandbox の実値は TC-DIO-34 が実行時に確認）
        for (const f of fs.readdirSync(DIR)) {
            expect(fs.readFileSync(path.join(DIR, f), 'utf8'), f).not.toContain('allow-same-origin');
        }
    });

    test('TC-DIO-09b: nonce に不正な文字があれば throw（属性の注入を防ぐ）', async () => {
        const { buildFrameDoc } = await load();
        expect(() => buildFrameDoc({ nonce: 'a" onload="x', viewerStatic: '', stencils: '', boot: '' })).toThrow();
    });
});
