/**
 * viewer-i18n.spec.ts — file viewer ツールバーの i18n 登録検査
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-14 / TC-FV-54（FR-FV-08）。
 * webview 側は `(window.__outlinerMessages || {}).viewerXxx || '<既定文言>'` で参照するため、
 * キーが未登録でも実行時エラーにならず全 locale 英語/日本語固定になる（silent i18n 債務 —
 * generator_failures 2026-08-09）。interface + 7 locale への登録をここで機械的に固定する。
 *
 * 検査面は source（messages.ts / locales/*.ts の字面）— TC-HMI-01（host-message-i18n.spec.ts）と
 * 同型。compile 済み out/locales を要求しないためビルド前でも走る。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const LOCALES = ['en', 'ja', 'es', 'fr', 'ko', 'zh-cn', 'zh-tw'];

/** TASK-14 で新設する viewer 専用キー（ラベル 4 + 逆引き失敗通知 1 = design §10） */
const NEW_KEYS = [
    'viewerOpenInNewTab',
    'viewerCopyPath',
    'viewerCopyInAppLink',
    'viewerExportFile',
    'viewerCopyInAppLinkFailed',
];

test.describe('file viewer toolbar i18n（FR-FV-08）', () => {

    test('TC-FV-54: 新設 5 キーが WebviewMessages interface + 7 locale すべてに存在', () => {
        const iface = fs.readFileSync(path.join(ROOT, 'src/i18n/messages.ts'), 'utf8');
        for (const key of NEW_KEYS) {
            expect(iface, `messages.ts の WebviewMessages に ${key} が無い`)
                .toMatch(new RegExp(`\\b${key}: string;`));
        }
        for (const loc of LOCALES) {
            const src = fs.readFileSync(path.join(ROOT, `src/i18n/locales/${loc}.ts`), 'utf8');
            for (const key of NEW_KEYS) {
                expect(src, `${loc}.ts に ${key} が無い`).toMatch(new RegExp(`\\b${key}:`));
            }
        }
    });

    test('TC-FV-54b: 5 キーは webviewMessages 側に登録されている（host messages 側ではない）', () => {
        // WebviewMessages は webview へ JSON で注入される別 export（notesWebviewContent.ts:309 等）。
        // host 用 `messages` にだけ足すと window.__outlinerMessages に載らず届かない
        for (const loc of LOCALES) {
            const src = fs.readFileSync(path.join(ROOT, `src/i18n/locales/${loc}.ts`), 'utf8');
            const idx = src.indexOf('export const webviewMessages');
            expect(idx, `${loc}.ts に webviewMessages export が無い`).toBeGreaterThan(-1);
            const webviewPart = src.slice(idx);
            for (const key of NEW_KEYS) {
                expect(webviewPart, `${loc}.ts の webviewMessages に ${key} が無い`)
                    .toMatch(new RegExp(`\\b${key}:`));
            }
        }
    });
});
