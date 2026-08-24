/**
 * viewer-i18n-keys.spec.ts — 新規 viewer 文言の i18n 帰属番人（TC-VEX-18 / NFR-VEX-05）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-06。
 * webview 文言は **WebviewMessages** interface 帰属（label() = __outlinerMessages 読取面）+ 7 locale。
 * Messages 側誤登録は全 locale 英語固定の実録前科（generator_failures 2026-08-22 — TC-VFB-04 形式）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const KEYS = [
    'viewerFit', 'viewerActualSize', 'viewerProtectedFile', 'viewerTooLargeToRender',
    'viewerBinaryFile', 'viewerLayoutApprox', 'viewerUnsupportedChart', 'viewerUnsupportedSmartArt',
    'viewerUnsupportedImageFmt', 'viewerUnsupportedMath', 'viewerSheetHidden', 'viewerVerticalTextApprox',
];
const LOCALES = ['en', 'ja', 'es', 'fr', 'ko', 'zh-cn', 'zh-tw'];

test('TC-VEX-18: 全キーが WebviewMessages interface ブロック内に定義されている', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'messages.ts'), 'utf8');
    const start = src.indexOf('interface WebviewMessages');
    expect(start).toBeGreaterThan(-1);
    // interface ブロック（最初の '{' から対応する '}' まで）を切り出して帰属を確認
    const open = src.indexOf('{', start);
    let depth = 0; let end = open;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') { depth++; }
        if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const block = src.slice(open, end);
    for (const k of KEYS) {
        expect(block, `WebviewMessages に ${k} が無い（Messages 側誤登録は英語固定になる）`).toContain(`${k}: string;`);
    }
});

test('TC-VEX-18: 7 locale 全部に全キーの実文言がある', () => {
    for (const loc of LOCALES) {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'locales', `${loc}.ts`), 'utf8');
        for (const k of KEYS) {
            const m = new RegExp(`${k}:\\s*'([^']+)'`).exec(src);
            expect(m, `${loc}.ts に ${k} が無い`).not.toBeNull();
            expect(m![1].length, `${loc}.ts の ${k} が空`).toBeGreaterThan(0);
        }
    }
});
