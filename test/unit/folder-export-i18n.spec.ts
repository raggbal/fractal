/**
 * folder-export-i18n.spec.ts — TC-EXF-07（NFR-EXF-02）
 *
 * Export folder / 右クリック 4 項目の文言が **消費側の interface** に登録され 7 locale を持つことの番人。
 * webview の `i18n`（= window.__outlinerMessages = webviewMessages）が読むキーと host の `t()`（= messages）が
 * 読むキーを分けて assert する（帰属ミスは全 locale 英語固定 or undefined になる — generator_failures 2026-08-22）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const LOCALES = ['en', 'ja', 'es', 'fr', 'ko', 'zh-cn', 'zh-tw'];

/** webview の i18n（≡ / 右クリックのラベル） */
const WEBVIEW_KEYS = ['exportFolderMenu', 'importMdFilesMenu', 'importFilesMenu'];
/** host の t()（modal / 通知 / ガード） */
const HOST_KEYS = ['exportFolderConfirm', 'exportFolderConfirmProceed', 'exportFolderDone', 'exportFolderInvalidDest'];

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

test('TC-EXF-07: interface 帰属 — menu 3 キーは WebviewMessages / modal・通知 4 キーは Messages', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'messages.ts'), 'utf8');
    const webviewBlock = blockAfter(src, 'interface WebviewMessages');
    const hostBlock = blockAfter(src, 'interface Messages');

    for (const k of WEBVIEW_KEYS) {
        expect(webviewBlock, `WebviewMessages に ${k} が無い（webview が読めず英語固定）`).toContain(`${k}: string;`);
        expect(hostBlock, `${k} を host 側 Messages に置かない`).not.toContain(`${k}: string;`);
    }
    for (const k of HOST_KEYS) {
        expect(hostBlock, `Messages に ${k} が無い（host の t() が読めず undefined）`).toContain(`${k}: string;`);
        expect(webviewBlock, `${k} を WebviewMessages に置かない`).not.toContain(`${k}: string;`);
    }
});

test('TC-EXF-07: 7 locale × 全キーが対応する export ブロックに実文言を持つ', () => {
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
        // 件数プレースが全 locale で維持されている（欠けると件数が表示されない）
        expect(messagesBlock, `${loc}: exportFolderConfirm に {count}`).toMatch(/exportFolderConfirm:\s*'[^']*\{count\}/);
        for (const ph of ['{folders}', '{files}', '{skipped}']) {
            const line = /exportFolderDone:\s*'([^']*)'/.exec(messagesBlock);
            expect(line, `${loc}: exportFolderDone 行`).not.toBeNull();
            expect(line![1], `${loc}: exportFolderDone に ${ph}`).toContain(ph);
        }
    }
});

test('TC-EXF-07: ≡ / 右クリックのラベルが i18n キー経由（英語ハードコードのままにしない）', () => {
    const outliner = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'outliner.js'), 'utf8');
    // 4 項目すべてが `i18n.<key> || '<fallback>'` の形で書かれていること（fallback は許容）
    for (const key of ['importMdFilesMenu', 'importFilesMenu', 'importFolderMenu', 'exportFolderMenu']) {
        const uses = outliner.split(`i18n.${key}`).length - 1;
        expect(uses, `${key} が ≡ と右クリックの 2 箇所で使われる`).toBeGreaterThanOrEqual(2);
    }
    // i18n を通さない裸の textContent 代入が残っていないこと
    expect(outliner, '≡ の Import .md files が i18n を通らない代入で残っていない')
        .not.toContain("textContent = 'Import .md files...'");
    expect(outliner, '≡ の Import any files が i18n を通らない代入で残っていない')
        .not.toContain("textContent = 'Import any files...'");
});
