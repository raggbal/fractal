/**
 * Sprint: 20260802-075012-md-pdf-export
 * TC-PDF-50: PDF エクスポート用 i18n 新 6 キー
 *   (pdfExportNoTarget / pdfExportBrowserNotFound / pdfExportProgress /
 *    pdfExportDone / pdfExportFailed / pdfExportCssSkipped) が
 *   Messages interface + 7 locale (en, ja, zh-cn, zh-tw, ko, es, fr) 全てに
 *   存在し、非空文字列であることを保証する。
 *
 * 注: i18n-copy-file-path.spec.ts は out/locales/*.js を読むが、本 spec は
 *     ビルド非依存にするため src/i18n/locales/*.ts を直接 import する
 *     (Playwright が TS を transpile して読み込む)。データ源は同一。
 *
 * Messages interface 側の網羅は下記 REQUIRED_KEYS を `(keyof Messages)[]` として
 *     型付けすることで、interface にキーが無ければ tsc が捕捉する契約を張る
 *     (完了条件: tsc clean)。実データの網羅は 7 locale の messages object を
 *     ループで assert する (キー欠落 or 空文字なら RED = load-bearing)。
 */
import { test, expect } from '@playwright/test';
import type { Messages } from '../../src/i18n/messages';
import { messages as enMessages } from '../../src/i18n/locales/en';
import { messages as jaMessages } from '../../src/i18n/locales/ja';
import { messages as zhCnMessages } from '../../src/i18n/locales/zh-cn';
import { messages as zhTwMessages } from '../../src/i18n/locales/zh-tw';
import { messages as koMessages } from '../../src/i18n/locales/ko';
import { messages as esMessages } from '../../src/i18n/locales/es';
import { messages as frMessages } from '../../src/i18n/locales/fr';

// interface 契約: 6 キーは全て keyof Messages でなければ tsc が RED
const REQUIRED_KEYS: (keyof Messages)[] = [
    'pdfExportNoTarget',
    'pdfExportBrowserNotFound',
    'pdfExportProgress',
    'pdfExportDone',
    'pdfExportFailed',
    'pdfExportCssSkipped',
];

const LOCALE_MESSAGES: Record<string, Record<string, unknown>> = {
    en: enMessages,
    ja: jaMessages,
    'zh-cn': zhCnMessages,
    'zh-tw': zhTwMessages,
    ko: koMessages,
    es: esMessages,
    fr: frMessages,
};

test.describe('TC-PDF-50: PDF export i18n 新 6 キーが 7 locale 全てに存在', () => {
    for (const [locale, msgs] of Object.entries(LOCALE_MESSAGES)) {
        for (const key of REQUIRED_KEYS) {
            test(`TC-PDF-50 (${locale}): ${key} が定義され非空文字列`, () => {
                const value = msgs[key];
                expect(value, `${locale}.messages.${key} が存在しない`).toBeDefined();
                expect(typeof value, `${locale}.messages.${key} が string でない`).toBe('string');
                expect((value as string).length, `${locale}.messages.${key} が空文字`).toBeGreaterThan(0);
            });
        }
    }

    test('TC-PDF-50: 全 locale が同一 6 キーを漏れなく持つ (locale 間の欠落非対称を検出)', () => {
        for (const [locale, msgs] of Object.entries(LOCALE_MESSAGES)) {
            const missing = REQUIRED_KEYS.filter((k) => typeof msgs[k] !== 'string' || (msgs[k] as string).length === 0);
            expect(missing, `${locale} で欠落: ${missing.join(', ')}`).toEqual([]);
        }
    });
});
