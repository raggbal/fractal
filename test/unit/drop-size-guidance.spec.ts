/**
 * TC-DSG-01 — 50MB 上限トーストの代替経路案内（sprint 20260822-051129 TASK-11 — ユーザー要望 2026-08-23）
 *
 * dropFileTooLarge（host）/ notesAttachTooLarge（webview）の両文言が、全 7 locale で
 * 「上限なしの代替経路（Explorer Shift+ドラッグ / +file ボタン）」への案内を含むことを pin。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');

test('TC-DSG-01 両キー × 7 locale に +file 案内が含まれる', () => {
    for (const loc of ['en', 'ja', 'es', 'fr', 'ko', 'zh-cn', 'zh-tw']) {
        const src = fs.readFileSync(path.join(ROOT, `src/i18n/locales/${loc}.ts`), 'utf8');
        for (const key of ['dropFileTooLarge', 'notesAttachTooLarge']) {
            const m = src.match(new RegExp(`  ${key}: '([^']*)'`));
            expect(m, `${loc}: ${key} が無い`).toBeTruthy();
            expect(m![1].includes('+file'), `${loc}: ${key} に代替経路の案内が無い`).toBe(true);
        }
    }
});
