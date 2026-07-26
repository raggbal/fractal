/**
 * chrome-extension i18n unit — sprint 20260727-065214-clipper-i18n-skills-search
 * TC-CI-01〜08 (testcases.md §A)
 *
 * lib/i18n.js / lib/i18n-messages.js は IIFE + module.exports 併設なので node から直接 require。
 * DOM 適用（applyDom）と chrome.storage は手動 US（US-A1/A2）に委譲し、
 * ここでは t()/フォールバック/補間/辞書対称性/buildPageMd labels/静的 3 点登録を検証する。
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const EXT = path.join(ROOT, 'chrome-extension');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const messages = require(path.join(EXT, 'lib/i18n-messages.js'));
// i18n.js は global.FractalI18nMessages を参照する → require 順で messages が先に this へ載る
// （両ファイルとも `typeof self !== 'undefined' ? self : this` の IIFE。node では this = module 環境の
//  グローバル相当だが、module.exports 併設なので require 戻り値で直接検証できる）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const i18n = require(path.join(EXT, 'lib/i18n.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require(path.join(EXT, 'lib/clipper-core.js'));

test.describe('Clipper i18n', () => {

    test('TC-CI-01 デフォルト英語: init 前/init(undefined)/init("en") で en 辞書', () => {
        i18n.init(undefined);
        expect(i18n.getLang()).toBe('en');
        expect(i18n.t('popup_processing')).toBe('Processing…');
        i18n.init('en');
        expect(i18n.t('bg_not_configured_title')).toBe('Not configured');
    });

    test('TC-CI-02 init("ja") で ja / 不正値は en に正規化', () => {
        i18n.init('ja');
        expect(i18n.getLang()).toBe('ja');
        expect(i18n.t('popup_processing')).toBe('処理中…');
        i18n.init('xx');
        expect(i18n.getLang()).toBe('en');
        i18n.init('ja-JP'); // 完全一致以外は en（明示切替のみの 2 値）
        expect(i18n.getLang()).toBe('en');
    });

    test('TC-CI-03 補間: {count}/{name} 置換・params 欠損はプレースホルダ残置', () => {
        i18n.init('en');
        expect(i18n.t('popup_saving_images', { count: 3 })).toBe('Saving 3 images…');
        i18n.init('ja');
        expect(i18n.t('popup_saving_images', { count: 3 })).toBe('画像 3 件を保存中…');
        expect(i18n.t('popup_write_permission_denied', { name: 'MyNote' })).toContain('MyNote');
        // params 欠損 → 例外を投げずプレースホルダ残置
        expect(i18n.t('popup_saving_images', {})).toContain('{count}');
        expect(i18n.t('popup_saving_images')).toContain('{count}');
    });

    test('TC-CI-04 フォールバック: 未知キーはキー名（空文字禁止）', () => {
        i18n.init('ja');
        expect(i18n.t('no_such_key_zzz')).toBe('no_such_key_zzz');
        i18n.init('en');
        expect(i18n.t('no_such_key_zzz')).toBe('no_such_key_zzz');
    });

    test('TC-CI-05 辞書対称性: en / ja のキー集合が完全一致', () => {
        const enKeys = Object.keys(messages.en).sort();
        const jaKeys = Object.keys(messages.ja).sort();
        const onlyEn = enKeys.filter((k) => !messages.ja[k]);
        const onlyJa = jaKeys.filter((k) => !messages.en[k]);
        expect(onlyEn, 'ja に無いキー').toEqual([]);
        expect(onlyJa, 'en に無いキー').toEqual([]);
    });

    test('TC-CI-06 buildPageMd: labels 省略 = en 既定（後方互換）/ 指定 = 日本語ラベル', () => {
        const opts = {
            title: 'T', url: 'https://x.example/', byline: 'A', siteName: 'S', markdown: 'body',
        };
        const en = core.buildPageMd(opts);
        expect(en).toContain('Source: [https://x.example/](https://x.example/)');
        expect(en).toContain('Author: A');
        expect(en).toContain('Site: S');
        expect(en).toContain('# T');
        const ja = core.buildPageMd({
            ...opts,
            labels: { source: '元ページ', author: '著者', site: 'サイト' },
        });
        expect(ja).toContain('元ページ: [https://x.example/](https://x.example/)');
        expect(ja).toContain('著者: A');
        expect(ja).toContain('サイト: S');
        expect(ja).toContain('body');
    });

    test('TC-CI-07 静的 grep: インライン日本語 UI 文字列 0 件（辞書とコメント以外）', () => {
        // 対象: UI/出力を組むファイル（i18n-messages.js は辞書なので対象外）
        const files = ['popup.js', 'options.js', 'background.js', 'popup.html', 'options.html',
            'lib/clipper-core.js'];
        const jp = /[ぁ-んァ-ヶ一-龠]/;
        const offenders: string[] = [];
        for (const f of files) {
            const lines = fs.readFileSync(path.join(EXT, f), 'utf-8').split('\n');
            let inBlockComment = false; // /* */ と <!-- --> の両方を追跡
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const trimmed = line.trim();
                // ブロックコメント/HTML コメント追跡（複数行対応）
                if (inBlockComment) {
                    if (trimmed.includes('*/') || trimmed.includes('-->')) inBlockComment = false;
                    continue;
                }
                if (trimmed.startsWith('/*')) { if (!trimmed.includes('*/')) inBlockComment = true; continue; }
                if (trimmed.startsWith('<!--')) { if (!trimmed.includes('-->')) inBlockComment = true; continue; }
                // 行コメント / JSDoc 継続行は除外
                if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
                if (!jp.test(line)) continue;
                // 許容: 言語セレクタの「日本語」表記（言語名は原語表記が i18n の慣例）
                if (line.includes('<option value="ja">日本語</option>')) continue;
                // 許容: コメント部分のみに日本語（行コメント // と行内ブロックコメント /* */ を剥がして判定）
                const codePart = line.split('//')[0].replace(/\/\*[\s\S]*?\*\//g, '');
                if (!jp.test(codePart)) continue;
                offenders.push(`${f}:${i + 1}: ${trimmed.slice(0, 80)}`);
            }
        }
        expect(offenders, offenders.join('\n')).toEqual([]);
    });

    test('TC-CI-08 3 点登録: popup/options の script + #langSelect は options のみ、background の importScripts', () => {
        // test_update (2026-07-27 手動検収): 言語セレクタは Settings（options）のみに置く
        // （popup には不要 — ユーザー決定）。popup は storage の言語を読んで表示に追従するだけ。
        const popup = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf-8');
        const options = fs.readFileSync(path.join(EXT, 'options.html'), 'utf-8');
        const bg = fs.readFileSync(path.join(EXT, 'background.js'), 'utf-8');
        for (const html of [popup, options]) {
            expect(html).toContain('lib/i18n-messages.js');
            expect(html).toContain('lib/i18n.js');
        }
        expect(options).toContain('id="langSelect"');
        expect(popup).not.toContain('id="langSelect"'); // popup には置かない
        // messages が i18n より先にロードされる順序（popup/options）
        expect(popup.indexOf('lib/i18n-messages.js')).toBeLessThan(popup.indexOf('lib/i18n.js'));
        expect(options.indexOf('lib/i18n-messages.js')).toBeLessThan(options.indexOf('lib/i18n.js'));
        // background: importScripts に 2 ファイル（messages が先）
        const m = bg.match(/importScripts\(([^)]*)\)/);
        expect(m).toBeTruthy();
        expect(m![1]).toContain('lib/i18n-messages.js');
        expect(m![1]).toContain('lib/i18n.js');
        expect(m![1].indexOf('i18n-messages')).toBeLessThan(m![1].indexOf("lib/i18n.js"));
    });
});
