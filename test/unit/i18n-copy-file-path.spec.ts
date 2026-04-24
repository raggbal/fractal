/**
 * Sprint: 20260424-135027-debug-banner-outliner-actions
 * NFR-I18N-1: 7 言語全て (en, ja, zh-cn, zh-tw, ko, es, fr) で
 *             `outlinerCopyFilePath` key が定義されている
 *
 * 注: i18n locale は ts ファイルだが build 経由で out/locales/*.js になる。
 *     コンパイル後のファイルを読み込んで messages object を確認する。
 */

import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

const LOCALES = ['en', 'ja', 'zh-cn', 'zh-tw', 'ko', 'es', 'fr'];

test.describe('NFR-I18N-1: outlinerCopyFilePath 全 7 言語カバー', () => {
    for (const locale of LOCALES) {
        test(`TC-I18N-1 (${locale}): outlinerCopyFilePath が webviewMessages に定義されている`, async () => {
            // out/locales/ から compiled js を読込
            // 注: outliner 関連 i18n key は `webviewMessages` 側 (webview に渡される)、
            //     `messages` は VSCode 拡張側 notification 等で使うため別オブジェクト
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const localePath = path.resolve(__dirname, '../../out/locales', `${locale}.js`);
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require(localePath);
            const webviewMessages = mod.webviewMessages;

            expect(webviewMessages).toBeDefined();
            expect(webviewMessages.outlinerCopyFilePath).toBeDefined();
            expect(typeof webviewMessages.outlinerCopyFilePath).toBe('string');
            expect(webviewMessages.outlinerCopyFilePath.length).toBeGreaterThan(0);
        });
    }
});
