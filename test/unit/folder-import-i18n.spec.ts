/**
 * folder-import-i18n.spec.ts — Import folder 文言の i18n 帰属番人（TC-OIF-06 / NFR-OIF-02）
 *
 * Sprint 20260827-172802 TASK-03/04。**消費関数ごとに interface 帰属が違う**ため、
 * キー存在だけでなく「どちらの interface ブロックにあるか」を assert する:
 *   - webview の label()/i18n（= window.__outlinerMessages = webviewMessages）が読む → WebviewMessages
 *   - host の t()（= messages）が読む modal / 通知 → Messages
 * 逆に登録すると全 locale 英語固定 or undefined になる（generator_failures 2026-08-22 の実録前科）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const LOCALES = ['en', 'ja', 'es', 'fr', 'ko', 'zh-cn', 'zh-tw'];

/** webview の i18n（menu ラベル） */
const WEBVIEW_KEYS = ['importFolderMenu'];
/** host の t()（確認 modal 本文 / ボタン / 上限超過通知 / skip 集計通知） */
const HOST_KEYS = [
    'importFolderConfirm', 'importFolderConfirmProceed', 'importFolderTooMany', 'importFolderSkipped',
];

/** `<開始トークン>` の直後の `{` から対応する `}` までを切り出す（ネスト対応） */
function blockAfter(src: string, startToken: string): string {
    const start = src.indexOf(startToken);
    expect(start, `${startToken} が見つからない`).toBeGreaterThan(-1);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') { depth++; }
        if (src[i] === '}') { depth--; if (depth === 0) { return src.slice(open, i); } }
    }
    throw new Error(`${startToken} のブロック終端が見つからない`);
}

test('TC-OIF-06: interface 帰属 — menu キーは WebviewMessages / modal・通知キーは Messages', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'messages.ts'), 'utf8');
    const webviewBlock = blockAfter(src, 'interface WebviewMessages');
    const hostBlock = blockAfter(src, 'interface Messages');

    for (const k of WEBVIEW_KEYS) {
        expect(webviewBlock, `WebviewMessages に ${k} が無い（webview の i18n が読めず英語固定）`).toContain(`${k}: string;`);
        expect(hostBlock, `${k} は host 側 Messages に置かない`).not.toContain(`${k}: string;`);
    }
    for (const k of HOST_KEYS) {
        expect(hostBlock, `Messages に ${k} が無い（host の t() が読めず undefined になる）`).toContain(`${k}: string;`);
        expect(webviewBlock, `${k} は WebviewMessages に置かない`).not.toContain(`${k}: string;`);
    }
});

test('TC-OIF-06: 7 locale × 全キーが「対応する export ブロック」に実文言を持つ', () => {
    for (const loc of LOCALES) {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'locales', `${loc}.ts`), 'utf8');
        const messagesBlock = blockAfter(src, 'export const messages');
        const webviewBlock = blockAfter(src, 'export const webviewMessages');

        for (const [block, keys, label] of [
            [messagesBlock, HOST_KEYS, 'messages'],
            [webviewBlock, WEBVIEW_KEYS, 'webviewMessages'],
        ] as Array<[string, string[], string]>) {
            for (const k of keys) {
                const m = new RegExp(`${k}:\\s*'((?:[^'\\\\]|\\\\.)+)'`).exec(block);
                expect(m, `${loc}.ts の ${label} ブロックに ${k} が無い`).not.toBeNull();
                expect(m![1].length, `${loc}.ts の ${k} が空`).toBeGreaterThan(0);
            }
        }
        // 件数プレースは全 locale で維持（欠けると件数が表示されない）
        expect(messagesBlock, `${loc}.ts の importFolderConfirm に {count} が無い`)
            .toMatch(/importFolderConfirm:\s*'[^']*\{count\}/);
        expect(messagesBlock, `${loc}.ts の importFolderSkipped に {count} が無い`)
            .toMatch(/importFolderSkipped:\s*'[^']*\{count\}/);
    }
});
