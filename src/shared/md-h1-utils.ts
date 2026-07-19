// md-h1-utils — Markdown 先頭 H1 の抽出/置換 と byte-skip ファイル書込。
//
// タイトル ↔ H1 双方向同期（FR-TH-01/02/04/05）の共有基盤。
// extractFirstH1 / setFirstH1 は pure（fs 非参照）でテスト容易。
// writeFileIfChanged は Node fs 依存だが vscode 非依存（tempDir で unit テスト可）。
import * as fs from 'fs';

/**
 * ATX H1 行（`# ...`）なら見出しテキストを返す。H1 でなければ null。
 *
 * CommonMark 準拠（★review it.2 HIGH）:
 * - 行頭のインデントは 0〜3 スペース、`#` が 1 個、直後に空白が必須。
 * - **末尾の閉じ `#` 列は「直前に空白がある時だけ」剥がす**（`# Title #` の ` #` は閉じ / `C#` の `#` はタイトルの一部）。
 *   → `# C#`→`C#`、`# F# and C#`→`F# and C#`、`# Title #`→`Title`、`# .gitignore #`→`.gitignore`。
 * - webview 側（outliner.js の firstH1 抽出）と同一ポリシーにするため、抽出はこの 1 関数に集約する意図。
 *
 * 注: 引数 line は EOL（`\r` / `\n`）を含まない 1 行想定だが、末尾 `\r` が残っていても
 *     trailing whitespace として扱われるため安全（呼び出し側で `\r` を別途保持する）。
 */
export function parseAtxH1Text(line: string): string | null {
    // 末尾 CR を落としてからマッチ（`.` は \r にマッチしないため split('\n') 残留 \r を先に除去）。
    const bare = line.replace(/\r$/, '');
    // 行頭 0-3 スペース + `# ` （`#` は 1 個 = H1 のみ）
    const m = bare.match(/^ {0,3}#[ \t]+(.*)$/);
    if (!m) { return null; }
    let text = m[1];
    // 末尾の trailing whitespace を落とす
    text = text.replace(/[ \t]+$/, '');
    // CommonMark: 閉じ `#` 列は「1 個以上の空白の後の `#` 列 + 末尾空白」のみ。
    // 空白を挟まない末尾 `#`（C#, F#）はタイトルの一部として保持する。
    const closing = text.match(/^(.*?)[ \t]+#+$/);
    if (closing) { text = closing[1]; }
    // 見出しテキストの前後空白を整える（先頭空白は既に `#[ \t]+` で消費済みだが念のため）
    return text.replace(/[ \t]+$/, '').replace(/^[ \t]+/, '');
}

/**
 * 本文に最初に現れる H1（`# 見出し`）のテキストを返す。
 * コードブロック（``` フェンス）内の `#` は見出しとみなさない。
 * 見つからなければ null。
 */
export function extractFirstH1(md: string): string | null {
    const lines = md.split('\n');
    let inCode = false;
    for (const line of lines) {
        if (line.startsWith('```')) { inCode = !inCode; continue; }
        if (inCode) { continue; }
        const text = parseAtxH1Text(line);
        if (text !== null) { return text; }
    }
    return null;
}

/**
 * 先頭 H1 を title に置換して返す。本文の他の行（## 以降の見出し等）は保持する。
 * 先頭 H1 が無ければ本文先頭に `# title\n\n` を挿入する。
 * 冪等: 先頭 H1 が既に title と同じなら、入力 md をそのまま（同一文字列で）返す。
 *
 * - 「先頭 H1」判定: 先頭から見て最初の非空行が H1 ならそれを置換対象とする。
 *   最初の非空行が H1 でなければ「H1 は無い」とみなし先頭に挿入する
 *   （本文途中の ## H2 等を H1 と誤検出しないため）。
 * - CRLF 保持（★review it.2 MEDIUM）: 置換対象 H1 行の末尾に `\r` があれば維持し、mixed EOL にしない。
 */
export function setFirstH1(md: string, title: string): string {
    const lines = md.split('\n');
    let inCode = false;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('```')) { inCode = !inCode; continue; }
        if (inCode) { continue; }
        const existing = parseAtxH1Text(lines[i]);
        if (existing !== null) {
            if (existing === title) { return md; } // 冪等: 同値なら書き換えない
            const eol = lines[i].endsWith('\r') ? '\r' : ''; // CRLF 本文の \r を保持
            lines[i] = `# ${title}${eol}`;
            return lines.join('\n');
        }
        // 先頭の非空行が H1 でない → H1 は存在しないとみなし挿入（見出しは先頭にある前提）
        if (lines[i].trim() !== '') { break; }
    }
    // H1 無し → 先頭に挿入
    return `# ${title}\n\n` + md;
}

/**
 * disk 上の内容と byte 一致なら書き込まない（mtime を保護、NFR-TH-02）。
 * 書き込んだら true、skip したら false。未存在 path は書いて true。
 *
 * S3 sync が mtime に依存するため、内容不変の wasteful 書込で mtime を更新しない。
 */
export function writeFileIfChanged(absPath: string, content: string): boolean {
    try {
        const existing = fs.readFileSync(absPath, 'utf8');
        if (existing === content) { return false; } // 冪等・mtime 不変
    } catch {
        // 未存在（新規ファイル等）→ 書く
    }
    fs.writeFileSync(absPath, content, 'utf8');
    return true;
}
