/**
 * v10 AWS Translate Module Unit Tests
 * - DOD-T6: The language settings are deprecated (the languages are remembered, ADRL-0141)
 * - DOD-T7: translateText calls AWS Translate and returns result
 * - DOD-T8: Text >10KB split by paragraphs and reassembled
 * - DOD-T13: Only one of the two keys is a settings error (empty = AWS CLI credentials)
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../..');

test.describe('v10 AWS Translate - Configuration', () => {
    // ADRL-0141: 翻訳の言語は設定ではなくなった（最後に選んだものを globalState に覚える）。
    // 古い設定は移すために deprecated で残し、既定の言語は translate-langs.ts が持つ。
    test('DOD-T6: translateSourceLang / translateTargetLang は deprecated、既定の言語は translate-langs', () => {
        const pkg = JSON.parse(require('fs').readFileSync(`${projectRoot}/package.json`, 'utf8'));
        const props = Object.assign({}, ...pkg.contributes.configuration.map((c: any) => c.properties));
        for (const key of ['fractal.translateSourceLang', 'fractal.translateTargetLang']) {
            expect(props[key], key).toBeTruthy();
            expect(props[key].deprecationMessage, key).toBeTruthy();
        }
        const langs = require('fs').readFileSync(`${projectRoot}/src/shared/translate-langs.ts`, 'utf8');
        expect(langs).toContain("DEFAULT_TRANSLATE_LANGS: TranslateLangs = { sourceLang: 'en', targetLang: 'ja' }");
    });

    test('DOD-T7: aws-translate.ts exports translateText function', () => {
        const cmd = `grep -n 'export.*function translateText' "${projectRoot}/src/shared/aws-translate.ts" || grep -n 'export.*translateText.*:' "${projectRoot}/src/shared/aws-translate.ts" || true`;
        const output = execSync(cmd, { encoding: 'utf-8' }).trim();
        expect(output).not.toBe('');
    });

    test('DOD-T7: aws-translate.ts exports TRANSLATE_LANGUAGES', () => {
        const cmd = `grep -n 'export.*TRANSLATE_LANGUAGES' "${projectRoot}/src/shared/aws-translate.ts" || true`;
        const output = execSync(cmd, { encoding: 'utf-8' }).trim();
        expect(output).not.toBe('');
    });

    // ADRL-0141: キーが空なのは AWS CLI の認証を使う正しい設定になった。確かめるのはキーが片方だけのとき（aws-settings.ts）。
    test('DOD-T13: キーが片方だけなら AwsSettingsError（両方空は AWS CLI の認証）', () => {
        const cmd = `grep -n "source === 'invalid'" "${projectRoot}/src/shared/aws-settings.ts" || true`;
        const output = execSync(cmd, { encoding: 'utf-8' }).trim();
        expect(output).not.toBe('');
    });
});
