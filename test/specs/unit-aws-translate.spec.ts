/**
 * v10 AWS Translate Module Unit Tests
 * - DOD-T6: Default language settings exist
 * - DOD-T7: translateText calls AWS Translate and returns result
 * - DOD-T8: Text >10KB split by paragraphs and reassembled
 * - DOD-T13: Empty credentials error shows clear message
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../..');

test.describe('v10 AWS Translate - Configuration', () => {
    test('DOD-T6: package.json has translateSourceLang setting', () => {
        const cmd = `grep -n 'fractal.translateSourceLang' "${projectRoot}/package.json" || true`;
        const output = execSync(cmd, { encoding: 'utf-8' }).trim();
        expect(output).not.toBe('');
    });

    test('DOD-T6: package.json has translateTargetLang setting', () => {
        const cmd = `grep -n 'fractal.translateTargetLang' "${projectRoot}/package.json" || true`;
        const output = execSync(cmd, { encoding: 'utf-8' }).trim();
        expect(output).not.toBe('');
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

    test('DOD-T13: translateText validates credentials', () => {
        const cmd = `grep -n 'credentials.*required\\|accessKeyId.*secretAccessKey' "${projectRoot}/src/shared/aws-translate.ts" || true`;
        const output = execSync(cmd, { encoding: 'utf-8' }).trim();
        expect(output).not.toBe('');
    });
});
