/**
 * host 側メッセージの i18n 化 (sprint 20260813-073112-host-message-i18n)
 *
 * - TC-HMI-01: 新設キーが Messages interface + 7 locale 全部に存在 (grep 検査)
 * - TC-HMI-02/03: 移行ゲート HTML が locale に応じた文言 + lang 属性で描画される (behavioral)
 * - TC-HMI-04: ja 文言の src/ 残存が i18n/locales のみ (grep = 0 検査)
 * - TC-HMI-05: 移行完了 toast が t() キー経由 (source contract — provider は巨大クロージャ内で
 *   behavioral 不能な既知制約のため。文言実在は TC-HMI-01/02/03 が担保)
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const LOCALES = ['en', 'ja', 'es', 'fr', 'ko', 'zh-cn', 'zh-tw'];

// TASK-01 で新設するキーの最終集合
const NEW_KEYS = [
    // 移行ゲート
    'mgTitle', 'mgDesc', 'mgSummaryPages', 'mgSummaryImages', 'mgSummaryFiles',
    'mgMigrate', 'mgMigrating', 'mgFailed', 'mgUnknownError', 'mgRetry',
    // 移行完了 toast
    'migrationDoneBackup', 'migrationDoneRecovery', 'migrationDoneUnresolved',
    // 翻訳系エラー
    'translateSaveFailedPagesDir', 'translateSaveFailedParse',
    'translateSaveFailed', 'terminologyUpdateFailed',
];

test.describe('host message i18n', () => {
    // TC-HMI-01: interface + 7 locale 全部にキーが存在
    test('TC-HMI-01 新設キーが Messages interface + 7 locale すべてに存在', () => {
        const iface = fs.readFileSync(path.join(ROOT, 'src/i18n/messages.ts'), 'utf8');
        for (const key of NEW_KEYS) {
            expect(iface, `messages.ts interface に ${key} が無い`).toMatch(new RegExp(`\\b${key}: string;`));
        }
        for (const loc of LOCALES) {
            const src = fs.readFileSync(path.join(ROOT, `src/i18n/locales/${loc}.ts`), 'utf8');
            for (const key of NEW_KEYS) {
                expect(src, `${loc}.ts に ${key} が無い`).toMatch(new RegExp(`\\b${key}:`));
            }
        }
    });

    // TC-HMI-02: en locale で英語文言 + lang="en"
    test('TC-HMI-02 gate HTML が en locale で英語文言 + lang="en"', () => {
        const { initLocale } = require('../../src/i18n/messages');
        initLocale('en', 'en');
        const { getNotesMigrationGateContent } = require('../../src/notesMigrationGate');
        const fakeWebview = { cspSource: 'vscode-resource:', asWebviewUri: (u: any) => u } as any;
        const html = getNotesMigrationGateContent(fakeWebview, {} as any,
            { pages: 2, images: 0, files: 1, total: 3 }, 'myNote');
        expect(html).toContain('lang="en"');
        expect(html).not.toContain('移行する');
        expect(html).not.toContain('このノートを新レイアウトに移行します');
        // en.ts の mgMigrate 値がボタンに入る
        const en = require('../../src/i18n/locales/en');
        expect(html).toContain(en.messages.mgMigrate);
        expect(html).toContain(en.messages.mgTitle);
    });

    // TC-HMI-03: ja locale で従来文言 + lang="ja" (後方互換)
    test('TC-HMI-03 gate HTML が ja locale で日本語文言 + lang="ja"', () => {
        const { initLocale } = require('../../src/i18n/messages');
        initLocale('ja', 'ja');
        const { getNotesMigrationGateContent } = require('../../src/notesMigrationGate');
        const fakeWebview = { cspSource: 'vscode-resource:', asWebviewUri: (u: any) => u } as any;
        const html = getNotesMigrationGateContent(fakeWebview, {} as any,
            { pages: 2, images: 0, files: 1, total: 3 }, 'myNote');
        expect(html).toContain('lang="ja"');
        expect(html).toContain('このノートを新レイアウトに移行します');
        expect(html).toContain('移行する');
    });

    // TC-HMI-04: ja 文言のハードコード残存が i18n/locales のみ
    test('TC-HMI-04 ja ハードコードが i18n/locales 以外の src/ に残っていない', () => {
        const offenders: string[] = [];
        const jaPattern = /移行する|移行できません|移行が完了しました|失敗しました|解決できません|お待ちください|不明なエラー|再試行/;
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'locales' || e.name === 'node_modules') continue;
                    walk(p);
                    continue;
                }
                if (!/\.(ts|js)$/.test(e.name)) continue;
                const lines = fs.readFileSync(p, 'utf8').split('\n');
                lines.forEach((line, i) => {
                    // コメント行 + 行内コメント (// 以降) を除外し、コード部分のみ検査する
                    // (ユーザー可視の文字列リテラルの検出が目的。コメントの日本語はスコープ外)
                    const trimmed = line.trim();
                    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
                    const codePart = line.split('//')[0];
                    if (jaPattern.test(codePart)) offenders.push(`${path.relative(ROOT, p)}:${i + 1}`);
                });
            }
        };
        walk(path.join(ROOT, 'src'));
        expect(offenders, `ja ハードコード残存: ${offenders.join(', ')}`).toEqual([]);
    });

    // TC-HMI-05: 移行完了 toast が t() キー経由 (source contract)
    test('TC-HMI-05 移行完了 toast (unresolved あり/なし両分岐) が t() キー経由', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/notesEditorProvider.ts'), 'utf8');
        expect(src).toContain("t('migrationDoneUnresolved')");
        expect(src).toContain("t('migrationDoneBackup')");
        expect(src).toContain("t('migrationDoneRecovery')");
    });
});
