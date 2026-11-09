/**
 * Every message key the webview code reads (`i18n.<key>` in src/webview/*.js and src/shared/*.js) has text in the
 * webviewMessages of all 7 locales. A key that is in none of them silently shows its English
 * fallback in every language — the Notes tree's right-click menu had 5 such keys (New Markdown here / Add to Favorites /
 * Move Other Note …) and the editor / outliner 10 more (code block Copy, Set page directory…, Pinned Tags …).
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const LOCALES = ['en', 'ja', 'es', 'fr', 'ko', 'zh-cn', 'zh-tw'];

function usedKeys(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const dir of ['src/webview', 'src/shared']) {
        for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith('.js'))) {
            const src = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
            for (const m of src.matchAll(/\bi18n\.([A-Za-z][A-Za-z0-9_]*)/g)) {
                if (!out.has(m[1])) out.set(m[1], new Set());
                out.get(m[1])!.add(f);
            }
        }
    }
    return out;
}

function block(src: string, marker: string): string {
    const start = src.indexOf(marker);
    expect(start, marker).toBeGreaterThan(-1);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        if (src[i] === '}' && --depth === 0) return src.slice(open, i);
    }
    return src.slice(open);
}

test('TC-WI18N-01 every i18n.<key> the webview reads has text in the webviewMessages of all 7 locales', () => {
    const keys = usedKeys();
    expect(keys.size).toBeGreaterThan(100); // the scan really sees the webview code
    // the locale's webviewMessages object is what getWebviewMessages() hands to the webview (the WebviewMessages
    // interface does not list every key — the locale objects are not checked against it — so the objects are the truth)
    const missing: string[] = [];
    for (const loc of LOCALES) {
        const wm = block(fs.readFileSync(path.join(ROOT, `src/i18n/locales/${loc}.ts`), 'utf8'), 'export const webviewMessages');
        for (const [k, files] of keys) {
            const m = new RegExp(`\\b${k}:\\s*(['"\`])((?:(?!\\1).)+)\\1`).exec(wm);
            if (!m) missing.push(`${loc}: ${k} (${[...files].join(', ')})`);
        }
    }
    expect(missing, missing.join('\n')).toEqual([]);
});

test('TC-WI18N-02 the Notes tree menu items that were English in every language are translated', () => {
    const ja = block(fs.readFileSync(path.join(ROOT, 'src/i18n/locales/ja.ts'), 'utf8'), 'export const webviewMessages');
    for (const [k, v] of [['notesNewMarkdownHere', '新規マークダウン'], ['notesFavorite', '☆ お気に入りに追加'], ['notesMoveOtherNote', '別のノートへ移動…']]) {
        expect(ja).toContain(`${k}: '${v}'`);
    }
});
