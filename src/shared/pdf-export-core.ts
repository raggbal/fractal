/**
 * pdf-export-core.ts — md → PDF export の純ロジック (vscode 非依存)
 *
 * design/system.md §4 + ADRL-0036 (自己完結 HTML + headless Chromium) /
 * ADRL-0037 (ネットワーク全遮断 --host-resolver-rules=MAP * ~NOTFOUND) 準拠。
 *
 * 対応 FR/NFR: FR-PDF-03 (見出しページ区切り), FR-PDF-04 (ユーザー CSS 合成),
 *              NFR-PDF-01 (自己完結・オフライン), NFR-PDF-02 (ネットワーク遮断)。
 *
 * import は node 標準のみ。パス解決は resolveTerminologyPath と同一規則を
 * 内部複製 (aws-translate は vscode 非依存だが core の独立性を保つため複製)。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

/**
 * ローカルファイルパスを解決 (絶対 / ~ 展開 / workspaceRoot 相対)。
 * aws-translate.resolveTerminologyPath と同一規則。
 */
export function resolveLocalPath(rawPath: string, workspaceRoot?: string): string {
    if (!rawPath) return '';
    let p = rawPath.trim();
    if (p.startsWith('~')) {
        p = path.join(os.homedir(), p.slice(1));
    }
    if (path.isAbsolute(p)) return p;
    const base = workspaceRoot || process.cwd();
    return path.resolve(base, p);
}

/**
 * 印刷向けクリーンスタイル (自己完結 HTML の <style> 先頭に入る既定 CSS)。
 * h1/h2 で改ページ、no-break-before で最初の見出し等は改ページ抑止。
 */
export const PDF_DEFAULT_CSS = `@page { size: A4; margin: 18mm 15mm; }
body.pdf-export { font-family: -apple-system, 'Segoe UI', 'Hiragino Sans', 'Noto Sans CJK JP', sans-serif; color: #24292e; background: #fff; font-size: 10.5pt; line-height: 1.7; }
h1,h2 { break-before: page; page-break-before: always; }
.no-break-before { break-before: auto; page-break-before: auto; }
h1,h2,h3,h4 { break-after: avoid; page-break-after: avoid; }
pre, table, blockquote, img { break-inside: avoid; page-break-inside: avoid; }
pre { background:#f6f8fa; padding:.8em; border-radius:4px; overflow-wrap:anywhere; white-space:pre-wrap; }
code { background:#f6f8fa; padding:.15em .35em; border-radius:3px; font-size:.9em; }
table { border-collapse: collapse; } th,td { border:1px solid #d0d7de; padding:.35em .6em; }
blockquote { border-left:3px solid #d0d7de; margin-left:0; padding-left:1em; color:#57606a; }
img { max-width:100%; }
a { color:#0969da; text-decoration:none; }
input[type=checkbox] { transform: translateY(1px); }`;

/**
 * 文書順トークン走査で h1/h2 開きタグを検出し、除外対象 (最初の h1 と
 * 各 h1 直後の最初の h2) に class `no-break-before` を追記する状態機械。
 *
 * HTML パーサ不使用。`<h1`/`<h2` の直後が空白 / `>` / `/` の場合のみ検出
 * (`<h10` 等の誤爆防止)。pre/code 内の見出しはエディタ生成 HTML で
 * `&lt;h1&gt;` にエスケープ済みなので素の `<h1` 検出で誤爆しない。
 */
export function injectNoBreakClasses(bodyHtml: string): string {
    let out = '';
    let i = 0;
    const n = bodyHtml.length;
    let firstH1Seen = false;
    let awaitingFirstH2AfterH1 = false;

    while (i < n) {
        const ch = bodyHtml[i];
        if (ch !== '<') {
            out += ch;
            i++;
            continue;
        }
        // `<` を検出。h1 / h2 の開きタグか判定 (case-insensitive)。
        const rest = bodyHtml.slice(i);
        // `<h1` or `<h2` の直後が 空白 / > / / であること
        const m = /^<(h[12])(?=[\s/>])/i.exec(rest);
        if (!m) {
            out += ch;
            i++;
            continue;
        }
        const tag = m[1].toLowerCase(); // 'h1' | 'h2'
        // タグの終端 `>` を探す (属性を含む開きタグ全体)
        const gt = bodyHtml.indexOf('>', i);
        if (gt === -1) {
            // 閉じられていない `<h1...` — そのまま出力して終了
            out += bodyHtml.slice(i);
            i = n;
            break;
        }
        const openTag = bodyHtml.slice(i, gt + 1); // 例: `<h1 class="x">` or `<h1/>`
        let shouldInject = false;

        if (tag === 'h1') {
            if (!firstH1Seen) {
                firstH1Seen = true;
                shouldInject = true; // 最初の h1
            }
            // h1 を見るたびに「次の最初の h2 を待つ」
            awaitingFirstH2AfterH1 = true;
        } else {
            // h2
            if (firstH1Seen && awaitingFirstH2AfterH1) {
                shouldInject = true; // h1 直後の最初の h2
                awaitingFirstH2AfterH1 = false;
            }
            // h1 未出現の h2 / 2 個目以降の h2 は付与しない
        }

        out += shouldInject ? addNoBreakClass(openTag) : openTag;
        i = gt + 1;
    }
    return out;
}

/**
 * 開きタグ文字列に class `no-break-before` を追記する。
 * 既存 class 属性があれば値に追記 (スペース区切り)、なければ新設。
 */
function addNoBreakClass(openTag: string): string {
    // 既存 class="..." または class='...' を探す (case-insensitive)
    const classRe = /(\sclass\s*=\s*)("([^"]*)"|'([^']*)')/i;
    const cm = classRe.exec(openTag);
    if (cm) {
        const quote = cm[2][0]; // " or '
        const existing = cm[3] !== undefined ? cm[3] : cm[4];
        const merged = existing ? `${existing} no-break-before` : 'no-break-before';
        const replacement = `${cm[1]}${quote}${merged}${quote}`;
        return openTag.slice(0, cm.index) + replacement + openTag.slice(cm.index + cm[0].length);
    }
    // class 属性なし → タグ名直後に class を新設
    // `<h1` / `<h2` の直後に ` class="no-break-before"` を挿入
    const tagNameEnd = /^<h[12]/i.exec(openTag)![0].length;
    return openTag.slice(0, tagNameEnd) + ' class="no-break-before"' + openTag.slice(tagNameEnd);
}

/** scheme 付き URL (`https://` / `file://` / 任意 scheme) を検出する正規表現。 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface ComposePdfCssOptions {
    includeDefault: boolean;
    stylePaths: string[];
    workspaceRoot?: string;
    readFile?: (p: string) => string;
    exists?: (p: string) => boolean;
}

/**
 * PDF 用 CSS を合成する。includeDefault=true なら PDF_DEFAULT_CSS を先頭、
 * stylePaths を配列順に解決・読取・連結 (後勝ち)。
 *
 * パス許可は allowlist 側判定: ローカルファイルパス (絶対 / ~ / 相対) のみ通す。
 * scheme 付き (`https://` も `file://` も) はすべて skipped。
 * 不在パス・読み取り失敗も skipped に積んで続行 (fail-soft)。
 */
export function composePdfCss(opts: ComposePdfCssOptions): { css: string; skipped: string[] } {
    const readFile = opts.readFile || ((p: string) => fs.readFileSync(p, 'utf8'));
    const exists = opts.exists || ((p: string) => fs.existsSync(p));
    const parts: string[] = [];
    const skipped: string[] = [];

    if (opts.includeDefault) {
        parts.push(PDF_DEFAULT_CSS);
    }

    for (const raw of opts.stylePaths || []) {
        if (!raw || !raw.trim()) {
            skipped.push(raw);
            continue;
        }
        // allowlist: scheme 付き (http(s):// / file:// / 任意 scheme://) は全て弾く
        if (SCHEME_RE.test(raw.trim())) {
            skipped.push(raw);
            continue;
        }
        const resolved = resolveLocalPath(raw, opts.workspaceRoot);
        if (!resolved || !exists(resolved)) {
            skipped.push(raw);
            continue;
        }
        try {
            parts.push(readFile(resolved));
        } catch {
            skipped.push(raw);
        }
    }

    return { css: parts.join('\n'), skipped };
}

/**
 * `<img src="...">` の src が絶対 fs パス (`/` 始まり or Windows `X:\` / `/X:/`)
 * なら pathToFileURL で file:// URI 化 (非 ASCII・空白を正しくエンコード)。
 * data: / http(s): / 既に file: の src は不変。
 */
export function rewriteImgSrcToFileUri(html: string): string {
    // <img ... src="..." ...> の src 属性値を書き換える (" or ' 対応)
    return html.replace(/(<img\b[^>]*?\ssrc\s*=\s*)("([^"]*)"|'([^']*)')/gi, (full, prefix, _quoted, dq, sq) => {
        const quote = _quoted[0];
        const src = dq !== undefined ? dq : sq;
        const rewritten = toFileUriIfAbsolute(src);
        if (rewritten === src) return full;
        return `${prefix}${quote}${rewritten}${quote}`;
    });
}

function toFileUriIfAbsolute(src: string): string {
    const s = src.trim();
    if (!s) return src;
    // scheme 付き (data: / http: / https: / file: / 任意 scheme:) は不変
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return src;
    // 絶対 fs パス判定: POSIX 絶対 (`/...`) or Windows (`X:\...` / `X:/...`) or `/X:/...`
    const isPosixAbs = s.startsWith('/');
    const isWinAbs = /^[a-zA-Z]:[\\/]/.test(s);
    const isSlashWinAbs = /^\/[a-zA-Z]:[\\/]/.test(s);
    if (isPosixAbs || isWinAbs || isSlashWinAbs) {
        return pathToFileURL(s).href;
    }
    return src;
}

export interface BuildSelfContainedHtmlOptions {
    bodyHtml: string;
    css: string;
    title?: string;
}

/**
 * 自己完結 HTML を組み立てる。charset utf-8 / inline <style> / body.pdf-export。
 */
export function buildSelfContainedHtml(opts: BuildSelfContainedHtmlOptions): string {
    const title = escapeHtmlText(opts.title || '');
    return (
        '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        `<title>${title}</title>` +
        `<style>\n${opts.css}\n</style>` +
        '</head><body class="pdf-export">' +
        opts.bodyHtml +
        '</body></html>'
    );
}

function escapeHtmlText(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * headless Chromium の print-to-pdf 引数を構築する。
 * `--host-resolver-rules=MAP * ~NOTFOUND` はネットワーク全遮断
 * (NFR-PDF-02 番人 / ADRL-0037) で必須。
 * `--disable-javascript` は防御 in depth (NFR-PDF-02 / ADRL-0037 強化):
 * 入力 HTML は描画済み DOM の静的 clone (mermaid/KaTeX は SVG/HTML 化済み) で
 * JS 実行は不要。web clipper 由来の外部コンテンツ混入に対する防御。
 * 両経路 (--headless=new / legacy --headless) で一律に付与する。
 */
export function buildPrintArgs(
    destPdfPath: string,
    inputFileUrl: string,
    opts?: { legacyHeadless?: boolean }
): string[] {
    const headless = opts && opts.legacyHeadless ? '--headless' : '--headless=new';
    return [
        headless,
        '--disable-gpu',
        '--no-pdf-header-footer',
        '--host-resolver-rules=MAP * ~NOTFOUND',
        '--disable-javascript',
        '--print-to-pdf=' + destPdfPath,
        inputFileUrl,
    ];
}

/**
 * Chromium/Chrome/Edge 実行ファイルを探索する。
 * explicitPath があり存在すれば最優先。プラットフォーム別候補を順に見て
 * 最初にヒットした 1 つを返す。無ければ undefined。
 */
export function findChromiumExecutable(
    explicitPath?: string,
    exists?: (p: string) => boolean,
    platform?: NodeJS.Platform
): string | undefined {
    const ex = exists || ((p: string) => fs.existsSync(p));
    const plat = platform || process.platform;

    if (explicitPath && ex(explicitPath)) {
        return explicitPath;
    }

    const candidates: string[] = [];
    if (plat === 'darwin') {
        candidates.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
        );
    } else if (plat === 'win32') {
        candidates.push(
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
        );
        const localAppData = process.env.LOCALAPPDATA;
        if (localAppData) {
            candidates.push(path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
        }
    } else {
        candidates.push(
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/microsoft-edge'
        );
    }

    for (const c of candidates) {
        if (ex(c)) return c;
    }
    return undefined;
}
